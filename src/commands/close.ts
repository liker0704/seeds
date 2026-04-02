import type { Command } from "commander";
import { findSeedsDir, readConfig } from "../config.ts";
import { outputJson, printSuccess } from "../output.ts";
import { issuesPath, readIssues, withLock, writeIssues } from "../store.ts";
import type { Issue } from "../types.ts";

function parseArgs(args: string[]) {
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (!arg) {
			i++;
			continue;
		}
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const eqIdx = key.indexOf("=");
			if (eqIdx !== -1) {
				flags[key.slice(0, eqIdx)] = key.slice(eqIdx + 1);
				i++;
			} else {
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags[key] = next;
					i += 2;
				} else {
					flags[key] = true;
					i++;
				}
			}
		} else {
			positional.push(arg);
			i++;
		}
	}
	return { flags, positional };
}

export async function run(args: string[], seedsDir?: string): Promise<void> {
	const jsonMode = args.includes("--json");
	const { flags, positional } = parseArgs(args);

	if (positional.length === 0) throw new Error("Usage: sd close <id> [ids...] [--reason text]");

	const reason = typeof flags.reason === "string" ? flags.reason : undefined;
	const ids = positional;

	const dir = seedsDir ?? (await findSeedsDir());
	const closed: string[] = [];

	await withLock(issuesPath(dir), async () => {
		const issues = await readIssues(dir);
		const now = new Date().toISOString();

		for (const id of ids) {
			const idx = issues.findIndex((i) => i.id === id);
			if (idx === -1) throw new Error(`Issue not found: ${id}`);
			const issue = issues[idx]!;
			const updated: Issue = {
				...issue,
				status: "closed",
				closedAt: now,
				updatedAt: now,
				...(reason ? { closeReason: reason } : {}),
			};
			issues[idx] = updated;
			closed.push(id);

			// Clean up blockedBy on issues this one blocks
			const blockedIssueIds = issue.blocks ?? [];
			for (const blockedId of blockedIssueIds) {
				const blockedIdx = issues.findIndex((i) => i.id === blockedId);
				if (blockedIdx === -1) continue;
				const blockedIssue = issues[blockedIdx]!;
				const remaining = (blockedIssue.blockedBy ?? []).filter((bid) => bid !== id);
				issues[blockedIdx] = {
					...blockedIssue,
					blockedBy: remaining.length > 0 ? remaining : undefined,
					updatedAt: now,
				};
			}
		}
		await writeIssues(dir, issues);

		// GitHub mirror: close issues on GitHub if enabled
		try {
			const config = await readConfig(dir);
			if (config.github_enabled && config.github_sync_on_write !== false) {
				const { ghClose, detectGitHubRepo, ghIsAvailable } = await import("../github.ts");
				if (await ghIsAvailable()) {
					const repo = config.github_repo ?? await detectGitHubRepo(process.cwd());
					if (repo) {
						for (const id of closed) {
							const issue = issues.find((i) => i.id === id);
							if (issue?.githubNumber) {
								await ghClose(issue.githubNumber, repo, reason);
							}
						}
					}
				}
			}
		} catch {
			// Non-fatal: GitHub sync failure doesn't block local close
		}
	});

	if (jsonMode) {
		outputJson({ success: true, command: "close", closed });
	} else {
		for (const id of closed) {
			printSuccess(`Closed ${id}${reason ? ` — ${reason}` : ""}`);
		}
	}
}

export function register(program: Command): void {
	program
		.command("close <id> [ids...]")
		.description("Close one or more issues")
		.option("--reason <text>", "Close reason")
		.option("--json", "Output as JSON")
		.action(async (id: string, ids: string[], opts: { reason?: string; json?: boolean }) => {
			const args: string[] = [id, ...ids];
			if (opts.reason) args.push("--reason", opts.reason);
			if (opts.json) args.push("--json");
			await run(args);
		});
}
