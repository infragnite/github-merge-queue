import { expect, test } from 'vitest';
import { batchCard, summarizeJobs } from './batch-view';
import type { BatchRow } from './batch-store';
import type { StackAnalysis, PRStackInfo } from './stacks';

const row = (o: Partial<BatchRow>): BatchRow => ({
	id: 1, repo_id: 1, kind: 'batch', parent_batch_id: null, branch: 'mq/1', base_sha: 'b', head_sha: 'h1', tree_sha: 't',
	base_tree: 'bt', heads: {}, steps: {}, retried_at: null, members: [], context: [], landed: [], left_prs: [], ejected: [], status: 'testing', express: false,
	ci_result: 'pending', created_at: '2026-11-09 21:00:00', finished_at: null, ...o
});

const info = (number: number, parent: number | null): PRStackInfo => ({
	number, parent, link: parent === null ? null : 'healthy', children: [], depth: 0, expectedBase: 'main', issues: [], broken: false
});

test('nests a PR under its parent only when the parent is in the same batch', () => {
	const analysis: StackAnalysis = { prs: new Map([[1, info(1, null)], [2, info(2, 1)], [3, info(3, 2)], [5, info(5, 4)]]), stacks: [], issues: [] };
	const meta = new Map([[1, { title: 'one', url: 'u1' }]]);
	const card = batchCard(row({ members: [1, 2, 3, 5] }), [], analysis, meta, new Map());
	expect(card.prs).toEqual([
		{ pr: 1, title: 'one', url: 'u1', depth: 0, parent: null, link: null },
		{ pr: 2, title: '', url: '', depth: 1, parent: 1, link: 'healthy' },
		{ pr: 3, title: '', url: '', depth: 2, parent: 2, link: 'healthy' },
		{ pr: 5, title: '', url: '', depth: 0, parent: 4, link: 'healthy' }
	]);
});

test('draws a PR under its own parent, not under the row before it, and not under a parent that landed', () => {
	// Like batch 13: #3296 is stacked on #3280, listed apart; #3039's parent #3000 already landed.
	const analysis: StackAnalysis = {
		prs: new Map([[2600, info(2600, null)], [3039, info(3039, 3000)], [3000, info(3000, null)], [3280, info(3280, null)], [3296, info(3296, 3280)]]),
		stacks: [],
		issues: []
	};
	const card = batchCard(row({ status: 'bisecting', members: [3000, 2600, 3039, 3280, 3296].reverse(), landed: [3000] }), [], analysis, new Map(), new Map());
	expect(card.prs.map((p) => [p.pr, p.depth])).toEqual([
		[3280, 0],
		[3296, 1],
		[3039, 0],
		[2600, 0],
		[3000, 0]
	]);
});

test('attaches each run its own progress, bisection runs included', () => {
	const progress = new Map([['h2', { total: 2, done: 1, failed: 0, running: 1, url: 'j', failedJobs: [] }]]);
	const card = batchCard(row({ status: 'bisecting', members: [1, 2] }), [row({ id: 2, kind: 'bisect', head_sha: 'h2', members: [1] })], null, new Map(), progress);
	expect(card.progress).toBeNull();
	expect(card.bisection.map((b) => [b.id, b.progress])).toEqual([[2, progress.get('h2')]]);
});

test('counts jobs, treating skipped and neutral as passing', () => {
	expect(
		summarizeJobs([
			{ name: 'lint', status: 'completed', conclusion: 'success', html_url: 'a' },
			{ name: 'docs', status: 'completed', conclusion: 'skipped', html_url: 'b' },
			{ name: 'test', status: 'completed', conclusion: 'failure', html_url: 'c' },
			{ name: 'e2e', status: 'in_progress', conclusion: null, html_url: 'd' },
			{ name: 'release', status: 'queued', conclusion: null, html_url: 'e' }
		])
	).toEqual({ total: 5, done: 3, failed: 1, running: 1, url: 'c', failedJobs: ['test'] });
});

test("a bisecting batch shows each PR's verdict and, apart from it, what is happening to it", () => {
	// #2 failed alone and was ejected, #9 with it (stacked on it); #7 went back in line.
	const batch = row({ id: 1, status: 'bisecting', members: [1, 2, 3, 4, 5, 6, 7, 8, 9], landed: [1], left_prs: [2, 7, 9], ejected: [2, 9] });
	const runs = [
		row({ id: 2, kind: 'bisect', members: [1, 3], ci_result: 'success', status: 'landed', base_sha: 'aaaaaaa1' }),
		row({ id: 3, kind: 'bisect', members: [2], ci_result: 'failure', status: 'failed', base_sha: 'bbbbbbb2' }),
		row({ id: 4, kind: 'bisect', members: [4, 5, 6, 7, 8], ci_result: 'failure', status: 'failed', base_sha: 'bbbbbbb2' }),
		row({ id: 5, kind: 'bisect', members: [4], ci_result: 'success', status: 'passed', base_sha: 'bbbbbbb2' }),
		row({ id: 6, kind: 'bisect', members: [5], ci_result: 'pending', status: 'testing', base_sha: 'ccccccc3' }),
		row({ id: 7, kind: 'bisect', members: [4, 8], ci_result: 'pending', status: 'testing', base_sha: 'ccccccc3' }),
		row({ id: 8, kind: 'bisect', members: [8], ci_result: 'failure', status: 'failed', base_sha: 'outside' })
	];
	const card = batchCard(batch, runs, null, new Map(), new Map());
	expect(card.prs.map((p) => [p.pr, p.verdict, p.activity])).toEqual([
		[1, 'passing', 'landed'],
		[2, 'failing', null],
		[3, 'passing', null],
		[4, 'passing', 'checking'],
		[5, 'unknown', 'checking'],
		[6, 'unknown', null],
		[7, 'unknown', 'left'],
		// Failed alone on a branch not known green, and run again: still unknown, being checked.
		[8, 'unknown', 'checking'],
		[9, 'failing', null]
	]);
	expect(card.prs[3].trail).toBe('run 3: failed with 4 others on bbbbbbb\nrun 4: passed alone on bbbbbbb\nrun 6: running with 1 other on ccccccc');
	// Runs themselves carry none.
	expect(card.bisection[0].prs[0].verdict).toBeUndefined();
});

test('a cycle in the stack analysis does not take the batch view down', () => {
	const analysis: StackAnalysis = { prs: new Map([[1, info(1, 2)], [2, info(2, 1)]]), stacks: [], issues: [] };
	const card = batchCard(row({ members: [1, 2] }), [], analysis, new Map(), new Map());
	expect(card.prs.map((p) => p.pr)).toEqual([1, 2]);
	expect(card.prs.every((p) => p.depth <= 2)).toBe(true);
});
