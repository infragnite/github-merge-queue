import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildBatch, GitRunner, type BatchMember } from './batch-builder';
import { GitSandbox } from './testing/git-sandbox';

let git: GitSandbox;
let runner: GitRunner;

beforeEach(() => {
	git = new GitSandbox();
	runner = new GitRunner(git.dir);
});

afterEach(() => git?.cleanup());

const member = (pr: number, ref: string, parentRef?: string): BatchMember => ({
	pr,
	headSha: git.sha(ref),
	title: `PR ${pr}`,
	parentHeadSha: parentRef ? git.sha(parentRef) : null
});

const files = (sha: string) => git.git('ls-tree', '-r', '--name-only', sha).split('\n').filter(Boolean).sort();
const show = (sha: string, path: string) => git.git('show', `${sha}:${path}`);

describe('building a batch', () => {
	test('applies independent PRs as one squash commit each, in order', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.commit('a', 'a2');
		git.branch('b', 'main');
		git.commit('b', 'b1');
		const base = git.sha('main');

		const r = buildBatch(runner, base, [member(1, 'a'), member(2, 'b')], { date: 1 });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.commits.map((c) => c.pr)).toEqual([1, 2]);
		expect(git.git('log', '--format=%s', `${base}..${r.headSha}`).split('\n')).toEqual(['PR 2 (#2)', 'PR 1 (#1)']);
		expect(git.git('rev-list', '--parents', '-n', '1', r.commits[0].sha).split(' ')).toEqual([r.commits[0].sha, base]);
		expect(files(r.headSha)).toEqual(['a1.txt', 'a2.txt', 'b1.txt']);
		// each squash commit keeps the PR author; the queue is only the committer
		expect(git.git('log', '-1', '--format=%ae|%ce', r.headSha)).toBe('dev@example.com|merge-queue[bot]@users.noreply.github.com');
	});

	test('is reproducible: the same inputs give the same SHA', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		const base = git.sha('main');
		const one = buildBatch(runner, base, [member(1, 'a')], { date: 5 });
		const two = buildBatch(runner, base, [member(1, 'a')], { date: 5 });
		expect(one.ok && two.ok && one.headSha === two.headSha).toBe(true);
	});

	test('lands the same tree as squash-merging the PRs one by one', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1', 'shared.txt');
		git.branch('b', 'main');
		git.commit('b', 'b1');
		const base = git.sha('main');
		const r = buildBatch(runner, base, [member(1, 'a'), member(2, 'b')]);

		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'main');
		git.merge(1, 'squash');
		git.merge(2, 'squash');
		expect(r.ok && r.tree).toBe(git.git('rev-parse', 'main^{tree}'));
	});

	test('applies only a stacked child’s own commits on top of its parent', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1', 'lib.txt');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		const r = buildBatch(runner, git.sha('main'), [member(1, 'a'), member(2, 'b', 'a')]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(git.git('diff', '--name-only', r.commits[0].sha, r.commits[1].sha)).toBe('b1.txt');
		expect(files(r.headSha)).toEqual(['b1.txt', 'lib.txt']);
	});

	test('a stacked child whose parent moved on after it forked still applies only its own work', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1', 'lib.txt');
		git.branch('b', 'a');
		const forkedAt = git.sha('a');
		git.commit('b', 'b1');
		git.commit('a', 'a2'); // parent gets a new commit the child doesn't have
		const r = buildBatch(runner, git.sha('main'), [
			member(1, 'a'),
			{ pr: 2, headSha: git.sha('b'), title: 'PR 2', parentHeadSha: forkedAt }
		]);
		expect(r.ok && files(r.headSha)).toEqual(['a2.txt', 'b1.txt', 'lib.txt']);
	});

	test('a stacked child of a parent that moved on starts from its fork point, not the parent head', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1', 'lib.txt');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.commit('a', 'a2'); // the child doesn't have this
		const r = buildBatch(runner, git.sha('main'), [member(1, 'a'), member(2, 'b', 'a')]);
		expect(r.ok && files(r.headSha)).toEqual(['a2.txt', 'b1.txt', 'lib.txt']);
		expect(r.ok && r.commits[1].fork).toBe(git.sha('a~1'));
	});

	test('batch commits name their base in a trailer, for CI', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		const base = git.sha('main');
		const r = buildBatch(runner, base, [member(1, 'a')]);
		expect(r.ok && git.git('log', '-1', '--format=%(trailers:key=Merge-Queue-Base,valueonly)', r.headSha)).toBe(base);
	});

	test('stops at a PR that conflicts with the batch and names the files', () => {
		git.branch('a', 'main');
		git.commit('a', 'from a', 'same.txt');
		git.branch('b', 'main');
		git.commit('b', 'from b', 'same.txt');
		git.branch('c', 'main');
		git.commit('c', 'c1');
		const r = buildBatch(runner, git.sha('main'), [member(1, 'a'), member(2, 'b'), member(3, 'c')]);
		expect(r).toMatchObject({ ok: false, pr: 2, conflicts: ['same.txt'] });
		expect(r.ok ? '' : r.reason).toMatch(/#2 conflicts with the batch in 1 file\(s\): same.txt/);
		expect(r.commits.map((c) => c.pr)).toEqual([1]);
	});

	test('rebuilding without the conflicting PR succeeds', () => {
		git.branch('a', 'main');
		git.commit('a', 'from a', 'same.txt');
		git.branch('b', 'main');
		git.commit('b', 'from b', 'same.txt');
		git.branch('c', 'main');
		git.commit('c', 'c1');
		const r = buildBatch(runner, git.sha('main'), [member(1, 'a'), member(3, 'c')]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(show(r.headSha, 'same.txt')).toMatch(/^from a/);
	});

	test('builds on top of a batch still in flight (pipelining)', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'main');
		git.commit('b', 'b1');
		const first = buildBatch(runner, git.sha('main'), [member(1, 'a')]);
		if (!first.ok) throw new Error('first batch failed');
		const second = buildBatch(runner, first.headSha, [member(2, 'b')]);
		expect(second.ok && files(second.headSha)).toEqual(['a1.txt', 'b1.txt']);
	});

	test('a PR whose changes are already on the base adds no commit', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.openPR(1, 'a', 'main');
		git.merge(1, 'squash');
		const base = git.sha('main');
		const r = buildBatch(runner, base, [member(1, 'a')]);
		expect(r.ok && r.headSha).toBe(base);
	});
});
