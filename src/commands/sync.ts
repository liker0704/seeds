import type { Command } from "commander";
import { findSeedsDir, isInsideWorktree, projectRootFromSeedsDir, readConfig } from "../config.ts";
import { outputJson, printSuccess, printWarning } from "../output.ts";
import { issuesPath, readIssues, withLock, writeIssues } from "../store.ts";
import { SEEDS_DIR_NAME } from "../types.ts";

function spawnSync(
	cmd: string[],
	cwd: string,
): { stdout: string; stderr: string; exitCode: number } {
	const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = new TextDecoder().decode(result.stdout);
	const stderr = new TextDecoder().decode(result.stderr);
	return { stdout, stderr, exitCode: result.exitCode ?? 0 };
}

/** Check if .seeds/ is in .gitignore. */
function isSeedsIgnored(projectRoot: string): boolean {
	const result = spawnSync(
		["git", "-C", projectRoot, "check-ignore", "-q", `${SEEDS_DIR_NAME}/`],
		projectRoot,
	);
	return result.exitCode === 0;
}

/** Pull state changes and comments from GitHub into sd. */
async function syncFromGitHub(dir: string, jsonMode: boolean): Promise<{ pulled: number }> {
	const config = await readConfig(dir);
	if (!config.github_enabled) return { pulled: 0 };

	const { ghIsAvailable, detectGitHubRepo, ghList, ghListComments } = await import(
		"../github.ts"
	);
	if (!(await ghIsAvailable())) return { pulled: 0 };

	const repo = config.github_repo ?? (await detectGitHubRepo(process.cwd()));
	if (!repo) return { pulled: 0 };

	let pulled = 0;

	await withLock(issuesPath(dir), async () => {
		const issues = await readIssues(dir);
		let changed = false;

		// Get all GitHub issues (open + closed)
		const ghIssues = await ghList(repo, { state: "all", limit: 200 });

		// Auto-discover: link sd issues that don't have githubNumber yet
		// Match by Seeds ID in GitHub issue body (`Seeds ID: \`overstory-xxxx\``)
		for (const ghIssue of ghIssues) {
			// Skip if already linked to an sd issue
			if (issues.some((i) => i.githubNumber === ghIssue.number)) continue;

			// Try to find Seeds ID in body
			const seedsIdMatch = ghIssue.body.match(/Seeds ID: `([^`]+)`/);
			if (seedsIdMatch?.[1]) {
				const sdId = seedsIdMatch[1];
				const idx = issues.findIndex((i) => i.id === sdId && !i.githubNumber);
				if (idx >= 0) {
					issues[idx] = { ...issues[idx]!, githubNumber: ghIssue.number, updatedAt: new Date().toISOString() };
					changed = true;
					pulled++;
					if (!jsonMode) printSuccess(`Linked: ${sdId} ↔ gh #${ghIssue.number}`);
				}
			} else {
				// Fallback: match by exact title
				const idx = issues.findIndex(
					(i) => i.title === ghIssue.title && !i.githubNumber,
				);
				if (idx >= 0) {
					issues[idx] = { ...issues[idx]!, githubNumber: ghIssue.number, updatedAt: new Date().toISOString() };
					changed = true;
					pulled++;
					if (!jsonMode) printSuccess(`Linked (by title): ${issues[idx]!.id} ↔ gh #${ghIssue.number}`);
				}
			}
		}

		for (const ghIssue of ghIssues) {
			const sdIssue = issues.find((i) => i.githubNumber === ghIssue.number);
			if (!sdIssue) continue;

			// Sync state: gh closed but sd open → close sd
			if (ghIssue.state === "CLOSED" && sdIssue.status !== "closed") {
				const idx = issues.findIndex((i) => i.id === sdIssue.id);
				if (idx >= 0) {
					issues[idx] = {
						...issues[idx]!,
						status: "closed",
						closedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						closeReason: "Closed on GitHub",
					};
					changed = true;
					pulled++;
					if (!jsonMode) printSuccess(`Synced close: ${sdIssue.id} (gh #${ghIssue.number})`);
				}
			}

			// Sync state: gh open but sd closed → reopen sd
			if (ghIssue.state === "OPEN" && sdIssue.status === "closed") {
				const idx = issues.findIndex((i) => i.id === sdIssue.id);
				if (idx >= 0) {
					issues[idx] = {
						...issues[idx]!,
						status: "open",
						closedAt: undefined,
						closeReason: undefined,
						updatedAt: new Date().toISOString(),
					};
					changed = true;
					pulled++;
					if (!jsonMode) printSuccess(`Synced reopen: ${sdIssue.id} (gh #${ghIssue.number})`);
				}
			}

			// Sync comments from GitHub → sd
			if (sdIssue.githubNumber) {
				const ghComments = await ghListComments(sdIssue.githubNumber, repo);
				const existingGhIds = new Set(
					(sdIssue.comments ?? []).filter((c) => c.githubId).map((c) => c.githubId),
				);
				// Also track existing comment bodies to detect duplicates from sd→gh→sd round-trip
				const existingBodies = new Set(
					(sdIssue.comments ?? []).map((c) => c.body),
				);

				for (const ghComment of ghComments) {
					if (existingGhIds.has(ghComment.id)) continue;

					// Skip if body matches an existing local comment (sd posted it → gh → sync back)
					// Strip **author:** prefix for matching
					const strippedBody = ghComment.body.replace(/^\*\*[^*]+:\*\*\s*/, "");
					if (existingBodies.has(ghComment.body) || existingBodies.has(strippedBody)) continue;

					const idx = issues.findIndex((i) => i.id === sdIssue.id);
					if (idx >= 0) {
						const existing = issues[idx]!;
						const comments = [
							...(existing.comments ?? []),
							{
								body: ghComment.body,
								author: ghComment.author,
								createdAt: ghComment.createdAt,
								githubId: ghComment.id,
							},
						];
						issues[idx] = { ...existing, comments, updatedAt: new Date().toISOString() };
						changed = true;
						pulled++;
					}
				}
			}
		}

		if (changed) {
			await writeIssues(dir, issues);
		}
	});

	return { pulled };
}

export async function run(args: string[], seedsDir?: string): Promise<void> {
	const jsonMode = args.includes("--json");
	const statusOnly = args.includes("--status");
	const dryRun = args.includes("--dry-run");

	const dir = seedsDir ?? (await findSeedsDir());
	const projectRoot = projectRootFromSeedsDir(dir);

	// GitHub sync: pull changes from GitHub first
	let ghPulled = 0;
	try {
		const result = await syncFromGitHub(dir, jsonMode);
		ghPulled = result.pulled;
	} catch {
		// Non-fatal: GitHub sync failure doesn't block local sync
	}

	// Worktree guard: skip commit when running from a worktree
	if (!seedsDir && isInsideWorktree(process.cwd())) {
		const msg = "Inside a git worktree — skipping commit. Issues are stored in the main repo.";
		if (jsonMode) {
			outputJson({
				success: true,
				command: "sync",
				committed: false,
				worktree: true,
				ghPulled,
				message: msg,
			});
		} else {
			printWarning(msg);
		}
		return;
	}

	// Check if .seeds/ is gitignored → skip git operations
	if (isSeedsIgnored(projectRoot)) {
		if (jsonMode) {
			outputJson({
				success: true,
				command: "sync",
				committed: false,
				gitignored: true,
				ghPulled,
				message: ".seeds/ is in .gitignore — skipping git commit",
			});
		} else {
			if (ghPulled > 0) {
				printSuccess(`Pulled ${ghPulled} change(s) from GitHub`);
			}
			console.log(".seeds/ is gitignored — skipping git commit.");
		}
		return;
	}

	const statusResult = spawnSync(
		["git", "-C", projectRoot, "status", "--porcelain", `${SEEDS_DIR_NAME}/`],
		projectRoot,
	);

	const changed = statusResult.stdout.trim();

	if (statusOnly) {
		if (jsonMode) {
			outputJson({
				success: true,
				command: "sync",
				hasChanges: !!changed,
				changes: changed,
				ghPulled,
			});
		} else {
			if (ghPulled > 0) printSuccess(`Pulled ${ghPulled} change(s) from GitHub`);
			if (changed) {
				console.log("Uncommitted .seeds/ changes:");
				console.log(changed);
			} else {
				console.log("No uncommitted .seeds/ changes.");
			}
		}
		return;
	}

	if (!changed) {
		if (jsonMode) {
			outputJson({
				success: true,
				command: "sync",
				committed: false,
				ghPulled,
				message: "Nothing to commit",
			});
		} else {
			if (ghPulled > 0) printSuccess(`Pulled ${ghPulled} change(s) from GitHub`);
			else console.log("No changes to commit.");
		}
		return;
	}

	if (dryRun) {
		const date = new Date().toISOString().slice(0, 10);
		const msg = `seeds: sync ${date}`;
		if (jsonMode) {
			outputJson({
				success: true,
				command: "sync",
				dryRun: true,
				wouldCommit: true,
				ghPulled,
				message: msg,
				changes: changed,
			});
		} else {
			if (ghPulled > 0) printSuccess(`Pulled ${ghPulled} change(s) from GitHub`);
			console.log("Dry run — would commit:");
			console.log(changed);
			console.log(`Commit message: ${msg}`);
		}
		return;
	}

	// Stage
	const addResult = spawnSync(
		["git", "-C", projectRoot, "add", `${SEEDS_DIR_NAME}/`],
		projectRoot,
	);
	if (addResult.exitCode !== 0) {
		throw new Error(`git add failed: ${addResult.stderr}`);
	}

	// Commit
	const date = new Date().toISOString().slice(0, 10);
	const msg = `seeds: sync ${date}`;
	const commitResult = spawnSync(["git", "-C", projectRoot, "commit", "-m", msg], projectRoot);
	if (commitResult.exitCode !== 0) {
		throw new Error(`git commit failed: ${commitResult.stderr}`);
	}

	if (jsonMode) {
		outputJson({ success: true, command: "sync", committed: true, ghPulled, message: msg });
	} else {
		if (ghPulled > 0) printSuccess(`Pulled ${ghPulled} change(s) from GitHub`);
		console.log(`Committed: ${msg}`);
	}
}

export function register(program: Command): void {
	program
		.command("sync")
		.description("Sync issues: pull from GitHub + stage/commit .seeds/ changes")
		.option("--status", "Check status without committing")
		.option("--dry-run", "Show what would be committed without committing")
		.option("--json", "Output as JSON")
		.action(async (opts: { status?: boolean; dryRun?: boolean; json?: boolean }) => {
			const args: string[] = [];
			if (opts.status) args.push("--status");
			if (opts.dryRun) args.push("--dry-run");
			if (opts.json) args.push("--json");
			await run(args);
		});
}
