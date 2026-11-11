// One line over the running work: what runs, what prepares, and how much CI waits for runners.

import { stillGoing } from './batch-stats';
import type { WorkItem } from './running-work';
import type { BatchCard } from './server/batch-view';

export interface SummaryPart {
	label: string;
	value: number;
}

/** The CI runs of a card that are still moving: its own, or while it bisects, its steps'. */
function liveRuns(c: BatchCard): BatchCard[] {
	if (c.status === 'bisecting' || c.bisection.length > 0) return c.bisection.filter(stillGoing);
	return [c];
}

export function queueSummary(work: WorkItem[], inLine: number): SummaryPart[] {
	const runs = work.flatMap((w) => (w.kind === 'run' ? [w.card] : []));
	const batches = runs.filter((c) => c.kind === 'batch');
	const preps = work.flatMap((w) => (w.kind === 'prep' ? [w.slot] : w.kind === 'run' ? w.prep : []));
	let running = 0;
	let waiting = 0;
	for (const r of runs.flatMap(liveRuns)) {
		const p = r.progress;
		if (!p) continue;
		running += p.running;
		waiting += Math.max(0, p.total - p.done - p.running);
	}
	const n = (one: string, many: string, value: number): SummaryPart => ({ label: value === 1 ? one : many, value });
	const failedSteps = preps.filter((s) => s.state === 'failed').length;
	const parts: SummaryPart[] = [
		n('batch', 'batches', batches.length),
		{ label: 'bisecting', value: batches.filter((b) => b.status === 'bisecting').length },
		n('try run', 'try runs', runs.filter((c) => c.kind === 'try').length),
		{ label: 'preparing', value: preps.filter((s) => s.state === 'running').length },
		n('step failed', 'steps failed', failedSteps),
		n('job running', 'jobs running', running),
		n('job waiting for a runner', 'jobs waiting for a runner', waiting)
	];
	return [...parts.filter((x) => x.value > 0), { label: 'in line', value: inLine }];
}
