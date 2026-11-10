import { afterEach, describe, expect, test } from 'vitest';
import {
	aloneIsCheaper,
	admit,
	planBisection,
	type BisectRun,
	DEFAULT_BATCH_CONFIG,
	descendants,
	splitPoint,
	forkSplit,
	type BatchConfig,
	type PRState,
	type Priority,
	type QueueEntry
} from './batching';
import { planNextBatch } from './queue-model';
import { analyzeStacks, type PRStackInfo, type StackAnalysis, type StackIssue } from './stacks';
import { GitSandbox } from './testing/git-sandbox';

const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-09T12:00:00Z');

/** A hand-built stack analysis: `parents` maps child -> parent among open PRs. */
function stacks(open: number[], parents: Record<number, number> = {}, issues: StackIssue[] = []): StackAnalysis {
	const prs = new Map<number, PRStackInfo>();
	for (const n of open) {
		prs.set(n, {
			number: n,
			parent: parents[n] ?? null,
			link: parents[n] ? 'healthy' : null,
			children: [],
			depth: 0,
			expectedBase: 'main',
			issues: issues.filter((i) => i.pr === n),
			broken: false
		});
	}
	for (const info of prs.values()) if (info.parent !== null) prs.get(info.parent)?.children.push(info.number);
	for (const info of prs.values()) {
		let d = 0;
		for (let p = info.parent; p !== null; p = prs.get(p)?.parent ?? null) d++;
		info.depth = d;
		info.broken = info.issues.some((i) => i.severity === 'blocking');
	}
	for (const info of prs.values()) {
		for (let p = info.parent; p !== null; p = prs.get(p)?.parent ?? null) {
			if (prs.get(p)?.broken) info.broken = true;
		}
	}
	return { prs, stacks: [], issues };
}

function ready(pr: number, over: Partial<PRState> = {}): PRState {
	return {
		pr,
		headSha: `sha${pr}`,
		draft: false,
		ciGreen: true,
		approvedShas: [`sha${pr}`],
		changesRequested: false,
		...over
	};
}

function entry(pr: number, minutesAgo: number, priority: Priority = 'normal'): QueueEntry {
	return { pr, enqueuedAt: NOW - minutesAgo * MIN, priority };
}

function plan(
	queue: QueueEntry[],
	analysis: StackAnalysis,
	opts: { states?: PRState[]; inflight?: number[][]; config?: Partial<BatchConfig> } = {}
) {
	const states = new Map((opts.states ?? queue.map((e) => ready(e.pr))).map((s) => [s.pr, s]));
	return planNextBatch({
		now: NOW,
		queue,
		states,
		analysis,
		inflight: opts.inflight ?? [],
		config: { ...DEFAULT_BATCH_CONFIG, ...opts.config }
	});
}

describe('admission', () => {
	const a = stacks([1]);
	const cfg = DEFAULT_BATCH_CONFIG;

	test('an approved PR with green checks is admitted', () => {
		expect(admit(ready(1), a, cfg)).toEqual({ ok: true });
	});

	test('drafts and running checks wait; failed checks do not', () => {
		expect(admit(ready(1, { draft: true }), a, cfg)).toMatchObject({ ok: false, code: 'draft', wait: true });
		expect(admit(ready(1, { ciGreen: null }), a, cfg)).toMatchObject({ code: 'ci-pending', wait: true });
		expect(admit(ready(1, { ciGreen: false }), a, cfg)).toMatchObject({ code: 'ci-failed', wait: false });
	});

	test('requires an approval on the current head', () => {
		expect(admit(ready(1, { approvedShas: [] }), a, cfg)).toMatchObject({ code: 'not-approved' });
		expect(admit(ready(1, { approvedShas: ['old'] }), a, cfg)).toMatchObject({ code: 'stale-approval' });
		expect(admit(ready(1, { approvedShas: ['old'] }), a, { ...cfg, approvalOnHead: false })).toEqual({ ok: true });
		expect(admit(ready(1, { changesRequested: true }), a, cfg)).toMatchObject({ code: 'changes-requested' });
	});

	test('approval can be switched off', () => {
		expect(admit(ready(1, { approvedShas: [] }), a, { ...cfg, requireApproval: false })).toEqual({ ok: true });
	});

	test('a rebased-under stack is refused, a child of a broken parent waits', () => {
		const issue: StackIssue = {
			kind: 'parent-rebased',
			pr: 2,
			parent: 1,
			severity: 'blocking',
			message: '#1 was rebased; restack #2'
		};
		const s = stacks([1, 2, 3], { 2: 1, 3: 2 }, [issue]);
		expect(admit(ready(2), s, cfg)).toMatchObject({ code: 'stack-broken', reason: '#1 was rebased; restack #2' });
		expect(admit(ready(3), s, cfg)).toMatchObject({ code: 'parent-not-ready', wait: true });
	});

	test('a hidden stack (base mismatch with a known parent) is admitted; a bogus base is not', () => {
		const known: StackIssue = { kind: 'base-mismatch', pr: 2, parent: 1, severity: 'blocking', message: 'm' };
		expect(admit(ready(2), stacks([1, 2], { 2: 1 }, [known]), cfg)).toEqual({ ok: true });
		const bogus: StackIssue = { kind: 'base-mismatch', pr: 2, parent: 1, severity: 'blocking', message: 'bogus' };
		expect(admit(ready(2), stacks([1, 2], {}, [bogus]), cfg)).toMatchObject({ code: 'stack-broken' });
	});
});

describe('planning a batch', () => {
	test('takes the oldest PRs up to the batch size', () => {
		const q = [10, 11, 12, 13, 14].map((n, i) => entry(n, 100 - i));
		const p = plan(q, stacks([10, 11, 12, 13, 14]), { config: { maxBatch: 3 } });
		expect(p.batch).toEqual([10, 11, 12]);
		expect(p.express).toBe(false);
	});

	test("follows the queue's own order within a priority, without making a moved PR urgent", () => {
		// #14 was moved to the front: it goes first among normal PRs, in a normal batch
		const q = [10, 11, 12, 13, 14].map((n, i) => ({ ...entry(n, 100 - i), position: n === 14 ? 0 : i + 1 }));
		const p = plan(q, stacks([10, 11, 12, 13, 14]), { config: { maxBatch: 3 } });
		expect(p.batch).toEqual([14, 10, 11]);
		expect(p.express).toBe(false);
	});

	test('waits for the collect window when the batch is not full', () => {
		const p = plan([entry(1, 10), entry(2, 5)], stacks([1, 2]));
		expect(p.batch).toBeNull();
		expect(p.waitUntil).toBe(NOW + 50 * MIN);
	});

	test('starts a partial batch once the oldest PR waited the whole window', () => {
		const p = plan([entry(1, 61), entry(2, 5)], stacks([1, 2]));
		expect(p.batch).toEqual([1, 2]);
	});

	test('a full batch starts at once', () => {
		const q = [1, 2, 3].map((n) => entry(n, 1));
		expect(plan(q, stacks([1, 2, 3]), { config: { maxBatch: 3 } }).batch).toEqual([1, 2, 3]);
	});

	test('does not start a batch past the pipeline depth', () => {
		const p = plan([entry(3, 90)], stacks([1, 2, 3]), { inflight: [[1], [2]] });
		expect(p.batch).toBeNull();
		expect(p.waitUntil).toBeNull();
	});

	test('unready PRs are held with their reason and skipped', () => {
		const q = [entry(1, 90), entry(2, 80), entry(3, 70)];
		const p = plan(q, stacks([1, 2, 3]), { states: [ready(1, { approvedShas: [] }), ready(2), ready(3)] });
		expect(p.batch).toEqual([2, 3]);
		expect(p.held).toEqual([{ pr: 1, admission: expect.objectContaining({ code: 'not-approved' }) }]);
	});

	test('urgent PRs go first, alone in an express batch, without waiting', () => {
		const q = [entry(1, 90), entry(2, 80), entry(3, 1, 'urgent')];
		const p = plan(q, stacks([1, 2, 3]));
		expect(p.batch).toEqual([3]);
		expect(p.express).toBe(true);
	});

	test('express batches hold at most expressMax urgent PRs', () => {
		const q = [entry(1, 3, 'urgent'), entry(2, 2, 'urgent'), entry(3, 1, 'urgent')];
		expect(plan(q, stacks([1, 2, 3])).batch).toEqual([1, 2]);
	});

	test('low priority goes after normal', () => {
		const q = [entry(1, 90, 'low'), entry(2, 80), entry(3, 70)];
		expect(plan(q, stacks([1, 2, 3]), { config: { maxBatch: 2 } }).batch).toEqual([2, 3]);
	});
});

describe('stacks in batches', () => {
	// 1 <- 2 <- 3, and 4 on its own
	const s = () => stacks([1, 2, 3, 4], { 2: 1, 3: 2 });

	test('a stack goes in parent-before-child order even if the child queued first', () => {
		const q = [entry(3, 90), entry(4, 85), entry(2, 80), entry(1, 70)];
		expect(plan(q, s()).batch).toEqual([1, 2, 3, 4]);
	});

	test('a child whose parent is not queued is held', () => {
		const p = plan([entry(2, 90), entry(4, 80)], s());
		expect(p.batch).toEqual([4]);
		expect(p.held).toEqual([
			{ pr: 2, admission: expect.objectContaining({ code: 'parent-not-queued', reason: "Stacked on #1, which isn't queued; queue #1 first" }) }
		]);
	});

	test('a child whose parent is held is held too', () => {
		const q = [entry(1, 90), entry(2, 80), entry(4, 70)];
		const p = plan(q, s(), { states: [ready(1, { ciGreen: null }), ready(2), ready(4)] });
		expect(p.batch).toEqual([4]);
		expect(p.held.map((h) => h.pr).sort()).toEqual([1, 2]);
	});

	test('a child may follow its parent into the next pipelined batch', () => {
		const p = plan([entry(2, 90)], s(), { inflight: [[1]] });
		expect(p.batch).toEqual([2]);
	});

	test('a child that does not fit with its parents waits; the parents may go ahead', () => {
		const q = [entry(4, 90), entry(3, 80), entry(2, 75), entry(1, 70)];
		// #3 needs #1 and #2 in front of it: 4 PRs don't fit in a batch of 3
		expect(plan(q, s(), { config: { maxBatch: 3 } }).batch).toEqual([4, 1, 2]);
	});

	test('an urgent child lifts the stack under it into the express batch', () => {
		const q = [entry(4, 90), entry(1, 80), entry(2, 70), entry(3, 1, 'urgent')];
		const p = plan(q, s());
		expect(p.batch).toEqual([1, 2, 3]);
		expect(p.express).toBe(true);
		expect(p.effectivePriority.get(1)).toBe('urgent');
		expect(p.effectivePriority.get(4)).toBe('normal');
	});

	test('descendants of a PR include the whole subtree', () => {
		const t = stacks([1, 2, 3, 4, 5], { 2: 1, 3: 2, 5: 1 });
		expect([...descendants(t, [1])].sort()).toEqual([2, 3, 5]);
		expect([...descendants(t, [2])]).toEqual([3]);
	});
});

describe('split points', () => {
	const none = () => null;

	test('independent PRs split in the middle', () => {
		expect(splitPoint([1, 2, 3, 4], none)).toEqual({ left: [1, 2], right: [3, 4], independent: true });
	});

	test('keeps a stack whole and balances the halves around it', () => {
		// 2 <- 3: the stack is one unit of two; the halves are two and two
		const parent = (n: number) => (n === 3 ? 2 : null);
		expect(splitPoint([1, 2, 3, 4], parent)).toEqual({ left: [2, 3], right: [1, 4], independent: true });
	});

	test('batch 49: a stack spread through the queue still splits 7 | 8, not 4 | 11', () => {
		const members = [3342, 3039, 3296, 3309, 3241, 3308, 3364, 3365, 3334, 3366, 3358, 3286, 3234, 3356, 3352];
		const parent = (n: number) => (n === 3308 || n === 3286 ? 3241 : null);
		const { left, right, independent } = splitPoint(members, parent);
		expect({ left, right, independent }).toEqual({
			left: [3342, 3039, 3296, 3309, 3241, 3308, 3286],
			right: [3364, 3365, 3334, 3366, 3358, 3234, 3356, 3352],
			independent: true
		});
	});

	test('a stack over half the group goes alone, the rest in the other half', () => {
		const parent = (n: number) => (n >= 2 && n <= 5 ? n - 1 : null);
		expect(splitPoint([1, 2, 3, 4, 5, 6, 7], parent)).toEqual({ left: [1, 2, 3, 4, 5], right: [6, 7], independent: true });
	});

	test('two stacks go to different halves, singles even them out', () => {
		// 1 <- 2 <- 3 and 4 <- 5, with 6, 7 and 8 alone
		const parent = (n: number) => ({ 2: 1, 3: 2, 5: 4 })[n] ?? null;
		expect(splitPoint([1, 2, 3, 4, 5, 6, 7, 8], parent)).toEqual({ left: [1, 2, 3, 6], right: [4, 5, 7, 8], independent: true });
	});

	test('a stack whose middle is outside the group is still one unit', () => {
		// 1 <- 9 <- 2: 9 landed or sits elsewhere, 1 and 2 still go together
		const parent = (n: number) => ({ 2: 9, 9: 1 })[n] ?? null;
		expect(splitPoint([1, 3, 2, 4], parent)).toEqual({ left: [1, 2], right: [3, 4], independent: true });
	});

	test('the halves differ by at most one PR when every unit is small', () => {
		for (let n = 3; n <= 40; n++) {
			const members = Array.from({ length: n }, (_, i) => i + 1);
			// pairs 1 <- 2, 4 <- 5, ...: every third PR starts a stack of two
			const parent = (x: number) => (x % 3 === 2 ? x - 1 : null);
			const { left, right } = splitPoint(members, parent);
			expect(Math.abs(left.length - right.length)).toBeLessThanOrEqual(1);
			expect([...left, ...right].sort((x, y) => x - y)).toEqual(members);
			for (const x of right) expect(left).not.toContain(parent(x));
			for (const x of left) expect(right).not.toContain(parent(x));
		}
	});

	test('a single stack is cut at a prefix', () => {
		const parent = (n: number) => (n > 1 ? n - 1 : null);
		expect(splitPoint([1, 2, 3, 4], parent)).toEqual({ left: [1, 2], right: [3, 4], independent: false });
	});
});

/**
 * Drives a bisection the way the queue does, against an oracle: every group runs on top of what
 * landed so far, results come back together each round, a passing group lands at once, and stack
 * children leave with an ejected parent.
 */
function bisect(batch: number[], fails: (tested: number[]) => boolean, parentOf: (n: number) => number | null = () => null, slots?: number) {
	const runs: BisectRun[] = [{ context: [], members: batch, baseTree: '', result: 'failure' }];
	const land: number[] = [];
	const eject: { pr: number; reason: string }[] = [];
	const tested: { base: number[]; members: number[] }[] = [];
	let remaining = [...batch];
	let rounds = 0;
	/** Round in which each PR landed. */
	const landedIn = new Map<number, number>();
	for (let i = 0; i < 200; i++) {
		// Every base here is the batch's own or a tree the bisection landed: all known green.
		const step = planBisection({ runs, remaining, masterTree: land.join(','), parentOf, trusted: () => true, slots });
		if (step.kind === 'land') {
			expect(fails([...land, ...step.prs])).toBe(false);
			land.push(...step.prs);
			for (const n of step.prs) landedIn.set(n, rounds);
			remaining = remaining.filter((n) => !step.prs.includes(n));
			continue;
		}
		for (const e of step.eject) {
			eject.push({ pr: e.pr, reason: e.reason });
			remaining = remaining.filter((n) => n !== e.pr);
			// The queue ejects an ejected PR's stack children with it.
			for (const n of [...remaining]) {
				let p = parentOf(n);
				while (p !== null && p !== e.pr) p = parentOf(p);
				if (p === e.pr) {
					eject.push({ pr: n, reason: `Stacked on #${parentOf(n)}, which failed in the queue` });
					remaining = remaining.filter((m) => m !== n);
				}
			}
		}
		if (step.done) return { land, eject, requeue: step.requeue, runs: runs.length - 1, rounds, tested, landedIn };
		if (step.start.length) rounds++;
		for (const g of step.start) {
			tested.push({ base: [...land], members: g });
			runs.push({ context: [], members: g, baseTree: land.join(','), result: fails([...land, ...g]) ? 'failure' : 'success' });
		}
	}
	throw new Error('bisection did not finish');
}

describe('bisection', () => {
	const batch = [1, 2, 3, 4, 5, 6, 7, 8];

	test('one at a time, a batch of 8 with one breaker takes no more runs than all at once', () => {
		const all = bisect(batch, (t) => t.includes(6));
		const one = bisect(batch, (t) => t.includes(6), () => null, 1);
		expect(one.eject.map((e) => e.pr)).toEqual([6]);
		expect([...one.land].sort()).toEqual([1, 2, 3, 4, 5, 7, 8]);
		expect(one.runs).toBeLessThanOrEqual(all.runs);
	});

	test('finds one breaker in a batch of 8, landing each passing half as soon as it passes', () => {
		const r = bisect(batch, (t) => t.includes(6));
		expect(r.eject).toEqual([{ pr: 6, reason: '#6 fails on its own on top of the default branch' }]);
		expect([...r.land].sort()).toEqual([1, 2, 3, 4, 5, 7, 8]);
		expect(r.requeue).toEqual([]);
		// 1-4 pass in the first round and land then; 5-8 narrow down on top of them.
		expect([1, 2, 3, 4].map((n) => r.landedIn.get(n))).toEqual([1, 1, 1, 1]);
		expect(r.rounds).toBe(3);
		expect(r.runs).toBeLessThanOrEqual(6);
	});

	test('a passing half lands first and the failing half is narrowed on top of it', () => {
		const r = bisect(batch, (t) => t.includes(2));
		expect(r.land.slice(0, 4)).toEqual([5, 6, 7, 8]);
		expect(r.tested.filter((t) => t.members.includes(2)).every((t) => t.base[0] === 5 || t.base.length === 0)).toBe(true);
		expect(r.eject.map((e) => e.pr)).toEqual([2]);
	});

	test('finds two breakers in different halves', () => {
		const r = bisect(batch, (t) => t.includes(2) || t.includes(7));
		expect(r.eject.map((e) => e.pr).sort()).toEqual([2, 7]);
		expect([...r.land].sort()).toEqual([1, 3, 4, 5, 6, 8]);
	});

	test('finds a semantic conflict between two PRs that pass alone', () => {
		// #3 adds a field, #6 adds an initializer without it: only the pair fails
		const r = bisect(batch, (t) => t.includes(3) && t.includes(6));
		expect(r.eject).toEqual([{ pr: 6, reason: '#6 fails on its own on top of the default branch' }]);
		expect([...r.land].sort()).toEqual([1, 2, 3, 4, 5, 7, 8]);
	});

	test('a flaky batch failure ejects nobody: both halves pass and land', () => {
		const r = bisect(batch, () => false);
		expect(r.eject).toEqual([]);
		expect([...r.land].sort()).toEqual(batch);
		expect(r.rounds).toBe(2);
	});

	test('a failing stack that forks is split along its paths, the shared PR in both', () => {
		// #1 with two branches on it, #2 and #3: one of the three breaks.
		const parent = (n: number) => (n === 1 ? null : 1);
		const runsOf = (r: ReturnType<typeof bisect>) => r.tested.map((t) => t.members);
		// A broken branch: the other path lands, the broken one runs alone and is ejected.
		const b3 = bisect([1, 2, 3], (t) => t.includes(3), parent, 1);
		expect(runsOf(b3)).toEqual([[1, 2], [3]]);
		expect([b3.land, b3.eject.map((e) => e.pr)]).toEqual([[1, 2], [3]]);
		// The path tested first is broken: the other one is tried before the shared PR alone.
		const b2 = bisect([1, 2, 3], (t) => t.includes(2), parent, 1);
		expect(runsOf(b2)).toEqual([[1, 2], [1, 3], [2]]);
		expect([b2.land, b2.eject.map((e) => e.pr)]).toEqual([[1, 3], [2]]);
		// Both paths fail: the shared PR runs alone, and takes both branches with it.
		const b1 = bisect([1, 2, 3], (t) => t.includes(1), parent, 1);
		expect(runsOf(b1)).toEqual([[1, 2], [1, 3], [1]]);
		expect([b1.land, b1.eject.map((e) => e.pr).sort()]).toEqual([[], [1, 2, 3]]);
	});

	test('a shared PR that passed before runs alone, not with a branch that never passed', () => {
		const parent = (n: number) => (n === 1 ? null : 1);
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3], baseTree: 'm', result: 'failure' },
			{ context: [], members: [1, 2], baseTree: 'm', result: 'failure' },
			{ context: [], members: [1], baseTree: 'older', result: 'success' }
		];
		expect(planBisection({ runs, remaining: [1, 2, 3], masterTree: 'm', parentOf: parent, slots: 1 })).toMatchObject({ start: [[1]] });
	});

	test('with free slots, both paths of a failing fork run side by side; with one slot, one at a time', () => {
		const parent = (n: number) => (n === 1 ? null : 1);
		const runs: BisectRun[] = [{ context: [], members: [1, 2, 3], baseTree: 'm', result: 'failure' }];
		expect(planBisection({ runs, remaining: [1, 2, 3], masterTree: 'm', parentOf: parent, slots: 2 })).toMatchObject({ start: [[1, 2], [1, 3]] });
		expect(planBisection({ runs, remaining: [1, 2, 3], masterTree: 'm', parentOf: parent, slots: 1 })).toMatchObject({ start: [[1, 2]] });
	});

	test('forkSplit shares out the branches above the first fork, with the PRs under it in both halves', () => {
		const parent = (n: number) => ({ 2: 1, 3: 2, 4: 2, 5: 4 })[n] ?? null;
		expect(forkSplit([1, 2, 3, 4, 5], parent)).toEqual({ left: [1, 2, 3], right: [1, 2, 4, 5] });
		expect(forkSplit([1, 2, 3], (n) => (n === 1 ? null : n - 1))).toBeNull();
		// Something beside the fork: not a single tree, split as usual.
		expect(forkSplit([1, 2, 3, 9], (n) => (n === 2 || n === 3 ? 1 : null))).toBeNull();
	});

	test('a failing parent takes its stack children with it', () => {
		// 4 <- 5 <- 6
		const parentOf = (n: number) => (n === 5 ? 4 : n === 6 ? 5 : null);
		const r = bisect(batch, (t) => t.includes(4), parentOf);
		expect(r.eject).toEqual([
			{ pr: 4, reason: '#4 fails on its own on top of the default branch' },
			{ pr: 5, reason: 'Stacked on #4, which failed in the queue' },
			{ pr: 6, reason: 'Stacked on #5, which failed in the queue' }
		]);
		expect([...r.land].sort()).toEqual([1, 2, 3, 7, 8]);
		// a child is never tested without its parent, which is landed or tested with it
		for (const g of r.tested) {
			for (const n of g.members) if (parentOf(n) !== null) expect([...g.base, ...g.members]).toContain(parentOf(n));
		}
	});

	test('a breaker at the top of a stack keeps the PRs below it', () => {
		const parentOf = (n: number) => (n > 1 ? n - 1 : null);
		const r = bisect([1, 2, 3, 4], (t) => t.includes(3), parentOf);
		expect(r.eject.map((e) => e.pr)).toEqual([3, 4]);
		expect(r.land).toEqual([1, 2]);
	});

	test('a PR is ejected only on a run of it alone', () => {
		// The batch failed by flake; #2 then fails alone for real only on top of #1.
		const fails = (t: number[]) => t.includes(1) && t.includes(2);
		const r = bisect([1, 2], fails);
		expect(r.land).toEqual([1]);
		expect(r.eject).toEqual([{ pr: 2, reason: '#2 fails on its own on top of the default branch' }]);
		expect(r.tested).toEqual([
			{ base: [], members: [1] },
			{ base: [], members: [2] },
			{ base: [1], members: [2] }
		]);
	});

	test('runs still going hold back new runs of their PRs, and a pass lands without waiting for them', () => {
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3, 4], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [1, 2], baseTree: 'm0', result: 'success' },
			{ context: [], members: [3, 4], baseTree: 'm0', result: 'pending' }
		];
		const none = () => null;
		expect(planBisection({ runs, remaining: [1, 2, 3, 4], masterTree: 'm0', parentOf: none })).toEqual({ kind: 'land', run: 1, prs: [1, 2] });
		// Landed: 3, 4 wait for their run on the old branch rather than start again.
		expect(planBisection({ runs, remaining: [3, 4], masterTree: 'm1', parentOf: none })).toEqual({
			kind: 'step',
			eject: [],
			start: [],
			requeue: [],
			done: false
		});
		// It failed: split on the new branch.
		runs[2].result = 'failure';
		expect(planBisection({ runs, remaining: [3, 4], masterTree: 'm1', parentOf: none })).toMatchObject({ start: [[3], [4]], done: false });
		// It passed on the old branch: run again on the new one to land.
		runs[2].result = 'success';
		expect(planBisection({ runs, remaining: [3, 4], masterTree: 'm1', parentOf: none })).toMatchObject({ start: [[3, 4]], done: false });
	});

	test('a half that fails early waits for its other half: that one may land and move the default branch', () => {
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3, 4], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [1, 2], baseTree: 'm0', result: 'pending' },
			{ context: [], members: [3, 4], baseTree: 'm0', result: 'failure' }
		];
		const none = () => null;
		const idle = { kind: 'step', eject: [], start: [], requeue: [], done: false };
		// [3, 4] is to blame, but nothing starts while [1, 2] runs: not with a free slot, not with many.
		expect(planBisection({ runs, remaining: [1, 2, 3, 4], masterTree: 'm0', parentOf: none, slots: 2 })).toEqual(idle);
		expect(planBisection({ runs, remaining: [1, 2, 3, 4], masterTree: 'm0', parentOf: none, slots: 4 })).toEqual(idle);
		expect(planBisection({ runs, remaining: [1, 2, 3, 4], masterTree: 'm0', parentOf: none })).toEqual(idle);
		// [1, 2] passed and lands; then [3, 4] splits on the branch it landed on.
		runs[1].result = 'success';
		expect(planBisection({ runs, remaining: [1, 2, 3, 4], masterTree: 'm0', parentOf: none, slots: 2 })).toEqual({ kind: 'land', run: 1, prs: [1, 2] });
		expect(planBisection({ runs, remaining: [3, 4], masterTree: 'm1', parentOf: none, slots: 2 })).toMatchObject({ start: [[3], [4]], done: false });
	});

	test('a PR that failed alone is ejected while other runs go on, but nothing new starts', () => {
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3, 4], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [1, 2], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [3, 4], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [1], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [2], baseTree: 'm0', result: 'pending' }
		];
		const r = planBisection({ runs, remaining: [1, 2, 3, 4], masterTree: 'm0', parentOf: () => null, slots: 4 });
		expect(r).toMatchObject({ kind: 'step', start: [], done: false });
		expect(r.kind === 'step' && r.eject.map((e) => e.pr)).toEqual([1]);
	});

	test('runs from before landing as it goes (on top of a passing context) are taken as they are', () => {
		// An older bisection tested [3, 4] on top of [1, 2]: its failure still points at 3, 4.
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3, 4], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [1, 2], baseTree: 'm0', result: 'success' },
			{ context: [1, 2], members: [3, 4], baseTree: 'm0', result: 'failure' }
		];
		const r = planBisection({ runs, remaining: [1, 2, 3, 4], masterTree: 'm0', parentOf: () => null });
		expect(r).toEqual({ kind: 'land', run: 1, prs: [1, 2] });
		expect(planBisection({ runs, remaining: [3, 4], masterTree: 'm1', parentOf: () => null })).toMatchObject({ start: [[3], [4]] });
	});

	test('a PR that failed alone on a branch not known green runs alone again before it is ejected', () => {
		const runs: BisectRun[] = [{ context: [], members: [2], baseTree: 'outside', result: 'failure' }];
		expect(planBisection({ runs, remaining: [2], masterTree: 'm1', parentOf: () => null })).toMatchObject({ eject: [], start: [[2]] });
		expect(planBisection({ runs, remaining: [2], masterTree: 'm1', parentOf: () => null, trusted: (t) => t === 'outside' })).toMatchObject({
			eject: [{ pr: 2, run: 0 }],
			start: []
		});
	});

	test('a PR ejected for failing alone explains the runs it failed in: the rest runs together', () => {
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3, 4], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [1, 2], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [3, 4], baseTree: 'm0', result: 'success' },
			{ context: [], members: [1], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [2], baseTree: 'm0', result: 'success' }
		];
		// #1 is gone (ejected); master moved, so 2, 3, 4 run once, together, and nothing is split again.
		expect(planBisection({ runs, remaining: [2, 3, 4], masterTree: 'm1', parentOf: () => null, trusted: () => true })).toEqual({
			kind: 'step',
			eject: [],
			start: [[2, 3, 4]],
			requeue: [],
			done: false
		});
		// Not failed alone on a branch known green: the batch's failure still points at what's left
		// of it, split in two; both halves passed, so they run as one pool to land together.
		expect(planBisection({ runs, remaining: [2, 3, 4], masterTree: 'm1', parentOf: () => null, trusted: (t) => t === 'm1' })).toMatchObject({
			start: [[2, 3, 4]]
		});
	});

	test('with one slot, what is expected to pass runs first; then both halves of one split', () => {
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3, 4, 5, 6, 7, 8], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [1, 2, 3, 4], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [5, 6, 7, 8], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [9], baseTree: 'm0', result: 'success' },
			// Ten PRs of the batch already landed: breakers are rare, so failing groups are halved.
			{ context: [], members: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], baseTree: 'm0', result: 'success' }
		];
		const plan = (slots?: number) => planBisection({ runs, remaining: [1, 2, 3, 4, 5, 6, 7, 8, 9], masterTree: 'm1', parentOf: () => null, slots });
		expect(plan()).toMatchObject({ start: [[9], [1, 2], [3, 4], [5, 6], [7, 8]] });
		expect(plan(1)).toMatchObject({ start: [[9]] });
		expect(plan(3)).toMatchObject({ start: [[9], [1, 2], [3, 4]] });
		// While a run goes, nothing starts beside it, even with a slot to spare: it may land.
		runs.push({ context: [], members: [9], baseTree: 'm1', result: 'pending' });
		expect(plan(1)).toMatchObject({ start: [], done: false });
		expect(plan(2)).toMatchObject({ start: [], done: false });
	});

	test('batch 13 on krusty: with one slot, one run, all that passed pooled in it', () => {
		// The recorded runs (trees shortened) when seven ran at once, three of them groups that had passed.
		const r = (members: number[], baseTree: string, result: BisectRun['result']): BisectRun => ({ context: [], members, baseTree, result });
		const runs: BisectRun[] = [
			r([3247, 3230, 3217, 3075, 3351, 3347, 3330, 3324, 3312, 2975, 3341, 3339, 3283, 3280, 3251, 3345, 3342, 3288, 2600, 3296, 3309, 3292, 3257], 'fb72', 'failure'),
			r([3247, 3230, 3217, 3075, 3351, 3347, 3330, 3324, 3312, 2975, 3341, 3339, 3283], '6b83', 'failure'),
			r([3247, 3230, 3217, 3075, 3351, 3347], '6b83', 'failure'),
			r([3330, 3324, 3312, 2975, 3341, 3339, 3283], '6b83', 'success'),
			r([3280, 3251, 3345, 3342, 3288, 2600, 3296, 3309, 3292, 3257], '6b83', 'failure'),
			r([3280, 3251, 3345, 3342, 3288, 2600, 3296], '2731', 'failure'),
			r([3309, 3292, 3257], '2731', 'failure'),
			r([3247, 3230, 3217], '2731', 'success'),
			r([3075, 3351, 3347], '2731', 'failure'),
			r([3309], '2731', 'success'),
			r([3292, 3257], '2731', 'success'),
			r([3075], '7154', 'failure'),
			r([3351, 3347], '7154', 'success'),
			r([3280, 3251, 3345], '7154', 'failure'),
			r([3309], '7154', 'success'),
			r([3292, 3257], '7154', 'success'),
			r([3280], '7154', 'success'),
			r([3251, 3345], '7154', 'failure'),
			r([3342, 3288, 2600], '7154', 'failure')
		];
		const step = planBisection({
			runs,
			remaining: [3280, 3251, 3345, 3342, 3288, 2600, 3309, 3292, 3257],
			masterTree: 'fb72',
			parentOf: () => null,
			trusted: (t) => ['fb72', '6b83', '2731', '7154'].includes(t),
			slots: 1
		});
		// Everything that passed goes first, as one run: #3280 (no failure left points at it) and both
		// halves of [3309 3292 3257], each of which passed. It lands them all if it passes.
		expect(step).toEqual({ kind: 'step', eject: [], start: [[3280, 3309, 3292, 3257]], requeue: [], done: false });
	});

	test('a PR that never passed is not pooled with PRs that passed: it runs after them, apart', () => {
		// #5 was only in failed runs, all explained by #1 (ejected); #2 and #3 passed, on an old branch.
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3, 5], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [1, 5], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [2, 3], baseTree: 'm0', result: 'success' },
			{ context: [], members: [1], baseTree: 'm0', result: 'failure' }
		];
		const plan = (slots?: number) => planBisection({ runs, remaining: [2, 3, 5], masterTree: 'm1', parentOf: () => null, trusted: () => true, slots });
		expect(plan()).toMatchObject({ start: [[2, 3], [5]] });
		expect(plan(1)).toMatchObject({ start: [[2, 3]] });
		// Stacked on one that passed, it waits until that one landed.
		const stacked = planBisection({ runs, remaining: [2, 3, 5], masterTree: 'm1', parentOf: (n) => (n === 5 ? 2 : null), trusted: () => true });
		expect(stacked).toMatchObject({ start: [[2, 3]] });
	});

	test('a failed pool is split into what passed before and what never did', () => {
		// Batch 13's run 26: four PRs that each passed alone, and #3296 (stacked on #3280) that never passed.
		const parentOf = (n: number) => (n === 3296 ? 3280 : null);
		const runs: BisectRun[] = [
			{ context: [], members: [3280, 3251, 3296, 3345, 3342, 3309], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [3280], baseTree: 'm0', result: 'success' },
			{ context: [], members: [3345], baseTree: 'm0', result: 'success' },
			{ context: [], members: [3342], baseTree: 'm0', result: 'success' },
			{ context: [], members: [3309], baseTree: 'm0', result: 'success' },
			{ context: [], members: [3251], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [3280, 3296, 3345, 3342, 3309], baseTree: 'm1', result: 'failure' }
		];
		const step = planBisection({ runs, remaining: [3280, 3296, 3345, 3342, 3309], masterTree: 'm1', parentOf, trusted: () => true });
		// #3296 can only run once #3280 landed; the four that passed go first, together.
		expect(step).toMatchObject({ eject: [], start: [[3280, 3345, 3342, 3309]] });
	});

	test('a half of PRs that all passed runs before halves that narrow a failure, from any group', () => {
		// Batch 13 after run 26: the pool of four that passed (and #3296) failed; [3288 2600] failed too.
		const parentOf = (n: number) => (n === 3296 ? 3280 : null);
		const runs: BisectRun[] = [
			{ context: [], members: [3280, 3345, 3342, 3309, 3296, 3288, 2600], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [3280], baseTree: 'm0', result: 'success' },
			{ context: [], members: [3345], baseTree: 'm0', result: 'success' },
			{ context: [], members: [3342], baseTree: 'm0', result: 'success' },
			{ context: [], members: [3309], baseTree: 'm0', result: 'success' },
			{ context: [], members: [3288, 2600], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [3280, 3345, 3342, 3296, 3309], baseTree: 'm1', result: 'failure' }
		];
		const step = planBisection({ runs, remaining: [3280, 3345, 3342, 3309, 3296, 3288, 2600], masterTree: 'm1', parentOf, trusted: () => true, slots: 1 });
		expect(step).toMatchObject({ start: [[3280, 3345, 3342, 3309]] });
	});

	test('a pool of PRs that passed which fails on this branch is not run again: its groups run apart', () => {
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3, 4], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [1, 2], baseTree: 'm0', result: 'success' },
			{ context: [], members: [3, 4], baseTree: 'm0', result: 'success' },
			// Pooled on the new branch: they fail together (an interaction).
			{ context: [], members: [1, 2, 3, 4], baseTree: 'm1', result: 'failure' }
		];
		const step = planBisection({ runs, remaining: [1, 2, 3, 4], masterTree: 'm1', parentOf: () => null, trusted: () => true, slots: 1 });
		expect(step).toMatchObject({ start: [[1, 2]] });
	});

	test('a single-PR group with a failure only in a larger run is run alone first', () => {
		const runs: BisectRun[] = [{ context: [], members: [1, 2], baseTree: 'm0', result: 'failure' }];
		expect(planBisection({ runs, remaining: [2], masterTree: 'm1', parentOf: () => null })).toMatchObject({ eject: [], start: [[2]] });
	});
});

describe('with real stack detection', () => {
	let git: GitSandbox | undefined;
	afterEach(() => git?.cleanup());

	test('plans a detected stack whose child targets main in parent-first order', () => {
		git = new GitSandbox();
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.branch('solo', 'main');
		git.commit('solo', 's1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'main'); // hidden stack: GitHub thinks #2 sits on main
		git.openPR(3, 'solo', 'main');
		const analysis = analyzeStacks(git.input());

		const p = plan([entry(2, 90), entry(3, 80), entry(1, 70)], analysis);
		expect(p.batch).toEqual([1, 2, 3]);
	});
});

describe('bisection invariants (randomised)', () => {
	test('never lands a failing set, never tests a child without its parent, accounts for every PR', () => {
		let seed = 7;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
		for (let run = 0; run < 300; run++) {
			const size = 1 + Math.floor(rnd() * 12);
			const batch = Array.from({ length: size }, (_, i) => i + 1);
			// random forest in landing order: a parent always comes earlier
			const parents = new Map<number, number>();
			for (const n of batch) if (n > 1 && rnd() < 0.3) parents.set(n, 1 + Math.floor(rnd() * (n - 1)));
			const parentOf = (n: number) => parents.get(n) ?? null;
			const breakers = new Set(batch.filter(() => rnd() < 0.15));
			const pair = rnd() < 0.3 && size > 2 ? [1 + Math.floor(rnd() * size), 1 + Math.floor(rnd() * size)] : null;
			const fails = (t: number[]) =>
				t.some((n) => breakers.has(n)) || (!!pair && pair[0] !== pair[1] && t.includes(pair[0]) && t.includes(pair[1]));
			if (!fails(batch)) continue;

			// All at once, and one or two at a time (the rest waiting their turn).
			for (const slots of [undefined, 1, 2]) {
				const r = bisect(batch, fails, parentOf, slots);
				expect(fails(r.land)).toBe(false);
				expect([...r.land, ...r.requeue, ...r.eject.map((e) => e.pr)].sort((a, b) => a - b)).toEqual(batch);
				for (const b of breakers) expect(r.land).not.toContain(b);
				for (const g of r.tested) {
					for (const n of g.members) if (parentOf(n) !== null) expect([...g.base, ...g.members]).toContain(parentOf(n));
				}
				for (const n of r.land) if (parentOf(n) !== null) expect(r.land.slice(0, r.land.indexOf(n))).toContain(parentOf(n));
				// Only PRs that fail alone on top of what landed are ejected (and their stack children).
				for (const e of r.eject) if (!e.reason.startsWith('Stacked')) expect(fails([...r.land, e.pr])).toBe(true);
				expect(r.runs).toBeLessThanOrEqual(4 * size);
			}
		}
	});
});

describe('never worse than one run per PR', () => {
	test('a small group, or one among many breakers, is cheaper alone than halved', () => {
		expect(aloneIsCheaper(2, 0.05)).toBe(true);
		expect(aloneIsCheaper(3, 0.05)).toBe(true);
		expect(aloneIsCheaper(8, 0.05)).toBe(false);
		expect(aloneIsCheaper(27, 0.15)).toBe(false);
		expect(aloneIsCheaper(8, 0.3)).toBe(true);
		expect(aloneIsCheaper(27, 0.3)).toBe(true);
	});

	test('a failing group of never-passed PRs in a batch full of breakers runs each PR alone', () => {
		// Three failed groups and nothing passed yet: breakers are common here, so [1..4] is not halved.
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [1, 2, 3, 4], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [5, 6, 7, 8], baseTree: 'm0', result: 'failure' },
			{ context: [], members: [9, 10, 11, 12], baseTree: 'm0', result: 'failure' }
		];
		const step = planBisection({ runs, remaining: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], masterTree: 'm0', parentOf: () => null, slots: 1 });
		expect(step).toEqual({ kind: 'step', eject: [], requeue: [], done: false, start: [[1]] });
	});

	test('a stacked group is still narrowed along the stack (prefixes), never into children without their parents', () => {
		const runs: BisectRun[] = [{ context: [], members: [1, 2, 3], baseTree: 'm0', result: 'failure' }];
		const step = planBisection({ runs, remaining: [1, 2, 3], masterTree: 'm0', parentOf: (n) => (n > 1 ? n - 1 : null), slots: 1 });
		expect(step.kind === 'step' && step.start).toEqual([[1]]);
	});
});
