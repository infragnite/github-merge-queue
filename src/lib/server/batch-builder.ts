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
//   would produce; the queue does that restack when it lands the child, if
//   GitHub's squash of the child as it is would not give the tree tested here
//   (see rebase.ts).
//
// Each merge reads `.gitattributes` from the base, so a file the base routes to one of the queue's
// merge drivers (merge-drivers.ts) merges with it, given the driver environment on the runner.
// With `drivers: false` (a repo where the queue can't push to a PR without dismissing its
// approval) every file merges line by line, as GitHub merges it.
//
// Needs git >= 2.40 (`merge-tree --write-tree --merge-base`, `--attr-source`).

import { execFile, execFileSync } from 'node:child_process';

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
	/** False: every file merges line by line, as GitHub merges it, whatever the base's `.gitattributes` says. */
	drivers?: boolean;
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

	run(args: string[], opts: { allowFail?: boolean; input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
		try {
			const out = execFileSync('git', args, {
				// Local plumbing takes seconds; a hung git must not stall the event loop for long.
				timeout: opts.timeoutMs ?? 2 * 60 * 1000,
				killSignal: 'SIGKILL',
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

	/**
	 * Same as `run`, without blocking the event loop: for network git (fetch, push), which can
	 * take minutes on a large repository and would otherwise freeze every request meanwhile.
	 */
	runAsync(
		args: string[],
		opts: { allowFail?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
	): Promise<{ code: number; out: string; err?: string }> {
		return new Promise((resolve, reject) => {
			execFile(
				'git',
				args,
				{
					timeout: opts.timeoutMs ?? 2 * 60 * 1000,
					killSignal: 'SIGKILL',
					cwd: this.dir,
					encoding: 'utf8',
					env: { ...process.env, ...this.env, ...opts.env },
					maxBuffer: 64 * 1024 * 1024
				},
				(e, stdout, stderr) => {
					if (!e) return resolve({ code: 0, out: stdout.trim() });
					const code = typeof e.code === 'number' ? e.code : 1;
					const why = e.killed ? `killed after ${opts.timeoutMs ?? 120000} ms` : stderr || stdout || e.message;
					if (!opts.allowFail) return reject(new Error(redact(`git ${args.join(' ')} failed: ${why}`)));
					resolve({ code, out: stdout.trim(), err: stderr });
				}
			);
		});
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

/**
 * A commit with `baseSha`'s own tree on top of it, so CI can test the default branch alone on a
 * queue branch (its trailer names the base, like a batch's).
 */
export function baselineCommit(git: GitRunner, baseSha: string): string {
	const tree = git.run(['rev-parse', `${baseSha}^{tree}`]).out;
	return git.run(['commit-tree', tree, '-p', baseSha, '-F', '-'], {
		input: `Merge queue: ${baseSha.slice(0, 12)} alone\n\n${BASE_TRAILER}: ${baseSha}\n`,
		env: {
			GIT_AUTHOR_NAME: 'merge-queue',
			GIT_AUTHOR_EMAIL: 'merge-queue@users.noreply.github.com',
			GIT_COMMITTER_NAME: 'merge-queue',
			GIT_COMMITTER_EMAIL: 'merge-queue@users.noreply.github.com'
		}
	}).out;
}

/** git's empty tree: as `--attr-source` it reads no attributes, so no merge driver applies. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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
		// Attributes come from the base, never from a PR: they pick the queue's merge drivers.
		const args = [`--attr-source=${opts.drivers === false ? EMPTY_TREE : baseSha}`, 'merge-tree', '--write-tree', '--name-only', '--no-messages'];
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

/**
 * `head` merged onto `onto` twice: with the queue's merge drivers (attributes from `onto`, as a
 * batch is built) and as a plain line merge (as GitHub merges). Each is the tree, or null on a conflict.
 */
export function mergeTrees(git: GitRunner, onto: string, head: string): { queue: string | null; line: string | null } {
	const tree = (attrs: string) => {
		const r = git.run([`--attr-source=${attrs}`, 'merge-tree', '--write-tree', '--name-only', '--no-messages', onto, head], { allowFail: true });
		return r.code === 0 ? r.out.split('\n')[0] : null;
	};
	return { queue: tree(onto), line: tree(EMPTY_TREE) };
}

/** A merge commit of `tree` on `parents`, committed by the queue. */
export function queueMergeCommit(git: GitRunner, tree: string, parents: string[], message: string): string {
	return git.run(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'], {
		input: `${message}\n`,
		env: {
			GIT_AUTHOR_NAME: 'merge-queue',
			GIT_AUTHOR_EMAIL: 'merge-queue@users.noreply.github.com',
			GIT_COMMITTER_NAME: 'merge-queue',
			GIT_COMMITTER_EMAIL: 'merge-queue@users.noreply.github.com'
		}
	}).out;
}
