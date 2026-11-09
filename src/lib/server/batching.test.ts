import { afterEach, describe, expect, test } from 'vitest';
import {
	admit,
	planBisection,
	type BisectRun,
	DEFAULT_BATCH_CONFIG,
	descendants,
	planNextBatch,
	splitPoint,
	type BatchConfig,
	type PRState,
	type Priority,
	type QueueEntry
} from './batching';
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
			{ pr: 2, admission: expect.objectContaining({ code: 'parent-not-ready', reason: expect.stringMatching(/queue #1 first/) }) }
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

	test('moves the cut to a stack boundary', () => {
		// 2 <- 3: cutting between them would separate a child from its parent
		const parent = (n: number) => (n === 3 ? 2 : null);
		expect(splitPoint([1, 2, 3, 4], parent)).toEqual({ left: [1, 2, 3], right: [4], independent: true });
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
function bisect(batch: number[], fails: (tested: number[]) => boolean, parentOf: (n: number) => number | null = () => null) {
	const runs: BisectRun[] = [{ context: [], members: batch, baseTree: '', result: 'failure' }];
	const land: number[] = [];
	const eject: { pr: number; reason: string }[] = [];
	const tested: { base: number[]; members: number[] }[] = [];
	let remaining = [...batch];
	let rounds = 0;
	/** Round in which each PR landed. */
	const landedIn = new Map<number, number>();
	for (let i = 0; i < 200; i++) {
		const step = planBisection({ runs, remaining, masterTree: land.join(','), parentOf });
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

			const r = bisect(batch, fails, parentOf);
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
	});
});
