import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	analyzeStacks,
	detectAutoClose,
	mergeBlocker,
	restackCommand,
	AUTO_CLOSE_WINDOW_MS,
	type PRSnapshot,
	type StackAnalysis,
	type StackCommit
} from './stacks';
import { GitSandbox } from './testing/git-sandbox';

let git: GitSandbox;

beforeEach(() => {
	git = new GitSandbox();
});

afterEach(() => {
	git?.cleanup();
});

function info(a: StackAnalysis, n: number) {
	const i = a.prs.get(n);
	if (!i) throw new Error(`no info for #${n}`);
	return i;
}

function kinds(a: StackAnalysis, n: number) {
	return info(a, n).issues.map((i) => i.kind);
}

/** main <- A(#1) <- B(#2) <- C(#3), each with two commits, bases declared correctly. */
function linearStack() {
	git.branch('a', 'main');
	git.commit('a', 'a1');
	git.commit('a', 'a2');
	git.branch('b', 'a');
	git.commit('b', 'b1');
	git.commit('b', 'b2');
	git.branch('c', 'b');
	git.commit('c', 'c1');
	git.openPR(1, 'a', 'main');
	git.openPR(2, 'b', 'a');
	git.openPR(3, 'c', 'b');
}

describe('stack inference from ancestry', () => {
	test('linear stack with correct bases is healthy', () => {
		linearStack();
		const a = analyzeStacks(git.input());

		expect(a.stacks).toEqual([[1, 2, 3]]);
		expect(info(a, 1)).toMatchObject({ parent: null, depth: 0, children: [2], broken: false });
		expect(info(a, 2)).toMatchObject({ parent: 1, link: 'healthy', depth: 1, children: [3] });
		expect(info(a, 3)).toMatchObject({ parent: 2, link: 'healthy', depth: 2, children: [] });
		expect(a.issues).toEqual([]);
	});

	test('picks the nearest parent, not the bottom of the stack', () => {
		linearStack();
		const a = analyzeStacks(git.input());
		// #3 contains both #1's and #2's heads; #2 is the direct parent.
		expect(info(a, 3).parent).toBe(2);
	});

	test('bottom of a stack is mergeable, upper PRs are held', () => {
		linearStack();
		const a = analyzeStacks(git.input());
		expect(mergeBlocker(a, 1)).toBeNull();
		expect(mergeBlocker(a, 2)).toMatch(/Stacked on #1/);
		expect(mergeBlocker(a, 3)).toMatch(/Stacked on #2/);
	});

	test('detects a stack the GitHub base field hides (child targets main)', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'main'); // API says not stacked

		const a = analyzeStacks(git.input());
		expect(info(a, 2)).toMatchObject({ parent: 1, link: 'healthy', expectedBase: 'a' });
		expect(kinds(a, 2)).toEqual(['base-mismatch']);
		expect(a.stacks).toEqual([[1, 2]]);
		// Merging #2 into main would silently land #1's commits too.
		expect(mergeBlocker(a, 2)).toMatch(/Stacked on #1/);
	});

	test('a declared stack that is not real in git is flagged', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'main'); // branched from main, not from a
		git.commit('b', 'b1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'a'); // API says stacked on #1

		const a = analyzeStacks(git.input());
		expect(info(a, 2).parent).toBeNull();
		const issue = info(a, 2).issues[0];
		expect(issue).toMatchObject({ kind: 'base-mismatch', parent: 1, severity: 'blocking' });
		expect(issue.message).toBe("Not on #1's latest commit");
		expect(mergeBlocker(a, 2)).toBe("Not on #1's latest commit");
		expect(a.stacks).toEqual([]);
	});

	test('siblings on the same parent are not stacked on each other', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.commit('a', 'a2');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.branch('c', 'a');
		git.commit('c', 'c1');
		git.commit('c', 'c2');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'a');
		git.openPR(3, 'c', 'a');

		const a = analyzeStacks(git.input());
		expect(info(a, 2).parent).toBe(1);
		expect(info(a, 3).parent).toBe(1);
		expect(info(a, 1).children).toEqual([2, 3]);
		expect(a.stacks).toEqual([[1, 2, 3]]);
		expect(a.issues).toEqual([]);
	});

	test('independent PRs form no stacks', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'main');
		git.commit('b', 'b1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'main');

		const a = analyzeStacks(git.input());
		expect(a.stacks).toEqual([]);
		expect(a.issues).toEqual([]);
		expect(mergeBlocker(a, 1)).toBeNull();
		expect(mergeBlocker(a, 2)).toBeNull();
	});

	test('a PR targeting a non-PR branch (e.g. release) is not a mismatch', () => {
		git.branch('release', 'main');
		git.commit('release', 'r1');
		git.branch('fix', 'release');
		git.commit('fix', 'f1');
		git.openPR(1, 'fix', 'release');

		const a = analyzeStacks(git.input());
		expect(info(a, 1).parent).toBeNull();
		expect(a.issues).toEqual([]);
	});

	test('a PR whose branch merges its parent in (instead of rebasing) stays healthy', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'a');
		git.commit('a', 'a2');
		git.mergeInto('b', 'a');

		const a = analyzeStacks(git.input());
		expect(info(a, 2)).toMatchObject({ parent: 1, link: 'healthy' });
		expect(a.issues).toEqual([]);
	});
});

describe('stacks broken by rebasing a lower PR', () => {
	function rebaseBottomOntoNewMain() {
		linearStack();
		git.commit('main', 'm2');
		git.rebase('a', 'main');
	}

	test('child of a rebased parent is broken (known head evidence)', () => {
		rebaseBottomOntoNewMain();
		const a = analyzeStacks(git.input());

		const b = info(a, 2);
		expect(b).toMatchObject({ parent: 1, link: 'rebased', broken: true });
		const issue = b.issues.find((i) => i.kind === 'parent-rebased')!;
		expect(issue).toMatchObject({ severity: 'blocking', evidence: 'known-head', parent: 1 });
		// The two pre-rebase copies of a1 and a2.
		expect(issue.staleCommits).toHaveLength(2);
		const subjects = git.commitsBetween('main', git.sha('b'));
		expect(issue.staleCommits).toEqual(subjects.slice(0, 2).map((c) => c.sha));
		expect(mergeBlocker(a, 2)).toMatch(/#1 was rebased/);
	});

	test('breakage propagates up the stack without re-reporting it', () => {
		rebaseBottomOntoNewMain();
		const a = analyzeStacks(git.input());
		expect(info(a, 3)).toMatchObject({ parent: 2, link: 'healthy', broken: true });
		expect(kinds(a, 3)).toEqual([]);
		expect(mergeBlocker(a, 3)).not.toBeNull();
		expect(info(a, 1).broken).toBe(false);
	});

	test('rebase is detected without any recorded history (commit fingerprints)', () => {
		git.recordHistory = false;
		rebaseBottomOntoNewMain();
		const a = analyzeStacks(git.input());
		const b = info(a, 2);
		expect(b).toMatchObject({ parent: 1, link: 'rebased', broken: true });
		expect(b.issues[0]).toMatchObject({ kind: 'parent-rebased', evidence: 'fingerprint' });
		expect(b.issues[0].staleCommits).toHaveLength(2);
	});

	test('amend with --no-edit is caught by fingerprints alone', () => {
		git.recordHistory = false;
		linearStack();
		git.amend('a');
		const a = analyzeStacks(git.input());
		expect(info(a, 2)).toMatchObject({ parent: 1, link: 'rebased' });
		expect(info(a, 2).issues[0].staleCommits).toHaveLength(1);
	});

	test('amend that rewrites the message is caught by recorded heads', () => {
		linearStack();
		git.amend('a', 'a2 reworded');
		const a = analyzeStacks(git.input());
		expect(info(a, 2)).toMatchObject({ parent: 1, link: 'rebased' });
		expect(info(a, 2).issues[0].evidence).toBe('known-head');
	});

	test('reworded amend without history still blocks via the declared base', () => {
		git.recordHistory = false;
		linearStack();
		git.amend('a', 'a2 reworded');
		const a = analyzeStacks(git.input());
		// Nothing ties #2 to #1 any more except the declared base, which
		// ancestry no longer backs.
		expect(info(a, 2).parent).toBeNull();
		expect(kinds(a, 2)).toEqual(['base-mismatch']);
		expect(mergeBlocker(a, 2)).not.toBeNull();
	});

	test('force-push of entirely new content under a child', () => {
		linearStack();
		git.forcePush('a', 'main', 'a-rewritten');
		const a = analyzeStacks(git.input());
		expect(info(a, 2)).toMatchObject({ parent: 1, link: 'rebased' });
		expect(info(a, 2).issues[0].staleCommits).toHaveLength(2);
	});

	test('restacking the child repairs the stack', () => {
		linearStack();
		const oldA = git.sha('a');
		const oldB = git.sha('b');
		git.commit('main', 'm2');
		git.rebase('a', 'main');
		git.rebaseOnto('b', 'a', oldA);
		const a = analyzeStacks(git.input());
		expect(info(a, 2)).toMatchObject({ parent: 1, link: 'healthy', broken: false });
		// #3 now sits on #2's pre-restack commits.
		expect(info(a, 3)).toMatchObject({ parent: 2, link: 'rebased', broken: true });

		git.rebaseOnto('c', 'b', oldB);
		const fixed = analyzeStacks(git.input());
		expect(fixed.issues).toEqual([]);
		expect(fixed.stacks).toEqual([[1, 2, 3]]);
	});

	test('a rebased middle PR breaks only the PRs above it', () => {
		linearStack();
		const oldA = git.sha('a');
		git.commit('a', 'a3');
		git.rebaseOnto('b', 'a', oldA); // #2 follows #1, #3 doesn't follow #2
		const a = analyzeStacks(git.input());
		expect(info(a, 2)).toMatchObject({ link: 'healthy', broken: false });
		expect(info(a, 3)).toMatchObject({ parent: 2, link: 'rebased', broken: true });
	});

	test('parent with new commits on top (no rewrite) is only a warning', () => {
		linearStack();
		git.commit('a', 'a3');
		const a = analyzeStacks(git.input());
		expect(info(a, 2)).toMatchObject({ parent: 1, link: 'behind', broken: false });
		expect(info(a, 2).issues[0]).toMatchObject({ kind: 'parent-behind', severity: 'warning' });
		// Still held because #1 isn't merged, but not because it's broken.
		expect(mergeBlocker(a, 2)).toMatch(/Stacked on #1/);
	});

	test('child rebased onto main dropping its parent while still targeting it', () => {
		linearStack();
		git.rebaseOnto('b', 'main', 'a');
		const a = analyzeStacks(git.input());
		expect(info(a, 2).parent).toBeNull();
		expect(kinds(a, 2)).toEqual(['base-mismatch']);
		// #3 still has b's old commits: rebased relative to #2.
		expect(info(a, 3)).toMatchObject({ parent: 2, link: 'rebased' });
	});

	test('a rebase in one stack does not leak into an unrelated stack', () => {
		linearStack();
		git.branch('x', 'main');
		git.commit('x', 'x1');
		git.branch('y', 'x');
		git.commit('y', 'y1');
		git.openPR(10, 'x', 'main');
		git.openPR(11, 'y', 'x');
		git.commit('main', 'm2');
		git.rebase('a', 'main');

		const a = analyzeStacks(git.input());
		expect(info(a, 11)).toMatchObject({ parent: 10, link: 'healthy', broken: false });
		expect(info(a, 2).link).toBe('rebased');
	});
});

describe('stacks after a lower PR merges', () => {
	function twoStack() {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'a');
	}

	test('squash-merged parent, branch auto-deleted, child retargeted', () => {
		twoStack();
		git.merge(1, 'squash');
		git.deleteBranch('a', { retarget: true });
		const a = analyzeStacks(git.input());
		expect(git.pr(2).baseRef).toBe('main');
		expect(info(a, 2)).toMatchObject({ parent: 1, link: 'parent-merged', broken: false });
		expect(info(a, 2).issues).toEqual([
			expect.objectContaining({ kind: 'parent-merged', severity: 'warning' })
		]);
		expect(a.stacks).toEqual([]);
		expect(mergeBlocker(a, 2)).toBeNull();
	});

	test('merge-commit parent leaves a clean child', () => {
		twoStack();
		git.merge(1, 'merge');
		git.deleteBranch('a', { retarget: true });
		const a = analyzeStacks(git.input());
		expect(info(a, 2)).toMatchObject({ parent: null, broken: false });
		expect(a.issues).toEqual([]);
	});

	test('rebase-merged parent', () => {
		twoStack();
		git.commit('main', 'm2'); // so the rebase merge actually rewrites #1
		git.merge(1, 'rebase');
		git.deleteBranch('a', { retarget: true });
		const a = analyzeStacks(git.input());
		expect(info(a, 2).link).toBe('parent-merged');
	});

	test('squash-merged parent whose branch was kept: child still targets it', () => {
		twoStack();
		git.merge(1, 'squash');
		const a = analyzeStacks(git.input());
		expect(kinds(a, 2).sort()).toEqual(['base-mismatch', 'parent-merged']);
		expect(info(a, 2).issues.every((i) => i.severity === 'warning')).toBe(true);
	});

	test('parent closed without merging', () => {
		twoStack();
		git.close(1);
		const a = analyzeStacks(git.input());
		expect(info(a, 2)).toMatchObject({ parent: 1, link: 'parent-closed', broken: true });
		expect(mergeBlocker(a, 2)).toMatch(/closed without merging/);
	});

	test('reopening a closed branch as a new PR is not a closed parent', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.openPR(1, 'a', 'main');
		git.close(1);
		git.commit('a', 'a2');
		git.openPR(5, 'a', 'main');
		const a = analyzeStacks(git.input());
		expect(info(a, 5)).toMatchObject({ parent: null });
		expect(a.issues).toEqual([]);
	});
});

describe('PRs GitHub auto-closes when their base branch is deleted', () => {
	function stackThenDeleteParentBranch(opts: { recordWebhook?: boolean } = {}) {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.branch('c', 'b');
		git.commit('c', 'c1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'a');
		git.openPR(3, 'c', 'b');
		git.merge(1, 'squash');
		// Branch deleted by `git push --delete` rather than the merge button:
		// GitHub closes #2 instead of retargeting it.
		git.deleteBranch('a', { retarget: false, recordWebhook: opts.recordWebhook });
	}

	test('confirmed by the branch delete webhook', () => {
		stackThenDeleteParentBranch();
		expect(git.pr(2).state).toBe('closed');
		const a = analyzeStacks(git.input());
		const issue = a.issues.find((i) => i.kind === 'auto-closed');
		expect(issue).toMatchObject({ pr: 2, parent: 1, evidence: 'webhook' });
		expect(issue!.message).toBe(
			"GitHub closed it because its base branch 'a' was deleted (it was stacked on #1); reopen it against main to queue it again"
		);
	});

	test('inferred from timing when the webhook was missed', () => {
		stackThenDeleteParentBranch({ recordWebhook: false });
		const a = analyzeStacks(git.input());
		const issue = a.issues.find((i) => i.kind === 'auto-closed');
		expect(issue).toMatchObject({ pr: 2, parent: 1, evidence: 'timing' });
		expect(issue!.message).toMatch(/most likely/);
	});

	test('the PR above an auto-closed PR is broken', () => {
		stackThenDeleteParentBranch();
		const a = analyzeStacks(git.input());
		expect(info(a, 3)).toMatchObject({ parent: 2, link: 'parent-closed', broken: true });
		// It still targets #2's branch, which exists but belongs to a closed PR.
		expect(mergeBlocker(a, 3)).toMatch(/#2 was closed without merging/);
	});

	test('a PR closed by hand while its base still exists is not auto-closed', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'a');
		git.close(2);
		const a = analyzeStacks(git.input());
		expect(a.issues.filter((i) => i.kind === 'auto-closed')).toEqual([]);
	});
});

describe('detectAutoClose edge cases', () => {
	const closed = (over: Partial<PRSnapshot>): PRSnapshot => ({
		number: 2,
		state: 'closed',
		merged: false,
		headRef: 'b',
		headSha: 'bbb',
		baseRef: 'a',
		commits: null,
		closedAt: '2026-01-01T12:00:00Z',
		...over
	});
	const parent: PRSnapshot = {
		number: 1,
		state: 'closed',
		merged: true,
		headRef: 'a',
		headSha: 'aaa',
		baseRef: 'main',
		commits: null,
		closedAt: '2026-01-01T11:00:00Z'
	};

	test('ignores merged PRs, open PRs and PRs on the default branch', () => {
		const ctx = { defaultBranch: 'main', prs: [parent], existingBranches: new Set(['main']) };
		expect(detectAutoClose(closed({ merged: true }), ctx)).toBeNull();
		expect(detectAutoClose(closed({ state: 'open' }), ctx)).toBeNull();
		expect(detectAutoClose(closed({ baseRef: 'main' }), ctx)).toBeNull();
	});

	test('base still exists means it was not auto-closed, even with a delete record', () => {
		const ctx = {
			defaultBranch: 'main',
			prs: [parent],
			existingBranches: new Set(['main', 'a']),
			deletedBranches: new Map([['a', '2026-01-01T12:00:00Z']])
		};
		expect(detectAutoClose(closed({}), ctx)).toBeNull();
	});

	test('webhook evidence only counts inside the time window', () => {
		const deletedAt = Date.parse('2026-01-01T12:00:00Z');
		const at = (ms: number) => new Date(deletedAt + ms).toISOString();
		const ctx = {
			defaultBranch: 'main',
			prs: [],
			existingBranches: null,
			deletedBranches: new Map([['a', at(0)]])
		};
		expect(detectAutoClose(closed({ closedAt: at(AUTO_CLOSE_WINDOW_MS) }), ctx)?.evidence).toBe('webhook');
		expect(detectAutoClose(closed({ closedAt: at(-1000) }), ctx)?.evidence).toBe('webhook');
		expect(detectAutoClose(closed({ closedAt: at(AUTO_CLOSE_WINDOW_MS + 1) }), ctx)).toBeNull();
		expect(detectAutoClose(closed({ closedAt: at(-60 * 60 * 1000) }), ctx)).toBeNull();
	});

	test('closed well before the parent closed is a manual close', () => {
		const ctx = { defaultBranch: 'main', prs: [parent], existingBranches: new Set(['main']) };
		expect(detectAutoClose(closed({ closedAt: '2026-01-01T09:00:00Z' }), ctx)).toBeNull();
		expect(detectAutoClose(closed({}), ctx)?.evidence).toBe('timing');
	});

	test('missing base with no owning PR is reported as likely', () => {
		const ctx = { defaultBranch: 'main', prs: [], existingBranches: new Set(['main']) };
		expect(detectAutoClose(closed({}), ctx)).toMatchObject({ evidence: 'branch-missing' });
	});

	test('unknown branch state and no webhook gives no verdict', () => {
		const ctx = { defaultBranch: 'main', prs: [parent], existingBranches: null };
		expect(detectAutoClose(closed({}), ctx)).toBeNull();
	});
});

describe('robustness', () => {
	const c = (sha: string, message = sha): StackCommit => ({
		sha,
		message,
		authorEmail: 'dev@example.com',
		authoredAt: `2026-01-01T00:00:${sha.length.toString().padStart(2, '0')}Z`
	});
	const open = (number: number, headRef: string, baseRef: string, commits: StackCommit[] | null): PRSnapshot => ({
		number,
		state: 'open',
		merged: false,
		headRef,
		baseRef,
		headSha: commits?.at(-1)?.sha ?? `${headRef}-head`,
		commits
	});

	test('two PRs sharing a head are not stacked on each other', () => {
		const commits = [c('x1')];
		const a = analyzeStacks({
			defaultBranch: 'main',
			prs: [open(1, 'a', 'main', commits), open(2, 'a2', 'main', commits)]
		});
		expect(info(a, 1).parent).toBeNull();
		expect(info(a, 2).parent).toBeNull();
		expect(a.stacks).toEqual([]);
	});

	test('unknown commits yield no parent and no crash', () => {
		const a = analyzeStacks({
			defaultBranch: 'main',
			prs: [open(1, 'a', 'main', [c('a1')]), open(2, 'b', 'main', null)]
		});
		expect(info(a, 2).parent).toBeNull();
	});

	test('truncated commit lists are reported', () => {
		const pr = { ...open(1, 'a', 'main', [c('a1')]), commitsTruncated: true };
		const a = analyzeStacks({ defaultBranch: 'main', prs: [pr] });
		expect(kinds(a, 1)).toEqual(['commits-truncated']);
		expect(mergeBlocker(a, 1)).toBeNull();
	});

	test('open PR whose base branch vanished is blocked', () => {
		const a = analyzeStacks({
			defaultBranch: 'main',
			prs: [open(1, 'a', 'gone', [c('a1')])],
			existingBranches: new Set(['main', 'a'])
		});
		expect(kinds(a, 1)).toContain('base-branch-missing');
		expect(mergeBlocker(a, 1)).toMatch(/no longer exists/);
	});

	test('PRs unknown to the analysis are never blocked', () => {
		const a = analyzeStacks({ defaultBranch: 'main', prs: [] });
		expect(mergeBlocker(a, 42)).toBeNull();
	});

	test('cherry-picked commit attributes to the lowest PR that owns it', () => {
		// #1 and #2 both contain x1 (shared), #2 also y1. #3 has a rewritten x1.
		const x1 = c('x1', 'shared work');
		const x1copy = { ...x1, sha: 'x1-copy' };
		const a = analyzeStacks({
			defaultBranch: 'main',
			prs: [
				open(1, 'a', 'main', [x1]),
				open(2, 'b', 'a', [x1, c('y1')]),
				open(3, 'c', 'a', [x1copy, c('z1')])
			]
		});
		expect(info(a, 3)).toMatchObject({ parent: 1, link: 'rebased' });
		expect(info(a, 3).issues[0].staleCommits).toEqual(['x1-copy']);
	});

	test('deep stacks resolve depth regardless of input order', () => {
		const chain: StackCommit[] = [];
		const prs: PRSnapshot[] = [];
		for (let i = 1; i <= 8; i++) {
			chain.push(c(`s${i}`));
			prs.push(open(i, `s${i}`, i === 1 ? 'main' : `s${i - 1}`, [...chain]));
		}
		const a = analyzeStacks({ defaultBranch: 'main', prs: prs.reverse() });
		expect(a.stacks).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
		expect(info(a, 8).depth).toBe(7);
		expect(a.issues).toEqual([]);
	});
});

describe('rebase matrix: every level of a 4-PR stack, every rewrite kind', () => {
	const DEPTH = 4;
	const branchOf = (level: number) => (level === 0 ? 'main' : `s${level}`);

	function build() {
		for (let level = 1; level <= DEPTH; level++) {
			git.branch(branchOf(level), branchOf(level - 1));
			git.commit(branchOf(level), `s${level}-1`);
			git.commit(branchOf(level), `s${level}-2`);
			git.openPR(level, branchOf(level), branchOf(level - 1));
		}
	}

	const rewrites = {
		'rebase onto updated parent': (level: number) => {
			git.commit(branchOf(level - 1), `parent-moved-${level}`);
			git.rebase(branchOf(level), branchOf(level - 1));
		},
		'amend --no-edit': (level: number) => git.amend(branchOf(level)),
		'amend with new message': (level: number) => git.amend(branchOf(level), `reworded ${level}`),
		'force-push new content': (level: number) =>
			git.forcePush(branchOf(level), branchOf(level - 1), `rewrite-${level}`)
	};
	// Rewrites whose old commits keep their author/date/message somewhere in the new head.
	const fingerprintVisible = new Set(['rebase onto updated parent', 'amend --no-edit']);

	for (const [name, rewrite] of Object.entries(rewrites)) {
		for (const history of [true, false]) {
			for (let level = 1; level < DEPTH; level++) {
				const label = `${name}, level ${level}, ${history ? 'with' : 'without'} head history`;
				test(label, () => {
					git.recordHistory = history;
					build();
					rewrite(level);
					const a = analyzeStacks(git.input());

					for (let l = 1; l <= level; l++) {
						expect(info(a, l).broken, `#${l} below the rewrite`).toBe(false);
					}
					const child = info(a, level + 1);
					if (history || fingerprintVisible.has(name)) {
						expect(child).toMatchObject({ parent: level, link: 'rebased', broken: true });
						expect(child.issues.map((i) => i.kind)).toEqual(['parent-rebased']);
					} else {
						// Nothing in git ties the child to the rewritten parent any more;
						// the declared base is what still catches it.
						expect(child.issues.map((i) => i.kind)).toContain('base-mismatch');
						expect(mergeBlocker(a, level + 1)).not.toBeNull();
					}
					for (let l = level + 2; l <= DEPTH; l++) {
						expect(info(a, l), `#${l} above the break`).toMatchObject({
							parent: l - 1,
							link: 'healthy',
							broken: true
						});
						expect(mergeBlocker(a, l)).not.toBeNull();
					}
				});
			}
		}
	}

	for (const method of ['squash', 'rebase', 'merge'] as const) {
		test(`bottom PR ${method}-merged with retarget leaves the rest of the stack intact`, () => {
			build();
			git.commit('main', 'm-other');
			git.merge(1, method);
			git.deleteBranch('s1', { retarget: true });
			const a = analyzeStacks(git.input());

			expect(info(a, 2)).toMatchObject({
				parent: method === 'merge' ? null : 1,
				link: method === 'merge' ? null : 'parent-merged',
				broken: false
			});
			expect(mergeBlocker(a, 2)).toBeNull();
			expect(info(a, 3)).toMatchObject({ parent: 2, link: 'healthy', broken: false });
			expect(info(a, 4)).toMatchObject({ parent: 3, link: 'healthy', broken: false });
			expect(a.stacks).toEqual([[2, 3, 4]]);
		});
	}
});

describe("a stack issue's message doesn't name the PR it is on", () => {
	function twoStack() {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'a');
	}
	const c = (sha: string): StackCommit => ({ sha, message: sha, authorEmail: 'dev@example.com', authoredAt: '2026-01-01T00:00:00Z' });
	const open = (number: number, headRef: string, baseRef: string, commits: StackCommit[]): PRSnapshot => ({
		number,
		state: 'open',
		merged: false,
		headRef,
		baseRef,
		headSha: commits.at(-1)!.sha,
		commits
	});
	const message = (a: StackAnalysis, n: number, kind: string) =>
		info(a, n).issues.find((i) => i.kind === kind)?.message;

	test("#3322's shape: on its parent's branch, sharing an older commit, without the parent's head", () => {
		// #3321 = c1 + c2 (head); #3322 targets #3321's branch with c1 + d1, and the queue never saw c1 as a head.
		git.branch('a', 'main');
		git.commit('a', 'c1');
		git.branch('b', 'a');
		git.commit('b', 'd1');
		git.commit('a', 'c2');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'a');
		const a = analyzeStacks({ ...git.input(), knownHeads: new Map() });
		expect(info(a, 2).issues).toEqual([
			{ kind: 'base-mismatch', pr: 2, parent: 1, severity: 'blocking', message: "Not on #1's latest commit" }
		]);
		expect(mergeBlocker(a, 2)).toBe("Not on #1's latest commit");
	});

	test('behind its parent', () => {
		twoStack();
		const known = new Map([[1, [git.sha('a')]]]);
		git.commit('a', 'a2');
		const a = analyzeStacks({ ...git.input(), knownHeads: known });
		expect(message(a, 2, 'parent-behind')).toBe("#1 has new commits this PR doesn't include yet");
	});

	test('its parent was rebased', () => {
		twoStack();
		git.commit('main', 'm2');
		git.rebase('a', 'main');
		const a = analyzeStacks(git.input());
		expect(message(a, 2, 'parent-rebased')).toBe('#1 was rebased or force-pushed; this PR still carries 1 old commit from it');
	});

	test('its parent was merged', () => {
		twoStack();
		git.merge(1, 'squash');
		git.deleteBranch('a', { retarget: true });
		const a = analyzeStacks(git.input());
		expect(message(a, 2, 'parent-merged')).toBe('#1 was merged, and this PR still carries its original commits; rebase it onto the default branch');
	});

	test('its parent was closed', () => {
		twoStack();
		git.close(1);
		const a = analyzeStacks(git.input());
		expect(message(a, 2, 'parent-closed')).toBe('#1 was closed without merging, and this PR still contains its commits');
	});

	test('stacked but pointed at the default branch', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'main');
		const a = analyzeStacks(git.input());
		expect(message(a, 2, 'base-mismatch')).toBe("Targets 'main' but its commits sit on #1; point it at 'a'");
	});

	test('its base branch is gone', () => {
		const a = analyzeStacks({
			defaultBranch: 'main',
			prs: [open(1, 'a', 'gone', [c('a1')])],
			existingBranches: new Set(['main', 'a'])
		});
		expect(message(a, 1, 'base-branch-missing')).toBe("Its base branch 'gone' no longer exists");
	});

	test('too many commits to fetch', () => {
		const pr = { ...open(1, 'a', 'main', [c('a1')]), commitsTruncated: true };
		const a = analyzeStacks({ defaultBranch: 'main', prs: [pr] });
		expect(message(a, 1, 'commits-truncated')).toBe('More commits than could be fetched; stack detection may be incomplete');
	});
});

describe('the command that restacks a broken PR', () => {
	test('onto a rebased parent: replays only its own commits, past the stale copies', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'a');
		const stale = git.sha('a');
		git.commit('main', 'm2');
		git.rebase('a', 'main');
		const a = analyzeStacks(git.input());
		expect(restackCommand(info(a, 2))).toBe(`git fetch origin pull/1/head && git rebase --onto FETCH_HEAD ${stale}`);
	});

	test("#3322's shape: a plain rebase onto the parent's head", () => {
		git.branch('a', 'main');
		git.commit('a', 'c1');
		git.branch('b', 'a');
		git.commit('b', 'd1');
		git.commit('a', 'c2');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'a');
		const a = analyzeStacks({ ...git.input(), knownHeads: new Map() });
		expect(restackCommand(info(a, 2))).toBe('git fetch origin pull/1/head && git rebase FETCH_HEAD');
	});

	test('a healthy stack has none', () => {
		linearStack();
		expect(restackCommand(info(analyzeStacks(git.input()), 2))).toBeNull();
	});
});
