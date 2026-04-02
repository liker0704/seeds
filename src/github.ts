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
	if (config.github?.repo) return config.github.repo;
	return detectGitHubRepo(cwd);
}

/** Create a GitHub issue mirroring a seeds issue. Returns gh issue number or null. */
export async function ghCreate(
	issue: Issue,
	repo: string,
): Promise<number | null> {
	try {
		const args = [
			"gh", "issue", "create",
			"--repo", repo,
			"--title", issue.title,
			"--body", issue.description || `Seeds issue: ${issue.id}`,
		];

		// Add labels
		const labels: string[] = [];
		if (issue.type) labels.push(`type:${issue.type}`);
		if (issue.priority !== undefined) labels.push(`priority:${issue.priority}`);
		if (issue.labels) labels.push(...issue.labels);
		if (labels.length > 0) {
			// Create labels if they don't exist (gh handles this gracefully)
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
