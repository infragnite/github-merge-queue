// The queue as both planners see it: a list of stacks of queued PRs, in the order the queue takes
// them, and the queued PRs that can't go yet, with why.
//
// A stack is a tree of queued PRs joined by their open parents; a lone PR is a stack of one. It is
// taken as one unit by both planners: one by one tests the head stack, and a batch is filled with
// whole stacks (only the last one may be cut, to its longest part that fits). A PR that can't go
// holds its own branch of the stack, never the PRs below it or a sibling branch.
//
// Pure: the runtime gathers the queue, PR states, the stack analysis and known conflicts.

import { type AdmissionCode, type BatchConfig, type PRState, type Priority, type QueueEntry } from './batching';
import type { StackAnalysis } from './stacks';

const RANK: Record<Priority, number> = { urgent: 0, normal: 1, low: 2 };

export interface QueueModelInput {
	/** The queued PRs (not those being tested). */
	queue: QueueEntry[];
	states: Map<number, PRState>;
	analysis: StackAnalysis;
	config: BatchConfig;
	/** PRs in a batch being tested: a stack may sit on one of them. */
	inflight: Set<number>;
	/** PRs known not to apply (on the default branch, or on a PR below them), with why. */
	conflicts?: Map<number, string>;
}

export interface QueueStack {
	/** The PR at the bottom of the stack: members[0]. */
	root: number;
	/** The PRs that can go, parents first, each branch whole (preorder), branches in queue order. */
	members: number[];
	/** Each member's parent within the stack; null for the root. */
	parentOf: Map<number, number | null>;
	/** The PR being tested that the root sits on, or null when it sits on the default branch. */
	on: number | null;
	/** Its most urgent member's priority. */
	priority: Priority;
	/** When its earliest member was queued. */
	enqueuedAt: number;
}

export type HoldCode = AdmissionCode | 'conflict' | 'parent-not-queued' | 'parent-held';

export interface Held {
	pr: number;
	code: HoldCode;
	reason: string;
	/** The held PR below this one that holds it, or null when the reason is its own. */
	cause: number | null;
}

export interface QueueModel {
	/** In the order the queue takes them. */
	stacks: QueueStack[];
	/** Held, and will be ready by itself (checks running, a draft, a parent not queued yet). */
	waiting: Held[];
	/** Held until someone acts (failed checks, approval, a conflict). */
	attention: Held[];
}

export function queueModel(_input: QueueModelInput): QueueModel {
	return { stacks: [], waiting: [], attention: [] };
}

export interface FillResult {
	batch: number[] | null;
	express: boolean;
	waitUntil: number | null;
}

export function fillBatch(_model: QueueModel, _opts: { config: BatchConfig; inflightBatches: number; now: number }): FillResult {
	return { batch: null, express: false, waitUntil: null };
}

export function serialPick(_model: QueueModel, _opts: { inflight: number }): number[] | null {
	return null;
}
