// The queue as both planners see it: a list of stacks of queued PRs, in the order the queue takes
// them, and the queued PRs that can't go yet, with what someone must do about it.
//
// A stack is a tree of queued PRs joined by their open parents; a lone PR is a stack of one. It is
// taken as one unit by both planners: one by one tests the head stack, and a batch is filled with
// whole stacks (only the last one may be cut, to its longest part that fits). A PR that can't go
// holds its own branch of the stack, never the PRs below it or a sibling branch.
//
// Pure: the runtime gathers the queue, PR states, the stack analysis and known conflicts.

import { admit, type Admission, type BatchConfig, type Hold, type HoldCode, type Plan, type PlanInput, type Priority, type QueueEntry } from './batching';
import type { StackAnalysis } from './stacks';

const RANK: Record<Priority, number> = { urgent: 0, normal: 1, low: 2 };

export interface QueueModelInput {
	/** The queued PRs (not those being tested). */
	queue: QueueEntry[];
	/** Whether a queued PR may be tested now, by itself and its stack (see `admit`). */
	admission: (pr: number) => { ok: true } | Hold;
	analysis: StackAnalysis;
	/** PRs in a batch being tested: a stack may sit on one of them. */
	inflight: Set<number>;
	/** PRs that need someone whatever their admission says (a known conflict, a failure), with why. */
	problems?: Map<number, { code: HoldCode; reason: string }>;
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
	/** Held until someone acts: a draft, failed checks, approval, a conflict, a parent to queue. */
	attention: Held[];
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

export function queueModel(input: QueueModelInput): QueueModel {
	const { queue, analysis, inflight } = input;
	const entries = new Map(queue.filter((e) => !inflight.has(e.pr)).map((e) => [e.pr, e]));
	const parentOf = (n: number) => {
		const p = analysis.prs.get(n)?.parent ?? null;
		return p !== null && analysis.prs.has(p) ? p : null;
	};
	const byOrder = (a: number, b: number) => {
		const x = entries.get(a)!;
		const y = entries.get(b)!;
		return RANK[x.priority] - RANK[y.priority] || (x.position ?? 0) - (y.position ?? 0) || x.enqueuedAt - y.enqueuedAt || a - b;
	};

	// Each PR's own reason to be held, if any.
	const own = new Map<number, { code: HoldCode; reason: string }>();
	for (const n of entries.keys()) {
		const problem = input.problems?.get(n);
		const a = problem ? null : input.admission(n);
		if (problem) own.set(n, problem);
		else if (a && !a.ok) own.set(n, { code: a.code, reason: a.reason });
		else {
			const p = parentOf(n);
			if (p !== null && !entries.has(p) && !inflight.has(p)) own.set(n, { code: 'parent-not-queued', reason: `Stacked on #${p}, which isn't queued; queue #${p} first` });
		}
	}

	// A held PR holds its branch: the nearest held PR below decides.
	const holder = new Map<number, number | null>();
	const heldBy = (n: number): number | null => {
		if (holder.has(n)) return holder.get(n)!;
		const p = parentOf(n);
		const below = p !== null && entries.has(p) ? (own.has(p) ? p : heldBy(p)) : null;
		holder.set(n, below);
		return below;
	};

	const attention: Held[] = [];
	const free: number[] = [];
	for (const n of [...entries.keys()].sort(byOrder)) {
		const mine = own.get(n);
		const cause = mine ? null : heldBy(n);
		if (!mine && cause === null) {
			free.push(n);
			continue;
		}
		const c = mine ?? own.get(cause!)!;
		const held: Held = mine
			? { pr: n, code: mine.code, reason: mine.reason, cause: null }
			: { pr: n, code: 'parent-held', reason: `Waits for #${cause}: ${lowerFirst(c.reason)}`, cause };
		// Every hold waits for someone: the PR's author, or whoever queues its parent.
		attention.push(held);
	}

	// Stacks of the free PRs: a free PR whose parent is free joins its parent's stack.
	const freeSet = new Set(free);
	const children = new Map<number, number[]>();
	const roots: number[] = [];
	for (const n of free) {
		const p = parentOf(n);
		if (p !== null && freeSet.has(p)) children.set(p, [...(children.get(p) ?? []), n]);
		else roots.push(n);
	}
	const stacks: QueueStack[] = roots.map((root) => {
		const members: number[] = [];
		const within = new Map<number, number | null>();
		const visit = (n: number, up: number | null) => {
			members.push(n);
			within.set(n, up);
			for (const c of [...(children.get(n) ?? [])].sort(byOrder)) visit(c, n);
		};
		visit(root, null);
		const es = members.map((m) => entries.get(m)!);
		return {
			root,
			members,
			parentOf: within,
			on: parentOf(root),
			priority: es.reduce<Priority>((best, e) => (RANK[e.priority] < RANK[best] ? e.priority : best), 'low'),
			enqueuedAt: Math.min(...es.map((e) => e.enqueuedAt))
		};
	});
	const place = (s: QueueStack) => Math.min(...s.members.map((m) => entries.get(m)!.position ?? 0));
	stacks.sort((a, b) => RANK[a.priority] - RANK[b.priority] || place(a) - place(b) || a.enqueuedAt - b.enqueuedAt || a.root - b.root);
	return { stacks, attention };
}

export interface FillResult {
	/** The new batch, parents before children, or null. */
	batch: number[] | null;
	/** An express batch of urgent stacks. */
	express: boolean;
	/** When nothing starts only to collect a fuller batch: when to plan again. */
	waitUntil: number | null;
}

/**
 * The next new batch: whole stacks in queue order until the queue runs out or the batch is full,
 * the last one cut to its longest part that fits. Urgent stacks get an express batch of their own
 * (the first one whole, even past `expressMax`).
 */
export function fillBatch(model: QueueModel, opts: { config: BatchConfig; inflightBatches: number; now: number }): FillResult {
	const { config } = opts;
	const none: FillResult = { batch: null, express: false, waitUntil: null };
	if (opts.inflightBatches >= config.depth || model.stacks.length === 0) return none;
	const express = model.stacks[0].priority === 'urgent';
	const candidates = express ? model.stacks.filter((s) => s.priority === 'urgent') : model.stacks;
	const room = express ? Math.max(config.expressMax, candidates[0].members.length) : config.maxBatch;
	const batch: number[] = [];
	let oldest = Infinity;
	for (const s of candidates) {
		const left = room - batch.length;
		if (left <= 0) break;
		batch.push(...s.members.slice(0, left));
		oldest = Math.min(oldest, s.enqueuedAt);
	}
	if (!express && batch.length < config.maxBatch && config.collectWindowMs > 0) {
		const due = oldest + config.collectWindowMs;
		if (opts.now < due) return { batch: null, express: false, waitUntil: due };
	}
	return { batch, express, waitUntil: null };
}

/** One by one: the head stack that sits on nothing being tested, whole; nothing while a run is in flight. */
export function serialPick(model: QueueModel, opts: { inflight: number }): number[] | null {
	if (opts.inflight > 0) return null;
	return model.stacks.find((s) => s.on === null)?.members ?? null;
}

/**
 * What the queue tests next: in batches, a new batch filled from the queue model; one by one, the
 * head stack whole.
 */
export function planNextBatch(input: PlanInput & { conflicts?: Map<number, string>; strategy?: 'batch' | 'serial'; held?: Map<number, Hold> }): Plan {
	const inflight = new Set(input.inflight.flat());
	const conflicts = [...(input.conflicts ?? [])].map(([pr, reason]) => [pr, { code: 'conflict' as const, reason }] as const);
	const admitted = plannedAdmission(input);
	const admission = (n: number) => input.held?.get(n) ?? admitted(n);
	const model = queueModel({ queue: input.queue, admission, analysis: input.analysis, inflight, problems: new Map(conflicts) });
	const fill: FillResult =
		input.strategy === 'serial'
			? { batch: serialPick(model, { inflight: input.inflight.length }), express: false, waitUntil: null }
			: fillBatch(model, { config: input.config, inflightBatches: input.inflight.length, now: input.now });
	const effectivePriority = new Map<number, Priority>(input.queue.map((e) => [e.pr, e.priority]));
	for (const s of model.stacks) for (const m of s.members) effectivePriority.set(m, s.priority);
	return {
		...fill,
		held: model.attention.map((h) => ({ pr: h.pr, admission: { ok: false, code: h.code, reason: h.reason } })),
		effectivePriority
	};
}

/** A queued PR's admission from what the planner fetched about it. */
export function plannedAdmission(input: Pick<PlanInput, 'states' | 'analysis' | 'config'>): (pr: number) => Admission {
	return (n) => {
		const s = input.states.get(n);
		return s ? admit(s, input.analysis, input.config) : { ok: false, code: 'not-fetched', reason: `#${n} has not been fetched yet` };
	};
}

/** A queue row as the queue page reads it from the database. */
export interface BoardItem {
	pr: number;
	status: 'queued' | 'updating' | 'checking' | 'merging' | 'merged' | 'failed' | 'cancelled' | 'conflict';
	priority: Priority;
	position: number;
	enqueuedAt: number;
	/** What the planner recorded when it held the PR, while still current. */
	hold: { code: HoldCode; reason: string } | null;
	message: string | null;
	/** The PRs ahead it conflicts with and waits for to land, when deferred. */
	after?: number[];
}

export interface QueueBoard {
	stacks: Array<{ root: number; on: number | null; priority: Priority; rows: Array<{ pr: number; depth: number; parent: number | null; after?: number[] }> }>;
	attention: Held[];
}

/**
 * The queue model as the queue page shows it, from the queue rows and the holds the planner
 * recorded: the same stacks, order and reasons the planners work from.
 */
export function queueBoard(items: BoardItem[], analysis: StackAnalysis, inflight: Set<number>): QueueBoard {
	const live = items.filter((i) => i.status !== 'merged' && i.status !== 'cancelled' && !inflight.has(i.pr));
	const byPr = new Map(live.map((i) => [i.pr, i]));
	const problems = new Map<number, { code: HoldCode; reason: string }>();
	for (const i of live) {
		if (i.status === 'conflict') problems.set(i.pr, { code: 'conflict', reason: i.message ?? 'Merge conflict' });
		if (i.status === 'failed') problems.set(i.pr, { code: 'failed', reason: i.message ?? 'Failed' });
	}
	const admission = (n: number): { ok: true } | Hold => {
		const i = byPr.get(n)!;
		if (i.status !== 'queued') return { ok: true };
		// Deferred behind PRs it conflicts with: nobody can do anything about it, so it is in line,
		// after them. A message without a planner's hold is such a deferral too.
		if (i.hold?.code === 'deferred' || (!i.hold && i.message)) return { ok: true };
		if (i.hold) return { ok: false, code: i.hold.code, reason: i.hold.reason };
		return { ok: true };
	};
	const model = queueModel({
		queue: live.map((i) => ({ pr: i.pr, enqueuedAt: i.enqueuedAt, priority: i.priority, position: i.position })),
		admission,
		analysis,
		inflight,
		problems
	});
	return {
		stacks: model.stacks.map((s) => {
			const depth = new Map<number, number>();
			return {
				root: s.root,
				on: s.on,
				priority: s.priority,
				rows: s.members.map((pr) => {
					const parent = s.parentOf.get(pr) ?? null;
					depth.set(pr, parent === null ? 0 : depth.get(parent)! + 1);
					const after = byPr.get(pr)?.after ?? [];
					return { pr, depth: depth.get(pr)!, parent, ...(after.length ? { after } : {}) };
				})
			};
		}),
		attention: model.attention
	};
}
