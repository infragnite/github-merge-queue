// One line of state per repository for the dashboard: whether its queue is moving, how it
// merges, and how many PRs need someone. Built from the database only (no GitHub calls), so the
// dashboard stays cheap however many repositories it lists.

import { getQueueItems } from './db';
import { currentHold, deferredFor, getActiveBatches, getMasterHealth, getQueueSettings } from './batch-store';
import { queueView, type ViewItem } from '../queue-view';
import type { QueueItem } from '../types';

/** paused and red stop the queue (or slow it), so they win over running. */
export type RepoState = 'paused' | 'red' | 'running' | 'waiting' | 'idle';

export interface RepoSummary {
	state: RepoState;
	/** Why it is paused, for signed-in users who can read the repository. */
	paused: string | null;
	mode: 'serial' | 'batch';
	/** The mode as the queue page's header shows it. */
	modeLabel: string;
	/** PRs being tested now. */
	testing: number;
	/** PRs in line, not yet tested and not needing anyone. */
	waiting: number;
	/** PRs someone has to look at: failed, in conflict, or held back for a reason only a person can fix. */
	attention: number;
}

type Inputs = {
	items: QueueItem[];
	mode: 'serial' | 'batch';
	maxBatch: number;
	expressMax: number;
	paused: string | null;
	masterRed: boolean;
	/** PRs of each batch in flight that are still being tested (not landed or left). */
	batches: Array<{ id: number; status: string; prs: number[] }>;
};

const TESTING_ONE_BY_ONE = new Set(['updating', 'checking', 'merging']);

/** The summary from what was read; pure, so it can be tested without a database. */
export function summarize(input: Inputs): RepoSummary {
	const items: ViewItem[] = input.items.map((i) => ({
		...i,
		holdWait: currentHold(i as QueueItem & { hold?: string | null })?.wait ?? null,
		deferred: deferredFor(i as QueueItem & { deferred_for?: string | null }).length > 0
	}));
	// Stack issues need GitHub, so they are left out here; the queue page shows them.
	const view = queueView({ items, mode: input.mode, batches: input.batches, stacks: null, limits: { maxBatch: input.maxBatch, expressMax: input.expressMax } });
	const inLine = [...view.upNext, ...view.rows];
	const testing =
		input.mode === 'batch'
			? view.inFlight.reduce((n, g) => n + g.prs.length, 0)
			: inLine.filter((r) => TESTING_ONE_BY_ONE.has(r.item.status)).length;
	const waiting = inLine.length - (input.mode === 'batch' ? 0 : testing);
	const state: RepoState = input.paused !== null ? 'paused' : input.masterRed ? 'red' : testing > 0 ? 'running' : waiting > 0 ? 'waiting' : 'idle';
	return {
		state,
		paused: input.paused,
		mode: input.mode,
		modeLabel: input.mode === 'batch' ? `Batches of up to ${input.maxBatch}` : 'One by one',
		testing,
		waiting,
		attention: view.attention.length
	};
}

export function repoSummary(repoId: number): RepoSummary {
	const settings = getQueueSettings(repoId);
	const mode = settings.mode === 'batch' ? 'batch' : 'serial';
	return summarize({
		items: getQueueItems(repoId),
		mode,
		maxBatch: settings.config.maxBatch,
		expressMax: settings.config.expressMax,
		paused: settings.pausedReason,
		masterRed: getMasterHealth(repoId)?.state === 'red',
		// As the queue page counts them: a batch's PRs that haven't landed or left.
		batches:
			mode === 'batch'
				? getActiveBatches(repoId).map((b) => ({
						id: b.id,
						status: b.status,
						prs: b.members.filter((n) => !b.landed.includes(n) && !b.left_prs.includes(n))
					}))
				: []
	});
}
