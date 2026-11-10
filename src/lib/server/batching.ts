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
	/** Place in the queue's own order (moved by a person or "jump to front"); ties fall back to age. */
	position?: number;
}

/** Urgent first, then the queue's order, then the oldest. */
const byQueueOrder = (rank: (e: QueueEntry) => number) => (a: QueueEntry, b: QueueEntry) =>
	rank(a) - rank(b) || (a.position ?? 0) - (b.position ?? 0) || a.enqueuedAt - b.enqueuedAt || a.pr - b.pr;

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

/** Picks the next batch: urgent first, then in line order; stacks in parent-before-child order. */
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

	const ordered = [...admitted.values()].sort(byQueueOrder((e) => PRIORITY_RANK[effective.get(e.pr)!]));
	// An urgent PR gets an express batch of urgent PRs only, and the next batch is built on top of
	// it: alone, it gets a clean result in one run (in a big batch it is split with its neighbours
	// for several rounds), and the batch on top of it loses nothing when it passes.
	const express = effective.get(ordered[0].pr) === 'urgent';
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

/** A test run of a bisection: `members` on top of `context`, on the default branch at `baseTree`. */
export interface BisectRun {
	context: number[];
	members: number[];
	baseTree: string;
	result: 'pending' | 'success' | 'failure';
}

export type BisectPlan =
	/** A run passed on the current default branch: land its PRs now, before anything else. */
	| { kind: 'land'; run: number; prs: number[] }
	| {
			kind: 'step';
			/** PRs shown to fail alone, with the run that shows it. */
			eject: { pr: number; reason: string; run: number }[];
			/** Groups to test now, each alone on the current default branch. */
			start: number[][];
			/** PRs the bisection can't place: back to the queue. */
			requeue: number[];
			/** Nothing is left to test or land. */
			done: boolean;
	  };

/**
 * One step of finding the PRs that broke a failed batch, from what the runs so far showed. Pure
 * and stateless, so it is planned again from the recorded runs on every tick (and after a restart).
 *
 * - A run that passed on the current default branch lands right away; the rest bisects on top of it.
 * - A failed run shows that its PRs (those still left) hold a breaker, whichever branch it ran on.
 *   Each such group is split in two (stacks kept whole) and both halves run on the current branch.
 * - A PR is ejected only when it failed alone, never by inference: a flake can't eject an innocent PR.
 * - PRs no failure points at (a half that passed on an older branch, the rest of a group explained
 *   by a smaller failing one) run together on the current branch, and land if they pass.
 *
 * `runs` includes the failed batch itself; `remaining` are the PRs still to land or eject, in order.
 */
export function planBisection(input: {
	runs: BisectRun[];
	remaining: number[];
	masterTree: string;
	parentOf: (n: number) => number | null;
	/**
	 * Default-branch trees known green, on which a PR failing alone is its own fault: the current
	 * one once settled, the batch's own base, trees this bisection landed. By default only the current.
	 */
	trusted?: (tree: string) => boolean;
}): BisectPlan {
	const { runs, masterTree, parentOf } = input;
	const trusted = input.trusted ?? ((t: string) => t === masterTree);
	const left = new Set(input.remaining);
	const order = input.remaining;
	const inOrder = (s: Set<number>) => order.filter((n) => s.has(n));
	/** A group can be tested (and landed) alone: no PR in it sits on a PR still left outside it. */
	const whole = (g: number[]) => {
		const set = new Set(g);
		return g.every((n) => {
			for (let p = parentOf(n); p !== null; p = parentOf(p)) if (left.has(p) && !set.has(p)) return false;
			return true;
		});
	};
	const same = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => n === b[i]);
	const current = (g: number[]) => runs.findIndex((r) => r.baseTree === masterTree && r.context.length === 0 && same(r.members, g));

	// 1. Land a group that passed on exactly this default branch: the one first in queue order (the
	// larger one of two that start alike), so the queue's order holds where it can.
	const first = (g: number[]) => Math.min(...g.map((n) => order.indexOf(n)));
	let best = -1;
	runs.forEach((r, i) => {
		if (r.result !== 'success' || r.baseTree !== masterTree || r.context.length || !r.members.length) return;
		if (!r.members.every((n) => left.has(n)) || !whole(r.members)) return;
		const b = best < 0 ? null : runs[best].members;
		if (!b || first(r.members) < first(b) || (first(r.members) === first(b) && r.members.length > b.length)) best = i;
	});
	if (best >= 0) return { kind: 'land', run: best, prs: runs[best].members };

	// 2. Failing groups: what's left of each failed run; a group that contains a smaller failing
	// group is explained by it, so only disjoint, smallest ones are narrowed.
	const failing: { set: Set<number>; run: number }[] = [];
	runs
		.map((r, i) => ({ set: new Set(r.members.filter((n) => left.has(n))), run: i, ok: r.result !== 'failure' }))
		.filter((f) => !f.ok && f.set.size > 0)
		// A later run with all of them that passed outweighs it: the failure was a flake, or came from
		// PRs that have landed or left since (if they still fail on top of what landed, a run says so).
		.filter((f) => !runs.some((r, i) => i > f.run && r.result === 'success' && [...f.set].every((n) => r.members.includes(n))))
		.sort((a, b) => a.set.size - b.set.size || a.run - b.run)
		.forEach((f) => {
			if (failing.some((g) => [...g.set].some((n) => f.set.has(n)))) return;
			failing.push(f);
		});

	const eject: { pr: number; reason: string; run: number }[] = [];
	const start: number[][] = [];
	const busy = new Set(runs.filter((r) => r.result === 'pending').flatMap((r) => r.members));
	const want = (g: number[]) => {
		// Wait for a run still going with any of these PRs: its failure narrows them down.
		if (g.some((n) => busy.has(n))) return;
		if (current(g) >= 0) return;
		start.push(g);
	};
	const suspects = new Set<number>();
	for (const f of failing) {
		const g = inOrder(f.set);
		for (const n of g) suspects.add(n);
		if (g.length === 1) {
			// Eject only on a run of this PR alone (on top of its passing context, if any), on a branch
			// known green; on any other, it runs alone again on the current one.
			const alone = runs.findIndex((r) => r.result === 'failure' && same(r.members, g) && trusted(r.baseTree));
			if (alone >= 0) {
				const ctx = runs[alone].context;
				eject.push({
					pr: g[0],
					reason: ctx.length
						? `#${g[0]} fails when combined with ${ctx.map((c) => `#${c}`).join(', ')}`
						: `#${g[0]} fails on its own on top of the default branch`,
					run: alone
				});
			} else if (whole(g)) want(g);
			continue;
		}
		const { left: a, right: b, independent } = splitPoint(g, parentOf);
		want(a);
		// A right half stacked on the left can only run once the left landed (it is then whole).
		if (independent) want(b);
	}

	// 3. Everything no failure points at runs together on the current branch, so it can land.
	const ejected = new Set(eject.map((e) => e.pr));
	const gone = (n: number) => {
		for (let p: number | null = n; p !== null; p = parentOf(p)) if (ejected.has(p)) return true;
		return false;
	};
	const rest = order.filter((n) => !suspects.has(n) && !gone(n));
	const clear = rest.filter((n) => {
		for (let p = parentOf(n); p !== null; p = parentOf(p)) if (suspects.has(p)) return false;
		return true;
	});
	if (clear.length) want(clear);

	const pending = runs.some((r) => r.result === 'pending');
	const stuck = !start.length && !eject.length && !pending;
	// Nothing to run and nothing running: what's left can't be placed (e.g. waits on a parent that
	// left); the queue takes it from here.
	const requeue = stuck ? order.filter((n) => !gone(n)) : [];
	return { kind: 'step', eject, start, requeue, done: stuck || order.every((n) => gone(n)) };
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
				if (!held.some((h) => h.pr === n)) held.push({
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
	const ordered = [...ok.values()].sort(byQueueOrder((e) => PRIORITY_RANK[e.priority]));
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
