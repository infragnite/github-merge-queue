// How the repository page arranges a long queue: what needs someone, what runs next, and the
// rest in the order the queue will take it. Pure, so the page can rebuild it on every refresh
// from what it already has (queue rows, the batches in flight, the stacks).

import type { QueueItem } from './types';

export type Priority = 'urgent' | 'normal' | 'low';
const RANK: Record<Priority, number> = { urgent: 0, normal: 1, low: 2 };

export interface ViewItem extends QueueItem {
	/** The planner's hold on a queued PR: true when it waits by itself, false when it needs someone. */
	holdWait: boolean | null;
}

/** A PR's place in a stack, for the chip on its row. */
export interface StackPlace {
	root: number;
	/** The open PR it sits on, or null for the stack's root. */
	parent: number | null;
	/** PRs stacked directly on it. */
	children: number;
	/** This PR or one below it has a blocking stack issue. */
	broken: boolean;
	/** Blocking issues on this PR itself. */
	issues: string[];
}

export interface FlightGroup {
	/** The batch the PRs are being tested in. */
	batch: number;
	status: string;
	prs: number[];
}

export interface Row {
	item: ViewItem;
	/** 1 for the PR the queue takes first. */
	position: number;
	stack: StackPlace | null;
}

export interface Attention {
	item: ViewItem;
	stack: StackPlace | null;
	/** What is wrong, in a few words. */
	why: string;
}

export interface QueueView {
	attention: Attention[];
	/** PRs in a batch being tested, one group per batch, in place of their rows. */
	inFlight: FlightGroup[];
	/** Batch mode: the PRs likely to form the next batch, in order. */
	upNext: Row[];
	/** Everything else, in the order the queue takes it. */
	rows: Row[];
	/** True when the next batch is an express batch of urgent PRs. */
	express: boolean;
}

export interface QueueViewInput {
	items: ViewItem[];
	mode: 'serial' | 'batch';
	/** Batches being tested (not bisection or try runs), with their members. */
	batches: Array<{ id: number; status: string; prs: number[] }>;
	stacks: Array<{ root: number; rows: Array<{ pr: number; depth: number; broken: boolean; issues: Array<{ severity: string; message: string }> }> }> | null;
	limits: { maxBatch: number; expressMax: number };
}

function stackPlaces(stacks: QueueViewInput['stacks']): Map<number, StackPlace> {
	const out = new Map<number, StackPlace>();
	for (const s of stacks ?? []) {
		// Rows come root first, depth-first: a row's parent is the last row one level up.
		const lastAt: number[] = [];
		for (const r of s.rows) {
			lastAt[r.depth] = r.pr;
			const parent = r.depth > 0 ? lastAt[r.depth - 1] : null;
			out.set(r.pr, {
				root: s.root,
				parent,
				children: 0,
				broken: r.broken,
				issues: r.issues.filter((i) => i.severity === 'blocking').map((i) => i.message)
			});
			if (parent !== null) out.get(parent)!.children++;
		}
	}
	return out;
}

const PRIORITY = (i: QueueItem): Priority => i.priority ?? 'normal';
const enqueued = (i: QueueItem) => Date.parse(i.created_at.replace(' ', 'T') + (i.created_at.includes('Z') ? '' : 'Z'));

function attentionReason(i: ViewItem, stack: StackPlace | null): string | null {
	if (i.status === 'conflict') return 'Merge conflict';
	if (i.status === 'failed') return i.error_message ?? 'Failed';
	if (i.status === 'queued' && i.holdWait === false && i.error_message) return i.error_message;
	if (i.status === 'queued' && stack && stack.issues.length > 0) return stack.issues[0];
	return null;
}

export function queueView(input: QueueViewInput): QueueView {
	const { items, mode, batches, limits } = input;
	const places = stackPlaces(input.stacks);
	const flying = new Map<number, number>();
	for (const b of batches) for (const n of b.prs) flying.set(n, b.id);

	const attention: Attention[] = [];
	const inFlight: FlightGroup[] = batches
		.map((b) => ({ batch: b.id, status: b.status, prs: b.prs.filter((n) => items.some((i) => i.pr_number === n)) }))
		.filter((g) => g.prs.length > 0);
	const rest: ViewItem[] = [];
	for (const i of items) {
		if (i.status === 'merged' || i.status === 'cancelled') continue;
		if (mode === 'batch' && flying.has(i.pr_number)) continue;
		const stack = places.get(i.pr_number) ?? null;
		const why = attentionReason(i, stack);
		if (why) attention.push({ item: i, stack, why });
		else rest.push(i);
	}

	// Batch mode takes urgent PRs first, then the oldest; one by one keeps the queue's own order.
	const ordered =
		mode === 'batch'
			? [...rest].sort((a, b) => RANK[PRIORITY(a)] - RANK[PRIORITY(b)] || enqueued(a) - enqueued(b) || a.pr_number - b.pr_number)
			: [...rest].sort((a, b) => a.position - b.position);
	const rows = ordered.map((item, k) => ({ item, position: k + 1, stack: places.get(item.pr_number) ?? null }));

	if (mode !== 'batch') return { attention, inFlight: [], upNext: [], rows, express: false };

	// The next batch, roughly: the planner also holds back PRs whose CI or parent isn't ready.
	const ready = rows.filter((r) => r.item.status === 'queued' && r.item.holdWait === null);
	const express = ready.length > 0 && PRIORITY(ready[0].item) === 'urgent';
	const upNext = express
		? ready.filter((r) => PRIORITY(r.item) === 'urgent').slice(0, limits.expressMax)
		: ready.slice(0, limits.maxBatch);
	const next = new Set(upNext.map((r) => r.item.id));
	return { attention, inFlight, upNext, rows: rows.filter((r) => !next.has(r.item.id)), express };
}
