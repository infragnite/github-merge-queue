import { describe, expect, test } from 'vitest';
import { queueSummary } from './queue-summary';
import type { WorkItem } from './running-work';
import type { BatchCard } from './server/batch-view';

const progress = (done: number, running: number, total = 40) => ({ total, done, failed: 0, running, url: null, failedJobs: [] });
const card = (id: number, over: Partial<BatchCard>): BatchCard => ({
	id, number: id, kind: 'batch', branch: `mq/${id}`, runUrl: null, status: 'testing', express: false, ci: 'pending', headSha: `h${id}`,
	createdAt: '2026-11-11 10:00:00', finishedAt: null, context: [], landed: [], prs: [], bisection: [], progress: null, ...over
});
const run = (c: BatchCard): WorkItem => ({ kind: 'run', key: `run${c.id}`, card: c, prep: [] });
const slot = (key: string, label: string, state: 'running' | 'failed' = 'running') => ({ kind: 'prep' as const, key, slot: { key, state, batch: null, label, branch: null, detail: '', prs: [], urgent: false } });

describe('the one-line summary over the running work', () => {
	test('counts batches, bisections, try runs, preparation and jobs waiting for a runner, across nested runs', () => {
		const b1 = card(1, { progress: progress(20, 8) });
		const b2 = card(2, { status: 'bisecting', ci: 'failure', progress: progress(40, 0), bisection: [card(10, { kind: 'bisect', progress: progress(10, 8) })] });
		const t = card(3, { kind: 'try', progress: progress(0, 4) });
		expect(queueSummary([slot('activity', 'Forming a batch'), run(b1), run(b2), run(t)], 6)).toEqual([
			{ label: 'batches', value: 2 },
			{ label: 'bisecting', value: 1 },
			{ label: 'try run', value: 1 },
			{ label: 'preparing', value: 1 },
			{ label: 'jobs running', value: 20 },
			{ label: 'jobs waiting for a runner', value: 70 },
			{ label: 'in line', value: 6 }
		]);
	});

	test('labels agree with their number', () => {
		const t = (id: number) => run(card(id, { kind: 'try' }));
		expect(queueSummary([run(card(1, {})), t(2), t(3)], 1)).toEqual([
			{ label: 'batch', value: 1 },
			{ label: 'try runs', value: 2 },
			{ label: 'in line', value: 1 }
		]);
	});

	test('a failed preparation step is counted apart; zeros are left out, but the line always says how many wait', () => {
		expect(queueSummary([slot('failure', 'Forming a batch failed', 'failed')], 0)).toEqual([
			{ label: 'step failed', value: 1 },
			{ label: 'in line', value: 0 }
		]);
	});
});
