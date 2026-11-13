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
// Each merge reads `.gitattributes` from the default branch (`attrs`), so a file the default branch
// routes to one of the queue's merge drivers (merge-drivers.ts) merges with it, given the driver
// environment on the runner.
// With `drivers: false` (a repo where the queue can't push to a PR without dismissing its
// approval), and for a member with `drivers: false` (a fork PR), the merge reads no attributes:
// every file merges by lines, as GitHub merges it. GitHub's merge ignores .gitattributes merge
// drivers, built-in ones such as `union` too (github.com/orgs/community/discussions/9288).
//
// Needs git >= 2.41 (`merge-tree --write-tree --merge-base`, `--attr-source`).

import { spawn } from 'node:child_process';
import { withDoing } from './stall-watch';
import { log } from './log';

export interface BatchMember {
	pr: number;
	headSha: string;
	title: string;
	/** Head SHA of the PR's open parent in the stack, when it has one in or below this batch. */
	parentHeadSha?: string | null;
	/**
	 * False: this PR merges by lines, without the queue's merge drivers, as GitHub merges it (a PR
	 * from a fork, which the queue can't push a merge of master to).
	 */
	drivers?: boolean;
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
	/**
	 * The commit whose `.gitattributes` pick the merge drivers: the default branch, never a PR or a
	 * batch ahead (whose PRs could opt themselves in). Defaults to `baseSha`.
	 */
	attrs?: string;
	/** False: every file merges by lines with no attributes, as GitHub merges it. */
	drivers?: boolean;
}

/** Strips credentials from text that may end up in logs. */
export function redact(text: string): string {
	return text
		.replace(/(Authorization:\s*\w+\s+)\S+/gi, '$1***')
		.replace(/(x-access-token:)[^@\s]+/gi, '$1***')
		.replace(/\bgh[opsu]_[A-Za-z0-9]{20,}/g, '***');
}

/** A git command slower than this is logged, with its arguments and time. */
const SLOW_GIT_MS = 5_000;
/** More output than this is a runaway command: it is killed. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export interface GitRunOptions {
	allowFail?: boolean;
	input?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export interface GitResult {
	code: number;
	out: string;
	err?: string;
}

export class GitRunner {
	constructor(
		readonly dir: string,
		private readonly env: NodeJS.ProcessEnv = {},
		private readonly watch: { slowMs?: number; log?: (msg: string) => void } = {}
	) {}

	/** Logs `args` when it took at least the slow threshold. */
	private timed(args: string[], started: number) {
		const took = Date.now() - started;
		if (took >= (this.watch.slowMs ?? SLOW_GIT_MS)) (this.watch.log ?? ((m) => log.info(m)))(redact(`[git] slow: git ${args.join(' ')} took ${took} ms`));
	}

	/**
	 * Runs git off the event loop: a slow or stuck git never freezes requests or ticks. The command
	 * runs in its own process group, and a timeout kills the whole group, so a merge driver or
	 * helper git started can't keep running after it.
	 */
	run(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
		const started = Date.now();
		return withDoing(redact(`git ${args.join(' ')}`).slice(0, 300), () => this.spawn(args, opts)).finally(() => this.timed(args, started));
	}

	/** `run`, for the network commands (fetch, push) that call it by this name. */
	runAsync(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
		return this.run(args, opts);
	}

	private spawn(args: string[], opts: GitRunOptions): Promise<GitResult> {
		const timeoutMs = opts.timeoutMs ?? 2 * 60 * 1000;
		return new Promise<GitResult>((resolve, reject) => {
			const child = spawn('git', args, {
				cwd: this.dir,
				env: { ...process.env, ...this.env, ...opts.env },
				stdio: ['pipe', 'pipe', 'pipe'],
				detached: true
			});
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			let size = 0;
			let why: string | null = null;
			const killGroup = () => {
				try {
					if (child.pid) process.kill(-child.pid, 'SIGKILL');
				} catch {
					// already gone
				}
			};
			const take = (into: Buffer[]) => (b: Buffer) => {
				size += b.length;
				if (size <= MAX_GIT_OUTPUT) return void into.push(b);
				why ??= `output over ${MAX_GIT_OUTPUT} bytes`;
				killGroup();
			};
			child.stdout.on('data', take(out));
			child.stderr.on('data', take(err));
			const timer = setTimeout(() => {
				why ??= `killed after ${timeoutMs} ms`;
				killGroup();
			}, timeoutMs);
			child.on('error', (e) => {
				clearTimeout(timer);
				reject(new Error(redact(`git ${args.join(' ')} failed: ${e.message}`)));
			});
			// 'exit', not 'close': something git started may hold the pipes open after git itself ends.
			child.on('exit', (code) => {
				clearTimeout(timer);
				// Nothing the command started outlives it.
				killGroup();
				setImmediate(() => {
					const stdout = Buffer.concat(out).toString('utf8');
					const stderr = Buffer.concat(err).toString('utf8');
					if (code === 0 && !why) return resolve({ code: 0, out: stdout.trim() });
					if (!opts.allowFail) return reject(new Error(redact(`git ${args.join(' ')} failed: ${why ?? (stderr || stdout || `exit code ${code}`)}`)));
					resolve({ code: code ?? 1, out: stdout.trim(), err: stderr });
				});
			});
			child.stdin.on('error', () => {
				// git exited before reading all its input; its exit code says why
			});
			child.stdin.end(opts.input ?? '');
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
export async function baselineCommit(git: GitRunner, baseSha: string): Promise<string> {
	const tree = (await git.run(['rev-parse', `${baseSha}^{tree}`])).out;
	return (await git.run(['commit-tree', tree, '-p', baseSha, '-F', '-'], {
		input: `Merge queue: ${baseSha.slice(0, 12)} alone\n\n${BASE_TRAILER}: ${baseSha}\n`,
		env: {
			GIT_AUTHOR_NAME: 'merge-queue',
			GIT_AUTHOR_EMAIL: 'merge-queue@users.noreply.github.com',
			GIT_COMMITTER_NAME: 'merge-queue',
			GIT_COMMITTER_EMAIL: 'merge-queue@users.noreply.github.com'
		}
	})).out;
}

/** Applies `members` in order on top of `baseSha`. Stops at the first PR that conflicts. */
export async function buildBatch(
	git: GitRunner,
	baseSha: string,
	members: BatchMember[],
	opts: BuildOptions = {}
): Promise<BuildResult> {
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
	let tipTree = (await git.run(['rev-parse', `${baseSha}^{tree}`])).out;
	const commits: BuiltCommit[] = [];
	for (const m of members) {
		// Attributes come from the default branch, never from a PR: they pick the queue's merge drivers.
		const attrs = opts.drivers === false || m.drivers === false ? EMPTY_TREE : (opts.attrs ?? baseSha);
		const args = [`--attr-source=${attrs}`, 'merge-tree', '--write-tree', '--name-only', '--no-messages'];
		// The parent may have moved on after the child branched: the child's work
		// starts at the newest parent commit it contains, not at the parent's head.
		const fork = m.parentHeadSha ? (await git.run(['merge-base', m.parentHeadSha, m.headSha])).out : null;
		if (fork) args.push(`--merge-base=${fork}`);
		args.push(tip, m.headSha);
		const r = (await git.run(args, { allowFail: true }));
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
		const [authorName, authorEmail] = (await git.run(['log', '-1', '--format=%an%x00%ae', m.headSha])).out.split('\0');
		const sha = (await git.run(['commit-tree', tree, '-p', tip, '-F', '-'], {
			input: `${squashMessage(m)}\n\n${BASE_TRAILER}: ${baseSha}\n`,
			env: { ...env, GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail }
		})).out;
		commits.push({ pr: m.pr, sha, tree, fork });
		tip = sha;
		tipTree = tree;
	}
	return { ok: true, headSha: tip, tree: tipTree, commits };
}

/** git's empty tree: as `--attr-source` it reads no attributes, so every file merges by lines. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * `head` merged onto `onto` twice: with the queue's merge drivers, picked by the attributes of
 * `attrs` (the default branch the batch was built with, which a PR landed before it may have
 * changed), and by lines with no attributes, as GitHub merges. Each is the tree, or null on a conflict.
 */
export async function mergeTrees(git: GitRunner, onto: string, head: string, attrs: string): Promise<{ queue: string | null; line: string | null }> {
	const tree = async (source: string) => {
		const r = (await git.run([`--attr-source=${source}`, 'merge-tree', '--write-tree', '--name-only', '--no-messages', onto, head], { allowFail: true }));
		return r.code === 0 ? r.out.split('\n')[0] : null;
	};
	return { queue: await tree(attrs), line: await tree(EMPTY_TREE) };
}

/** A merge commit of `tree` on `parents`, committed by the queue. */
export async function queueMergeCommit(git: GitRunner, tree: string, parents: string[], message: string): Promise<string> {
	return (await git.run(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'], {
		input: `${message}\n`,
		env: {
			GIT_AUTHOR_NAME: 'merge-queue',
			GIT_AUTHOR_EMAIL: 'merge-queue@users.noreply.github.com',
			GIT_COMMITTER_NAME: 'merge-queue',
			GIT_COMMITTER_EMAIL: 'merge-queue@users.noreply.github.com'
		}
	})).out;
}
