import { expect, test } from 'vitest';
import { batchCard, summarizeJobs } from './batch-view';
import type { BatchRow } from './batch-store';
import type { StackAnalysis, PRStackInfo } from './stacks';

const row = (o: Partial<BatchRow>): BatchRow => ({
	id: 1, repo_id: 1, kind: 'batch', parent_batch_id: null, branch: 'mq/1', base_sha: 'b', head_sha: 'h1', tree_sha: 't',
	base_tree: 'bt', heads: {}, steps: {}, retried_at: null, members: [], context: [], landed: [], left_prs: [], status: 'testing', express: false,
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
