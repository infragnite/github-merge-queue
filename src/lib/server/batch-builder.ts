// Builds a batch commit: the base plus one squash commit per PR, in order,
// with git plumbing only (no work tree), so the queue can build and rebuild
// batches in a bare clone.
//
// Each PR is applied as a three-way merge of the PR head onto the batch tip:
// - a PR on the default branch merges with its usual merge base, so only its
//   own changes are applied;
// - a stacked child merges with its fork point from the parent (the newest
//   parent commit it contains) as the merge base, so only its own commits are
//   applied (the parent's changes are already in the batch as the parent's
//   squash commit). This is what restacking the child onto the default branch
//   would produce; the queue does exactly that restack when it lands the child
//   (see rebase.ts), so GitHub's squash merge gives the tree tested here.
//
// Needs git >= 2.40 (`merge-tree --write-tree --merge-base`).

import { execFileSync } from 'node:child_process';

export interface BatchMember {
	pr: number;
	headSha: string;
	title: string;
	/** Head SHA of the PR's open parent in the stack, when it has one in or below this batch. */
	parentHeadSha?: string | null;
}

export interface BuiltCommit {
	pr: number;
	sha: string;
	tree: string;
	/** For a stacked child: the parent commit its own work starts after (the restack upstream). */
	fork: string | null;
}

export type BuildResult =
	| { ok: true; headSha: string; tree: string; commits: BuiltCommit[] }
	| { ok: false; pr: number; reason: string; conflicts: string[]; commits: BuiltCommit[] };

export interface BuildOptions {
	/** Committer of the batch commits. Each squash commit keeps the author of the PR's head commit. */
	author?: { name: string; email: string };
	/** Fixed commit date (seconds since epoch) for reproducible SHAs, e.g. in tests. */
	date?: number;
}

/** Strips credentials from text that may end up in logs. */
export function redact(text: string): string {
	return text
		.replace(/(Authorization:\s*\w+\s+)\S+/gi, '$1***')
		.replace(/(x-access-token:)[^@\s]+/gi, '$1***')
		.replace(/\bgh[opsu]_[A-Za-z0-9]{20,}/g, '***');
}

export class GitRunner {
	constructor(
		readonly dir: string,
		private readonly env: NodeJS.ProcessEnv = {}
	) {}

	run(args: string[], opts: { allowFail?: boolean; input?: string; env?: NodeJS.ProcessEnv } = {}) {
		try {
			const out = execFileSync('git', args, {
				cwd: this.dir,
				encoding: 'utf8',
				input: opts.input,
				env: { ...process.env, ...this.env, ...opts.env },
				stdio: ['pipe', 'pipe', 'pipe'],
				maxBuffer: 64 * 1024 * 1024
			});
			return { code: 0, out: out.trim() };
		} catch (e) {
			const err = e as { status?: number; stdout?: string; stderr?: string };
			if (!opts.allowFail) {
				throw new Error(redact(`git ${args.join(' ')} failed: ${err.stderr || err.stdout || e}`));
			}
			return { code: err.status ?? 1, out: (err.stdout ?? '').trim(), err: err.stderr ?? '' };
		}
	}
}

/** Squash-commit message for one PR, matching GitHub's squash title. */
/** GitHub skips workflows for a push whose commit message has one of these; a batch must never be skipped. */
const SKIP_DIRECTIVE = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/gi;

export function squashMessage(m: BatchMember): string {
	const title = m.title.replace(SKIP_DIRECTIVE, '').replace(/\s{2,}/g, ' ').trim();
	return `${title} (#${m.pr})`;
}

/**
 * Trailer naming the commit a batch is built on, so CI triggered by the push
 * of an `mq/*` branch knows its base (the range to check) without inputs.
 */
export const BASE_TRAILER = 'Merge-Queue-Base';

/** Applies `members` in order on top of `baseSha`. Stops at the first PR that conflicts. */
export function buildBatch(
	git: GitRunner,
	baseSha: string,
	members: BatchMember[],
	opts: BuildOptions = {}
): BuildResult {
	const author = opts.author ?? { name: 'merge-queue[bot]', email: 'merge-queue[bot]@users.noreply.github.com' };
	const when = opts.date !== undefined ? `@${opts.date} +0000` : undefined;
	const env: NodeJS.ProcessEnv = {
		GIT_AUTHOR_NAME: author.name,
		GIT_AUTHOR_EMAIL: author.email,
		GIT_COMMITTER_NAME: author.name,
		GIT_COMMITTER_EMAIL: author.email,
		...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {})
	};

	let tip = baseSha;
	let tipTree = git.run(['rev-parse', `${baseSha}^{tree}`]).out;
	const commits: BuiltCommit[] = [];
	for (const m of members) {
		const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages'];
		// The parent may have moved on after the child branched: the child's work
		// starts at the newest parent commit it contains, not at the parent's head.
		const fork = m.parentHeadSha ? git.run(['merge-base', m.parentHeadSha, m.headSha]).out : null;
		if (fork) args.push(`--merge-base=${fork}`);
		args.push(tip, m.headSha);
		const r = git.run(args, { allowFail: true });
		const lines = r.out.split('\n').filter(Boolean);
		if (r.code !== 0) {
			const conflicts = r.code === 1 ? lines.slice(1) : [];
			return {
				ok: false,
				pr: m.pr,
				reason:
					r.code === 1
						? `#${m.pr} conflicts with the batch in ${conflicts.length} file(s): ${conflicts.slice(0, 5).join(', ')}`
						: `#${m.pr} could not be merged: ${(r as { err?: string }).err || r.out}`,
				conflicts,
				commits
			};
		}
		const tree = lines[0];
		if (tree === tipTree) {
			// Nothing to apply (e.g. already on the default branch): record no commit.
			commits.push({ pr: m.pr, sha: tip, tree, fork });
			continue;
		}
		// A squash keeps the squashed commits' author (as `git merge --squash` would), not the queue's.
		const [authorName, authorEmail] = git.run(['log', '-1', '--format=%an%x00%ae', m.headSha]).out.split('\0');
		const sha = git.run(['commit-tree', tree, '-p', tip, '-F', '-'], {
			input: `${squashMessage(m)}\n\n${BASE_TRAILER}: ${baseSha}\n`,
			env: { ...env, GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail }
		}).out;
		commits.push({ pr: m.pr, sha, tree, fork });
		tip = sha;
		tipTree = tree;
	}
	return { ok: true, headSha: tip, tree: tipTree, commits };
}
