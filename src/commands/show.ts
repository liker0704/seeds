import type { Command } from "commander";
import { findSeedsDir } from "../config.ts";
import { outputJson, printIssueFull } from "../output.ts";
import { readIssues } from "../store.ts";

export async function run(args: string[], seedsDir?: string): Promise<void> {
	const jsonMode = args.includes("--json");
	const id = args.find((a) => !a.startsWith("--"));
	if (!id) throw new Error("Usage: sd show <id>");

	const dir = seedsDir ?? (await findSeedsDir());
	const issues = await readIssues(dir);

	// Support lookup by GitHub number: #123 or gh:123
	let issue;
	const ghMatch = id.match(/^#?(\d+)$|^gh:(\d+)$/);
	if (ghMatch) {
		const ghNumber = Number(ghMatch[1] ?? ghMatch[2]);
		issue = issues.find((i) => i.githubNumber === ghNumber);
		if (!issue) throw new Error(`No issue linked to GitHub #${ghNumber}`);
	} else {
		issue = issues.find((i) => i.id === id);
		if (!issue) throw new Error(`Issue not found: ${id}`);
	}

	if (jsonMode) {
		outputJson({ success: true, command: "show", issue });
	} else {
		printIssueFull(issue);
	}
}

export function register(program: Command): void {
	program
		.command("show <id>")
		.description("Show issue details")
		.option("--json", "Output as JSON")
		.action(async (id: string, opts: { json?: boolean }) => {
			const args: string[] = [id];
			if (opts.json) args.push("--json");
			await run(args);
		});
}
