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
	/** The branch its CI runs on, while it runs; null for what comes next. */
	branch: string | null;
	detail: string;
	prs: number[];
	urgent: boolean;
}

/** Unresolved PRs of a bisecting batch: neither landed, ejected (or about to be) nor back in line. */
function unresolved(b: BatchCard) {
	return b.prs.filter((p) => p.verdict !== 'failing' && !p.awaitingEject && p.activity !== 'landed' && p.activity !== 'left');
}

/** The default branch's health, as the queue records it. `since` is in ms. */
export interface MasterRun {
	sha: string;
	state: string;
	since: number;
	/** The default branch's name. */
	branch: string;
}

const minutes = (ms: number) => {
	const m = Math.max(0, Math.round(ms / 60_000));
	return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

export function runOrder(input: { active: BatchCard[]; upNext: number[]; express: boolean; master?: MasterRun | null; now?: number }): RunSlot[] {
	const running: RunSlot[] = [];
	const next: RunSlot[] = [];
	// While the default branch is checked, nobody is ejected: its check is what they wait for.
	const m = input.master;
	const checking = m && (m.state === 'verifying' || m.state === 'checking') ? m : null;
	if (checking) {
		const sha = checking.sha.slice(0, 7);
		const baseline = input.active.find((b) => b.kind === 'baseline' && b.ci === 'pending');
		running.push({
			key: 'master',
			state: 'running',
			batch: null,
			label: `Check of ${checking.branch}`,
			branch: checking.state === 'checking' ? (baseline?.branch ?? null) : checking.branch,
			detail: `${sha}${checking.state === 'checking' ? ', pushed outside the queue' : ''}, running ${minutes((input.now ?? Date.now()) - checking.since)}; ejections wait for it`,
			prs: [],
			urgent: false
		});
	}
	// An urgent batch bisecting between two steps of another bisection goes on first.
	const bisecting = input.active.filter((b) => b.kind === 'batch' && b.status === 'bisecting').sort((a, b) => Number(b.express) - Number(a.express));
	for (const b of input.active) {
		if (b.kind !== 'batch') continue;
		const name = `${b.express ? 'Urgent batch' : 'Batch'} #${b.number}`;
		if (b.status === 'testing' || b.status === 'retrying') {
			const prs = b.prs.map((p) => p.pr);
			running.push({ key: `b${b.id}`, state: 'running', batch: b.id, label: name, branch: b.branch, detail: b.status === 'retrying' ? 're-running failed jobs' : `${prs.length} PR${prs.length === 1 ? '' : 's'}`, prs, urgent: b.express });
		} else if (b.status === 'passed') {
			running.push({ key: `b${b.id}`, state: 'running', batch: b.id, label: name, branch: b.branch, detail: 'passed, landing', prs: b.prs.map((p) => p.pr), urgent: b.express });
		} else if (b.status === 'bisecting') {
			b.bisection.forEach((r, i) => {
				if (r.ci !== 'pending' || r.status === 'cancelled' || r.status === 'superseded') return;
				const prs = r.prs.map((p) => p.pr);
				running.push({ key: `r${r.id}`, state: 'running', batch: b.id, label: `${name}, bisection step ${i + 1}`, branch: r.branch, detail: prs.length === 1 ? `#${prs[0]} alone` : `${prs.length} PRs`, prs, urgent: b.express });
			});
		}
	}
	if (input.express && input.upNext.length) {
		next.push({
			key: 'urgent',
			state: 'next',
			batch: null,
			label: 'Urgent batch',
			branch: null,
			detail: bisecting.length ? 'before the next bisection step' : 'ahead of the rest of the queue',
			prs: input.upNext,
			urgent: true
		});
	}
	for (const b of bisecting) {
		const failing = b.prs.filter((p) => p.awaitingEject);
		if (checking && failing.length)
			next.push({
				key: `e${b.id}`,
				state: 'next',
				batch: b.id,
				label: `${b.express ? 'Urgent batch' : 'Batch'} #${b.number}: eject ${failing.map((p) => `#${p.pr}`).join(' ')}`,
				branch: null,
				detail: `waits for the check of ${checking.branch} ${checking.sha.slice(0, 7)}`,
				prs: failing.map((p) => p.pr),
				urgent: b.express
			});
		const open = unresolved(b).filter((p) => p.activity !== 'checking');
		if (!open.length) continue;
		next.push({
			key: `n${b.id}`,
			state: 'next',
			batch: b.id,
			label: `${b.express ? 'Urgent batch' : 'Batch'} #${b.number}, next bisection step`,
			branch: null,
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
			branch: null,
			detail: bisecting.length ? 'once the bisection is done' : `${input.upNext.length} PR${input.upNext.length === 1 ? '' : 's'}`,
			prs: input.upNext,
			urgent: false
		});
	}
	return [...running, ...next];
}
