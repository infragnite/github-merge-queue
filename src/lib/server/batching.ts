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

/**
 * How much the queue comments on PRs: every notice, only the ones that ask someone to act (a hold,
 * a conflict, an ejection), or none. Statuses and labels are set either way.
 */
export type CommentMode = 'all' | 'attention' | 'none';
export const COMMENT_MODES: CommentMode[] = ['all', 'attention', 'none'];

export interface BatchConfig {
	/** Most PRs in a normal batch. */
	maxBatch: number;
	/** How long to wait for a fuller batch before testing a partial one. */
	collectWindowMs: number;
	/** Batches in flight at once, each built on the one before it. */
	depth: number;
	/** Only approved PRs may enter a batch. */
	requireApproval: boolean;
	/** The approval must be on the PR's current head, not an earlier push. */
	approvalOnHead: boolean;
	/** Restack PRs whose parent was rebased or merged when that needs no conflict resolution. */
	autoRebase: boolean;
	/** A batch whose CI has not finished after this long pauses the queue. */
	ciTimeoutMs: number;
	/**
	 * A PR whose own `requiredCheck` failed on its head is held; one still running is not. Off by default: the batch run is the
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
	/**
	 * Count a run of several PRs as failed at its first failed job and cancel the rest, instead of
	 * waiting for every job: a failure only has to be narrowed down, and the rest of the run would
	 * hold runners for nothing. A PR's run alone, whose failure ejects it, still runs to the end, so
	 * its author sees every failure.
	 */
	stopOnFirstFailure: boolean;
	/** At least this long between those runs (0: one per landed batch). */
	masterRunMinGapMs: number;
	/**
	 * Bisection runs of one failed batch tested at once; the rest wait their turn. One by default:
	 * two groups expected to pass can't both land on the branch they ran on, and one by one every
	 * run is built on what the one before it landed.
	 */
	bisectRuns: number;
	/** Which notices are posted as PR comments; see `CommentMode`. */
	comments: CommentMode;
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
	maxBatch: 8,
	collectWindowMs: 60 * 60 * 1000,
	depth: 2,
	requireApproval: true,
	approvalOnHead: true,
	autoRebase: true,
	ciTimeoutMs: 12 * 60 * 60 * 1000,
	requirePRChecks: false,
	masterRun: true,
	retryFailed: true,
	stopOnFirstFailure: true,
	masterRunMinGapMs: 0,
	bisectRuns: 1,
	comments: 'all'
};

export type AdmissionCode =
	| 'draft'
	| 'not-fetched'
	| 'ci-failed'
	| 'not-approved'
	| 'stale-approval'
	| 'changes-requested'
	| 'stack-broken'
	| 'parent-not-ready'
	| 'wrong-base';

/** Why the planner holds a queued PR: its own admission, a known conflict, or its stack. */
export type HoldCode = AdmissionCode | 'conflict' | 'workflow-permission' | 'failed' | 'deferred' | 'parent-not-queued' | 'parent-held';

const EVERY_HOLD: Record<HoldCode, true> = {
	draft: true,
	'not-fetched': true,
	'ci-failed': true,
	'not-approved': true,
	'stale-approval': true,
	'changes-requested': true,
	'stack-broken': true,
	'parent-not-ready': true,
	'wrong-base': true,
	conflict: true,
	'workflow-permission': true,
	failed: true,
	deferred: true,
	'parent-not-queued': true,
	'parent-held': true
};

/** Every hold code: stable ids, shown on the PR and in its hidden block, so agents can switch on them. */
export const HOLD_CODES = Object.keys(EVERY_HOLD) as HoldCode[];

/** The one thing a held PR's author does about its hold, as a sentence. Empty: there is nothing to do, so nothing is said. */
export function holdAdvice(code: HoldCode): string {
	switch (code) {
		case 'draft':
			return 'Mark it ready for review.';
		case 'ci-failed':
			return 'Fix the failing checks and push.';
		case 'not-approved':
			return 'Get an approving review.';
		case 'stale-approval':
			return 'Get it approved again on its current head.';
		case 'changes-requested':
			return 'Address them, then get the review approved or dismissed.';
		case 'stack-broken':
			return 'Rebase it onto the current head of the PR it builds on.';
		case 'wrong-base':
			return 'Point its base at the default branch, or at the branch of the queued PR it builds on.';
		case 'parent-not-queued':
			return 'Queue the PR it builds on; a stacked PR goes only with the PRs under it.';
		case 'conflict':
			return 'Rebase it and push:';
		case 'workflow-permission':
			return 'A repository admin grants the app the Workflows: Read and write permission; then push to retry.';
		case 'failed':
			return 'Fix the failure and push.';
		// Nothing the author can do: it waits for other PRs, or for the queue itself.
		case 'deferred':
		case 'parent-held':
		case 'parent-not-ready':
		case 'not-fetched':
			return '';
	}
}

export interface Hold {
	ok: false;
	code: HoldCode;
	reason: string;
}

export type Admission =
	| { ok: true }
	| {
			ok: false;
			code: AdmissionCode;
			reason: string;
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
	if (state.draft) return { ok: false, code: 'draft', reason: 'Draft' };

	// Checks still running don't hold a PR: the batch's own CI tests it.
	if (state.ciGreen === false) {
		return { ok: false, code: 'ci-failed', reason: 'Its own checks failed on its head' };
	}

	if (config.requireApproval) {
		if (state.changesRequested) {
			return { ok: false, code: 'changes-requested', reason: 'Changes requested' };
		}
		if (state.approvedShas.length === 0) {
			return { ok: false, code: 'not-approved', reason: 'Not approved' };
		}
		if (config.approvalOnHead && !state.approvedShas.includes(state.headSha)) {
			return {
				ok: false,
				code: 'stale-approval',
				reason: `Approved on an earlier push; approve its current head ${state.headSha.slice(0, 7)}`
			};
		}
	}

	if (state.fromFork && !state.approvedShas.includes(state.headSha)) {
		// Batches run in this repo's CI, with its secrets and runners: outside code needs a writer's look first.
		return { ok: false, code: 'not-approved', reason: 'From a fork; a writer must approve its head first' };
	}

	const info = analysis.prs.get(n);
	const own = info ? stopper(info) : null;
	if (own) return { ok: false, code: 'stack-broken', reason: own };
	if (state.targetsDefault === false && (info?.parent ?? null) === null) {
		// Only the default branch is batched; a PR into another branch is merged some other way.
		return { ok: false, code: 'wrong-base', reason: 'Does not target the default branch' };
	}
	if (state.fromFork && (info?.parent ?? null) !== null) {
		// Landing a stacked child restacks and pushes its branch, which the queue can't do in a fork.
		return { ok: false, code: 'wrong-base', reason: 'Stacked on another PR from a fork; retarget it to the default branch once its parent lands' };
	}
	if (info) {
		for (let p = info.parent; p !== null; ) {
			const up = analysis.prs.get(p);
			if (!up) break;
			if (stopper(up)) {
				return {
					ok: false,
					code: 'parent-not-ready',
					reason: `The stack under it is broken at #${p}`
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
	held: { pr: number; admission: Hold }[];
	/** The priority each queued PR was planned at, after stack inheritance. */
	effectivePriority: Map<number, Priority>;
}

/** Parent PR by ancestry while it's still open, else null. */
function openParent(analysis: StackAnalysis, n: number): number | null {
	const p = analysis.prs.get(n)?.parent ?? null;
	return p !== null && analysis.prs.has(p) ? p : null;
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
/**
 * The head of `batch` that a passed `try` run already tested on this default branch, or null. A
 * try tests one PR's head alone on the default branch, and a stacked PR's head carries its
 * parents' commits, so a try of `n` stands for `n` with its ancestors: the prefix must be exactly
 * those, at the start of the batch (nothing else under it), and keep its stack whole (no PR behind
 * it in the batch sits on it). The first such prefix wins; the caller still checks that building it
 * gives the tree the try tested.
 */
export function triedPrefix(batch: number[], parentOf: (n: number) => number | null, passed: (n: number) => boolean): number[] | null {
	for (let k = 1; k <= batch.length; k++) {
		const n = batch[k - 1];
		if (!passed(n)) continue;
		const prefix = batch.slice(0, k);
		const ancestors = new Set<number>();
		for (let p = parentOf(n), i = 0; p !== null && i < batch.length; p = parentOf(p), i++) ancestors.add(p);
		if (!prefix.every((m) => m === n || ancestors.has(m))) continue;
		const inPrefix = new Set(prefix);
		const splits = batch.slice(k).some((m) => {
			for (let p = parentOf(m), i = 0; p !== null && i < batch.length; p = parentOf(p), i++) if (inPrefix.has(p)) return true;
			return false;
		});
		if (!splits) return prefix;
	}
	return null;
}

export interface TestGroup {
	context: number[];
	members: number[];
}

/**
 * Whether a group of `k` PRs known to fail is narrowed down faster by running each PR alone than
 * by halving it, when each PR breaks with probability `p`. Expected runs, under the queue's rules
 * (a PR is ejected only on a run of it alone; a passing half lands; the other half is then known
 * to fail): halving wins on large groups with few breakers, running alone on small groups or when
 * breakers are common (from about 30%, on any size). So bisection never costs more than one run
 * per PR.
 */
export function aloneIsCheaper(k: number, p: number): boolean {
	if (k <= 1) return true;
	const q = 1 - Math.min(Math.max(p, 0.001), 0.999);
	// U: runs for k PRs not known to fail (one run together; if it fails, P). P: known to fail.
	const U = [0, 1];
	const P = [0, 1];
	let alone = true;
	for (let n = 2; n <= k; n++) {
		const a = Math.ceil(n / 2);
		const b = n - a;
		const pa = (1 - q ** a) / (1 - q ** n);
		const halve = 1 + pa * ((a === 1 ? 0 : P[a]) + U[b]) + (1 - pa) * P[b];
		alone = n <= halve;
		P[n] = Math.min(n, halve);
		U[n] = 1 + (1 - q ** n) * P[n];
	}
	return alone;
}

/**
 * Splits a failing group in two for bisection. A batch has no order of its own, so the halves
 * are balanced by size: each stack (a PR with what it sits on, or what sits on it, in the group)
 * is a unit that stays whole. Stacks are dealt largest first to the lighter half, then single PRs
 * fill the first half in queue order up to half the group, so the halves differ by at most one
 * PR unless a stack is bigger than the rest. A group that is one stack is cut at a prefix
 * (`independent` false: the right half can only run once the left landed).
 */
export function splitPoint(
	members: number[],
	parentOf: (n: number) => number | null
): { left: number[]; right: number[]; independent: boolean } {
	const set = new Set(members);
	// Each PR's unit is its topmost ancestor in the group (through ancestors outside it, too).
	const rootOf = (n: number) => {
		let r = n;
		for (let p = parentOf(n), seen = 0; p !== null && seen <= members.length; p = parentOf(p), seen++) if (set.has(p)) r = p;
		return r;
	};
	const units = new Map<number, number[]>();
	for (const n of members) {
		const r = rootOf(n);
		units.set(r, [...(units.get(r) ?? []), n]);
	}
	if (units.size === 1) {
		const mid = Math.floor(members.length / 2);
		return { left: members.slice(0, mid), right: members.slice(mid), independent: false };
	}
	// Stacks go largest first to the lighter half; single PRs then fill the first half in queue
	// order up to half the group, the rest go to the second.
	const left = new Set<number>();
	let leftSize = 0;
	let rightSize = 0;
	const stacks = [...units.values()].filter((u) => u.length > 1).sort((a, b) => b.length - a.length);
	for (const u of stacks) {
		if (leftSize <= rightSize) {
			for (const n of u) left.add(n);
			leftSize += u.length;
		} else rightSize += u.length;
	}
	for (const u of units.values()) {
		if (u.length > 1) continue;
		if (2 * (leftSize + 1) <= members.length) {
			left.add(u[0]);
			leftSize++;
		}
	}
	return { left: members.filter((n) => left.has(n)), right: members.filter((n) => !left.has(n)), independent: true };
}

/**
 * A failing stack that forks splits along its paths: the PRs under the first fork go in both
 * halves, the branches above it are shared out between them. Each half is a tree that can be
 * built, and a half that passes lands with the shared part, leaving the other branch as the
 * suspect. Null when `members` has no fork.
 */
export function forkSplit(members: number[], parentOf: (n: number) => number | null): { left: number[]; right: number[] } | null {
	const set = new Set(members);
	const kids = (n: number) => members.filter((m) => parentOf(m) === n);
	const under = (n: number): number[] => [n, ...kids(n).flatMap(under)];
	for (const f of members) {
		const branches = kids(f);
		if (branches.length < 2) continue;
		// Only a fork with nothing else beside it: the shared part is `f` and the PRs under it.
		const shared: number[] = [];
		for (let p: number | null = f; p !== null && set.has(p); p = parentOf(p)) shared.push(p);
		const subtrees = branches.map(under);
		if (shared.length + subtrees.flat().length !== members.length) continue;
		// Branches are shared out by size, in queue order, so both halves test about as much.
		const total = subtrees.flat().length;
		const a = new Set(shared);
		let size = 0;
		for (const t of subtrees) {
			if (size > 0 && size + t.length > total / 2) break;
			for (const n of t) a.add(n);
			size += t.length;
		}
		const left = members.filter((n) => a.has(n));
		const right = members.filter((n) => !a.has(n) || shared.includes(n));
		return { left, right };
	}
	return null;
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
 * - Runs go one step at a time: nothing starts while a run is going, since it may land and move the
 *   branch. A pass still lands, and a PR that failed alone is still ejected, as soon as it shows.
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
	/**
	 * Most runs in one step (unlimited by default). Those to start are taken in turn: first what
	 * is expected to pass and land, then PRs to retry alone, then both halves of each failing group,
	 * smallest group first, and last what no failure points at but never passed.
	 */
	slots?: number;
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
	// A PR that failed alone on a trusted branch and is gone (ejected) explains every failed run it
	// was in: the rest of such a run is no longer pointed at, and runs with everything else.
	const proven = new Set(
		runs.filter((r) => r.result === 'failure' && r.members.length === 1 && !left.has(r.members[0]) && trusted(r.baseTree)).map((r) => r.members[0])
	);
	/** `n` or a PR it is stacked on was ejected: it leaves with it. */
	const provenUnder = (n: number) => {
		for (let p: number | null = n; p !== null; p = parentOf(p)) if (proven.has(p)) return true;
		return false;
	};
	const failing: { set: Set<number>; run: number }[] = [];
	runs
		.map((r, i) => ({ set: new Set(r.members.filter((n) => left.has(n))), run: i, ok: r.result !== 'failure' || r.members.some((n) => proven.has(n)) }))
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
	// Groups to run, in the order they take free slots: what is expected to pass, PRs to retry
	// alone, then both halves of each failing group, smallest group first.
	const clearRun: number[][] = [];
	const retryAlone: number[][] = [];
	// The halves of each failing group, which narrow it.
	const splits: number[][][] = [];
	const busy = new Set(runs.filter((r) => r.result === 'pending').flatMap((r) => r.members));
	/** Whether `g` should run now. */
	const want = (g: number[]) => {
		// Wait for a run still going with any of these PRs: its failure narrows them down.
		if (g.some((n) => busy.has(n))) return false;
		return current(g) < 0;
	};
	const suspects = new Set<number>();
	// PRs some run passed with (on any branch), and whose ancestors here did too: those are
	// pooled and split apart from PRs that never passed, which only an explained failure cleared.
	const passedWith = new Set(runs.filter((r) => r.result === 'success').flatMap((r) => [...r.context, ...r.members]));
	const passed = (n: number, among: Set<number>) => {
		for (let p: number | null = n; p !== null; p = parentOf(p)) if (among.has(p) && !passedWith.has(p)) return false;
		return true;
	};
	/** `g` split into what passed before and what never did, when it holds both. */
	const byEvidence = (g: number[]) => {
		const set = new Set(g);
		const a = g.filter((n) => passed(n, set));
		const b = g.filter((n) => !a.includes(n));
		if (!a.length || !b.length) return null;
		const inA = new Set(a);
		const independent = b.every((n) => {
			for (let p = parentOf(n); p !== null; p = parentOf(p)) if (inA.has(p)) return false;
			return true;
		});
		return { left: a, right: b, independent };
	};
	// How often a PR of this batch breaks, from what the runs showed: each failing group and each
	// ejected PR holds a breaker, each PR in a passing run none (with a prior of one in ten).
	const breakers = proven.size + failing.length;
	const breakRate = (breakers + 1) / (breakers + passedWith.size + 10);
	for (const f of failing) {
		const g = inOrder(f.set);
		for (const n of g) suspects.add(n);
		// Small groups, or many breakers: each PR runs alone (one at a time; the first to fail alone
		// is ejected and explains the group's failure), which then costs no more than one run per PR.
		// Not where some passed before: those are split off by evidence and pooled to land.
		const set = new Set(g);
		const fresh = g.every((n) => !passedWith.has(n)) && g.every((n) => parentOf(n) === null || !set.has(parentOf(n)!));
		// With a few slots, halves run side by side and narrow faster than single PRs a few at a time.
		const slots = input.slots ?? Infinity;
		if (g.length > 1 && fresh && (slots === 1 || slots >= g.length) && aloneIsCheaper(g.length, breakRate)) {
			for (const n of g) if (whole([n]) && want([n])) retryAlone.push([n]);
			continue;
		}
		if (g.length === 1) {
			// Eject only on a run of this PR alone (on top of its passing context, if any), on a branch
			// known green; on any other, it runs alone again on the current one.
			const alone = runs.findIndex((r) => r.result === 'failure' && same(r.members, g) && trusted(r.baseTree));
			if (alone >= 0) {
				const ctx = runs[alone].context;
				eject.push({
					pr: g[0],
					reason: ctx.length
						? `Fails when combined with ${ctx.map((c) => `#${c}`).join(', ')}`
						: `Fails on its own on top of the default branch`,
					run: alone
				});
			} else if (whole(g) && want(g)) retryAlone.push(g);
			continue;
		}
		// What passed before goes in one half, so it can land without what never did. A fork splits
		// along its paths, which can run side by side: the group failed, so (barring an interaction)
		// at most one path passes and lands, and the other keeps narrowing. Otherwise at a prefix.
		const evidence = byEvidence(g);
		const fork = evidence ? null : forkSplit(g, parentOf);
		let { left: a, right: b, independent } = evidence ?? (fork ? { ...fork, independent: true } : splitPoint(g, parentOf));
		// Never where the split keeps what passed apart from what never did: that pool lands first.
		if (!evidence && !fork && !independent) {
			// The prefix would run alone. Where another branch of it waits outside the group, untested
			// with it, the prefix runs with that branch instead: a pass lands both and leaves the
			// rest of the group as the suspect; a failure points at the prefix, which then runs alone.
			const inA = new Set(a);
			const above = (n: number) => {
				for (let p = parentOf(n); p !== null; p = parentOf(p)) if (inA.has(p)) return true;
				return false;
			};
			const branch = order.filter((n) => left.has(n) && !set.has(n) && !failing.some((o) => o.set.has(n)) && !provenUnder(n) && above(n));
			const path = inOrder(new Set([...a, ...branch]));
			const failedWith = runs.some((r) => r.result === 'failure' && r.members.every((n) => !left.has(n) || path.includes(n)) && r.members.some((n) => branch.includes(n)));
			if (branch.length && branch.length >= a.length && !failedWith && whole(path)) a = path;
		}
		const halves = [a, ...(independent ? [b] : [])].filter(want);
		// A right half stacked on the left can only run once the left landed (it is then whole).
		if (halves.length) splits.push(halves);
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
	// What passed before runs first, together; what never passed (its failures explained by an
	// ejected PR) runs after it, apart, so it can't hold the others back. Stacked on what passed,
	// it waits until that landed.
	const split = byEvidence(clear);
	for (const g of split ? [split.left, split.right] : [clear]) if (g.length && whole(g) && want(g)) clearRun.push(g);
	// Every group made only of PRs that passed is expected to pass and land: they run first, as one
	// run (one landing for all), unless that very run already failed on this branch; then apart.
	const expected = (g: number[]) => g.every((n) => passedWith.has(n));
	// Both halves of a split take slots together, the smallest failing group's first: one half
	// lands and the other keeps narrowing, and the smallest group settles soonest.
	const narrowing = splits.sort((x, y) => x.flat().length - y.flat().length).flat();
	const groups = [...clearRun, ...narrowing];
	const passing = groups.filter(expected);
	const pool = inOrder(new Set(passing.flat()));
	const lead = passing.length > 1 && whole(pool) && want(pool) ? [pool] : passing;
	// Then PRs to retry alone, the halves that narrow a failure, and last what no failure points at
	// but never passed.
	const start = [...lead, ...retryAlone, ...narrowing.filter((g) => !expected(g)), ...clearRun.filter((g) => !expected(g))];
	const pending = runs.some((r) => r.result === 'pending');
	// One step at a time: a run still going may pass, land and move the default branch, which would
	// leave runs started beside it on a branch that is gone. The next step waits for every run going.
	if (pending) start.length = 0;
	else if (input.slots !== undefined) start.splice(input.slots);

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
						reason: queued.has(p) ? `Stacked on #${p}, which can't be batched yet` : `Stacked on #${p}, which isn't merged or queued; queue #${p} first`
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
