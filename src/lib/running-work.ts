// What the queue page shows on top: everything running now, in the order it holds the runners.
// The queue's own preparation (forming a batch, a failed step) goes first; preparing a bisection
// step or landing goes inside the batch it is for, and that batch goes first too. Then the check
// of the default branch, urgent batches, batches by number, and try runs.

import { runOrder, type MasterRun, type RunSlot } from './run-order';
import type { BatchCard } from './server/batch-view';
import type { ActivityView } from './server/activity';

export type WorkItem =
	| { kind: 'prep'; key: string; slot: RunSlot }
	| { kind: 'master'; key: string; slot: RunSlot }
	| { kind: 'run'; key: string; card: BatchCard; prep: RunSlot[] };

/** Phases that work on a batch already running, by the label activity gives them. */
const IN_BATCH: Record<string, (b: BatchCard) => boolean> = {
	'Preparing a bisection step': (b) => b.kind === 'batch' && b.status === 'bisecting',
	Landing: (b) => b.kind === 'batch' && (b.status === 'passed' || b.status === 'bisecting')
};

function rank(b: BatchCard): number {
	if (b.kind === 'baseline') return 0;
	if (b.kind === 'batch') return b.express ? 1 : 2;
	return 3;
}

export function runningWork(input: { active: BatchCard[]; master?: MasterRun | null; activity?: ActivityView | null; now?: number }): WorkItem[] {
	const now = input.now ?? Date.now();
	const baselines = input.active.filter((b) => b.kind === 'baseline');
	const slots = runOrder({ active: baselines, upNext: [], express: false, master: input.master ?? null, activity: input.activity ?? null, now });
	const a = input.activity;

	// Which batch a slot of the queue's own work is for, if it works on one already running.
	const owner = (slot: RunSlot): BatchCard | null => {
		const label = slot.key === 'failure' ? a?.failure?.phase : slot.key === 'activity' ? a?.phase?.label : null;
		const fits = label ? IN_BATCH[label] : undefined;
		if (!fits || slot.prs.length === 0) return null;
		return input.active.find((b) => fits(b) && b.prs.some((p) => slot.prs.includes(p.pr))) ?? null;
	};

	const prepOf = new Map<number, RunSlot[]>();
	const own: WorkItem[] = [];
	let master: WorkItem | null = null;
	for (const slot of slots) {
		if (slot.key === 'master') {
			// A check of a commit pushed outside the queue is its baseline run's card.
			if (!(input.master?.state === 'checking' && baselines.length)) master = { kind: 'master', key: 'master', slot };
			continue;
		}
		const b = owner(slot);
		if (b) prepOf.set(b.id, [...(prepOf.get(b.id) ?? []), slot]);
		else own.push({ kind: 'prep', key: slot.key, slot });
	}

	const runs = [...input.active].sort((x, y) => rank(x) - rank(y) || x.number - y.number).map((card): WorkItem => ({ kind: 'run', key: `run${card.id}`, card, prep: prepOf.get(card.id) ?? [] }));
	const preparing = runs.filter((r) => r.kind === 'run' && r.prep.length > 0);
	const rest = runs.filter((r) => r.kind === 'run' && r.prep.length === 0);
	return [...own, ...preparing, ...(master ? [master] : []), ...rest];
}
