import { describe, expect, test } from 'vitest';
import { runOrder } from './run-order';
import type { BatchCard, BatchPR } from './server/batch-view';

const pr = (n: number, extra: Partial<BatchPR> = {}): BatchPR => ({ pr: n, title: '', url: '', depth: 0, parent: null, link: null, ...extra });
const card = (id: number, over: Partial<BatchCard>): BatchCard => ({
	id,
	number: id,
	kind: 'batch',
	branch: `mq/${id}`,
	status: 'testing',
	express: false,
	ci: 'pending',
	headSha: `h${id}`,
	createdAt: '2026-11-10 08:00:00',
	finishedAt: null,
	context: [],
	landed: [],
	prs: [],
	bisection: [],
	progress: null,
	...over
});

describe('runOrder', () => {
	test('a bisection with its step running, urgent PRs waiting: the urgent batch goes before the next step', () => {
		const b = card(13, {
			status: 'bisecting',
			prs: [
				pr(1, { verdict: 'passing', activity: 'landed' }),
				pr(2, { verdict: 'unknown', activity: 'checking' }),
				pr(3, { verdict: 'passing', activity: null }),
				pr(4, { verdict: 'unknown', activity: null }),
				pr(5, { verdict: 'failing', activity: null })
			],
			bisection: [card(20, { kind: 'bisect', status: 'landed', ci: 'success', prs: [pr(1)] }), card(21, { kind: 'bisect', ci: 'pending', prs: [pr(2)] })]
		});
		expect(runOrder({ active: [b], upNext: [9], express: true }).map((s) => [s.state, s.label, s.detail, s.prs])).toEqual([
			['running', 'Batch #13, bisection step 2', '#2 alone', [2]],
			['next', 'Urgent batch', 'before the next bisection step', [9]],
			['next', 'Batch #13, next bisection step', '2 PRs still to settle', [3, 4]]
		]);
	});

	test('an urgent batch running between two steps holds the runners; a normal batch waits for the bisection', () => {
		const b = card(13, { status: 'bisecting', prs: [pr(1, { verdict: 'unknown', activity: null })] });
		const u = card(14, { express: true, prs: [pr(9)] });
		expect(runOrder({ active: [b, u], upNext: [7, 8], express: false }).map((s) => [s.state, s.label, s.detail])).toEqual([
			['running', 'Urgent batch #14', '1 PR'],
			['next', 'Batch #13, next bisection step', '1 PR still to settle'],
			['next', 'Next batch', 'once the bisection is done']
		]);
	});

	test('an urgent batch bisecting between two steps of another goes on first', () => {
		const b = card(13, { status: 'bisecting', prs: [pr(1, { verdict: 'unknown', activity: null })] });
		const u = card(14, { status: 'bisecting', express: true, prs: [pr(8, { verdict: 'unknown', activity: null }), pr(9, { verdict: 'passing', activity: 'landed' })] });
		expect(runOrder({ active: [b, u], upNext: [], express: false }).map((s) => s.label)).toEqual(['Urgent batch #14, next bisection step', 'Batch #13, next bisection step']);
	});

	test('a pipeline without a bisection: the batches testing, then the next one', () => {
		expect(runOrder({ active: [card(1, { prs: [pr(1), pr(2)] }), card(2, { status: 'passed', ci: 'success', prs: [pr(3)] })], upNext: [4], express: false }).map((s) => [s.state, s.label, s.detail])).toEqual([
			['running', 'Batch #1', '2 PRs'],
			['running', 'Batch #2', 'passed, landing'],
			['next', 'Next batch', '1 PR']
		]);
	});
});
