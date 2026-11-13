import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildBatch, GitRunner, squashMessage, type BatchMember } from './batch-builder';
import { GitSandbox } from './testing/git-sandbox';
import { mergeDriverEnv } from './merge-drivers';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
	test('applies independent PRs as one squash commit each, in order', async () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.commit('a', 'a2');
		git.branch('b', 'main');
		git.commit('b', 'b1');
		const base = git.sha('main');

		const r = (await buildBatch(runner, base, [member(1, 'a'), member(2, 'b')], { date: 1 }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.commits.map((c) => c.pr)).toEqual([1, 2]);
		expect(git.git('log', '--format=%s', `${base}..${r.headSha}`).split('\n')).toEqual(['PR 2 (#2)', 'PR 1 (#1)']);
		expect(git.git('rev-list', '--parents', '-n', '1', r.commits[0].sha).split(' ')).toEqual([r.commits[0].sha, base]);
		expect(files(r.headSha)).toEqual(['a1.txt', 'a2.txt', 'b1.txt']);
		// each squash commit keeps the PR author; the queue is only the committer
		expect(git.git('log', '-1', '--format=%ae|%ce', r.headSha)).toBe('dev@example.com|merge-queue[bot]@users.noreply.github.com');
	});

	test('is reproducible: the same inputs give the same SHA', async () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		const base = git.sha('main');
		const one = (await buildBatch(runner, base, [member(1, 'a')], { date: 5 }));
		const two = (await buildBatch(runner, base, [member(1, 'a')], { date: 5 }));
		expect(one.ok && two.ok && one.headSha === two.headSha).toBe(true);
	});

	test('lands the same tree as squash-merging the PRs one by one', async () => {
		git.branch('a', 'main');
		git.commit('a', 'a1', 'shared.txt');
		git.branch('b', 'main');
		git.commit('b', 'b1');
		const base = git.sha('main');
		const r = (await buildBatch(runner, base, [member(1, 'a'), member(2, 'b')]));

		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'main');
		git.merge(1, 'squash');
		git.merge(2, 'squash');
		expect(r.ok && r.tree).toBe(git.git('rev-parse', 'main^{tree}'));
	});

	test('applies only a stacked child’s own commits on top of its parent', async () => {
		git.branch('a', 'main');
		git.commit('a', 'a1', 'lib.txt');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		const r = (await buildBatch(runner, git.sha('main'), [member(1, 'a'), member(2, 'b', 'a')]));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(git.git('diff', '--name-only', r.commits[0].sha, r.commits[1].sha)).toBe('b1.txt');
		expect(files(r.headSha)).toEqual(['b1.txt', 'lib.txt']);
	});

	test('a stacked child whose parent moved on after it forked still applies only its own work', async () => {
		git.branch('a', 'main');
		git.commit('a', 'a1', 'lib.txt');
		git.branch('b', 'a');
		const forkedAt = git.sha('a');
		git.commit('b', 'b1');
		git.commit('a', 'a2'); // parent gets a new commit the child doesn't have
		const r = (await buildBatch(runner, git.sha('main'), [
			member(1, 'a'),
			{ pr: 2, headSha: git.sha('b'), title: 'PR 2', parentHeadSha: forkedAt }
		]));
		expect(r.ok && files(r.headSha)).toEqual(['a2.txt', 'b1.txt', 'lib.txt']);
	});

	test('a stacked child of a parent that moved on starts from its fork point, not the parent head', async () => {
		git.branch('a', 'main');
		git.commit('a', 'a1', 'lib.txt');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.commit('a', 'a2'); // the child doesn't have this
		const r = (await buildBatch(runner, git.sha('main'), [member(1, 'a'), member(2, 'b', 'a')]));
		expect(r.ok && files(r.headSha)).toEqual(['a2.txt', 'b1.txt', 'lib.txt']);
		expect(r.ok && r.commits[1].fork).toBe(git.sha('a~1'));
	});

	test('batch commits name their base in a trailer, for CI', async () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		const base = git.sha('main');
		const r = (await buildBatch(runner, base, [member(1, 'a')]));
		expect(r.ok && git.git('log', '-1', '--format=%(trailers:key=Merge-Queue-Base,valueonly)', r.headSha)).toBe(base);
	});

	test('stops at a PR that conflicts with the batch and names the files', async () => {
		git.branch('a', 'main');
		git.commit('a', 'from a', 'same.txt');
		git.branch('b', 'main');
		git.commit('b', 'from b', 'same.txt');
		git.branch('c', 'main');
		git.commit('c', 'c1');
		const r = (await buildBatch(runner, git.sha('main'), [member(1, 'a'), member(2, 'b'), member(3, 'c')]));
		expect(r).toMatchObject({ ok: false, pr: 2, conflicts: ['same.txt'] });
		expect(r.ok ? '' : r.reason).toMatch(/#2 conflicts with the batch in 1 file\(s\): same.txt/);
		expect(r.commits.map((c) => c.pr)).toEqual([1]);
	});

	test('rebuilding without the conflicting PR succeeds', async () => {
		git.branch('a', 'main');
		git.commit('a', 'from a', 'same.txt');
		git.branch('b', 'main');
		git.commit('b', 'from b', 'same.txt');
		git.branch('c', 'main');
		git.commit('c', 'c1');
		const r = (await buildBatch(runner, git.sha('main'), [member(1, 'a'), member(3, 'c')]));
		expect(r.ok).toBe(true);
		if (r.ok) expect(show(r.headSha, 'same.txt')).toMatch(/^from a/);
	});

	test('builds on top of a batch still in flight (pipelining)', async () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'main');
		git.commit('b', 'b1');
		const first = (await buildBatch(runner, git.sha('main'), [member(1, 'a')]));
		if (!first.ok) throw new Error('first batch failed');
		const second = (await buildBatch(runner, first.headSha, [member(2, 'b')]));
		expect(second.ok && files(second.headSha)).toEqual(['a1.txt', 'b1.txt']);
	});

	test('a PR whose changes are already on the base adds no commit', async () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.openPR(1, 'a', 'main');
		git.merge(1, 'squash');
		const base = git.sha('main');
		const r = (await buildBatch(runner, base, [member(1, 'a')]));
		expect(r.ok && r.headSha).toBe(base);
	});
});

test('a skip directive in a PR title cannot skip the batch CI', async () => {
	expect(squashMessage({ pr: 7, headSha: 'x', title: 'Docs only [skip ci]', parentHeadSha: null })).toBe('Docs only (#7)');
	expect(squashMessage({ pr: 8, headSha: 'x', title: '[CI SKIP] tweak [no ci] it', parentHeadSha: null })).toBe('tweak it (#8)');
});

describe('running git without blocking', () => {
	test('resolves with the output, like the synchronous run', async () => {
		expect(await runner.runAsync(['rev-parse', 'main'])).toEqual({ code: 0, out: git.sha('main') });
	});

	test('reports a failure as its exit code when failure is allowed', async () => {
		const r = await runner.runAsync(['cat-file', '-e', 'no-such-ref'], { allowFail: true });
		expect(r.code).not.toBe(0);
	});

	test('rejects on failure, naming the command', async () => {
		await expect(runner.runAsync(['cat-file', '-e', 'no-such-ref'])).rejects.toThrow(/^git cat-file -e no-such-ref failed: /);
	});

	test('lets other work run while git is busy', async () => {
		let ticked = false;
		const timer = setTimeout(() => (ticked = true), 0);
		await runner.runAsync(['rev-parse', 'main']);
		clearTimeout(timer);
		expect(ticked).toBe(true);
	});
});

describe('merge drivers in a batch', () => {
	const LIST = 'lane.txt';
	const write = (branch: string, path: string, text: string) => {
		git.git('checkout', '-q', branch);
		writeFileSync(join(git.dir, path), text);
		git.git('add', '-A');
		git.git('commit', '-q', '-m', `${branch}: ${path}`);
	};
	let queue: GitRunner;
	beforeEach(() => {
		queue = new GitRunner(git.dir, mergeDriverEnv(join(git.dir, '.git')));
		write('main', LIST, 'a\nb\nc\nd\n');
	});

	/** A batch ahead whose PR routes the list to the driver, and two PRs removing neighbouring lines built on it. */
	const onBatchAhead = () => {
		git.branch('ahead', 'main');
		write('ahead', 'ahead.txt', 'ahead\n');
		if (!git.git('ls-tree', '--name-only', 'main', '.gitattributes')) write('ahead', '.gitattributes', `${LIST} merge=sorted-set\n`);
		git.branch('one', 'main');
		write('one', LIST, 'a\nc\nd\n');
		git.branch('two', 'main');
		write('two', LIST, 'a\nb\nd\n');
		return [member(1, 'one'), member(2, 'two')];
	};

	test("attributes come from the default branch, not from the base a batch ahead's PRs made", async () => {
		const members = onBatchAhead();
		const r = (await buildBatch(queue, git.sha('ahead'), members, { attrs: git.sha('main'), date: 1 }));
		expect(r).toMatchObject({ ok: false, pr: 2, conflicts: [LIST] });
	});

	test('with the attributes on the default branch, the same PRs build', async () => {
		write('main', '.gitattributes', `${LIST} merge=sorted-set\n`);
		const members = onBatchAhead();
		const r = (await buildBatch(queue, git.sha('ahead'), members, { attrs: git.sha('main'), date: 1 }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(show(r.headSha, LIST)).toBe('a\nd');
	});
});
