// Bisection with declared dependencies: a PR may depend on several PRs of the batch (its git
// parent and what it declares), so a stack is a small graph. The rule stays: never a PR without
// its dependencies, in a run or in a landing; only a run of a PR alone ejects it.

import { describe, expect, test } from 'vitest';
import { forkSplit, planBisection, splitPoint, type BisectRun } from './batching';

type DepsOf = (n: number) => number[];

/** Dependencies as the planner is given them; asked about anything but one PR, it says so instead of looping. */
const strict =
	(f: DepsOf): DepsOf =>
	(n) => {
		if (typeof n !== 'number') throw new TypeError(`asked for the dependencies of ${JSON.stringify(n)}, not of one PR`);
		return f(n);
	};

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s * 1103515245 + 12345) % 2 ** 31;
		return s / 2 ** 31;
	};
}

const sorted = (xs: Iterable<number>) => [...xs].sort((a, b) => a - b);

describe('splitting a failing group whose PRs depend on several others', () => {
	test('PRs joined by a dependency are one unit; units are dealt to the halves whole', () => {
		// 3 needs 1 and 2; 4 stands alone.
		const deps: DepsOf = strict((n) => (n === 3 ? [1, 2] : []));
		expect(splitPoint([1, 2, 3, 4], deps)).toEqual({ left: [1, 2, 3], right: [4], independent: true });
	});

	test('a unit with two tops splits by them, each half with everything it needs', () => {
		// Landing order 1, 2, 5, 3: 2 needs 1; 3 needs 1 and 5. The tops are 2 and 3.
		const deps: DepsOf = strict((n) => ({ 2: [1], 3: [1, 5] })[n] ?? []);
		expect(forkSplit([1, 2, 5, 3], deps)).toEqual({ left: [1, 2], right: [1, 5, 3] });
	});

	test('a unit with a single top has no such split: it is cut at a prefix of its order', () => {
		// The diamond: 2 and 3 need 1, 4 needs 2 and 3.
		const deps: DepsOf = strict((n) => ({ 2: [1], 3: [1], 4: [2, 3] })[n] ?? []);
		expect(forkSplit([1, 2, 3, 4], deps)).toBe(null);
		expect(splitPoint([1, 2, 3, 4], deps)).toEqual({ left: [1, 2], right: [3, 4], independent: false });
	});

	test('PRs that need the same PR outside the group are apart, as siblings of a parent outside it are', () => {
		// 2 and 3 both need 9, which is not in the group: each half can run on its own.
		const deps: DepsOf = strict((n) => (n === 2 || n === 3 ? [9] : []));
		expect(splitPoint([1, 2, 3, 4], deps)).toEqual({ left: [1, 2], right: [3, 4], independent: true });
	});

	test('a git parent given as a list splits as it does given alone', () => {
		const parent = (n: number) => ({ 2: 1, 3: 2, 5: 4, 6: 4 })[n] ?? null;
		const asList: DepsOf = strict((n) => (parent(n) === null ? [] : [parent(n)!]));
		for (const g of [[1, 2, 3, 4, 5, 6], [4, 5, 6], [1, 2, 3], [1, 2, 3, 7, 8]]) {
			expect(splitPoint(g, asList)).toEqual(splitPoint(g, parent));
			expect(forkSplit(g, asList)).toEqual(forkSplit(g, parent));
		}
	});
});

describe('planning a bisection step with declared dependencies', () => {
	test('a group never runs without what its PRs depend on', () => {
		// 4 needs 1 and 3; the batch failed. Every group started holds each PR's dependencies or runs once they landed.
		const deps: DepsOf = strict((n) => (n === 4 ? [1, 3] : []));
		const runs: BisectRun[] = [{ context: [], members: [1, 2, 3, 4], baseTree: 't0', result: 'failure' }];
		const step = planBisection({ runs, remaining: [1, 2, 3, 4], masterTree: 't0', parentOf: deps });
		expect(step.kind).toBe('step');
		if (step.kind !== 'step') return;
		for (const g of step.start) for (const n of g) for (const d of deps(n)) expect(g.includes(d), `#${n} runs without #${d}: ${JSON.stringify(step.start)}`).toBe(true);
	});

	test('a PR whose dependency was ejected leaves the bisection with it, unblamed', () => {
		// 2 needs 1, and 1 failed alone on a trusted tree: 1 is ejected; 2 is not, and is done here.
		const deps: DepsOf = strict((n) => (n === 2 ? [1] : []));
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3], baseTree: 't0', result: 'failure' },
			{ context: [], members: [1], baseTree: 't0', result: 'failure' }
		];
		const step = planBisection({ runs, remaining: [1, 2, 3], masterTree: 't0', parentOf: deps });
		expect(step.kind).toBe('step');
		if (step.kind !== 'step') return;
		expect(step.eject.map((e) => e.pr)).toEqual([1]);
		expect(step.start.flat()).not.toContain(2);
		expect(step.requeue).not.toContain(2);
	});

	test('a passing run lands only when its PRs have what they depend on', () => {
		// 3 needs 2. A run of 1 and 3 can't have passed legitimately; it is not a landing either way.
		const deps: DepsOf = strict((n) => (n === 3 ? [2] : []));
		const runs: BisectRun[] = [
			{ context: [], members: [1, 2, 3], baseTree: 't0', result: 'failure' },
			{ context: [], members: [1, 3], baseTree: 't0', result: 'success' }
		];
		const step = planBisection({ runs, remaining: [1, 2, 3], masterTree: 't0', parentOf: deps });
		expect(step.kind === 'land' && step.prs.includes(3)).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------
// A simulation against a known truth, as the queue drives the planner: runs take one round, a run
// that passes on the current tree lands, and an ejected PR's dependents leave the bisection (git
// children are ejected with it; PRs that only declared it go back in line).

interface Outcome {
	landed: number[];
	ejected: number[];
	/** Left with an ejected dependency, or handed back by the planner. */
	back: number[];
	runs: number;
	violations: string[];
}

function simulate(batch: number[], deps: DepsOf, bad: Set<number>, slots: number | undefined): Outcome {
	const violations: string[] = [];
	const inBatch = new Set(batch);
	const landed: number[] = [];
	const ejected: number[] = [];
	const back: number[] = [];
	let remaining = [...batch];
	const runs: BisectRun[] = [{ context: [], members: [...batch], baseTree: '', result: 'failure' }];
	const there = (d: number) => !inBatch.has(d) || landed.includes(d);
	const closure = (n: number): number[] => deps(n).flatMap((d) => [d, ...closure(d)]);
	// The truth: a breaker fails any run it is in; a PR without a dependency fails too (that is
	// what declaring it says), and the checks below never let that happen.
	const fails = (prs: number[]) => prs.some((n) => bad.has(n) || deps(n).some((d) => inBatch.has(d) && !prs.includes(d)));
	const missing = (g: number[], n: number) => deps(n).find((d) => !there(d) && !g.includes(d));

	for (let i = 0; i < 2000; i++) {
		const tree = landed.join(',');
		const step = planBisection({ runs, remaining, masterTree: tree, parentOf: deps, trusted: () => true, slots });
		if (step.kind === 'land') {
			const proof = runs[step.run];
			if (proof.result !== 'success' || proof.baseTree !== tree) violations.push(`landed ${step.prs} without a green run on this tree`);
			for (const n of step.prs) {
				const d = missing(step.prs, n);
				if (d !== undefined) violations.push(`#${n} landed without #${d}`);
			}
			if (fails([...landed, ...step.prs])) violations.push(`landed a failing set ${step.prs}`);
			landed.push(...step.prs);
			remaining = remaining.filter((n) => !step.prs.includes(n));
			continue;
		}
		for (const e of step.eject) {
			const r = runs[e.run];
			if (r.members.length !== 1 || r.members[0] !== e.pr) violations.push(`#${e.pr} ejected on a run not of it alone`);
			if (!bad.has(e.pr)) violations.push(`#${e.pr} ejected, but it is good`);
			ejected.push(e.pr);
			remaining = remaining.filter((n) => n !== e.pr);
			// Its dependents leave with it: they can't land without it.
			for (const n of [...remaining]) {
				if (closure(n).includes(e.pr)) {
					back.push(n);
					remaining = remaining.filter((m) => m !== n);
				}
			}
		}
		const pending = runs.filter((r) => r.result === 'pending');
		if (step.done || (!step.start.length && !pending.length && !step.eject.length)) {
			back.push(...step.requeue.filter((n) => remaining.includes(n)));
			remaining = remaining.filter((n) => !step.requeue.includes(n));
			if (!step.done) violations.push('nothing to start and not done');
			return { landed, ejected, back, runs: runs.length - 1, violations };
		}
		for (const g of step.start) {
			for (const n of g) {
				const d = missing(g, n);
				if (d !== undefined) violations.push(`#${n} runs without its dependency #${d}: ${JSON.stringify(step.start)}`);
				if (!remaining.includes(n)) violations.push(`#${n} runs after it settled`);
			}
			runs.push({ context: [], members: g, baseTree: tree, result: 'pending' });
		}
		for (const r of runs) if (r.result === 'pending') r.result = fails([...landed, ...r.members]) ? 'failure' : 'success';
	}
	violations.push('bisection did not finish');
	return { landed, ejected, back, runs: runs.length - 1, violations };
}

/** A random batch in landing order: each PR may depend on up to three earlier ones. */
function randomBatch(rnd: () => number, size: number, branchy: number) {
	const batch = Array.from({ length: size }, (_, i) => i + 1);
	const on = new Map<number, number[]>();
	for (const n of batch) {
		const k = rnd() < branchy ? 1 + Math.floor(rnd() * 3) : 0;
		const ds = new Set<number>();
		for (let j = 0; j < k && n > 1; j++) ds.add(1 + Math.floor(rnd() * (n - 1)));
		if (ds.size) on.set(n, sorted(ds));
	}
	return { batch, deps: strict((n: number) => on.get(n) ?? []) };
}

describe('bisection simulation with declared dependencies', { timeout: 120_000 }, () => {
	test('never a run or a landing without dependencies; good PRs land, breakers are ejected, their dependents go back', () => {
		const rnd = rng(7);
		let checked = 0;
		for (let trial = 0; trial < 300; trial++) {
			const size = 2 + Math.floor(rnd() * 24);
			const { batch, deps } = randomBatch(rnd, size, 0.45);
			const bad = new Set<number>();
			const k = 1 + Math.floor(rnd() * 3);
			while (bad.size < Math.min(k, size)) bad.add(1 + Math.floor(rnd() * size));
			const closure = (n: number): number[] => deps(n).flatMap((d) => [d, ...closure(d)]);
			const good = batch.filter((n) => !bad.has(n) && !closure(n).some((d) => bad.has(d)));
			for (const slots of [1, 2, 4, undefined]) {
				const r = simulate(batch, deps, bad, slots);
				const where = `trial ${trial}, ${size} PRs, deps ${batch.map((n) => `${n}<-[${deps(n)}]`).join(' ')}, bad ${sorted(bad)}, slots ${slots}`;
				expect(r.violations, where).toEqual([]);
				expect(sorted([...r.landed, ...r.ejected, ...r.back]), where).toEqual(batch);
				expect(sorted(r.landed), where).toEqual(good);
				expect(sorted(r.ejected), where).toEqual(sorted(batch.filter((n) => bad.has(n) && !closure(n).some((d) => bad.has(d)))));
				checked++;
			}
		}
		expect(checked).toBe(1200);
	});

	test('a batch with no declarations bisects exactly as before: a parent given as a list or alone', () => {
		const rnd = rng(11);
		for (let trial = 0; trial < 200; trial++) {
			const size = 2 + Math.floor(rnd() * 24);
			const parents = new Map<number, number>();
			for (let n = 2; n <= size; n++) if (rnd() < 0.3) parents.set(n, 1 + Math.floor(rnd() * (n - 1)));
			const bad = new Set([1 + Math.floor(rnd() * size), 1 + Math.floor(rnd() * size)]);
			const batch = Array.from({ length: size }, (_, i) => i + 1);
			const asList: DepsOf = strict((n) => (parents.has(n) ? [parents.get(n)!] : []));
			const alone = (n: number) => parents.get(n) ?? null;
			// The same steps, one by one, whichever way the parent is given.
			const runsA: BisectRun[] = [{ context: [], members: [...batch], baseTree: '', result: 'failure' }];
			const runsB: BisectRun[] = [{ context: [], members: [...batch], baseTree: '', result: 'failure' }];
			for (let i = 0; i < 40; i++) {
				const a = planBisection({ runs: runsA, remaining: batch, masterTree: '', parentOf: asList, trusted: () => true, slots: 2 });
				const b = planBisection({ runs: runsB, remaining: batch, masterTree: '', parentOf: alone, trusted: () => true, slots: 2 });
				expect(a, `trial ${trial}, step ${i}`).toEqual(b);
				if (a.kind !== 'step' || !a.start.length) break;
				for (const g of a.start) {
					const result = g.some((n) => bad.has(n)) ? 'failure' : 'success';
					runsA.push({ context: [], members: g, baseTree: 'x', result });
					runsB.push({ context: [], members: g, baseTree: 'x', result });
				}
			}
		}
	});
});
