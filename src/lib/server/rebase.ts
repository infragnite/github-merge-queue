// Trivial rebases, done by the queue so nobody has to.
//
// `replay` is `git rebase --onto <onto> <upstream> <head>` in plumbing: each
// of the PR's own commits (upstream..head, merges dropped) is cherry-picked
// onto `onto` with merge-tree, keeping its author, committer identity and
// message. A rebase is trivial only when every commit applies cleanly AND the
// result is the tree a single three-way merge of the whole change gives; any
// conflict, or a difference (e.g. a merge commit carrying a conflict
// resolution), makes it a real conflict that goes back to the author.

import type { GitRunner } from './batch-builder';

export interface ReplayInput {
	head: string;
	/** The last commit that is not the PR's own work (the parent's head as the PR contains it). */
	upstream: string;
	onto: string;
	/** Fixed committer date (seconds since epoch), for tests. */
	date?: number;
}

export type ReplayResult =
	| { ok: true; head: string; tree: string; replayed: number }
	| { ok: false; reason: string; conflicts: string[] };

const MERGE_TREE = ['merge-tree', '--write-tree', '--name-only', '--no-messages'];

export function replay(git: GitRunner, { head, upstream, onto, date }: ReplayInput): ReplayResult {
	const whole = git.run([...MERGE_TREE, `--merge-base=${upstream}`, onto, head], { allowFail: true });
	const lines = whole.out.split('\n').filter(Boolean);
	if (whole.code !== 0) {
		const conflicts = whole.code === 1 ? lines.slice(1) : [];
		return {
			ok: false,
			reason: conflicts.length
				? `conflicts in ${conflicts.length} file(s): ${conflicts.slice(0, 5).join(', ')}`
				: `could not be merged: ${(whole as { err?: string }).err || whole.out}`,
			conflicts
		};
	}
	const expected = lines[0];

	const commits = git
		.run(['rev-list', '--reverse', '--topo-order', '--no-merges', `${upstream}..${head}`])
		.out.split('\n')
		.filter(Boolean);
	let tip = onto;
	let tipTree = git.run(['rev-parse', `${onto}^{tree}`]).out;
	let replayed = 0;
	for (const c of commits) {
		const r = git.run([...MERGE_TREE, `--merge-base=${c}^`, tip, c], { allowFail: true });
		const out = r.out.split('\n').filter(Boolean);
		if (r.code !== 0) {
			const conflicts = r.code === 1 ? out.slice(1) : [];
			return {
				ok: false,
				reason: `commit ${c.slice(0, 7)} does not apply cleanly${conflicts.length ? ` (${conflicts.slice(0, 5).join(', ')})` : ''}`,
				conflicts
			};
		}
		const tree = out[0];
		if (tree === tipTree) continue; // already on `onto` (e.g. commits merged in from the default branch)
		const [an, ae, ad, cn, ce] = git
			.run(['log', '-1', '--format=%an%x00%ae%x00%ad%x00%cn%x00%ce', '--date=raw', c])
			.out.split('\0');
		const message = git.run(['log', '-1', '--format=%B', c]).out;
		const when = date !== undefined ? `@${date} +0000` : undefined;
		tip = git.run(['commit-tree', tree, '-p', tip, '-F', '-'], {
			input: message + '\n',
			env: {
				GIT_AUTHOR_NAME: an,
				GIT_AUTHOR_EMAIL: ae,
				GIT_AUTHOR_DATE: ad,
				GIT_COMMITTER_NAME: cn,
				GIT_COMMITTER_EMAIL: ce,
				...(when ? { GIT_COMMITTER_DATE: when } : {})
			}
		}).out;
		tipTree = tree;
		replayed++;
	}
	if (tipTree !== expected) {
		return {
			ok: false,
			reason: 'replaying the commits one by one does not give the same result as merging the change (a merge commit with a conflict resolution?)',
			conflicts: []
		};
	}
	if (replayed === 0) return { ok: false, reason: 'nothing of its own is left after restacking', conflicts: [] };
	return { ok: true, head: tip, tree: tipTree, replayed };
}
