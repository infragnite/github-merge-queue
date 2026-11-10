import { expect, test } from 'vitest';
import { queueView, type ViewItem } from './queue-view';

let nextId = 1;
function item(pr: number, over: Partial<ViewItem> = {}): ViewItem {
	return {
		id: nextId++,
		repo_id: 1,
		pr_number: pr,
		pr_title: `PR ${pr}`,
		pr_url: `https://x/${pr}`,
		author_login: 'a',
		author_avatar: '',
		head_sha: null,
		status: 'queued',
		position: pr,
		error_message: null,
		queued_by: 'a',
		created_at: `2026-11-09 10:${String(pr % 60).padStart(2, '0')}:00`,
		started_at: null,
		completed_at: null,
		priority: 'normal',
		holdWait: null,
		...over
	};
}

const limits = { maxBatch: 3, expressMax: 2 };
const nums = (rows: Array<{ item: ViewItem }>) => rows.map((r) => r.item.pr_number);

test('batch mode orders urgent first then oldest, previews the next batch, and folds batch members into one group', () => {
	const items = [
		item(1),
		item(2),
		item(3, { status: 'checking' }),
		item(4, { status: 'checking' }),
		item(5),
		item(6, { priority: 'low' }),
		item(7),
		item(8)
	];
	const v = queueView({ items, mode: 'batch', batches: [{ id: 5, status: 'bisecting', prs: [3, 4] }], stacks: null, limits });

	expect(v.inFlight).toEqual([{ batch: 5, number: 5, status: 'bisecting', prs: [3, 4] }]);
	expect(v.express).toBe(false);
	expect(nums(v.upNext)).toEqual([1, 2, 5]);
	expect(v.upNext.map((r) => r.position)).toEqual([1, 2, 3]);
	expect(nums(v.rows)).toEqual([7, 8, 6]);
	expect(v.rows.map((r) => r.position)).toEqual([4, 5, 6]);
	expect(v.attention).toEqual([]);
});

test('an urgent PR makes the next batch an express batch of urgent PRs only', () => {
	const items = [item(1), item(2), item(30, { priority: 'urgent' }), item(31, { priority: 'urgent' }), item(32, { priority: 'urgent' })];
	const v = queueView({ items, mode: 'batch', batches: [], stacks: null, limits });

	expect(v.express).toBe(true);
	expect(nums(v.upNext)).toEqual([30, 31]);
	expect(nums(v.rows)).toEqual([32, 1, 2]);
});

test('batch mode follows the queue order within a priority (a PR moved to the front)', () => {
	const items = [item(1, { position: 2 }), item(2, { position: 3 }), item(3, { position: 1 })];
	const v = queueView({ items, mode: 'batch', batches: [], stacks: null, limits });
	expect(nums(v.upNext)).toEqual([3, 1, 2]);
	expect(v.express).toBe(false);
});

test('PRs that need someone move to attention with the reason; PRs that wait by themselves stay in line but out of the preview', () => {
	const items = [
		item(1, { status: 'conflict' }),
		item(2, { error_message: '#2 is not approved', holdWait: false }),
		item(3, { error_message: "#3's checks are still running", holdWait: true }),
		item(4, { status: 'failed', error_message: 'Failed in batch 3' }),
		item(5),
		item(6, { status: 'merged' })
	];
	const v = queueView({ items, mode: 'batch', batches: [], stacks: null, limits });

	expect(v.attention.map((a) => [a.item.pr_number, a.why])).toEqual([
		[1, 'Merge conflict'],
		[2, '#2 is not approved'],
		[4, 'Failed in batch 3']
	]);
	expect(nums(v.upNext)).toEqual([5]);
	expect(nums(v.rows)).toEqual([3]);
	expect(v.rows[0].position).toBe(1);
});

test('rows carry their place in a stack, and a blocking stack issue on a queued PR needs attention', () => {
	const stacks = [
		{
			root: 1,
			rows: [
				{ pr: 1, depth: 0, broken: true, issues: [] },
				{ pr: 2, depth: 1, broken: true, issues: [{ severity: 'blocking', message: '#2 was rebased away from #1' }] },
				{ pr: 3, depth: 1, broken: false, issues: [{ severity: 'warning', message: 'old base' }] }
			]
		}
	];
	const v = queueView({ items: [item(1), item(2), item(3)], mode: 'serial', batches: [], stacks, limits });

	expect(v.attention.map((a) => [a.item.pr_number, a.why])).toEqual([[2, '#2 was rebased away from #1']]);
	expect(v.rows.map((r) => [r.item.pr_number, r.stack])).toEqual([
		[1, { root: 1, parent: null, children: 2, broken: true, issues: [] }],
		[3, { root: 1, parent: 1, children: 0, broken: false, issues: [] }]
	]);
});

test('one by one keeps the queue order, the active PR in line, and has no batch preview', () => {
	const items = [item(2, { position: 2 }), item(1, { position: 1, status: 'checking' }), item(3, { position: 3, priority: 'urgent' })];
	const v = queueView({ items, mode: 'serial', batches: [{ id: 9, status: 'testing', prs: [1] }], stacks: null, limits });

	expect(nums(v.rows)).toEqual([1, 2, 3]);
	expect(v.inFlight).toEqual([]);
	expect(v.upNext).toEqual([]);
});

test('a PR that waits for PRs being tested is not shown as the next batch', () => {
	const items = [item(1, { deferred: true, error_message: 'Conflicts with #9 ahead of it; waits for them to land' }), item(2)];
	const v = queueView({ items, mode: 'batch', batches: [], stacks: null, limits });
	expect(nums(v.upNext)).toEqual([2]);
	expect(nums(v.rows)).toEqual([1]);
	expect(v.attention).toEqual([]);
});
