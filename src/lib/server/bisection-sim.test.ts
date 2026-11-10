import { writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { planBisection, splitPoint, type BisectRun } from './batching';

/**
 * A simulation of bisection against a known truth, driving the real planner the way the queue
 * does: runs take slots and time, results come back one by one, a passing run on the current
 * default branch lands at once (and makes runs on the old one stale), and an ejected PR takes its
 * stack children with it. Every planner decision is checked against invariants as it is made.
 */

type ParentOf = (n: number) => number | null;

interface World {
	batch: number[];
	parentOf?: ParentOf;
	/** The truth: whether CI fails on the default branch with these PRs on it. */
	fails: (prs: number[]) => boolean;
	/** Most runs at once; unlimited when absent. */
	slots?: number;
	/** Chance that a run fails for no reason. */
	flake?: number;
	/** Runs take 1 to 3 time units at random; otherwise all take 1, so time counts rounds. */
	uneven?: boolean;
	seed?: number;
}

interface Outcome {
	landed: number[];
	ejected: { pr: number; reason: string }[];
	requeued: number[];
	/** Runs started, beside the batch's own. */
	runs: number;
	/** Time until the bisection settled: rounds when runs are even. */
	time: number;
	/** When each PR landed. */
	landedAt: Map<number, number>;
	/** Time each PR spent in the bisection, landed or not. */
	settledAt: Map<number, number>;
	/** Invariant violations, empty when all held. */
	violations: string[];
}

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s * 1103515245 + 12345) % 2 ** 31;
		return s / 2 ** 31;
	};
}

/** Stacks of `g` as units: each PR under its topmost ancestor in `g`, through ancestors outside it. */
function units(g: number[], parentOf: ParentOf): number[][] {
	const set = new Set(g);
	const out = new Map<number, number[]>();
	for (const n of g) {
		let r = n;
		for (let p = parentOf(n), i = 0; p !== null && i < 1000; p = parentOf(p), i++) if (set.has(p)) r = p;
		out.set(r, [...(out.get(r) ?? []), n]);
	}
	return [...out.values()];
}

function simulate(w: World): Outcome {
	const parentOf = w.parentOf ?? (() => null);
	const rnd = rng(w.seed ?? 1);
	const inBatch = new Set(w.batch);
	const violations: string[] = [];
	const fail = (why: string) => violations.push(why);
	const runs: BisectRun[] = [{ context: [], members: [...w.batch], baseTree: '', result: 'failure' }];
	/** What had landed under each run, and when it ends. */
	const meta: { base: number[]; end: number }[] = [{ base: [], end: 0 }];
	const landed: number[] = [];
	const ejected: { pr: number; reason: string }[] = [];
	const landedAt = new Map<number, number>();
	const settledAt = new Map<number, number>();
	let remaining = [...w.batch];
	let time = 0;
	/** Landed, or outside the batch (merged before it). */
	const there = (p: number) => !inBatch.has(p) || landed.includes(p);
	const key = (g: number[]) => [...g].sort((a, b) => a - b).join(',');

	for (let i = 0; i < 5000; i++) {
		const tree = landed.join(',');
		const step = planBisection({ runs, remaining, masterTree: tree, parentOf, trusted: () => true, slots: w.slots });
		if (step.kind === 'land') {
			if (w.fails([...landed, ...step.prs])) fail(`landed a failing set: ${step.prs.join(' ')} on ${tree || 'base'}`);
			for (const n of step.prs) {
				const p = parentOf(n);
				if (p !== null && !there(p) && !step.prs.includes(p)) fail(`#${n} landed before its parent #${p}`);
			}
			landed.push(...step.prs);
			for (const n of step.prs) landedAt.set(n, time), settledAt.set(n, time);
			remaining = remaining.filter((n) => !step.prs.includes(n));
			continue;
		}
		for (const e of step.eject) {
			const r = runs[e.run];
			if (!w.flake) {
				// Shown to fail alone (on top of the context it ran with), on what had landed then.
				const base = [...meta[e.run].base, ...r.context];
				if (!w.fails([...base, e.pr])) fail(`#${e.pr} ejected, but it passes on top of ${base.join(' ') || 'the base'}`);
				if (r.context.length && w.fails(base)) fail(`#${e.pr} ejected on a context that fails without it`);
			}
			if (!r.members.includes(e.pr) || r.members.length !== 1) fail(`#${e.pr} ejected on a run not of it alone`);
			ejected.push({ pr: e.pr, reason: e.reason });
			settledAt.set(e.pr, time);
			remaining = remaining.filter((n) => n !== e.pr);
			for (const n of [...remaining]) {
				let p = parentOf(n);
				while (p !== null && p !== e.pr) p = parentOf(p);
				if (p === e.pr) {
					ejected.push({ pr: n, reason: `Stacked on #${parentOf(n)}, which failed in the queue` });
					settledAt.set(n, time);
					remaining = remaining.filter((m) => m !== n);
				}
			}
		}
		const pending = runs.filter((r) => r.result === 'pending');
		if (step.done) {
			if (pending.length) fail(`done with ${pending.length} runs still going`);
			for (const n of step.requeue) settledAt.set(n, time);
			return { landed, ejected, requeued: step.requeue, runs: runs.length - 1, time, landedAt, settledAt, violations };
		}
		if (w.slots !== undefined && pending.length + step.start.length > w.slots) fail(`${pending.length + step.start.length} runs at once on ${w.slots} slots`);
		const startKeys = step.start.map(key);
		if (new Set(startKeys).size !== startKeys.length) fail(`the same group started twice at once`);
		for (const g of step.start) {
			if (!g.length) fail('an empty run');
			for (const n of g) {
				if (!remaining.includes(n)) fail(`#${n} runs after it settled`);
				const p = parentOf(n);
				if (p !== null && !there(p) && !g.includes(p)) fail(`#${n} runs without its parent #${p}`);
			}
			if (pending.some((r) => g.some((n) => r.members.includes(n)))) fail(`${key(g)} starts while a run with its PRs is going`);
			if (runs.some((r) => r.result !== 'pending' && r.baseTree === tree && !r.context.length && key(r.members) === key(g)))
				fail(`${key(g)} runs again on the same tree`);
		}
		if (!pending.length && !step.start.length) {
			fail('nothing running and nothing to start, but not done');
			break;
		}
		for (const g of step.start) {
			runs.push({ context: [], members: g, baseTree: tree, result: 'pending' });
			const failed = w.fails([...landed, ...g]) || (!!w.flake && rnd() < w.flake);
			meta.push({ base: [...landed], end: time + (w.uneven ? 1 + Math.floor(rnd() * 3) : 1) });
			// The result is fixed when it starts (on what had landed then); it shows when the run ends.
			(meta[meta.length - 1] as { result?: boolean }).result = failed;
		}
		const going = runs.map((r, j) => ({ r, j })).filter(({ r }) => r.result === 'pending');
		time = Math.min(...going.map(({ j }) => meta[j].end));
		for (const { r, j } of going) if (meta[j].end === time) r.result = (meta[j] as { result?: boolean }).result ? 'failure' : 'success';
	}
	fail('bisection did not finish');
	return { landed, ejected, requeued: remaining, runs: runs.length - 1, time, landedAt, settledAt, violations };
}

/** `count` distinct PRs of `batch`, at random. */
function pick(batch: number[], count: number, rnd: () => number): Set<number> {
	const out = new Set<number>();
	while (out.size < Math.min(count, batch.length)) out.add(batch[Math.floor(rnd() * batch.length)]);
	return out;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** PRs that land when each of `bad` breaks alone: the rest, without what is stacked on a bad one. */
function goodOnes(batch: number[], bad: Set<number>, parentOf: ParentOf) {
	return batch.filter((n) => {
		for (let p: number | null = n; p !== null; p = parentOf(p)) if (bad.has(p)) return false;
		return true;
	});
}

describe('bisection simulation: invariants on every decision', () => {
	// Random batches: stacks and forks, independent breakers, interacting pairs, flakes, uneven run
	// times, and 1, 2, 4 or unlimited slots. Each decision is checked as it is made (see simulate).
	const cases: { name: string; flake?: number; pairs: boolean; uneven: boolean }[] = [
		{ name: 'independent breakers, even runs', pairs: false, uneven: false },
		{ name: 'independent breakers, uneven runs', pairs: false, uneven: true },
		{ name: 'interacting pairs, uneven runs', pairs: true, uneven: true },
		{ name: 'flaky runs', flake: 0.1, pairs: false, uneven: true }
	];
	for (const c of cases)
		test(c.name, () => {
			const rnd = rng(42);
			let checked = 0;
			for (let trial = 0; trial < 250; trial++) {
				const size = 2 + Math.floor(rnd() * 31);
				const batch = range(size);
				// A forest in queue order (a parent comes earlier); some PRs fork.
				const parents = new Map<number, number>();
				for (const n of batch) if (n > 1 && rnd() < 0.3) parents.set(n, 1 + Math.floor(rnd() * (n - 1)));
				const parentOf = (n: number) => parents.get(n) ?? null;
				const bad = pick(batch, Math.floor(rnd() * 4), rnd);
				const pair = c.pairs && size > 2 ? [...pick(batch, 2, rnd)] : null;
				const fails = (t: number[]) => t.some((n) => bad.has(n)) || (!!pair && t.includes(pair[0]) && t.includes(pair[1]));
				if (!fails(batch)) continue;
				for (const slots of [1, 2, 4, undefined]) {
					const r = simulate({ batch, parentOf, fails, slots, flake: c.flake, uneven: c.uneven, seed: trial * 7 + (slots ?? 9) });
					expect(r.violations, `trial ${trial}, ${size} PRs, slots ${slots}, bad ${[...bad]}, pair ${pair}`).toEqual([]);
					// Every PR settles exactly once: landed, ejected or back in line.
					expect([...r.landed, ...r.ejected.map((e) => e.pr), ...r.requeued].sort((a, b) => a - b)).toEqual(batch);
					expect(fails(r.landed)).toBe(false);
					if (!c.pairs && !c.flake) {
						// With independent breakers the result is exact: what is good lands, the rest is ejected.
						expect([...r.landed].sort((a, b) => a - b)).toEqual(goodOnes(batch, bad, parentOf));
						expect(r.requeued).toEqual([]);
					}
					checked++;
				}
			}
			expect(checked).toBeGreaterThan(500);
		});
});

/**
 * Mean rounds, runs and landing round of a good PR, over many batches of `n` independent PRs with
 * `k` breakers, runs taking one round each.
 */
function averages(n: number, k: number, slots: number | undefined, trials = 600) {
	const rnd = rng(1000 * n + 10 * k + (slots ?? 0));
	let rounds = 0;
	let runs = 0;
	let landing = 0;
	let worst = 0;
	const batch = range(n);
	for (let t = 0; t < trials; t++) {
		const bad = pick(batch, k, rnd);
		const r = simulate({ batch, fails: (g) => g.some((x) => bad.has(x)), slots, seed: t });
		expect(r.violations).toEqual([]);
		rounds += r.time;
		runs += r.runs;
		landing += [...r.landedAt.values()].reduce((a, b) => a + b, 0) / Math.max(1, r.landedAt.size);
		worst = Math.max(worst, r.runs);
	}
	return { rounds: rounds / trials, runs: runs / trials, landing: landing / trials, worst };
}

describe('bisection simulation: efficiency', () => {
	// The planner's own numbers (independent breakers, no flakes), kept from regressing by more
	// than 5%. Beside them, the reference model's (`slots.py`): it ejects a single PR whose sibling
	// half passed without running it alone; the queue runs it alone first, so a flake or an
	// interaction never ejects an innocent PR. That costs one run per breaker on one slot.
	const bounds: { n: number; k: number; slots: number; rounds: number; runs: number; reference: string }[] = [
		{ n: 32, k: 1, slots: 1, rounds: 6.5, runs: 6.5, reference: '7.5/7.5' },
		{ n: 32, k: 1, slots: 2, rounds: 5.0, runs: 10.0, reference: '5.0/10.0' },
		{ n: 32, k: 1, slots: 4, rounds: 5.0, runs: 10.0, reference: '5.0/10.0' },
		{ n: 32, k: 2, slots: 1, rounds: 12.3, runs: 12.3, reference: '12.7/12.7' },
		{ n: 32, k: 2, slots: 2, rounds: 8.2, runs: 16.3, reference: '8.9/16.9' },
		{ n: 32, k: 2, slots: 4, rounds: 6.8, runs: 19.8, reference: '8.2/23.5' },
		{ n: 32, k: 3, slots: 1, rounds: 17.9, runs: 17.9, reference: '17.2/17.2' },
		{ n: 32, k: 3, slots: 2, rounds: 10.8, runs: 21.5, reference: '11.0/21.3' },
		{ n: 32, k: 3, slots: 4, rounds: 8.4, runs: 26.5, reference: '9.8/30.7' },
		{ n: 32, k: 5, slots: 1, rounds: 28.6, runs: 28.6, reference: '24.3/24.3' },
		{ n: 32, k: 5, slots: 2, rounds: 14.9, runs: 29.8, reference: '14.9/29.0' },
		{ n: 32, k: 5, slots: 4, rounds: 10.5, runs: 35.5, reference: '12.5/42.2' },
		{ n: 16, k: 3, slots: 2, rounds: 8.1, runs: 16.1, reference: '8.0/15.4' }
	];
	const report: string[] = ['n\tbad\tslots\trounds\truns\tlanding round\tworst runs\treference rounds/runs'];
	for (const b of bounds)
		test(`${b.n} PRs, ${b.k} bad, ${b.slots} slots: ≤ ${b.rounds} rounds and ${b.runs} runs on average`, () => {
			const a = averages(b.n, b.k, b.slots);
			report.push([b.n, b.k, b.slots, a.rounds.toFixed(2), a.runs.toFixed(2), a.landing.toFixed(2), a.worst, b.reference].join('\t'));
			if (process.env.BISECT_REPORT) writeFileSync(process.env.BISECT_REPORT, report.join('\n') + '\n');
			expect(a.rounds).toBeLessThanOrEqual(b.rounds * 1.05);
			expect(a.runs).toBeLessThanOrEqual(b.runs * 1.05);
		});

	test('worst case: no batch takes more than 2·k·⌈log2 n⌉ + k runs (plus a re-run per level with slots to spare)', () => {
		const rnd = rng(5);
		for (let t = 0; t < 400; t++) {
			const n = 2 + Math.floor(rnd() * 31);
			const k = 1 + Math.floor(rnd() * Math.min(5, n));
			const batch = range(n);
			const bad = pick(batch, k, rnd);
			for (const slots of [1, 2, 4]) {
				const r = simulate({ batch, fails: (g) => g.some((x) => bad.has(x)), slots, uneven: true, seed: t });
				// With more than one slot, a passing run can go stale when another lands first, and run again: at
				// most once per level of the halving.
				const stale = slots > 1 ? Math.ceil(Math.log2(n)) : 0;
				expect(r.runs, `${n} PRs, bad ${[...bad]}, slots ${slots}`).toBeLessThanOrEqual(2 * k * Math.ceil(Math.log2(n)) + k + stale);
			}
		}
	});

	test('more slots never take more rounds', () => {
		for (const [n, k] of [
			[16, 1],
			[16, 3],
			[32, 2],
			[32, 5]
		]) {
			const one = averages(n, k, 1, 300).rounds;
			const two = averages(n, k, 2, 300).rounds;
			const four = averages(n, k, 4, 300).rounds;
			expect(two).toBeLessThanOrEqual(one);
			expect(four).toBeLessThanOrEqual(two * 1.02);
		}
	});
});

describe('bisection replays from krusty', () => {
	test('batch 49: the first split is 7 | 8 with the #3241 stack whole, and both halves run', () => {
		const members = [3342, 3039, 3296, 3309, 3241, 3308, 3364, 3365, 3334, 3366, 3358, 3286, 3234, 3356, 3352];
		// #3308 and #3286 sit on #3241; #3296 on #3280 and #3039 on a PR, both merged before the batch.
		const parents: Record<number, number> = { 3308: 3241, 3286: 3241, 3296: 3280 };
		const parentOf = (n: number) => parents[n] ?? null;
		const runs: BisectRun[] = [{ context: [], members, baseTree: 'bf9d', result: 'failure' }];
		const step = planBisection({ runs, remaining: members, masterTree: 'bf9d', parentOf, slots: 2 });
		expect(step).toEqual({
			kind: 'step',
			eject: [],
			requeue: [],
			done: false,
			start: [
				[3342, 3039, 3296, 3309, 3241, 3308, 3286],
				[3364, 3365, 3334, 3366, 3358, 3234, 3356, 3352]
			]
		});
		// The 7 failed first while the 8 still runs: the 7 splits 3 | 4 (the stack whole), and the
		// free slot takes one half...
		runs.push({ context: [], members: [3342, 3039, 3296, 3309, 3241, 3308, 3286], baseTree: 'bf9d', result: 'failure' });
		runs.push({ context: [], members: [3364, 3365, 3334, 3366, 3358, 3234, 3356, 3352], baseTree: 'bf9d', result: 'pending' });
		const next = planBisection({ runs, remaining: members, masterTree: 'bf9d', parentOf, slots: 2 });
		expect(next.kind === 'step' && next.start).toEqual([[3241, 3308, 3286]]);
		// ...and the other takes the next one, before the 8's halves: the smaller group settles first.
		runs.push({ context: [], members: [3241, 3308, 3286], baseTree: 'bf9d', result: 'pending' });
		runs[2].result = 'failure';
		const then = planBisection({ runs, remaining: members, masterTree: 'bf9d', parentOf, slots: 2 });
		expect(then.kind === 'step' && then.start).toEqual([[3342, 3039, 3296, 3309]]);
		// With four slots, once the 3 failed too (and before the 4 started): the stack forks into its two paths, the 8 splits 4 | 4,
		// and all four halves run at once. The 7's other four wait: the stack's failure explains the 7's.
		runs[3].result = 'failure';
		const all = planBisection({ runs, remaining: members, masterTree: 'bf9d', parentOf, slots: 4 });
		expect(all.kind === 'step' && all.start).toEqual([
			[3241, 3308],
			[3241, 3286],
			[3364, 3365, 3334, 3366],
			[3358, 3234, 3356, 3352]
		]);
	});

	// Batch 13's 23 PRs that ran, with what its runs showed: #3075, #3251 and #2600 fail alone, and
	// #3342 and #3309 fail together though each passes alone. #3296 sits on #3280.
	const batch13 = [3247, 3230, 3217, 3075, 3351, 3347, 3330, 3324, 3312, 2975, 3341, 3339, 3283, 3280, 3251, 3345, 3342, 3288, 2600, 3296, 3309, 3292, 3257];
	const bad13 = new Set([3075, 3251, 2600]);
	const fails13 = (t: number[]) => t.some((n) => bad13.has(n)) || (t.includes(3342) && t.includes(3309));
	const parent13 = (n: number) => (n === 3296 ? 3280 : null);

	for (const slots of [1, 2, 4])
		test(`batch 13 with ${slots} slot${slots > 1 ? 's' : ''}: settles every PR, ejects only what fails`, () => {
			const r = simulate({ batch: batch13, parentOf: parent13, fails: fails13, slots });
			expect(r.violations).toEqual([]);
			const out = r.ejected.map((e) => e.pr);
			for (const b of bad13) expect(out).toContain(b);
			// Of the pair, the one that runs last fails on top of the other, which landed.
			expect(out.filter((n) => n === 3342 || n === 3309)).toHaveLength(1);
			expect(out).toHaveLength(4);
			expect(r.landed).toHaveLength(19);
			expect(r.requeued).toEqual([]);
			// On krusty: 34 runs in ten and a half hours (runs take about an hour), and not finished.
			expect({ runs: r.runs, rounds: r.time }).toEqual({ 1: { runs: 17, rounds: 17 }, 2: { runs: 22, rounds: 11 }, 4: { runs: 31, rounds: 11 } }[slots]);
		});
});

describe('split balance', () => {
	test('random groups split within one PR, or within the stack that cannot be cut', () => {
		const rnd = rng(3);
		for (let t = 0; t < 2000; t++) {
			const size = 2 + Math.floor(rnd() * 40);
			const g = range(size);
			const parents = new Map<number, number>();
			for (const n of g) if (n > 1 && rnd() < 0.35) parents.set(n, 1 + Math.floor(rnd() * (n - 1)));
			const parentOf = (n: number) => parents.get(n) ?? null;
			const { left, right, independent } = splitPoint(g, parentOf);
			expect(left.length && right.length).toBeTruthy();
			expect([...left, ...right].sort((a, b) => a - b)).toEqual(g);
			const us = units(g, parentOf);
			if (us.length === 1) {
				expect(independent).toBe(false);
				continue;
			}
			expect(independent).toBe(true);
			// No stack is cut, and the queue order holds within each half.
			const inLeft = new Set(left);
			for (const u of us) expect(new Set(u.map((n) => inLeft.has(n))).size).toBe(1);
			expect(left).toEqual(g.filter((n) => inLeft.has(n)));
			// The best two-way partition of the units is at least this far apart; greedy gets within one stack.
			const biggest = Math.max(...us.map((u) => u.length));
			expect(Math.abs(left.length - right.length)).toBeLessThanOrEqual(Math.max(1, biggest));
			if (biggest * 2 <= size && us.filter((u) => u.length === 1).length >= biggest) expect(Math.abs(left.length - right.length)).toBeLessThanOrEqual(1);
		}
	});
});
