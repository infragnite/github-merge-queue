// What a batch card counts: its own CI jobs while it tests, or its bisection runs once it bisects,
// and which of those runs are still going (shown as cards of their own inside the batch).

import { runStatus } from './run-status';
import type { BatchCard } from './server/batch-view';

export interface BatchStats {
	prs: number;
	jobs: { done: number; total: number; failed: number; running: number; waiting: number } | null;
	runs: { total: number; passed: number; failed: number; running: number } | null;
	elapsedMs: number;
	running: BatchCard[];
}

const sqlTime = (t: string) => Date.parse(t.includes('T') ? t : t.replace(' ', 'T') + 'Z');

/** A run still going: its CI is pending, or it failed and its other jobs go on for the log. */
export function stillGoing(r: BatchCard): boolean {
	if (r.status === 'cancelled' || r.status === 'superseded') return false;
	return (r.ci === 'pending' && !r.finishedAt) || runStatus(r) === 'failing';
}

export function batchStats(b: BatchCard, now = Date.now()): BatchStats {
	const p = b.progress;
	const bisecting = b.status === 'bisecting' || b.bisection.length > 0;
	const running = b.bisection.filter(stillGoing);
	return {
		prs: b.prs.length,
		jobs: !bisecting && p ? { done: p.done, total: p.total, failed: p.failed, running: p.running, waiting: Math.max(0, p.total - p.done - p.running) } : null,
		runs: bisecting
			? {
					total: b.bisection.length,
					passed: b.bisection.filter((r) => r.status === 'landed' || r.ci === 'success').length,
					failed: b.bisection.filter((r) => r.status === 'failed' && !stillGoing(r)).length,
					running: running.length
				}
			: null,
		elapsedMs: Math.max(0, (b.finishedAt ? sqlTime(b.finishedAt) : now) - sqlTime(b.createdAt)),
		running
	};
}
