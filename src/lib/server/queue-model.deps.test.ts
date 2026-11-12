// The queue model with declared dependencies (`Depends-On:`): a dependency is a stack parent that
// shares no commits, so units become small graphs. Trees keep their order (queue-model.test.ts).

import { describe, expect, test } from 'vitest';
import { DEFAULT_BATCH_CONFIG, type BatchConfig, type PRState, type Priority, type QueueEntry } from './batching';
import { dependencyGraph, type DependencyGraph, type Problem } from './deps';
import { fillBatch, planNextBatch, plannedAdmission, queueBoard, queueModel, serialPick, type BoardItem, type QueueModel, type QueueStack } from './queue-model';
import { entry, MIN, NOW, ready, stacks } from './testing/stack-fixture';
import type { StackAnalysis } from './stacks';

const config: BatchConfig = { ...DEFAULT_BATCH_CONFIG, requireApproval: true, collectWindowMs: 0, maxBatch: 8, depth: 2 };

const graph = (analysis: StackAnalysis, on: Record<number, number[]>, problems: Record<number, Problem> = {}): DependencyGraph =>
	dependencyGraph(analysis, {
		on: new Map(Object.entries(on).map(([k, v]) => [Number(k), v])),
		problems: new Map(Object.entries(problems).map(([k, v]) => [Number(k), v]))
	});

function model(
	queue: QueueEntry[],
	analysis: StackAnalysis,
	on: Record<number, number[]>,
	opts: { states?: PRState[]; inflight?: number[]; problems?: Record<number, Problem> } = {}
): QueueModel {
	const states = new Map(queue.map((e) => [e.pr, ready(e.pr)]));
	for (const s of opts.states ?? []) states.set(s.pr, s);
	const deps = graph(analysis, on, opts.problems);
	return queueModel({
		queue,
		admission: plannedAdmission({ states, analysis, config }),
		analysis,
		inflight: new Set(opts.inflight ?? []),
		problems: deps.problems,
		deps
	});
}

const shape = (m: QueueModel) => ({
	stacks: m.stacks.map((s) => ({ members: s.members, on: s.on, priority: s.priority })),
	attention: m.attention.map((h) => `#${h.pr} ${h.code}: ${h.reason}`)
});

describe('a declared dependency joins PRs into one unit', () => {
	test('the dependency goes first, though the dependent was queued earlier', () => {
		const m = model([entry(2, 50), entry(1, 30), entry(3, 40)], stacks([1, 2, 3]), { 2: [1] });
		expect(shape(m)).toEqual({
			stacks: [
				{ members: [1, 2], on: null, priority: 'normal' },
				{ members: [3], on: null, priority: 'normal' }
			],
			attention: []
		});
		expect(m.stacks[0].parentOf).toEqual(new Map([[1, null], [2, 1]]));
		expect(m.stacks[0].needs).toEqual(new Map([[1, []], [2, [1]]]));
		expect(m.stacks[0].after).toEqual([]);
	});

	test('a PR with a git parent and a declaration lands after both; a tree branch stays whole', () => {
		// The proposal's example: 11 is stacked on 10 by git; 12 declares 10 and 20.
		const m = model([entry(10, 60), entry(11, 50), entry(12, 40), entry(20, 30)], stacks([10, 11, 12, 20], { 11: 10 }), { 12: [10, 20] });
		expect(shape(m).stacks).toEqual([{ members: [10, 11, 20, 12], on: null, priority: 'normal' }]);
		// Drawn as a tree under the dependency it waited for last; it also needs the other.
		expect(m.stacks[0].parentOf).toEqual(new Map([[10, null], [11, 10], [20, null], [12, 20]]));
		expect(m.stacks[0].needs.get(12)).toEqual([10, 20]);
		// A batch of three takes a prefix of that order: everything in it has what it needs.
		expect(fillBatch(m, { config: { ...config, maxBatch: 3 }, inflightBatches: 0, now: NOW }).batch).toEqual([10, 11, 20]);
		expect(serialPick(m, { inflight: 0 })).toEqual([10, 11, 20, 12]);
	});

	test('two PRs that need the same one share its unit, in queue order', () => {
		const m = model([entry(1, 60), entry(3, 50), entry(2, 40)], stacks([1, 2, 3]), { 2: [1], 3: [1] });
		expect(shape(m).stacks).toEqual([{ members: [1, 3, 2], on: null, priority: 'normal' }]);
	});

	test('a chain of declarations is one unit, bottom first', () => {
		const m = model([entry(3, 60), entry(2, 50), entry(1, 40)], stacks([1, 2, 3]), { 3: [2], 2: [1] });
		expect(shape(m).stacks).toEqual([{ members: [1, 2, 3], on: null, priority: 'normal' }]);
	});

	test('a diamond: the PR that needs both sides goes after the second', () => {
		// 2 and 3 need 1; 4 needs 2 and 3.
		const m = model([entry(1, 60), entry(2, 50), entry(3, 40), entry(4, 30)], stacks([1, 2, 3, 4]), { 2: [1], 3: [1], 4: [2, 3] });
		expect(m.stacks.map((s) => s.members)).toEqual([[1, 2, 3, 4]]);
		expect(m.stacks[0].parentOf.get(4)).toBe(3);
	});

	test('a declaration that repeats the git parent changes nothing', () => {
		const m = model([entry(1, 60), entry(2, 50)], stacks([1, 2], { 2: 1 }), { 2: [1] });
		expect(m.stacks.map((s) => s.members)).toEqual([[1, 2]]);
		expect(m.stacks[0].needs.get(2)).toEqual([1]);
	});
});

describe('what a declared dependency holds', () => {
	test("a dependency that isn't queued holds the PR, and what depends on it", () => {
		const m = model([entry(2, 50), entry(3, 40), entry(9, 30)], stacks([1, 2, 3, 9]), { 2: [1], 3: [2] });
		expect(shape(m)).toEqual({
			stacks: [{ members: [9], on: null, priority: 'normal' }],
			attention: ["#2 dependency-not-queued: Depends on #1, which isn't queued", "#3 parent-held: Waits for #2: depends on #1, which isn't queued"]
		});
		expect(m.attention[1].cause).toBe(2);
	});

	test('a held dependency holds its dependents, never what it depends on', () => {
		const m = model([entry(1, 60), entry(2, 50), entry(3, 40)], stacks([1, 2, 3]), { 2: [1], 3: [2] }, { states: [ready(2, { draft: true })] });
		expect(shape(m)).toEqual({
			stacks: [{ members: [1], on: null, priority: 'normal' }],
			attention: ['#2 draft: Draft', '#3 parent-held: Waits for #2: draft']
		});
	});

	test('a PR with a held git parent and a free declared dependency waits for the git parent', () => {
		const m = model([entry(1, 60), entry(2, 50), entry(3, 40)], stacks([1, 2, 3], { 3: 1 }), { 3: [2] }, { states: [ready(1, { ciGreen: false })] });
		expect(shape(m)).toEqual({
			stacks: [{ members: [2], on: null, priority: 'normal' }],
			attention: ['#1 ci-failed: Its own checks failed on its head', '#3 parent-held: Waits for #1: its own checks failed on its head']
		});
	});

	test("the declarations' problems and cycles hold the PR; its dependents wait for it", () => {
		const m = model([entry(1, 60), entry(2, 50), entry(3, 40), entry(4, 30), entry(5, 20)], stacks([1, 2, 3, 4, 5]), { 1: [2], 2: [1], 3: [1], 5: [4] }, {
			problems: { 4: { code: 'dependency-closed', reason: 'Depends on #8, which was closed without merging' } }
		});
		expect(shape(m)).toEqual({
			stacks: [],
			attention: [
				'#1 dependency-cycle: Depends on itself through #2',
				'#2 dependency-cycle: Depends on itself through #1',
				'#3 parent-held: Waits for #1: depends on itself through #2',
				'#4 dependency-closed: Depends on #8, which was closed without merging',
				'#5 parent-held: Waits for #4: depends on #8, which was closed without merging'
			]
		});
	});

	test('a dependency being tested: the PR sits on it, goes on top of its batch, and waits in one by one', () => {
		const m = model([entry(2, 50), entry(3, 40)], stacks([1, 2, 3]), { 2: [1] }, { inflight: [1] });
		expect(shape(m).stacks).toEqual([
			{ members: [2], on: 1, priority: 'normal' },
			{ members: [3], on: null, priority: 'normal' }
		]);
		expect(fillBatch(m, { config, inflightBatches: 1, now: NOW }).batch).toEqual([2, 3]);
		expect(serialPick(m, { inflight: 0 })).toEqual([3]);
	});

	test('a dependency deep in a unit, being tested, makes the unit sit on it', () => {
		// 2 <- 3 by git; 3 also needs 1, which is being tested.
		const m = model([entry(2, 50), entry(3, 40)], stacks([1, 2, 3], { 3: 2 }), { 3: [1] }, { inflight: [1] });
		expect(shape(m).stacks).toEqual([{ members: [2, 3], on: 1, priority: 'normal' }]);
	});
});

describe('priority flows down to dependencies, never up to dependents', () => {
	test('an urgent PR takes what it depends on into its express batch', () => {
		const m = model([entry(1, 60), entry(2, 50, 'urgent'), entry(3, 40)], stacks([1, 2, 3]), { 2: [1] });
		expect(shape(m).stacks).toEqual([
			{ members: [1, 2], on: null, priority: 'urgent' },
			{ members: [3], on: null, priority: 'normal' }
		]);
		expect(fillBatch(m, { config, inflightBatches: 0, now: NOW })).toEqual({ batch: [1, 2], express: true, waitUntil: null });
	});

	test('a PR that depends on an urgent one does not ride its express batch: it follows at its own priority', () => {
		const m = model([entry(1, 60, 'urgent'), entry(2, 50), entry(3, 70)], stacks([1, 2, 3]), { 2: [1] });
		expect(shape(m).stacks).toEqual([
			{ members: [1], on: null, priority: 'urgent' },
			{ members: [3], on: null, priority: 'normal' },
			{ members: [2], on: null, priority: 'normal' }
		]);
		expect(m.stacks[2].after).toEqual([1]);
		expect(fillBatch(m, { config, inflightBatches: 0, now: NOW })).toEqual({ batch: [1], express: true, waitUntil: null });
		// Once the urgent one is being tested, the dependent sits on it.
		const later = model([entry(2, 50), entry(3, 70)], stacks([1, 2, 3]), { 2: [1] }, { inflight: [1] });
		expect(fillBatch(later, { config, inflightBatches: 1, now: NOW }).batch).toEqual([3, 2]);
	});

	test("urgency lifts only what the urgent PR needs, not the rest of its dependency's git stack", () => {
		// 11 is stacked on 10 by git; the urgent 20 declares 10. 10 rides with 20; 11 is not needed.
		const m = model([entry(10, 60), entry(11, 50), entry(20, 40, 'urgent')], stacks([10, 11, 20], { 11: 10 }), { 20: [10] });
		expect(shape(m).stacks).toEqual([
			{ members: [10, 20], on: null, priority: 'urgent' },
			{ members: [11], on: null, priority: 'normal' }
		]);
		expect(m.stacks[1].after).toEqual([10]);
		expect(fillBatch(m, { config, inflightBatches: 0, now: NOW })).toEqual({ batch: [10, 20], express: true, waitUntil: null });
	});

	test("urgency lifts the git parents of what an urgent PR needs, since that needs them too", () => {
		// 2 is stacked on 1; the urgent 9 declares 2: both 1 and 2 ride with it, 1's other child 3 does not.
		const m = model([entry(1, 60), entry(2, 50), entry(3, 45), entry(9, 40, 'urgent')], stacks([1, 2, 3, 9], { 2: 1, 3: 1 }), { 9: [2] });
		expect(shape(m).stacks).toEqual([
			{ members: [1, 2, 9], on: null, priority: 'urgent' },
			{ members: [3], on: null, priority: 'normal' }
		]);
	});

	test('a low PR that depends on a normal one follows it in the same batch', () => {
		const m = model([entry(1, 60), entry(2, 50, 'low'), entry(3, 40)], stacks([1, 2, 3]), { 2: [1] });
		expect(m.stacks.map((s) => s.members)).toEqual([[1], [3], [2]]);
		expect(fillBatch(m, { config, inflightBatches: 0, now: NOW }).batch).toEqual([1, 3, 2]);
	});

	test('the planner records the priority each PR was planned at', () => {
		const states = new Map([1, 2, 3].map((n) => [n, ready(n)]));
		const analysis = stacks([1, 2, 3]);
		const plan = planNextBatch({
			now: NOW,
			queue: [entry(1, 60), entry(2, 50, 'urgent'), entry(3, 40, 'low')],
			states,
			analysis,
			inflight: [],
			config,
			dependencies: graph(analysis, { 2: [1], 3: [2] })
		});
		expect(plan.batch).toEqual([1, 2]);
		expect(plan.express).toBe(true);
		expect(plan.effectivePriority).toEqual(new Map<number, Priority>([[1, 'urgent'], [2, 'urgent'], [3, 'low']]));
	});

	test("the planner holds a PR for its declarations' problems", () => {
		const states = new Map([1, 2].map((n) => [n, ready(n)]));
		const analysis = stacks([1, 2]);
		const plan = planNextBatch({
			now: NOW,
			queue: [entry(1, 60), entry(2, 50)],
			states,
			analysis,
			inflight: [],
			config,
			dependencies: graph(analysis, {}, { 2: { code: 'dependency-invalid', reason: '`Depends-On: x` names no pull request' } })
		});
		expect(plan.batch).toEqual([1]);
		expect(plan.held).toEqual([{ pr: 2, admission: { ok: false, code: 'dependency-invalid', reason: '`Depends-On: x` names no pull request' } }]);
	});
});

describe('filling never takes a unit before what it depends on', () => {
	test('a unit whose dependency is not in the batch is skipped, and so is what depends on it', () => {
		const unit = (members: number[], after: number[] = [], priority: Priority = 'normal'): QueueStack => ({
			root: members[0],
			members,
			parentOf: new Map(members.map((m) => [m, null])),
			needs: new Map(members.map((m) => [m, []])),
			on: null,
			after,
			priority,
			enqueuedAt: NOW,
			landable: false
		});
		const m: QueueModel = { stacks: [unit([5], [9]), unit([6], [5]), unit([7])], attention: [] };
		expect(fillBatch(m, { config, inflightBatches: 0, now: NOW }).batch).toEqual([7]);
		expect(serialPick(m, { inflight: 0 })).toEqual([7]);
	});
});

describe('the queue page with declared dependencies', () => {
	const item = (pr: number, minutesAgo: number, over: Partial<BoardItem> = {}): BoardItem => ({
		pr,
		status: 'queued',
		priority: 'normal',
		position: 0,
		enqueuedAt: NOW - minutesAgo * MIN,
		hold: null,
		message: null,
		...over
	});

	test('a row under the dependency it waited for last, naming the others it also needs', () => {
		const analysis = stacks([10, 11, 12, 20], { 11: 10 });
		const b = queueBoard([item(10, 60), item(11, 50), item(12, 40), item(20, 30)], analysis, new Set(), graph(analysis, { 12: [10, 20] }));
		expect(b.stacks).toEqual([
			{
				root: 10,
				on: null,
				priority: 'normal',
				rows: [
					{ pr: 10, depth: 0, parent: null },
					{ pr: 11, depth: 1, parent: 10 },
					{ pr: 20, depth: 0, parent: null },
					{ pr: 12, depth: 1, parent: 20, also: [10] }
				]
			}
		]);
	});

	test('a dependency that is not queued sends the row to attention with what to do', () => {
		const analysis = stacks([1, 2]);
		const b = queueBoard([item(2, 40)], analysis, new Set(), graph(analysis, { 2: [1] }));
		expect(b.stacks).toEqual([]);
		expect(b.attention).toEqual([{ pr: 2, code: 'dependency-not-queued', reason: "Depends on #1, which isn't queued", cause: null }]);
	});
});

// ---------------------------------------------------------------------------------------------
// Properties, over random queues of stacks with random declarations.

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const RANK: Record<Priority, number> = { urgent: 0, normal: 1, low: 2 };

function randomQueue(seed: number) {
	const r = rng(seed);
	const n = 5 + Math.floor(r() * 30);
	const open = Array.from({ length: n }, (_, k) => k + 1);
	const parents: Record<number, number> = {};
	for (const p of open) if (p > 1 && r() < 0.35) parents[p] = 1 + Math.floor(r() * (p - 1));
	// Declarations point anywhere, so cycles happen too.
	const on: Record<number, number[]> = {};
	for (const p of open) {
		const k = r() < 0.3 ? 1 + Math.floor(r() * 2) : 0;
		for (let i = 0; i < k; i++) {
			const d = 1 + Math.floor(r() * n);
			if (d !== p) (on[p] ??= []).push(d);
		}
	}
	const inflight: number[] = [];
	for (const p of open) if (r() < 0.1 && (parents[p] === undefined || inflight.includes(parents[p])) && !(on[p] ?? []).length) inflight.push(p);
	const queue = open
		.filter((p) => !inflight.includes(p) && r() < 0.85)
		.map((p) => entry(p, Math.floor(r() * 500), (['urgent', 'normal', 'normal', 'normal', 'low'] as Priority[])[Math.floor(r() * 5)], r() < 0.3 ? Math.floor(r() * 10) : undefined));
	const states = queue.map((e) => {
		const x = r();
		return x < 0.08 ? ready(e.pr, { ciGreen: null }) : x < 0.13 ? ready(e.pr, { ciGreen: false }) : x < 0.16 ? ready(e.pr, { draft: true }) : ready(e.pr);
	});
	return { queue, analysis: stacks(open, parents), on, inflight, states };
}

describe('queue model properties with declared dependencies, 300 random queues', () => {
	test.each(Array.from({ length: 300 }, (_, k) => k + 1))('seed %i', (seed) => {
		const q = randomQueue(seed);
		const m = model(q.queue, q.analysis, q.on, { states: q.states, inflight: q.inflight });
		const deps = graph(q.analysis, q.on);
		const queued = new Map(q.queue.map((e) => [e.pr, e]));
		const held = new Set(m.attention.map((h) => h.pr));

		// Every queued PR is in exactly one place.
		const placed = [...m.stacks.flatMap((s) => s.members), ...m.attention.map((h) => h.pr)];
		expect([...placed].sort((a, b) => a - b)).toEqual([...queued.keys()].sort((a, b) => a - b));
		// Every PR in a cycle is held.
		for (const [p, problem] of deps.problems) if (queued.has(p)) expect(held.has(p), `#${p} ${problem.reason}`).toBe(true);

		// Each member's dependencies: earlier in its unit, in an earlier unit, or being tested; none held.
		const unitOf = new Map<number, number>();
		m.stacks.forEach((s, k) => s.members.forEach((p) => unitOf.set(p, k)));
		m.stacks.forEach((s, k) => {
			expect(s.root).toBe(s.members[0]);
			const seen = new Set<number>();
			for (const p of s.members) {
				for (const d of deps.depsOf(p)) {
					expect(held.has(d), `#${p} in a unit, needing held #${d}`).toBe(false);
					const ok = seen.has(d) || (unitOf.has(d) && unitOf.get(d)! < k) || q.inflight.includes(d);
					expect(ok, `#${p} placed before its dependency #${d}`).toBe(true);
				}
				seen.add(p);
				// A unit member is at least as urgent as everything that depends on it there.
				for (const c of s.members) if (deps.depsOf(c).includes(p)) expect(RANK[queued.get(c)!.priority]).toBeGreaterThanOrEqual(RANK[s.priority]);
			}
			// Its priority is its most urgent member's own, or that of a free PR depending on it.
			expect(RANK[s.priority]).toBeLessThanOrEqual(Math.min(...s.members.map((p) => RANK[queued.get(p)!.priority])));
		});
		// A held PR's dependents are held with it.
		for (const h of m.attention) for (const c of queued.keys()) if (deps.depsOf(c).includes(h.pr)) expect(held.has(c), `#${c} on held #${h.pr}`).toBe(true);

		// A batch: nothing held, and each PR after what it needs (or on what is being tested).
		const room = 2 + (seed % 7);
		const f = fillBatch(m, { config: { ...config, maxBatch: room }, inflightBatches: 0, now: NOW });
		if (f.batch) {
			expect(new Set(f.batch).size).toBe(f.batch.length);
			const inBatch = new Set<number>();
			for (const p of f.batch) {
				expect(held.has(p)).toBe(false);
				for (const d of deps.depsOf(p)) expect(inBatch.has(d) || q.inflight.includes(d), `#${p} without #${d}`).toBe(true);
				inBatch.add(p);
			}
		}
		// One by one: a whole unit that needs nothing outside it.
		const s = serialPick(m, { inflight: 0 });
		if (s) {
			const inS = new Set(s);
			for (const p of s) for (const d of deps.depsOf(p)) expect(inS.has(d), `#${p} picked without #${d}`).toBe(true);
		}
	});
});
