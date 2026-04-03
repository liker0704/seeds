import type { Command } from "commander";
import { findSeedsDir, readConfig } from "../config.ts";
import { accent, muted, outputJson } from "../output.ts";
import { issuesPath, readIssues, withLock, writeIssues } from "../store.ts";
import type { Issue } from "../types.ts";

export async function run(args: string[], seedsDir?: string): Promise<void> {
	const jsonMode = args.includes("--json");
	const allFlag = args.includes("--all");

	// Parse --from <blocker-id>
	const fromIdx = args.indexOf("--from");
	const blockerId = fromIdx !== -1 ? args[fromIdx + 1] : undefined;

	// Collect positional args (skip flags and their values)
	const skipNext = new Set<number>();
	if (fromIdx !== -1) skipNext.add(fromIdx + 1);
	const positional = args.filter((a, i) => !a.startsWith("--") && !skipNext.has(i));

	const issueId = positional[0];
	if (!issueId) throw new Error("Usage: sd unblock <id> [--from <blocker-id> | --all]");
	if (!allFlag && fromIdx === -1) {
		throw new Error("Usage: sd unblock <id> [--from <blocker-id> | --all]");
	}
	if (fromIdx !== -1 && !blockerId) {
		throw new Error("--from requires a blocker ID");
	}

	const dir = seedsDir ?? (await findSeedsDir());
	let removed: string[] = [];

	await withLock(issuesPath(dir), async () => {
		const issues = await readIssues(dir);
		const issueIdx = issues.findIndex((i) => i.id === issueId);
		if (issueIdx === -1) throw new Error(`Issue not found: ${issueId}`);

		const issue = issues[issueIdx]!;
		const currentBlockers = issue.blockedBy ?? [];

		if (allFlag) {
			const closedIds = new Set(issues.filter((i) => i.status === "closed").map((i) => i.id));
			removed = currentBlockers.filter((bid) => closedIds.has(bid));
			const remaining = currentBlockers.filter((bid) => !closedIds.has(bid));

			const updatedIssue: Issue = { ...issue, updatedAt: new Date().toISOString() };
			if (remaining.length > 0) updatedIssue.blockedBy = remaining;
			else updatedIssue.blockedBy = undefined;
			issues[issueIdx] = updatedIssue;

			for (const bid of removed) {
				const bidIdx = issues.findIndex((i) => i.id === bid);
				if (bidIdx !== -1) {
					const blocker = issues[bidIdx]!;
					const newBlocks = (blocker.blocks ?? []).filter((id) => id !== issueId);
					const updatedBlocker: Issue = { ...blocker, updatedAt: new Date().toISOString() };
					if (newBlocks.length > 0) updatedBlocker.blocks = newBlocks;
					else updatedBlocker.blocks = undefined;
					issues[bidIdx] = updatedBlocker;
				}
			}
		} else {
			if (!currentBlockers.includes(blockerId!)) {
				throw new Error(`${issueId} is not blocked by ${blockerId}`);
			}
			removed = [blockerId!];
			const remaining = currentBlockers.filter((bid) => bid !== blockerId);

			const updatedIssue: Issue = { ...issue, updatedAt: new Date().toISOString() };
			if (remaining.length > 0) updatedIssue.blockedBy = remaining;
			else updatedIssue.blockedBy = undefined;
			issues[issueIdx] = updatedIssue;

			const bidIdx = issues.findIndex((i) => i.id === blockerId);
			if (bidIdx !== -1) {
				const blocker = issues[bidIdx]!;
				const newBlocks = (blocker.blocks ?? []).filter((id) => id !== issueId);
				const updatedBlocker: Issue = { ...blocker, updatedAt: new Date().toISOString() };
				if (newBlocks.length > 0) updatedBlocker.blocks = newBlocks;
				else updatedBlocker.blocks = undefined;
				issues[bidIdx] = updatedBlocker;
			}
		}

		await writeIssues(dir, issues);

		// GitHub sync: update deps sections on affected issues
		try {
			const config = await readConfig(dir);
			if (config.github_enabled) {
				const { ghUpdate, bodyWithDeps, detectGitHubRepo, ghIsAvailable } = await import("../github.ts");
				if (await ghIsAvailable()) {
					const repo = config.github_repo ?? (await detectGitHubRepo(process.cwd()));
					if (repo) {
						const updatedIssue = issues.find((i) => i.id === issueId);
						if (updatedIssue?.githubNumber) {
							await ghUpdate(updatedIssue.githubNumber, repo, {
								description: bodyWithDeps(updatedIssue.description || "", updatedIssue, issues, repo),
							});
						}
						for (const bid of removed) {
							const blocker = issues.find((i) => i.id === bid);
							if (blocker?.githubNumber) {
								await ghUpdate(blocker.githubNumber, repo, {
									description: bodyWithDeps(blocker.description || "", blocker, issues, repo),
								});
							}
						}
					}
				}
			}
		} catch {
			// Non-fatal
		}
	});

	if (jsonMode) {
		outputJson({ success: true, command: "unblock", issueId, removed });
	} else {
		if (removed.length === 0) {
			console.log(`${muted("No closed blockers to remove from")} ${accent(issueId)}.`);
		} else {
			for (const bid of removed) {
				console.log(`${accent(issueId)} ${muted("unblocked from")} ${accent(bid)}`);
			}
		}
	}
}

export function register(program: Command): void {
	program
		.command("unblock")
		.description("Remove blockers from an issue")
		.argument("<id>", "Issue ID to unblock")
		.option("--from <blocker-id>", "Remove a specific blocker")
		.option("--all", "Remove all closed blockers")
		.option("--json", "Output as JSON")
		.action(async (id: string, opts: { from?: string; all?: boolean; json?: boolean }) => {
			const args: string[] = [id];
			if (opts.from) args.push("--from", opts.from);
			if (opts.all) args.push("--all");
			if (opts.json) args.push("--json");
			await run(args);
		});
}
