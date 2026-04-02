import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { outputJson, printSuccess } from "../output.ts";
import { CONFIG_FILE, ISSUES_FILE, SEEDS_DIR_NAME, TEMPLATES_FILE } from "../types.ts";

/** Seeds label definitions that map to GitHub labels. */
const SEEDS_LABELS = [
	{ name: "type:task", color: "0075ca", description: "Task" },
	{ name: "type:bug", color: "d73a4a", description: "Bug report" },
	{ name: "type:feature", color: "a2eeef", description: "Feature request" },
	{ name: "type:epic", color: "fbca04", description: "Epic tracking issue" },
	{ name: "priority:0", color: "b60205", description: "Critical priority" },
	{ name: "priority:1", color: "d93f0b", description: "High priority" },
	{ name: "priority:2", color: "e4e669", description: "Medium priority" },
	{ name: "priority:3", color: "0e8a16", description: "Low priority" },
	{ name: "priority:4", color: "c5def5", description: "Backlog" },
];

async function setupGitHub(cwd: string, seedsDir: string, autoYes: boolean): Promise<boolean> {
	// Check if gh CLI available
	try {
		const proc = Bun.spawn(["gh", "auth", "status"], { stdout: "pipe", stderr: "pipe" });
		if ((await proc.exited) !== 0) {
			process.stderr.write("  GitHub CLI not authenticated. Run: gh auth login\n");
			return false;
		}
	} catch {
		process.stderr.write("  GitHub CLI (gh) not installed. Install: https://cli.github.com\n");
		return false;
	}

	// Detect repo
	const { detectGitHubRepo } = await import("../github.ts");
	const repo = await detectGitHubRepo(cwd);
	if (!repo) {
		process.stderr.write("  No GitHub remote detected. Add a github.com remote first.\n");
		return false;
	}

	if (!autoYes) {
		process.stdout.write(`\n  GitHub repo detected: ${repo}\n`);
		process.stdout.write("  This will:\n");
		process.stdout.write("    1. Create seeds labels on GitHub (type:task, priority:0, etc.)\n");
		process.stdout.write("    2. Enable automatic issue sync (sd create → gh issue create)\n");
		process.stdout.write(`\n  Continue? [y/N] `);

		// Read stdin for confirmation
		const response = await new Promise<string>((resolve) => {
			process.stdin.setRawMode?.(false);
			process.stdin.resume();
			process.stdin.once("data", (data) => {
				process.stdin.pause();
				resolve(data.toString().trim().toLowerCase());
			});
		});

		if (response !== "y" && response !== "yes") {
			process.stdout.write("  Skipped GitHub setup.\n");
			return false;
		}
	}

	// Create labels
	process.stdout.write("  Creating GitHub labels...\n");
	let created = 0;
	for (const label of SEEDS_LABELS) {
		const proc = Bun.spawn(
			[
				"gh", "label", "create", label.name,
				"--repo", repo,
				"--color", label.color,
				"--description", label.description,
				"--force",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if ((await proc.exited) === 0) created++;
	}
	process.stdout.write(`  Created ${created}/${SEEDS_LABELS.length} labels on ${repo}\n`);

	// Update config
	const configPath = join(seedsDir, CONFIG_FILE);
	const existing = readFileSync(configPath, "utf8");
	if (!existing.includes("github_enabled")) {
		writeFileSync(configPath, `${existing}github_enabled: true\ngithub_sync_on_write: true\n`);
	}

	printSuccess(`GitHub sync enabled for ${repo}`);
	return true;
}

export async function run(args: string[]): Promise<void> {
	const jsonMode = args.includes("--json");
	const githubMode = args.includes("--github");
	const autoYes = args.includes("--yes") || args.includes("-y");
	const cwd = process.cwd();
	const seedsDir = join(cwd, SEEDS_DIR_NAME);

	const alreadyExists = existsSync(join(seedsDir, CONFIG_FILE));

	if (alreadyExists && !githubMode) {
		if (jsonMode) {
			outputJson({ success: true, command: "init", dir: seedsDir });
		} else {
			printSuccess(`Already initialized: ${seedsDir}`);
		}
		return;
	}

	if (!alreadyExists) {
		mkdirSync(seedsDir, { recursive: true });

		// config.yaml — derive project name from directory
		const projectName = basename(cwd);
		writeFileSync(join(seedsDir, CONFIG_FILE), `project: "${projectName}"\nversion: "1"\n`);

		// empty JSONL files
		writeFileSync(join(seedsDir, ISSUES_FILE), "");
		writeFileSync(join(seedsDir, TEMPLATES_FILE), "");

		// .gitignore inside .seeds/
		writeFileSync(join(seedsDir, ".gitignore"), "*.lock\n");

		// Append .gitattributes to project root
		const gitattrsPath = join(cwd, ".gitattributes");
		const entry = ".seeds/issues.jsonl merge=union\n.seeds/templates.jsonl merge=union\n";
		if (existsSync(gitattrsPath)) {
			const existing = readFileSync(gitattrsPath, "utf8");
			if (!existing.includes(".seeds/issues.jsonl")) {
				writeFileSync(gitattrsPath, `${existing}\n${entry}`);
			}
		} else {
			writeFileSync(gitattrsPath, entry);
		}

		if (!jsonMode) {
			printSuccess(`Initialized .seeds/ in ${cwd}`);
		}
	}

	// GitHub setup
	if (githubMode || (!alreadyExists && !jsonMode)) {
		const shouldSetupGh = githubMode || autoYes;
		if (shouldSetupGh) {
			await setupGitHub(cwd, seedsDir, autoYes);
		}
	}

	if (jsonMode) {
		outputJson({ success: true, command: "init", dir: seedsDir });
	}
}

export function register(program: Command): void {
	program
		.command("init")
		.description("Initialize .seeds/ in current directory")
		.option("--github", "Set up GitHub issue sync (creates labels, enables mirroring)")
		.option("-y, --yes", "Auto-accept all prompts")
		.option("--json", "Output as JSON")
		.action(async (opts: { github?: boolean; yes?: boolean; json?: boolean }) => {
			const args: string[] = [];
			if (opts.github) args.push("--github");
			if (opts.yes) args.push("--yes");
			if (opts.json) args.push("--json");
			await run(args);
		});
}
