// Batch planning for the merge queue.
//
// The queue tests several PRs at once: a batch is the default branch plus one
// squash commit per PR, in order, and master only moves to a tree that passed.
// This file decides which PRs may enter the queue (admission), which of them
// go into the next batch (priority, stacks, the collect window), and how a
// failed batch is bisected down to the PRs that broke it.
//
// Stacks come from `analyzeStacks` (stacks.ts): a stacked child may only be
// tested together with, or after, its parent, and leaves the queue with it.
//
// Everything here is pure; the runtime builds branches, runs CI and lands.

import type { PRStackInfo, StackAnalysis } from './stacks';

export type Priority = 'urgent' | 'normal' | 'low';

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, normal: 1, low: 2 };

export interface QueueEntry {
	pr: number;
	/** Epoch ms when the PR entered the queue. */
	enqueuedAt: number;
	priority: Priority;
}

/** What the queue knows about a PR's readiness on GitHub. */
export interface PRState {
	pr: number;
	headSha: string;
	draft: boolean;
	/** The PR's own required check on its head: true green, false red, null still running. */
	ciGreen: boolean | null;
	/** Head SHAs that an APPROVED review (from someone with write access) was given on. */
	approvedShas: string[];
	/** An unresolved CHANGES_REQUESTED review from someone with write access. */
	changesRequested: boolean;
	/** The PR's base is the default branch. Otherwise it may only enter as a stacked child. */
	targetsDefault?: boolean;
	/** The head is in a fork: its code runs in this repo's CI only once a writer approved that head. */
	fromFork?: boolean;
}

export interface BatchConfig {
	/** Most PRs in a normal batch. */
	maxBatch: number;
	/** How long to wait for a fuller batch before testing a partial one. */
	collectWindowMs: number;
	/** Batches in flight at once, each built on the one before it. */
	depth: number;
	/** Most PRs in an express batch for urgent PRs (a stack under one may exceed it). */
	expressMax: number;
	/** Only approved PRs may enter a batch. */
	requireApproval: boolean;
	/** The approval must be on the PR's current head, not an earlier push. */
	approvalOnHead: boolean;
	/** Restack PRs whose parent was rebased or merged when that needs no conflict resolution. */
	autoRebase: boolean;
	/** A batch whose CI has not finished after this long pauses the queue. */
	ciTimeoutMs: number;
	/**
	 * The PR's own `requiredCheck` must pass on its head first. Off by default: the batch run is the
	 * gate, and a repo whose CI runs only on queue branches has no PR checks at all.
	 */
	requirePRChecks: boolean;
	/**
	 * Dispatch the workflow on the default branch after each landed batch: the run in its scope
	 * saves the caches that batch runs restore, and does whatever else the repo runs on it
	 * (releases). Off for a repo whose CI needs no default-branch run.
	 */
	masterRun: boolean;
	/**
	 * Re-run a failed batch's (and bisection step's) failed jobs once before treating the failure as
	 * real. Off for a repo without flaky tests: a failure then goes straight to bisection.
	 */
	retryFailed: boolean;
	/** At least this long between those runs (0: one per landed batch). */
	masterRunMinGapMs: number;
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
	maxBatch: 8,
	collectWindowMs: 60 * 60 * 1000,
	depth: 2,
	expressMax: 2,
	requireApproval: true,
	approvalOnHead: true,
	autoRebase: true,
	ciTimeoutMs: 12 * 60 * 60 * 1000,
	requirePRChecks: false,
	masterRun: true,
	retryFailed: true,
	masterRunMinGapMs: 0
};

export type AdmissionCode =
	| 'draft'
	| 'ci-pending'
	| 'ci-failed'
	| 'not-approved'
	| 'stale-approval'
	| 'changes-requested'
	| 'stack-broken'
	| 'parent-not-ready'
	| 'wrong-base';

export type Admission =
	| { ok: true }
	| {
			ok: false;
			code: AdmissionCode;
			reason: string;
			/** True when the PR stays queued and may become ready by itself (CI running, parent pending). */
			wait: boolean;
	  };

// Blocking stack issues the queue cannot work around. A base-mismatch is
// handled at landing (the child is retargeted) when ancestry knows the parent.
const UNFIXABLE: ReadonlySet<string> = new Set([
	'parent-rebased',
	'parent-closed',
	'base-branch-missing',
	'auto-closed'
]);

/** The blocking stack issue on this PR that the queue can't work around, if any. */
function stopper(info: PRStackInfo): string | null {
	const i = info.issues.find(
		(i) =>
			i.severity === 'blocking' &&
			(UNFIXABLE.has(i.kind) || (i.kind === 'base-mismatch' && info.parent === null))
	);
	return i ? i.message : null;
}

/** Whether a PR may be tested in a batch now, looking at the PR alone and its stack. */
export function admit(state: PRState, analysis: StackAnalysis, config: BatchConfig): Admission {
	const n = state.pr;
	if (state.draft) return { ok: false, code: 'draft', reason: `#${n} is a draft`, wait: true };

	if (state.ciGreen === null) {
		return { ok: false, code: 'ci-pending', reason: `#${n}'s checks are still running`, wait: true };
	}
	if (state.ciGreen === false) {
		return { ok: false, code: 'ci-failed', reason: `#${n}'s own checks failed on its head`, wait: false };
	}

	if (config.requireApproval) {
		if (state.changesRequested) {
			return { ok: false, code: 'changes-requested', reason: `#${n} has changes requested`, wait: false };
		}
		if (state.approvedShas.length === 0) {
			return { ok: false, code: 'not-approved', reason: `#${n} is not approved`, wait: false };
		}
		if (config.approvalOnHead && !state.approvedShas.includes(state.headSha)) {
			return {
				ok: false,
				code: 'stale-approval',
				reason: `#${n} was approved on an earlier push; approve its current head ${state.headSha.slice(0, 7)}`,
				wait: false
			};
		}
	}

	if (state.fromFork && !state.approvedShas.includes(state.headSha)) {
		// Batches run in this repo's CI, with its secrets and runners: outside code needs a writer's look first.
		return { ok: false, code: 'not-approved', reason: `#${n} comes from a fork; a writer must approve its head first`, wait: false };
	}

	const info = analysis.prs.get(n);
	if (state.targetsDefault === false && (info?.parent ?? null) === null) {
		// Only the default branch is batched; a PR into another branch is merged some other way.
		return { ok: false, code: 'wrong-base', reason: `#${n} does not target the default branch`, wait: false };
	}
	if (state.fromFork && (info?.parent ?? null) !== null) {
		// Landing a stacked child restacks and pushes its branch, which the queue can't do in a fork.
		return { ok: false, code: 'wrong-base', reason: `#${n} is stacked on another PR from a fork; retarget it to the default branch once its parent lands`, wait: false };
	}
	if (info) {
		const own = stopper(info);
		if (own) return { ok: false, code: 'stack-broken', reason: own, wait: false };
		for (let p = info.parent; p !== null; ) {
			const up = analysis.prs.get(p);
			if (!up) break;
			if (stopper(up)) {
				return {
					ok: false,
					code: 'parent-not-ready',
					reason: `The stack under #${n} is broken at #${p}`,
					wait: true
				};
			}
			p = up.parent;
		}
	}
	return { ok: true };
}

export interface PlanInput {
	now: number;
	queue: QueueEntry[];
	states: Map<number, PRState>;
	analysis: StackAnalysis;
	/** Batches being tested, oldest first. A new batch is built on top of all of them. */
	inflight: number[][];
	config: BatchConfig;
}

export interface Plan {
	/** PRs for the next batch in landing order (parents before children), or null. */
	batch: number[] | null;
	/** True when the batch is an express batch of urgent PRs. */
	express: boolean;
	/** When nothing is started only to collect a fuller batch: when to plan again. */
	waitUntil: number | null;
	/** Queued PRs that cannot go in a batch now, and why. */
	held: { pr: number; admission: Exclude<Admission, { ok: true }> }[];
	/** The priority each queued PR was planned at, after stack inheritance. */
	effectivePriority: Map<number, Priority>;
}

/** Parent PR by ancestry while it's still open, else null. */
function openParent(analysis: StackAnalysis, n: number): number | null {
	const p = analysis.prs.get(n)?.parent ?? null;
	return p !== null && analysis.prs.has(p) ? p : null;
}

/** Picks the next batch: urgent first, then oldest; stacks in parent-before-child order. */
export function planNextBatch(input: PlanInput): Plan {
	const { now, queue, states, analysis, inflight, config } = input;
	const held: Plan['held'] = [];
	const admitted = new Map<number, QueueEntry>();
	for (const e of queue) {
		const s = states.get(e.pr);
		const a: Admission = s
			? admit(s, analysis, config)
			: { ok: false, code: 'ci-pending', reason: `#${e.pr} has not been fetched yet`, wait: true };
		if (a.ok) admitted.set(e.pr, e);
		else held.push({ pr: e.pr, admission: a });
	}

	// A PR whose open parent is neither in flight nor admitted can't be tested yet.
	const flying = new Set(inflight.flat());
	const queued = new Set(queue.map((e) => e.pr));
	const reachable = new Map<number, boolean>();
	const canReach = (n: number, seen = new Set<number>()): boolean => {
		const cached = reachable.get(n);
		if (cached !== undefined) return cached;
		if (seen.has(n)) return false;
		seen.add(n);
		const p = openParent(analysis, n);
		const ok = p === null || flying.has(p) || (admitted.has(p) && canReach(p, seen));
		reachable.set(n, ok);
		return ok;
	};
	for (const n of [...admitted.keys()]) {
		if (canReach(n)) continue;
		const p = openParent(analysis, n)!;
		admitted.delete(n);
		held.push({
			pr: n,
			admission: {
				ok: false,
				code: 'parent-not-ready',
				reason: queued.has(p)
					? `Stacked on #${p}, which can't be batched yet`
					: `Stacked on #${p}, which isn't merged or queued; queue #${p} first`,
				wait: true
			}
		});
	}

	// Priority inheritance: an urgent child lifts the unmerged stack under it.
	const effective = new Map<number, Priority>();
	for (const e of queue) effective.set(e.pr, e.priority);
	for (const e of admitted.values()) {
		let p = openParent(analysis, e.pr);
		while (p !== null && admitted.has(p)) {
			if (PRIORITY_RANK[e.priority] < PRIORITY_RANK[effective.get(p)!]) effective.set(p, e.priority);
			p = openParent(analysis, p);
		}
	}

	const result = (batch: number[] | null, express = false, waitUntil: number | null = null): Plan => ({
		batch,
		express,
		waitUntil,
		held,
		effectivePriority: effective
	});

	if (inflight.length >= config.depth || admitted.size === 0) return result(null);

	const ordered = [...admitted.values()].sort(
		(a, b) =>
			PRIORITY_RANK[effective.get(a.pr)!] - PRIORITY_RANK[effective.get(b.pr)!] ||
			a.enqueuedAt - b.enqueuedAt ||
			a.pr - b.pr
	);
	const express = effective.get(ordered[0].pr) === 'urgent';
	// An express batch is built around the PRs marked urgent; their stacks come along via `chain`.
	const candidates = express ? ordered.filter((e) => e.priority === 'urgent') : ordered;
	const limit = express ? config.expressMax : config.maxBatch;

	const batch: number[] = [];
	const inBatch = new Set<number>();
	/** Unmerged ancestors not yet in flight or in the batch, bottom-up, ending with n. */
	const chain = (n: number): number[] => {
		const out = [n];
		let p = openParent(analysis, n);
		while (p !== null && !flying.has(p) && !inBatch.has(p)) {
			out.unshift(p);
			p = openParent(analysis, p);
		}
		return out;
	};
	for (const e of candidates) {
		if (inBatch.has(e.pr)) continue;
		const c = chain(e.pr);
		// An express batch takes a whole urgent stack even past its size limit.
		const room = express && batch.length === 0 ? Math.max(limit, c.length) : limit;
		if (batch.length + c.length > room) continue;
		for (const n of c) {
			batch.push(n);
			inBatch.add(n);
		}
		if (batch.length >= room) break;
	}
	if (batch.length === 0) return result(null);

	if (!express && batch.length < config.maxBatch && config.collectWindowMs > 0) {
		const oldest = Math.min(...batch.map((n) => admitted.get(n)!.enqueuedAt));
		const due = oldest + config.collectWindowMs;
		if (now < due) return result(null, false, due);
	}
	return result(batch, express);
}

/** Every open PR stacked (directly or not) on one of `prs`. */
export function descendants(analysis: StackAnalysis, prs: Iterable<number>): Set<number> {
	const out = new Set<number>();
	const todo = [...prs];
	while (todo.length) {
		const n = todo.pop()!;
		for (const c of analysis.prs.get(n)?.children ?? []) {
			if (!out.has(c)) {
				out.add(c);
				todo.push(c);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Bisection

/** A commit to test: `context` (known good on the base) plus `members`, in order. */
export interface TestGroup {
	context: number[];
	members: number[];
}

export type BisectStep =
	| { kind: 'test'; groups: TestGroup[] }
	| {
			kind: 'done';
			/** Tested together on the base and passed: land these, in order. */
			land: number[];
			/** PRs that broke the batch, with why. */
			eject: { pr: number; reason: string }[];
			/** PRs that were not shown bad but did not pass together with the rest: back to the queue. */
			requeue: number[];
	  };

const key = (g: TestGroup) => `${g.context.join(',')}|${g.members.join(',')}`;

/**
 * Where to cut `members` (in landing order) so that the halves keep stacks
 * whole. `independent` means the right half has no ancestor in the left and
 * can be tested on its own; otherwise it can only be tested on top of the left.
 */
export function splitPoint(
	members: number[],
	parentOf: (n: number) => number | null
): { left: number[]; right: number[]; independent: boolean } {
	const ancestorsIn = (n: number, set: Set<number>) => {
		for (let p = parentOf(n); p !== null; p = parentOf(p)) if (set.has(p)) return true;
		return false;
	};
	const mid = Math.floor(members.length / 2);
	const cuts: number[] = [];
	for (let d = 0; d < members.length; d++) {
		for (const c of [mid + d, mid - d]) if (c > 0 && c < members.length && !cuts.includes(c)) cuts.push(c);
	}
	for (const c of cuts) {
		const left = new Set(members.slice(0, c));
		if (members.slice(c).every((n) => !ancestorsIn(n, left))) {
			return { left: members.slice(0, c), right: members.slice(c), independent: true };
		}
	}
	return { left: members.slice(0, mid), right: members.slice(mid), independent: false };
}

/**
 * Finds the PRs that broke a failed batch. Every group is tested on the same
 * base as the failed batch. Drive it with `next()`, run every group it asks
 * for (they are independent and can run in parallel), `record()` each result,
 * and repeat until it returns `done`.
 */
export class Bisection {
	private readonly results = new Map<string, boolean>();
	private readonly culprits = new Map<number, string>();
	private readonly requeued = new Set<number>();
	/** Failed groups still to narrow down. */
	private open: TestGroup[];

	constructor(
		private readonly batch: number[],
		private readonly parentOf: (n: number) => number | null
	) {
		this.open = [{ context: [], members: [...batch] }];
		this.results.set(key(this.open[0]), false);
	}

	record(group: TestGroup, passed: boolean): void {
		this.results.set(key(group), passed);
	}

	next(): BisectStep {
		for (;;) {
			const groups = this.open;
			this.open = [];
			const wanted: TestGroup[] = [];
			for (const g of groups) wanted.push(...this.narrow(g));
			if (wanted.length) return { kind: 'test', groups: dedupe(wanted) };
			if (this.open.length === 0) return this.finish();
		}
	}

	/**
	 * Advances one failed group: either returns the groups it still needs
	 * results for (and stays open), or replaces itself in `open` with narrower
	 * failed groups, or resolves to a culprit. Returns [] unless it needs tests.
	 */
	private narrow(g: TestGroup): TestGroup[] {
		if (g.members.length === 1) {
			const n = g.members[0];
			this.culprits.set(
				n,
				g.context.length
					? `#${n} fails when combined with ${g.context.map((c) => `#${c}`).join(', ')}`
					: `#${n} fails on its own on top of the default branch`
			);
			return [];
		}
		const { left, right, independent } = splitPoint(g.members, this.parentOf);
		const a: TestGroup = { context: g.context, members: left };
		const ra = this.results.get(key(a));
		if (independent) {
			const b: TestGroup = { context: g.context, members: right };
			const rb = this.results.get(key(b));
			const need = [ra === undefined ? a : null, rb === undefined ? b : null].filter(Boolean) as TestGroup[];
			if (need.length) {
				this.open.push(g);
				return need;
			}
			if (!ra) this.open.push(a);
			if (!rb) this.open.push(b);
			if (ra && rb) {
				// Each half passes alone, so the right half breaks on top of the left.
				const onLeft: TestGroup = { context: [...g.context, ...left], members: right };
				this.results.set(key(onLeft), false);
				this.open.push(onLeft);
			}
			return [];
		}
		if (ra === undefined) {
			this.open.push(g);
			return [a];
		}
		if (ra) {
			// The left half passes; the whole failed, so the right half fails on top of it.
			const onLeft: TestGroup = { context: [...g.context, ...left], members: right };
			this.results.set(key(onLeft), false);
			this.open.push(onLeft);
		} else {
			// The right half can't be tested without the left: send it back to the queue.
			this.open.push(a);
			for (const n of right) this.requeued.add(n);
		}
		return [];
	}

	private finish(): BisectStep {
		const bad = new Set(this.culprits.keys());
		// Stack children of a culprit leave with it.
		for (const n of this.batch) {
			for (let p = this.parentOf(n); p !== null; p = this.parentOf(p)) {
				if (bad.has(p) && !bad.has(n)) {
					this.culprits.set(n, `Stacked on #${p}, which failed in the queue`);
					bad.add(n);
					break;
				}
			}
		}
		const survivors = this.batch.filter((n) => !bad.has(n) && !this.requeued.has(n));
		const eject = this.batch.filter((n) => bad.has(n)).map((n) => ({ pr: n, reason: this.culprits.get(n)! }));
		const requeue = this.batch.filter((n) => this.requeued.has(n) && !bad.has(n));
		if (survivors.length === 0) return { kind: 'done', land: [], eject, requeue };

		// Survivors were only shown good in parts; land them only once they pass together.
		const final: TestGroup = { context: [], members: survivors };
		const r = this.results.get(key(final));
		if (r === undefined) {
			return { kind: 'test', groups: [final] };
		}
		if (r) return { kind: 'done', land: survivors, eject, requeue };

		// They interact in a way the bisection didn't isolate: land the largest group
		// that passed on the bare base and whose stacks are complete; requeue the rest.
		let best: number[] = [];
		for (const [k, passed] of this.results) {
			if (!passed) continue;
			const [ctx, mem] = k.split('|');
			if (ctx !== '') continue;
			const members = mem.split(',').map(Number).filter((n) => survivors.includes(n));
			if (members.length > best.length) best = members;
		}
		const land = best;
		return {
			kind: 'done',
			land,
			eject,
			requeue: [...requeue, ...survivors.filter((n) => !land.includes(n))]
		};
	}
}

function dedupe(groups: TestGroup[]): TestGroup[] {
	const seen = new Set<string>();
	return groups.filter((g) => {
		const k = key(g);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/**
 * The next batch on a red default branch, where a batch that passes carries a fix. Each queued
 * PR goes with its queued ancestors (a child is never tested without them). First, PRs not yet
 * tried there (`tried(n, false)`), packed up to `maxBatch` (an urgent one alone with its stack);
 * once none is left, each PR's stack once more on its own (`tried(n, true)`). Every batch holds
 * a PR not tried that way, so the tries run out.
 */
export function planRedBatch(input: {
	queue: QueueEntry[];
	states: Map<number, PRState>;
	analysis: StackAnalysis;
	config: BatchConfig;
	tried: (n: number, alone: boolean) => boolean;
	/** Every PR still in the queue, also those being tested in another batch. */
	live?: Set<number>;
}): Pick<Plan, 'batch' | 'express' | 'held'> {
	const { queue, states, analysis, config, tried } = input;
	const held: Plan['held'] = [];
	const ok = new Map<number, QueueEntry>();
	for (const e of queue) {
		const a = admit(states.get(e.pr)!, analysis, config);
		if (a.ok) ok.set(e.pr, e);
		else held.push({ pr: e.pr, admission: a });
	}
	const queued = input.live ?? new Set(queue.map((e) => e.pr));
	const chainOf = (n: number): number[] | null => {
		const out = [n];
		for (let p = openParent(analysis, n); p !== null; p = openParent(analysis, p)) {
			if (out.includes(p)) return null; // a cycle in the analysis: never loop
			if (!ok.has(p)) {
				held.push({
					pr: n,
					admission: {
						ok: false,
						code: 'parent-not-ready',
						reason: queued.has(p) ? `Stacked on #${p}, which can't be batched yet` : `Stacked on #${p}, which isn't merged or queued; queue #${p} first`,
						wait: true
					}
				});
				return null;
			}
			out.unshift(p);
		}
		return out;
	};
	const ordered = [...ok.values()].sort(
		(a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.enqueuedAt - b.enqueuedAt || a.pr - b.pr
	);
	const chains = (alone: boolean) =>
		ordered.filter((e) => !tried(e.pr, alone)).flatMap((e) => {
			const c = chainOf(e.pr);
			return c ? [{ tip: e, chain: c }] : [];
		});

	let cands = chains(false);
	if (cands.length) {
		const first = cands[0];
		if (first.tip.priority === 'urgent') return { batch: first.chain, express: true, held };
		const batch: number[] = [];
		for (const { chain } of cands) {
			const add = chain.filter((n) => !batch.includes(n));
			if (batch.length && batch.length + add.length > config.maxBatch) continue;
			batch.push(...add);
			if (batch.length >= config.maxBatch) break;
		}
		return { batch, express: false, held };
	}
	cands = chains(true);
	if (cands.length) {
		// The lowest PR of the stack not yet tried alone goes first, with only what's under it:
		// a fixing parent must not be tried only together with a breaking child.
		const { chain, tip } = cands[0];
		const batch = chain.slice(0, chain.findIndex((n) => !tried(n, true)) + 1);
		return { batch, express: tip.priority === 'urgent', held };
	}
	return { batch: null, express: false, held };
}
