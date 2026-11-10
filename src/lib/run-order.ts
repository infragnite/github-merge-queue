// The order the queue runs CI in, apart from the batches it runs for: what holds the runners now,
// then what runs next. Batches and the queue are separate: an urgent batch can run between two
// steps of a bisection, which is planned again from its runs on whatever master is current.

import type { BatchCard } from './server/batch-view';

export interface RunSlot {
	key: string;
	state: 'running' | 'next';
	/** The batch the run belongs to, for a link to its card. */
	batch: number | null;
	label: string;
	detail: string;
	prs: number[];
	urgent: boolean;
}

/** Unresolved PRs of a bisecting batch: neither landed, ejected nor back in line. */
function unresolved(b: BatchCard) {
	return b.prs.filter((p) => p.verdict !== 'failing' && p.activity !== 'landed' && p.activity !== 'left');
}

export function runOrder(input: { active: BatchCard[]; upNext: number[]; express: boolean }): RunSlot[] {
	const running: RunSlot[] = [];
	const next: RunSlot[] = [];
	// An urgent batch bisecting between two steps of another bisection goes on first.
	const bisecting = input.active.filter((b) => b.kind === 'batch' && b.status === 'bisecting').sort((a, b) => Number(b.express) - Number(a.express));
	for (const b of input.active) {
		if (b.kind !== 'batch') continue;
		const name = `${b.express ? 'Urgent batch' : 'Batch'} #${b.id}`;
		if (b.status === 'testing' || b.status === 'retrying') {
			const prs = b.prs.map((p) => p.pr);
			running.push({ key: `b${b.id}`, state: 'running', batch: b.id, label: name, detail: b.status === 'retrying' ? 're-running failed jobs' : `${prs.length} PR${prs.length === 1 ? '' : 's'}`, prs, urgent: b.express });
		} else if (b.status === 'passed') {
			running.push({ key: `b${b.id}`, state: 'running', batch: b.id, label: name, detail: 'passed, waiting to land', prs: b.prs.map((p) => p.pr), urgent: b.express });
		} else if (b.status === 'bisecting') {
			b.bisection.forEach((r, i) => {
				if (r.ci !== 'pending' || r.status === 'cancelled' || r.status === 'superseded') return;
				const prs = r.prs.map((p) => p.pr);
				running.push({ key: `r${r.id}`, state: 'running', batch: b.id, label: `${name}, bisection step ${i + 1}`, detail: prs.length === 1 ? `#${prs[0]} alone` : `${prs.length} PRs`, prs, urgent: b.express });
			});
		}
	}
	if (input.express && input.upNext.length) {
		next.push({
			key: 'urgent',
			state: 'next',
			batch: null,
			label: 'Urgent batch',
			detail: bisecting.length ? 'before the next bisection step' : 'ahead of the rest of the queue',
			prs: input.upNext,
			urgent: true
		});
	}
	for (const b of bisecting) {
		const open = unresolved(b).filter((p) => p.activity !== 'checking');
		if (!open.length) continue;
		next.push({
			key: `n${b.id}`,
			state: 'next',
			batch: b.id,
			label: `${b.express ? 'Urgent batch' : 'Batch'} #${b.id}, next bisection step`,
			detail: `${open.length} PR${open.length === 1 ? '' : 's'} still to settle`,
			prs: open.map((p) => p.pr),
			urgent: b.express
		});
	}
	if (!input.express && input.upNext.length) {
		next.push({
			key: 'next',
			state: 'next',
			batch: null,
			label: 'Next batch',
			detail: bisecting.length ? 'once the bisection is done' : `${input.upNext.length} PR${input.upNext.length === 1 ? '' : 's'}`,
			prs: input.upNext,
			urgent: false
		});
	}
	return [...running, ...next];
}
