import type { Command } from "commander";
import { findSeedsDir, readConfig } from "../config.ts";
import { outputJson, printSuccess } from "../output.ts";
import { issuesPath, readIssues, withLock, writeIssues } from "../store.ts";
import type { IssueComment } from "../types.ts";

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

	const id = positional[0];
	const body = positional[1] ?? (typeof flags.body === "string" ? flags.body : undefined);
	const author = typeof flags.author === "string" ? flags.author : "operator";

	if (!id) throw new Error("Usage: sd comment <id> <body> [--author name] [--json]");
	if (!body) throw new Error("Usage: sd comment <id> <body> [--author name] [--json]");

	const dir = seedsDir ?? (await findSeedsDir());

	await withLock(issuesPath(dir), async () => {
		const issues = await readIssues(dir);
		const idx = issues.findIndex((i) => i.id === id);
		if (idx === -1) throw new Error(`Issue not found: ${id}`);

		const issue = issues[idx]!;
		const comment: IssueComment = {
			body,
			author,
			createdAt: new Date().toISOString(),
		};

		const comments = [...(issue.comments ?? []), comment];
		issues[idx] = { ...issue, comments, updatedAt: new Date().toISOString() };
		await writeIssues(dir, issues);

		// GitHub sync: post comment if enabled
		try {
			const config = await readConfig(dir);
			if (config.github_enabled && issue.githubNumber) {
				const { ghIsAvailable, detectGitHubRepo } = await import("../github.ts");
				if (await ghIsAvailable()) {
					const repo = config.github_repo ?? (await detectGitHubRepo(process.cwd()));
					if (repo) {
						const ghBody = `**${author}:** ${body}`;
						const proc = Bun.spawn(
							[
								"gh",
								"issue",
								"comment",
								String(issue.githubNumber),
								"--repo",
								repo,
								"--body",
								ghBody,
							],
							{ stdout: "pipe", stderr: "pipe" },
						);
						const ghOutput = await new Response(proc.stdout).text();
						const code = await proc.exited;
						if (code === 0) {
							// Extract comment URL/ID from output
							const urlMatch = ghOutput.trim().match(/\/comments\/(\d+)/);
							if (urlMatch?.[1]) {
								comment.githubId = Number(urlMatch[1]);
								issues[idx] = {
									...issues[idx]!,
									comments: [...(issues[idx]!.comments?.slice(0, -1) ?? []), comment],
								};
								await writeIssues(dir, issues);
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
		outputJson({ success: true, command: "comment", id, body, author });
	} else {
		printSuccess(`Comment added to ${id}`);
	}
}

export function register(program: Command): void {
	program
		.command("comment <id> [body]")
		.description("Add a comment to an issue")
		.option("--body <text>", "Comment body (alternative to positional)")
		.option("--author <name>", "Comment author (default: operator)")
		.option("--json", "Output as JSON")
		.action(
			async (
				id: string,
				body: string | undefined,
				opts: { body?: string; author?: string; json?: boolean },
			) => {
				const args: string[] = [id];
				if (body) args.push(body);
				else if (opts.body) args.push("--body", opts.body);
				if (opts.author) args.push("--author", opts.author);
				if (opts.json) args.push("--json");
				await run(args);
			},
		);
}
