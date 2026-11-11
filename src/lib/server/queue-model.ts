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
import type { DependencyGraph } from './deps';
import type { StackAnalysis } from './stacks';

const RANK: Record<Priority, number> = { urgent: 0, normal: 1, low: 2 };
const PRIORITIES: Priority[] = ['urgent', 'normal', 'low'];

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
	/**
	 * Each PR's git parent and the dependencies it declares (`Depends-On:`, see deps.ts), cycles
	 * already cut. By default only the git parent.
	 */
	deps?: Pick<DependencyGraph, 'depsOf' | 'declaredOf'>;
}

export interface QueueStack {
	/** The PR at the bottom of the stack: members[0]. */
	root: number;
	/**
	 * The PRs that can go, in landing order: each after everything it depends on, each branch whole
	 * (preorder) where it can be, branches in queue order. A prefix of it is always buildable.
	 */
	members: number[];
	/**
	 * Each member's place in the stack drawn as a tree: the member it comes after, the one of its
	 * dependencies here placed last (its git parent in a plain stack); null for a member that
	 * depends on nothing here.
	 */
	parentOf: Map<number, number | null>;
	/** Each member's dependencies within the stack (its git parent first, then what it declares). */
	needs: Map<number, number[]>;
	/** The PR being tested that a member depends on, or null when the stack sits on the default branch. */
	on: number | null;
	/**
	 * Queued PRs of earlier stacks that members depend on: a less urgent PR that declares a
	 * dependency on a more urgent one follows it in a stack of its own.
	 */
	after: number[];
	/** Its most urgent member's priority, or that of a PR depending on it. */
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
	const gitParent = (n: number) => {
		const p = analysis.prs.get(n)?.parent ?? null;
		return p !== null && analysis.prs.has(p) ? p : null;
	};
	const depsOf = input.deps
		? (n: number) => input.deps!.depsOf(n)
		: (n: number) => {
				const p = gitParent(n);
				return p === null ? [] : [p];
			};
	const declared = (n: number) => (input.deps ? input.deps.declaredOf(n).filter((d) => d !== gitParent(n)) : []);
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
			const missing = (d: number) => !entries.has(d) && !inflight.has(d);
			const p = gitParent(n);
			const d = declared(n).find(missing);
			if (p !== null && missing(p)) own.set(n, { code: 'parent-not-queued', reason: `Stacked on #${p}, which isn't queued; queue #${p} first` });
			else if (d !== undefined) own.set(n, { code: 'dependency-not-queued', reason: `Depends on #${d}, which isn't queued` });
		}
	}

	// A held PR holds what depends on it: the first held PR found below decides.
	const holder = new Map<number, number | null>();
	const heldBy = (n: number): number | null => {
		if (holder.has(n)) return holder.get(n)!;
		holder.set(n, null); // never loops, whatever the graph
		let below: number | null = null;
		for (const p of depsOf(n)) {
			if (!entries.has(p)) continue;
			below = own.has(p) ? p : heldBy(p);
			if (below !== null) break;
		}
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

	// Priority: a git stack shares its most urgent member's; a declared dependency takes on the
	// priority of what depends on it, never the other way.
	const freeSet = new Set(free);
	const inFree = (n: number) => depsOf(n).filter((p) => freeSet.has(p));
	const eff = new Map(free.map((n) => [n, RANK[entries.get(n)!.priority]]));
	for (let changed = true; changed; ) {
		changed = false;
		for (const n of free) {
			for (const p of inFree(n)) {
				const both = Math.min(eff.get(n)!, eff.get(p)!);
				if (eff.get(p)! > both) {
					eff.set(p, both);
					changed = true;
				}
				if (p === gitParent(n) && eff.get(n)! > both) {
					eff.set(n, both);
					changed = true;
				}
			}
		}
	}

	// Stacks: free PRs joined by git parents, and by declarations between PRs of one priority.
	const unit = new Map(free.map((n) => [n, n]));
	const find = (n: number): number => (unit.get(n) === n ? n : find(unit.get(n)!));
	const joins = (n: number, p: number) => p === gitParent(n) || eff.get(p) === eff.get(n);
	for (const n of free) for (const p of inFree(n)) if (joins(n, p)) unit.set(find(n), find(p));
	const groups = new Map<number, number[]>();
	for (const n of free) groups.set(find(n), [...(groups.get(find(n)) ?? []), n]);

	const stacks: QueueStack[] = [...groups.values()].map((group) => {
		const set = new Set(group);
		const needs = new Map(group.map((n) => [n, inFree(n).filter((p) => set.has(p))]));
		const members: number[] = [];
		const within = new Map<number, number | null>();
		const placed = new Set<number>();
		// Preorder from the PRs that need nothing here; a PR that needs several goes right after the
		// last of them is placed. A plain stack is a tree, and this is its preorder.
		const visit = (n: number, up: number | null) => {
			members.push(n);
			within.set(n, up);
			placed.add(n);
			const kids = group.filter((c) => needs.get(c)!.includes(n)).sort(byOrder);
			for (const c of kids) if (!placed.has(c) && needs.get(c)!.every((p) => placed.has(p))) visit(c, n);
		};
		for (const r of group.filter((n) => needs.get(n)!.length === 0).sort(byOrder)) visit(r, null);
		const outside = members.flatMap((m) => depsOf(m).filter((p) => !set.has(p)));
		const es = members.map((m) => entries.get(m)!);
		return {
			root: members[0],
			members,
			parentOf: within,
			needs,
			on: outside.find((p) => inflight.has(p)) ?? null,
			after: [...new Set(outside.filter((p) => freeSet.has(p)))],
			priority: PRIORITIES[Math.min(...members.map((m) => eff.get(m)!))],
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
 * the last one cut to its longest part that fits. Urgent stacks get an express batch of their own,
 * filled the same way from the urgent stacks alone.
 */
export function fillBatch(model: QueueModel, opts: { config: BatchConfig; inflightBatches: number; now: number }): FillResult {
	const { config } = opts;
	const none: FillResult = { batch: null, express: false, waitUntil: null };
	if (opts.inflightBatches >= config.depth || model.stacks.length === 0) return none;
	const express = model.stacks[0].priority === 'urgent';
	const candidates = express ? model.stacks.filter((s) => s.priority === 'urgent') : model.stacks;
	const batch: number[] = [];
	const taken = new Set<number>();
	let oldest = Infinity;
	for (const s of candidates) {
		const left = config.maxBatch - batch.length;
		if (left <= 0) break;
		// Never before what it depends on: a stack that follows another goes only with it.
		if (s.after.some((p) => !taken.has(p))) continue;
		const part = s.members.slice(0, left);
		batch.push(...part);
		for (const p of part) taken.add(p);
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
	return model.stacks.find((s) => s.on === null && s.after.length === 0)?.members ?? null;
}

/**
 * What the queue tests next: in batches, a new batch filled from the queue model; one by one, the
 * head stack whole.
 */
export function planNextBatch(
	input: PlanInput & { conflicts?: Map<number, string>; strategy?: 'batch' | 'serial'; held?: Map<number, Hold>; dependencies?: DependencyGraph }
): Plan {
	const inflight = new Set(input.inflight.flat());
	const conflicts = [...(input.conflicts ?? [])].map(([pr, reason]) => [pr, { code: 'conflict' as const, reason }] as const);
	const admitted = plannedAdmission(input);
	const admission = (n: number) => input.held?.get(n) ?? admitted(n);
	// A known conflict is said before a problem with the PR's declarations.
	const problems = new Map([...(input.dependencies?.problems ?? []), ...conflicts]);
	const model = queueModel({ queue: input.queue, admission, analysis: input.analysis, inflight, problems, deps: input.dependencies });
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
		return s ? admit(s, input.analysis, input.config) : { ok: false, code: 'not-fetched', reason: 'Not fetched yet' };
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
	stacks: Array<{
		root: number;
		on: number | null;
		priority: Priority;
		/** `also`: what the PR depends on here besides the row it is drawn under; `after`: PRs it conflicts with ahead. */
		rows: Array<{ pr: number; depth: number; parent: number | null; also?: number[]; after?: number[] }>;
	}>;
	attention: Held[];
}

/**
 * The queue model as the queue page shows it, from the queue rows and the holds the planner
 * recorded: the same stacks, order and reasons the planners work from.
 */
export function queueBoard(items: BoardItem[], analysis: StackAnalysis, inflight: Set<number>, deps?: DependencyGraph): QueueBoard {
	const live = items.filter((i) => i.status !== 'merged' && i.status !== 'cancelled' && !inflight.has(i.pr));
	const byPr = new Map(live.map((i) => [i.pr, i]));
	const problems = new Map<number, { code: HoldCode; reason: string }>(deps?.problems ?? []);
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
		problems,
		deps
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
					const also = (s.needs.get(pr) ?? []).filter((d) => d !== parent);
					return { pr, depth: depth.get(pr)!, parent, ...(also.length ? { also } : {}), ...(after.length ? { after } : {}) };
				})
			};
		}),
		attention: model.attention
	};
}
