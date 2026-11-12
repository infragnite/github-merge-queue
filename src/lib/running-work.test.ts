import { describe, expect, test } from 'vitest';
import { runningWork } from './running-work';
import type { BatchCard, BatchPR } from './server/batch-view';
import type { ActivityView } from './server/activity';

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
const at = Date.parse('2026-11-11T18:00:00Z');
const idle: ActivityView = { since: null, phase: null, step: null, failure: null };
const keys = (w: ReturnType<typeof runningWork>) => w.map((x) => x.key);

describe('running work, in the order it holds the runners', () => {
	test('urgent batches first, then batches by number, then tries', () => {
		const active = [card(3, { kind: 'try', prs: [pr(30)] }), card(5, { prs: [pr(1)] }), card(4, { prs: [pr(2)] }), card(6, { express: true, prs: [pr(3)] })];
		expect(keys(runningWork({ active, activity: idle, now: at }))).toEqual(['run6', 'run4', 'run5', 'run3']);
	});

	test('a batch that has finished its runs but is still on the page (passed, landing) stays in the list', () => {
		const active = [card(4, { status: 'passed', ci: 'success', prs: [pr(2)] })];
		expect(keys(runningWork({ active, activity: idle, now: at }))).toEqual(['run4']);
	});

	test('forming a batch is preparation: it goes on top of every run, with its step and how long it has taken', () => {
		const activity: ActivityView = {
			since: at,
			phase: { kind: 'forming', label: 'Forming a batch', prs: [7, 8], branch: null, since: at },
			step: { label: 'merging #7 #8', prs: [7, 8], since: at },
			failure: null
		};
		const w = runningWork({ active: [card(6, { express: true, prs: [pr(3)] })], activity, now: at + 30_000 });
		expect(keys(w)).toEqual(['activity', 'run6']);
		expect(w[0]).toMatchObject({ kind: 'prep', slot: { label: 'Forming a batch', detail: 'merging #7 #8, 30 s', prs: [7, 8] } });
	});

	test('a failed preparation step goes on top too, before the retry of it', () => {
		const failure = { phase: 'Forming a batch', step: 'pushing mq/batch-5', prs: [1], action: 'Grant it', at };
		const activity: ActivityView = { since: at, phase: { kind: 'forming', label: 'Forming a batch', prs: [1], branch: null, since: at }, step: null, failure };
		expect(keys(runningWork({ active: [card(4, { prs: [pr(2)] })], activity, now: at + 1000 }))).toEqual(['failure', 'activity', 'run4']);
	});

	test('preparing a bisection step goes on top inside its batch; the batch keeps its place, so cards never jump', () => {
		const b13 = card(13, { status: 'bisecting', ci: 'failure', prs: [pr(1, { verdict: 'unknown' }), pr(2, { verdict: 'unknown' })] });
		const u14 = card(14, { express: true, prs: [pr(9)] });
		const activity: ActivityView = {
			since: at,
			phase: { kind: 'bisect', label: 'Preparing a bisection step', prs: [1], branch: null, since: at },
			step: { label: 'merging #1', prs: [1], since: at },
			failure: null
		};
		const w = runningWork({ active: [b13, u14], activity, now: at + 5000 });
		expect(keys(w)).toEqual(['run14', 'run13']);
		expect(w[1]).toMatchObject({ kind: 'run', prep: [{ label: 'Preparing a bisection step', detail: 'merging #1, 5 s', prs: [1] }] });
		expect(w[0]).toMatchObject({ kind: 'run', prep: [] });
	});

	test('a failed bisection step preparation shows inside its batch too', () => {
		const b13 = card(13, { status: 'bisecting', ci: 'failure', prs: [pr(1, { verdict: 'unknown' }), pr(2, { verdict: 'unknown' })] });
		const failure = { phase: 'Preparing a bisection step', step: 'merging #2', prs: [2], action: 'Grant it', at };
		const w = runningWork({ active: [card(12, { prs: [pr(5)] }), b13], activity: { ...idle, failure }, now: at + 1000 });
		expect(keys(w)).toEqual(['run12', 'run13']);
		expect(w[1]).toMatchObject({ prep: [{ key: 'failure', state: 'failed', label: 'Preparing a bisection step failed' }] });
	});

	test('preparing a bisection step no batch carries stays on its own', () => {
		const activity: ActivityView = { since: at, phase: { kind: 'bisect', label: 'Preparing a bisection step', prs: [99], branch: null, since: at }, step: null, failure: null };
		expect(keys(runningWork({ active: [card(4, { prs: [pr(2)] })], activity, now: at }))).toEqual(['activity', 'run4']);
	});

	test('landing goes inside the batch it lands', () => {
		const b4 = card(4, { status: 'passed', ci: 'success', prs: [pr(2), pr(3)] });
		const activity: ActivityView = { since: at, phase: { kind: 'landing', label: 'Landing', prs: [2, 3], branch: null, since: at }, step: { label: 'merging #2 into master', prs: [2], since: at }, failure: null };
		const w = runningWork({ active: [card(3, { prs: [pr(1)] }), b4], activity, now: at });
		expect(keys(w)).toEqual(['run3', 'run4']);
		expect(w[1]).toMatchObject({ prep: [{ label: 'Landing' }] });
	});

	test('the check of the default branch after a landing is a run of its own, after the preparation', () => {
		const since = at - 10 * 60_000;
		const activity: ActivityView = { since: at, phase: { kind: 'forming', label: 'Forming a batch', prs: [7], branch: null, since: at }, step: null, failure: null };
		const w = runningWork({ active: [card(4, { prs: [pr(2)] })], master: { sha: 'abc1234ff', state: 'verifying', since, branch: 'master' }, activity, now: at });
		expect(keys(w)).toEqual(['activity', 'master', 'run4']);
		expect(w[1]).toMatchObject({ kind: 'master', slot: { label: 'Check of master' } });
	});

	test('a check of a commit pushed outside the queue is its baseline run, shown once, before the batches', () => {
		const base = card(30, { kind: 'baseline', branch: 'mq/base-1', ci: 'pending' });
		const w = runningWork({ active: [card(4, { prs: [pr(2)] }), base], master: { sha: 'abc1234ff', state: 'checking', since: at, branch: 'master' }, activity: idle, now: at });
		expect(keys(w)).toEqual(['run30', 'run4']);
	});

	test('nothing running: nothing to show', () => {
		expect(runningWork({ active: [], activity: idle, now: at })).toEqual([]);
		expect(runningWork({ active: [], master: { sha: 'a', state: 'green', since: at, branch: 'master' }, activity: null, now: at })).toEqual([]);
	});
});
