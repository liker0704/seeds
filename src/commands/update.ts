import type { Command } from "commander";
import { findSeedsDir, readConfig } from "../config.ts";
import { outputJson, printSuccess } from "../output.ts";
import { issuesPath, readIssues, withLock, writeIssues } from "../store.ts";
import type { Issue } from "../types.ts";
import { VALID_STATUSES, VALID_TYPES } from "../types.ts";

function parseArgs(args: string[]) {
	const flags: Record<string, string | boolean> = {};
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
			i++;
		}
	}
	return flags;
}

function parsePriority(val: string): number {
	if (val.toUpperCase().startsWith("P")) return Number.parseInt(val.slice(1), 10);
	return Number.parseInt(val, 10);
}

export async function run(args: string[], seedsDir?: string): Promise<void> {
	const jsonMode = args.includes("--json");
	const id = args.find((a) => !a.startsWith("--"));
	if (!id) throw new Error("Usage: sd update <id> [flags]");

	const flags = parseArgs(args);

	const dir = seedsDir ?? (await findSeedsDir());
	let updated: Issue | undefined;

	await withLock(issuesPath(dir), async () => {
		const issues = await readIssues(dir);
		const idx = issues.findIndex((i) => i.id === id);
		if (idx === -1) throw new Error(`Issue not found: ${id}`);

		const issue = issues[idx]!;
		const now = new Date().toISOString();
		const patch: Partial<Issue> = { updatedAt: now };

		if (typeof flags.status === "string") {
			const s = flags.status;
			if (!(VALID_STATUSES as readonly string[]).includes(s)) {
				throw new Error(`--status must be one of: ${VALID_STATUSES.join(", ")}`);
			}
			patch.status = s as Issue["status"];
		}
		if (typeof flags.title === "string") patch.title = flags.title;
		if (typeof flags.assignee === "string") patch.assignee = flags.assignee;
		const desc =
			typeof flags.description === "string"
				? flags.description
				: typeof flags.desc === "string"
					? flags.desc
					: flags.body;
		if (typeof desc === "string") patch.description = desc;
		if (typeof flags.type === "string") {
			const t = flags.type;
			if (!(VALID_TYPES as readonly string[]).includes(t)) {
				throw new Error(`--type must be one of: ${VALID_TYPES.join(", ")}`);
			}
			patch.type = t as Issue["type"];
		}
		if (typeof flags.priority === "string") {
			const p = parsePriority(flags.priority);
			if (Number.isNaN(p) || p < 0 || p > 4) throw new Error("--priority must be 0-4 or P0-P4");
			patch.priority = p;
		}

		if (typeof flags["set-labels"] === "string") {
			const val = flags["set-labels"];
			if (val === "") {
				patch.labels = undefined;
			} else {
				const parsed = val
					.split(",")
					.map((l) => l.trim().toLowerCase())
					.filter(Boolean);
				patch.labels = parsed.length > 0 ? parsed : undefined;
			}
		}
		if (typeof flags["add-label"] === "string") {
			const toAdd = flags["add-label"]
				.split(",")
				.map((l) => l.trim().toLowerCase())
				.filter(Boolean);
			const base = patch.labels ?? issue.labels ?? [];
			const merged = Array.from(new Set([...base, ...toAdd]));
			patch.labels = merged.length > 0 ? merged : undefined;
		}
		if (typeof flags["remove-label"] === "string") {
			const toRemove = new Set(flags["remove-label"].split(",").map((l) => l.trim().toLowerCase()));
			const base = patch.labels ?? issue.labels ?? [];
			const remaining = base.filter((l) => !toRemove.has(l));
			patch.labels = remaining.length > 0 ? remaining : undefined;
		}

		issues[idx] = { ...issue, ...patch };
		updated = issues[idx];
		await writeIssues(dir, issues);

		// GitHub sync
		try {
			const config = await readConfig(dir);
			if (config.github_enabled && updated?.githubNumber) {
				const { ghUpdate, ghIsAvailable, detectGitHubRepo } = await import("../github.ts");
				if (await ghIsAvailable()) {
					const repo = config.github_repo ?? (await detectGitHubRepo(process.cwd()));
					if (repo) {
						const fields: { title?: string; description?: string; labels?: string[] } = {};
						if (patch.title) fields.title = patch.title;
						if (patch.description) fields.description = patch.description;
						if (patch.labels) fields.labels = patch.labels;
						if (Object.keys(fields).length > 0) {
							await ghUpdate(updated.githubNumber, repo, fields);
						}
					}
				}
			}
		} catch {
			// Non-fatal
		}
	});

	if (jsonMode) {
		outputJson({ success: true, command: "update", issue: updated });
	} else {
		printSuccess(`Updated ${id}`);
	}
}

export function register(program: Command): void {
	program
		.command("update <id>")
		.description("Update issue fields")
		.option("--status <status>", "New status (open|in_progress|closed)")
		.option("--title <text>", "New title")
		.option("--assignee <name>", "New assignee")
		.option("--description <text>", "New description")
		.option("--desc <text>", "New description (alias for --description)")
		.option("--body <text>", "New description (alias for --description)")
		.option("--type <type>", "New type (task|bug|feature|epic)")
		.option("--priority <n>", "New priority 0-4 or P0-P4")
		.option("--add-label <labels>", "Add label(s) (comma-separated)")
		.option("--remove-label <labels>", "Remove label(s) (comma-separated)")
		.option("--set-labels <labels>", "Set labels (comma-separated, empty to clear)")
		.option("--json", "Output as JSON")
		.action(
			async (
				id: string,
				opts: {
					status?: string;
					title?: string;
					assignee?: string;
					description?: string;
					desc?: string;
					body?: string;
					type?: string;
					priority?: string;
					addLabel?: string;
					removeLabel?: string;
					setLabels?: string;
					json?: boolean;
				},
			) => {
				const args: string[] = [id];
				if (opts.status) args.push("--status", opts.status);
				if (opts.title) args.push("--title", opts.title);
				if (opts.assignee) args.push("--assignee", opts.assignee);
				if (opts.description) args.push("--description", opts.description);
				if (opts.desc) args.push("--desc", opts.desc);
				if (opts.body) args.push("--body", opts.body);
				if (opts.type) args.push("--type", opts.type);
				if (opts.priority) args.push("--priority", opts.priority);
				if (opts.addLabel) args.push("--add-label", opts.addLabel);
				if (opts.removeLabel) args.push("--remove-label", opts.removeLabel);
				if (opts.setLabels !== undefined) args.push("--set-labels", opts.setLabels);
				if (opts.json) args.push("--json");
				await run(args);
			},
		);
}
