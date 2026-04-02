/**
 * GitHub mirror — bidirectional sync between seeds and GitHub Issues.
 *
 * Uses `gh` CLI for all GitHub operations. No npm dependencies needed.
 * All functions are non-fatal: if gh is unavailable or network fails,
 * seeds continues working locally.
 */

import type { Config, Issue } from "./types.ts";

/** Check if gh CLI is available and authenticated. */
export async function ghIsAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["gh", "auth", "status"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}

/** Auto-detect GitHub repo from git remote. */
export async function detectGitHubRepo(cwd: string): Promise<string | null> {
	try {
		const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return null;

		const url = output.trim();
		// Match github.com:owner/repo.git or github.com/owner/repo
		const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

/** Resolve the GitHub repo to use. Config > auto-detect. */
export async function resolveRepo(config: Config, cwd: string): Promise<string | null> {
	if (config.github_repo) return config.github_repo;
	return detectGitHubRepo(cwd);
}

/**
 * Build the <!-- seeds:deps --> section for a GitHub issue body.
 * Resolves blocks/blockedBy sd IDs to GitHub issue numbers and titles.
 */
export function buildDepsSection(
	issue: Issue,
	allIssues: Issue[],
	repo: string,
): string {
	const blocks = issue.blocks ?? [];
	const blockedBy = issue.blockedBy ?? [];
	if (blocks.length === 0 && blockedBy.length === 0) return "";

	const resolveLink = (sdId: string): string => {
		const dep = allIssues.find((i) => i.id === sdId);
		if (dep?.githubNumber) {
			return `[${dep.title} (#${dep.githubNumber})](https://github.com/${repo}/issues/${dep.githubNumber})`;
		}
		return `\`${sdId}\` (not synced)`;
	};

	const lines = ["<!-- seeds:deps -->", "### Issue Dependencies"];
	if (blocks.length > 0) {
		lines.push(`- **Blocks:** ${blocks.map(resolveLink).join(", ")}`);
	}
	if (blockedBy.length > 0) {
		lines.push(`- **Blocked by:** ${blockedBy.map(resolveLink).join(", ")}`);
	}
	lines.push("<!-- /seeds:deps -->");
	return lines.join("\n");
}

/**
 * Parse <!-- seeds:deps --> section from a GitHub issue body.
 * Returns GitHub issue numbers for blocks/blockedBy.
 */
export function parseDepsFromBody(body: string): { blocks: number[]; blockedBy: number[] } {
	const blocks: number[] = [];
	const blockedBy: number[] = [];

	const match = body.match(/<!-- seeds:deps -->([\s\S]*?)<!-- \/seeds:deps -->/);
	if (!match?.[1]) return { blocks, blockedBy };

	const section = match[1];
	const numberRe = /#(\d+)/g;

	for (const line of section.split("\n")) {
		if (line.includes("**Blocks:**")) {
			for (const m of line.matchAll(numberRe)) {
				if (m[1]) blocks.push(Number(m[1]));
			}
		} else if (line.includes("**Blocked by:**")) {
			for (const m of line.matchAll(numberRe)) {
				if (m[1]) blockedBy.push(Number(m[1]));
			}
		}
	}

	return { blocks, blockedBy };
}

/** Create a GitHub issue mirroring a seeds issue. Returns gh issue number or null. */
export async function ghCreate(
	issue: Issue,
	repo: string,
	allIssues?: Issue[],
): Promise<number | null> {
	try {
		const bodyParts = [
			issue.description || "",
			"",
			`_Seeds ID: \`${issue.id}\`_`,
		];

		// Add dependency section if issue has blocks/blockedBy
		if (allIssues) {
			const depsSection = buildDepsSection(issue, allIssues, repo);
			if (depsSection) {
				bodyParts.push("", depsSection);
			}
		}

		const body = bodyParts.join("\n");

		const args = [
			"gh", "issue", "create",
			"--repo", repo,
			"--title", issue.title,
			"--body", body,
		];

		// Add labels if they exist (created by sd init --github)
		const labels: string[] = [];
		if (issue.type) labels.push(`type:${issue.type}`);
		if (issue.priority !== undefined) labels.push(`priority:${issue.priority}`);
		if (labels.length > 0) {
			args.push("--label", labels.join(","));
		}

		const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
		const output = await new Response(proc.stdout).text();
		const code = await proc.exited;

		if (code !== 0) return null;

		// gh issue create returns URL like https://github.com/owner/repo/issues/123
		const match = output.trim().match(/\/issues\/(\d+)/);
		return match ? Number(match[1]) : null;
	} catch {
		return null;
	}
}

/** Close a GitHub issue. */
export async function ghClose(
	githubNumber: number,
	repo: string,
	reason?: string,
): Promise<boolean> {
	try {
		const args = ["gh", "issue", "close", String(githubNumber), "--repo", repo];
		if (reason) args.push("--comment", reason);

		const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}

/** Update a GitHub issue (title, body, labels). */
export async function ghUpdate(
	githubNumber: number,
	repo: string,
	fields: { title?: string; description?: string; labels?: string[] },
): Promise<boolean> {
	try {
		const args = ["gh", "issue", "edit", String(githubNumber), "--repo", repo];
		if (fields.title) args.push("--title", fields.title);
		if (fields.description) args.push("--body", fields.description);
		if (fields.labels && fields.labels.length > 0) {
			args.push("--add-label", fields.labels.join(","));
		}

		const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}

/** List GitHub issues for a repo. */
export async function ghList(
	repo: string,
	opts?: { state?: "open" | "closed" | "all"; limit?: number },
): Promise<Array<{ number: number; title: string; state: string; labels: string[] }>> {
	try {
		const args = [
			"gh", "issue", "list",
			"--repo", repo,
			"--json", "number,title,state,labels",
			"--limit", String(opts?.limit ?? 100),
		];
		if (opts?.state) args.push("--state", opts.state);

		const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
		const output = await new Response(proc.stdout).text();
		const code = await proc.exited;

		if (code !== 0) return [];

		const issues = JSON.parse(output) as Array<{
			number: number;
			title: string;
			state: string;
			labels: Array<{ name: string }>;
		}>;

		return issues.map((i) => ({
			number: i.number,
			title: i.title,
			state: i.state,
			labels: i.labels.map((l) => l.name),
		}));
	} catch {
		return [];
	}
}

/** Reopen a GitHub issue. */
export async function ghReopen(
	githubNumber: number,
	repo: string,
): Promise<boolean> {
	try {
		const proc = Bun.spawn(
			["gh", "issue", "reopen", String(githubNumber), "--repo", repo],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}
