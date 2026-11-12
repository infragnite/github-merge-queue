import { describe, expect, test } from 'vitest';
import { batchStats } from './batch-stats';
import type { BatchCard, BatchPR } from './server/batch-view';

const pr = (n: number, extra: Partial<BatchPR> = {}): BatchPR => ({ pr: n, title: '', url: '', depth: 0, parent: null, link: null, ...extra });
const progress = (done: number, failed: number, running: number, total = 40) => ({ total, done, failed, running, url: null, failedJobs: ['lint'] });
const card = (id: number, over: Partial<BatchCard>): BatchCard => ({
	id, number: id, kind: 'batch', branch: `mq/${id}`, runUrl: null, status: 'testing', express: false, ci: 'pending', headSha: `h${id}`,
	createdAt: '2026-11-11 10:00:00', finishedAt: null, context: [], landed: [], prs: [], bisection: [], progress: null, ...over
});

describe('what a batch card counts', () => {
	test('a testing batch counts its CI jobs: done, failed, running, waiting for a runner', () => {
		const s = batchStats(card(1, { prs: [pr(1), pr(2)], progress: progress(20, 1, 8) }), Date.parse('2026-11-11T10:25:00Z'));
		expect(s).toEqual({ prs: 2, jobs: { done: 20, total: 40, failed: 1, running: 8, waiting: 12 }, runs: null, elapsedMs: 25 * 60_000, running: [] });
	});

	test('a bisecting batch counts its runs, and lists the ones still going (failing ones too) as its running cards', () => {
		const runs = [
			card(10, { kind: 'bisect', status: 'landed', ci: 'success', finishedAt: '2026-11-11 10:40:00' }),
			card(11, { kind: 'bisect', status: 'failed', ci: 'failure', finishedAt: '2026-11-11 10:41:00', prs: [pr(3)], progress: progress(40, 2, 0) }),
			card(12, { kind: 'bisect', status: 'testing', ci: 'pending', prs: [pr(4)] }),
			card(13, { kind: 'bisect', status: 'failed', ci: 'failure', finishedAt: '2026-11-11 10:50:00', prs: [pr(5)], progress: progress(12, 1, 20) }),
			card(14, { kind: 'bisect', status: 'cancelled', ci: 'pending' }),
			card(15, { kind: 'bisect', status: 'superseded', ci: 'pending' })
		];
		const s = batchStats(card(1, { status: 'bisecting', ci: 'failure', prs: [pr(3), pr(4), pr(5)], bisection: runs, progress: progress(40, 3, 0) }), Date.parse('2026-11-11T11:00:00Z'));
		expect(s.jobs).toBeNull();
		expect(s.runs).toEqual({ total: 6, passed: 1, failed: 1, running: 2 });
		expect(s.running.map((r) => r.id)).toEqual([12, 13]);
	});

	test('a finished batch counts the time it took', () => {
		expect(batchStats(card(1, { status: 'landed', ci: 'success', finishedAt: '2026-11-11 10:30:00' }), Date.parse('2026-11-11T12:00:00Z')).elapsedMs).toBe(30 * 60_000);
	});
});
