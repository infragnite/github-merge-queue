// One line of state per repository for the dashboard: whether its queue is moving, how it
// merges, and how many PRs need someone. Built from the database only (no GitHub calls), so the
// dashboard stays cheap however many repositories it lists.

import { getQueueItems } from './db';
import { getActiveBatches, getMasterHealth, getQueueSettings, trySlotsInUse, getQueuedTries, getRunningBaseline } from './batch-store';
import { boardItem } from './api-service';
import { dashboardStackAnalysis } from './stack-runtime';
import type { Repo } from '../types';
import { queueBoard, type BoardItem } from './queue-model';
import type { StackAnalysis } from './stacks';

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
	triesRunning: number;
	triesWaiting: number;
	baselineRunning: boolean;
	/** PRs in line, not yet tested and not needing anyone. */
	waiting: number;
	/** PRs someone has to look at: failed, in conflict, or held for a reason only a person can fix. */
	attention: number;
}

type Inputs = {
	items: BoardItem[];
	mode: 'serial' | 'batch';
	maxBatch: number;
	paused: string | null;
	masterRed: boolean;
	/** Batch mode: the PRs of the batches in flight that are still in them (not landed or left). */
	inflight: number[];
	triesRunning?: number;
	triesWaiting?: number;
	baselineRunning?: boolean;
	/** The queue page's last stack analysis, when there is one: PRs stacked on a held one need attention too. */
	analysis?: StackAnalysis | null;
};

const TESTING_ONE_BY_ONE = new Set<BoardItem['status']>(['updating', 'checking', 'merging']);
// Before the queue page has analysed the stacks, every PR counts as a stack of its own.
const NO_STACKS: StackAnalysis = { prs: new Map(), stacks: [], issues: [] };

/** The summary from what was read; pure, so it can be tested without a database. */
export function summarize(input: Inputs): RepoSummary {
	const testingPrs =
		input.mode === 'batch' ? input.inflight : input.items.filter((i) => TESTING_ONE_BY_ONE.has(i.status)).map((i) => i.pr);
	// The same board the queue page shows: its "In line" and "Needs attention" counts.
	const board = queueBoard(input.items, input.analysis ?? NO_STACKS, new Set(testingPrs));
	const testing = new Set(testingPrs).size;
	const waiting = board.stacks.reduce((n, s) => n + s.rows.length, 0);
	const triesRunning = input.triesRunning ?? 0;
	const triesWaiting = input.triesWaiting ?? 0;
	const baselineRunning = input.baselineRunning ?? false;
	const state: RepoState = input.paused !== null ? 'paused' : input.masterRed ? 'red' : testing > 0 || triesRunning > 0 || baselineRunning ? 'running' : waiting > 0 || triesWaiting > 0 ? 'waiting' : 'idle';
	return {
		state,
		paused: input.paused,
		mode: input.mode,
		modeLabel: input.mode === 'batch' ? `Batches of up to ${input.maxBatch}` : 'One by one',
		testing,
		triesRunning,
		triesWaiting,
		baselineRunning,
		waiting,
		attention: board.attention.length
	};
}

export async function repoSummary(repo: Repo): Promise<RepoSummary> {
	const settings = getQueueSettings(repo.id);
	const mode = settings.mode === 'batch' ? 'batch' : 'serial';
	// Only what the queue page last analysed: the dashboard never asks GitHub.
	const analysis = await dashboardStackAnalysis(repo, { cachedOnly: true }).catch(() => null);
	return summarize({
		items: getQueueItems(repo.id).map((i) => boardItem(i)),
		mode,
		maxBatch: settings.config.maxBatch,
		paused: settings.pausedReason,
		masterRed: getMasterHealth(repo.id)?.state === 'red',
		inflight: mode === 'batch' ? getActiveBatches(repo.id).flatMap((b) => b.members.filter((n) => !b.landed.includes(n) && !b.left_prs.includes(n))) : [],
		triesRunning: trySlotsInUse(repo.id).length,
		triesWaiting: getQueuedTries(repo.id).length,
		baselineRunning: getRunningBaseline(repo.id) !== null,
		analysis
	});
}
