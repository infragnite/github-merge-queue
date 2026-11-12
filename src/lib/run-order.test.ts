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
	test('a running batch or bisection step names the branch its CI runs on, for a link to its Actions runs', () => {
		const b = card(13, { status: 'bisecting', prs: [pr(2, { verdict: 'unknown', activity: 'checking' })], bisection: [card(21, { kind: 'bisect', ci: 'pending', prs: [pr(2)] })] });
		const t = card(14, { prs: [pr(7)] });
		expect(runOrder({ active: [b, t], upNext: [9], express: true }).map((s) => [s.label, s.branch])).toEqual([
			['Batch #13, bisection step 1', 'mq/21'],
			['Batch #14', 'mq/14'],
			['Urgent batch', null]
		]);
	});

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
	test('the check of the default branch is a run of its own while it goes, and an ejection waiting for it says so', () => {
		const since = Date.parse('2026-11-10T17:03:00Z');
		const b8 = card(8, {
			status: 'bisecting',
			prs: [pr(3241, { verdict: 'unknown', awaitingEject: true }), pr(3309, { verdict: 'unknown' }), pr(3364, { verdict: 'passing', activity: 'landed', settled: true })],
			bisection: []
		});
		const rows = runOrder({ active: [b8], upNext: [], express: false, master: { sha: '9db284a0c0ffee', state: 'verifying', since, branch: 'master' }, now: since + 25 * 60_000 });
		expect(rows).toEqual([
			{ key: 'master', state: 'running', batch: null, label: 'Check of master', branch: 'master', detail: '9db284a, running 25 min; ejections wait for it', prs: [], urgent: false },
			{ key: 'e8', state: 'next', batch: 8, label: 'Batch #8: eject #3241', branch: null, detail: 'waits for the check of master 9db284a', prs: [3241], urgent: false },
			{ key: 'n8', state: 'next', batch: 8, label: 'Batch #8, next bisection step', branch: null, detail: '1 PR still to settle', prs: [3309], urgent: false }
		]);
	});

	test('a check of a commit pushed outside the queue runs on its baseline branch; a green or red default branch is no run', () => {
		const since = Date.parse('2026-11-10T17:03:00Z');
		const base = card(30, { kind: 'baseline', branch: 'mq/base-1', ci: 'pending' });
		expect(runOrder({ active: [base], upNext: [], express: false, master: { sha: 'abc1234ff', state: 'checking', since, branch: 'master' }, now: since + 90 * 60_000 })[0]).toEqual({
			key: 'master',
			state: 'running',
			batch: null,
			label: 'Check of master',
			branch: 'mq/base-1',
			detail: 'abc1234, pushed outside the queue, running 1 h 30 min; ejections wait for it',
			prs: [],
			urgent: false
		});
		for (const state of ['green', 'red'])
			expect(runOrder({ active: [], upNext: [], express: false, master: { sha: 'abc1234ff', state, since, branch: 'master' }, now: since })).toEqual([]);
	});
});

describe('runOrder: what the queue is doing now', () => {
	const at = Date.parse('2026-11-10T22:40:00Z');
	const idle = { since: null, phase: null, step: null, failure: null };

	test('forming a batch goes first, with its PRs, the step running and how long the batch has been forming', () => {
		const b = card(4, { prs: [pr(9)] });
		const activity = {
			since: at,
			phase: { kind: 'forming' as const, label: 'Forming a batch', prs: [1, 2, 3], branch: 'mq/batch-5', since: at },
			step: { label: 'pushing mq/batch-5', prs: [1, 2, 3], since: at + 40_000 },
			failure: null
		};
		expect(runOrder({ active: [b], upNext: [], express: false, activity, now: at + 72_000 })).toEqual([
			{ key: 'activity', state: 'running', batch: null, label: 'Forming a batch', branch: null, detail: 'pushing mq/batch-5, 1 min 12 s', prs: [1, 2, 3], urgent: false },
			{ key: 'b4', state: 'running', batch: 4, label: 'Batch #4', branch: 'mq/4', detail: '1 PR', prs: [9], urgent: false }
		]);
	});

	test('under a minute it counts seconds; between steps it says what it is doing', () => {
		const activity = { since: at, phase: { kind: 'restack' as const, label: 'Restacking #4', prs: [4], branch: null, since: at }, step: null, failure: null };
		expect(runOrder({ active: [], upNext: [], express: false, activity, now: at + 8_400 })).toEqual([
			{ key: 'activity', state: 'running', batch: null, label: 'Restacking #4', branch: null, detail: '8 s', prs: [4], urgent: false }
		]);
	});

	test('a routine pass over the queue shows only once it has run for 10 seconds, with the step it is on', () => {
		const activity = { since: at, phase: null, step: { label: 'reading the reviews and checks of #12', prs: [12], since: at + 9_000 }, failure: null };
		expect(runOrder({ active: [], upNext: [], express: false, activity, now: at + 9_999 })).toEqual([]);
		expect(runOrder({ active: [], upNext: [], express: false, activity, now: at + 14_000 })).toEqual([
			{ key: 'activity', state: 'running', batch: null, label: 'Updating the queue', branch: null, detail: 'reading the reviews and checks of #12, 14 s', prs: [12], urgent: false }
		]);
	});

	const GRANT = "Grant the GitHub App the Workflows (read and write) permission, then approve it on this account's installation";

	test('a failed step is shown first, with its PRs, the step, what to do and when', () => {
		const failure = { phase: 'Forming a batch', step: 'pushing mq/batch-5', prs: [1, 2], action: GRANT, at };
		const rows = runOrder({ active: [card(4, { prs: [pr(9)] })], upNext: [], express: false, activity: { ...idle, failure }, now: at + 5 * 60_000 });
		expect(rows[0]).toEqual({
			key: 'failure',
			state: 'failed',
			batch: null,
			label: 'Forming a batch failed',
			branch: null,
			detail: `pushing mq/batch-5: ${GRANT} (5 min ago)`,
			prs: [1, 2],
			urgent: false
		});
		expect(rows.map((r) => r.key)).toEqual(['failure', 'b4']);
	});

	test('a failed step outside a batch is named by the step', () => {
		const failure = { phase: null, step: 'pointing #3 at main', prs: [3], action: GRANT, at };
		expect(runOrder({ active: [], upNext: [], express: false, activity: { ...idle, failure }, now: at + 20_000 })[0]).toMatchObject({ label: 'Pointing #3 at main failed', detail: `${GRANT} (just now)` });
	});

	test('a failure and the retry of it both show while the retry runs', () => {
		const failure = { phase: 'Forming a batch', step: 'pushing mq/batch-5', prs: [1], action: GRANT, at };
		const activity = { since: at + 60_000, phase: { kind: 'forming' as const, label: 'Forming a batch', prs: [1], branch: null, since: at + 60_000 }, step: { label: 'merging #1', prs: [1], since: at + 60_000 }, failure };
		expect(runOrder({ active: [], upNext: [], express: false, activity, now: at + 61_000 }).map((r) => [r.key, r.state])).toEqual([
			['failure', 'failed'],
			['activity', 'running']
		]);
	});

	test('without what to do (the public page), a failed step says only what failed and when', () => {
		const failure = { phase: 'Forming a batch', step: 'pushing mq/batch-5', prs: [1], action: null, at };
		expect(runOrder({ active: [], upNext: [], express: false, activity: { ...idle, failure }, now: at + 120_000 })[0]).toMatchObject({ label: 'Forming a batch failed', detail: 'pushing mq/batch-5 (2 min ago)' });
	});

	test('nothing running and nothing failed adds nothing', () => {
		expect(runOrder({ active: [], upNext: [], express: false, activity: idle, now: at })).toEqual([]);
	});
});
