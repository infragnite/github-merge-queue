import { describe, expect, test } from 'vitest';
import { DEFAULT_BATCH_CONFIG, type BatchConfig, type PRState, type Priority, type QueueEntry } from './batching';
import { fillBatch, plannedAdmission, queueBoard, queueModel, serialPick, type BoardItem, type QueueModel } from './queue-model';
import { entry, MIN, NOW, ready, stacks } from './testing/stack-fixture';
import type { StackAnalysis } from './stacks';

const config: BatchConfig = { ...DEFAULT_BATCH_CONFIG, requireApproval: true, collectWindowMs: 0, maxBatch: 8, depth: 2, expressMax: 2 };

function model(
	queue: QueueEntry[],
	analysis: StackAnalysis,
	opts: { states?: PRState[]; inflight?: number[]; conflicts?: Record<number, string>; config?: Partial<BatchConfig> } = {}
): QueueModel {
	const states = new Map(queue.map((e) => [e.pr, ready(e.pr)]));
	for (const s of opts.states ?? []) states.set(s.pr, s);
	return queueModel({
		queue,
		admission: plannedAdmission({ states, analysis, config: { ...config, ...opts.config } }),
		analysis,
		inflight: new Set(opts.inflight ?? []),
		problems: new Map(Object.entries(opts.conflicts ?? {}).map(([k, v]) => [Number(k), { code: 'conflict' as const, reason: v }]))
	});
}

/** The model in a compact form: stacks as their members, and the held PRs with their reasons. */
const shape = (m: QueueModel) => ({
	stacks: m.stacks.map((s) => ({ members: s.members, on: s.on, priority: s.priority })),
	attention: m.attention.map((h) => `#${h.pr} ${h.reason}`)
});

describe('the queue model: entries are stacks of queued PRs', () => {
	test('a lone PR is a stack of one', () => {
		const m = model([entry(1, 30), entry(2, 20)], stacks([1, 2]));
		expect(shape(m)).toEqual({
			stacks: [
				{ members: [1], on: null, priority: 'normal' },
				{ members: [2], on: null, priority: 'normal' }
			],
			attention: []
		});
		expect(m.stacks[0].parentOf).toEqual(new Map([[1, null]]));
	});

	test('a child joins its queued parent; a fork lists each branch parent first, branches in queue order', () => {
		// 1 <- 2 <- 3, and 1 <- 4 <- 5; 4 was queued before 2.
		const m = model([entry(5, 10), entry(3, 15), entry(2, 20), entry(4, 25), entry(1, 30), entry(9, 40)], stacks([1, 2, 3, 4, 5, 9], { 2: 1, 3: 2, 4: 1, 5: 4 }));
		expect(shape(m).stacks).toEqual([
			{ members: [9], on: null, priority: 'normal' },
			{ members: [1, 4, 5, 2, 3], on: null, priority: 'normal' }
		]);
		expect(m.stacks[1].parentOf).toEqual(
			new Map([
				[1, null],
				[4, 1],
				[5, 4],
				[2, 1],
				[3, 2]
			])
		);
	});

	test('a stack takes the place of its earliest member, and the priority of its most urgent one', () => {
		// The stack 1 <- 2 <- 3 has its urgent PR at the top; its sibling branch 4 rides along.
		const m = model([entry(7, 50), entry(1, 30), entry(2, 20), entry(3, 10, 'urgent'), entry(4, 5), entry(8, 40, 'low')], stacks([1, 2, 3, 4, 7, 8], { 2: 1, 3: 2, 4: 1 }));
		expect(shape(m).stacks).toEqual([
			{ members: [1, 2, 3, 4], on: null, priority: 'urgent' },
			{ members: [7], on: null, priority: 'normal' },
			{ members: [8], on: null, priority: 'low' }
		]);
	});

	test("the queue's own order (position) comes before age, for a stack by its earliest-placed member", () => {
		const m = model([entry(1, 30, 'normal', 3), entry(2, 20, 'normal', 1), entry(3, 10, 'normal', 2), entry(4, 5, 'normal', 0)], stacks([1, 2, 3, 4], { 3: 1 }));
		expect(shape(m).stacks.map((s) => s.members)).toEqual([[4], [2], [1, 3]]);
	});

	test("a child whose parent isn't queued needs someone to queue it, and so does everything stacked on the child", () => {
		const m = model([entry(2, 20), entry(3, 10), entry(9, 5)], stacks([1, 2, 3, 9], { 2: 1, 3: 2 }));
		expect(shape(m)).toEqual({
			stacks: [{ members: [9], on: null, priority: 'normal' }],
			attention: ["#2 Stacked on #1, which isn't queued; queue #1 first", "#3 Waits for #2: stacked on #1, which isn't queued; queue #1 first"]
		});
	});

	test('a PR that needs someone goes to attention, its branch with it; the rest of the stack stays', () => {
		// 1 <- 2 <- 3 <- 4, and 1 <- 5: #3's own checks failed.
		const m = model([entry(1, 50), entry(2, 40), entry(3, 30), entry(4, 20), entry(5, 10)], stacks([1, 2, 3, 4, 5], { 2: 1, 3: 2, 4: 3, 5: 1 }), {
			states: [ready(3, { ciGreen: false })]
		});
		expect(shape(m)).toEqual({
			stacks: [{ members: [1, 2, 5], on: null, priority: 'normal' }],
			attention: ["#3 Its own checks failed on its head", "#4 Waits for #3: its own checks failed on its head"]
		});
	});

	test("a PR whose own checks still run is not held: the batch's CI tests it", () => {
		const m = model([entry(1, 50), entry(2, 40), entry(3, 30)], stacks([1, 2, 3], { 2: 1, 3: 2 }), { states: [ready(2, { ciGreen: null })], config: { requirePRChecks: true } });
		expect(shape(m)).toEqual({
			stacks: [{ members: [1, 2, 3], on: null, priority: 'normal' }],
			attention: []
		});
	});

	test('a held root holds the whole stack; a draft needs its author', () => {
		const m = model([entry(1, 50), entry(2, 40), entry(3, 30), entry(4, 20)], stacks([1, 2, 3, 4], { 2: 1, 3: 1 }), { states: [ready(1, { draft: true })] });
		expect(shape(m)).toEqual({
			stacks: [{ members: [4], on: null, priority: 'normal' }],
			attention: ['#1 Draft', '#2 Waits for #1: draft', '#3 Waits for #1: draft']
		});
	});

	test("a known conflict needs someone; a held PR's reason is its own, not its child's", () => {
		const m = model([entry(1, 50), entry(2, 40), entry(3, 30)], stacks([1, 2, 3], { 2: 1 }), {
			conflicts: { 2: 'Conflicts with main in src/a.ts', 3: 'Conflicts with #1 in src/b.ts' },
			states: [ready(2, { ciGreen: null })]
		});
		// #2's checks run, and it conflicts: the conflict is what needs someone.
		expect(shape(m)).toEqual({
			stacks: [{ members: [1], on: null, priority: 'normal' }],
			attention: ['#2 Conflicts with main in src/a.ts', '#3 Conflicts with #1 in src/b.ts']
		});
	});

	test('a stack whose parent is being tested sits on it', () => {
		const m = model([entry(2, 40), entry(3, 30), entry(4, 20)], stacks([1, 2, 3, 4], { 2: 1, 3: 2 }), { inflight: [1] });
		expect(shape(m).stacks).toEqual([
			{ members: [2, 3], on: 1, priority: 'normal' },
			{ members: [4], on: null, priority: 'normal' }
		]);
		expect(m.stacks[0].parentOf).toEqual(
			new Map([
				[2, null],
				[3, 2]
			])
		);
	});

	test('PRs being tested are not in the model', () => {
		const m = model([entry(1, 40), entry(2, 30)], stacks([1, 2]), { inflight: [1] });
		expect(shape(m).stacks.map((s) => s.members)).toEqual([[2]]);
	});
});

describe('filling a new batch from the queue model', () => {
	const fill = (m: QueueModel, opts: { inflight?: number; config?: Partial<BatchConfig>; now?: number; enqueuedAt?: Map<number, number> } = {}) =>
		fillBatch(m, { config: { ...config, ...opts.config }, inflightBatches: opts.inflight ?? 0, now: opts.now ?? NOW });

	test('fills with whole stacks until the queue is empty', () => {
		const m = model([entry(1, 50), entry(2, 40), entry(3, 30), entry(4, 20)], stacks([1, 2, 3, 4], { 3: 2 }));
		expect(fill(m)).toEqual({ batch: [1, 2, 3, 4], express: false, waitUntil: null });
	});

	test('fills up to maxBatch, skipping what is held', () => {
		const q = Array.from({ length: 12 }, (_, k) => entry(k + 1, 100 - k));
		const m = model(q, stacks(q.map((e) => e.pr)), { states: [ready(2, { ciGreen: false }), ready(5, { draft: true })] });
		expect(fill(m)).toEqual({ batch: [1, 3, 4, 6, 7, 8, 9, 10], express: false, waitUntil: null });
	});

	test('a stack that does not fit gives its longest fitting part, parents first', () => {
		// 3 singles, then the stack 4 <- 5 <- 6, 4 <- 7 with 6 places left... of 5.
		const m = model([entry(1, 90), entry(2, 80), entry(3, 70), entry(4, 60), entry(5, 50), entry(6, 40), entry(7, 30), entry(8, 20)], stacks([1, 2, 3, 4, 5, 6, 7, 8], { 5: 4, 6: 5, 7: 4 }));
		expect(fill(m, { config: { maxBatch: 5 } })).toEqual({ batch: [1, 2, 3, 4, 5], express: false, waitUntil: null });
	});

	test('a stack with a held middle gives its good part; later stacks still fill the batch', () => {
		const m = model([entry(1, 90), entry(2, 80), entry(3, 70), entry(4, 60), entry(5, 50)], stacks([1, 2, 3, 4, 5], { 2: 1, 3: 2 }), { conflicts: { 3: 'Conflicts with main' } });
		expect(fill(m)).toEqual({ batch: [1, 2, 4, 5], express: false, waitUntil: null });
	});

	test('a stack on a PR being tested goes on top of it', () => {
		const m = model([entry(2, 50), entry(3, 40)], stacks([1, 2, 3], { 2: 1 }), { inflight: [1] });
		expect(fill(m, { inflight: 1 })).toEqual({ batch: [2, 3], express: false, waitUntil: null });
	});

	test('no new batch past the pipeline depth', () => {
		const m = model([entry(1, 50)], stacks([1]));
		expect(fill(m, { inflight: 2 })).toEqual({ batch: null, express: false, waitUntil: null });
	});

	test('an urgent stack gets an express batch of urgent stacks, a whole stack even past expressMax', () => {
		const m = model([entry(1, 90), entry(2, 80, 'urgent'), entry(3, 70), entry(4, 60), entry(5, 50, 'urgent')], stacks([1, 2, 3, 4, 5], { 3: 2, 4: 3 }));
		expect(fill(m)).toEqual({ batch: [2, 3, 4], express: true, waitUntil: null });
	});

	test('an express batch takes urgent stacks while they fit expressMax', () => {
		const m = model([entry(1, 90), entry(2, 80, 'urgent'), entry(3, 70, 'urgent'), entry(4, 60, 'urgent')], stacks([1, 2, 3, 4]));
		expect(fill(m)).toEqual({ batch: [2, 3], express: true, waitUntil: null });
	});

	test('a partial batch waits for the collect window of its oldest PR', () => {
		const m = model([entry(1, 10), entry(2, 5)], stacks([1, 2]));
		expect(fill(m, { config: { collectWindowMs: 60 * MIN } })).toEqual({ batch: null, express: false, waitUntil: NOW + 50 * MIN });
		expect(fill(m, { config: { collectWindowMs: 60 * MIN, maxBatch: 2 } })).toEqual({ batch: [1, 2], express: false, waitUntil: null });
	});
});

describe('one by one: the head stack of the queue', () => {
	test('takes the head stack whole', () => {
		const m = model([entry(1, 90), entry(2, 80), entry(3, 70), entry(4, 60)], stacks([1, 2, 3, 4], { 2: 1, 3: 2 }));
		expect(serialPick(m, { inflight: 0 })).toEqual([1, 2, 3]);
	});

	test('a lone PR is its own stack', () => {
		const m = model([entry(4, 90), entry(1, 60)], stacks([1, 4]));
		expect(serialPick(m, { inflight: 0 })).toEqual([4]);
	});

	test("takes the stack's good part when a PR in it is held", () => {
		const m = model([entry(1, 90), entry(2, 80), entry(3, 70)], stacks([1, 2, 3], { 2: 1, 3: 2 }), { states: [ready(3, { ciGreen: false })] });
		expect(serialPick(m, { inflight: 0 })).toEqual([1, 2]);
	});

	test('nothing while a run is in flight', () => {
		const m = model([entry(1, 90)], stacks([1]));
		expect(serialPick(m, { inflight: 1 })).toEqual(null);
	});

	test('a stack sitting on a PR being tested waits for it to land', () => {
		const m = model([entry(2, 90), entry(5, 60)], stacks([1, 2, 5], { 2: 1 }), { inflight: [1] });
		expect(serialPick(m, { inflight: 0 })).toEqual([5]);
	});
});

// ---------------------------------------------------------------------------------------------
// Properties, over random queues of stacks.

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
	for (const p of open) if (p > 1 && r() < 0.45) parents[p] = 1 + Math.floor(r() * (p - 1));
	// Being tested: a PR whose parent, if open, is being tested too.
	const inflight: number[] = [];
	for (const p of open) if (r() < 0.12 && (parents[p] === undefined || inflight.includes(parents[p]))) inflight.push(p);
	const queue = open
		.filter((p) => !inflight.includes(p) && r() < 0.85)
		.map((p) => entry(p, Math.floor(r() * 500), (['urgent', 'normal', 'normal', 'normal', 'low'] as Priority[])[Math.floor(r() * 5)], r() < 0.3 ? Math.floor(r() * 10) : undefined));
	const states = queue.map((e) => {
		const x = r();
		return x < 0.08 ? ready(e.pr, { ciGreen: null }) : x < 0.14 ? ready(e.pr, { ciGreen: false }) : x < 0.18 ? ready(e.pr, { draft: true }) : ready(e.pr);
	});
	const conflicts: Record<number, string> = {};
	for (const e of queue) if (r() < 0.06) conflicts[e.pr] = `Conflicts with main (#${e.pr})`;
	return { queue, analysis: stacks(open, parents), parents, inflight, states, conflicts };
}

describe('queue model properties, 300 random queues', () => {
	const seeds = Array.from({ length: 300 }, (_, k) => k + 1);

	test.each(seeds)('seed %i', (seed) => {
		const q = randomQueue(seed);
		const m = model(q.queue, q.analysis, { states: q.states, inflight: q.inflight, conflicts: q.conflicts });
		const parentOf = (n: number) => q.parents[n] ?? null;
		const queued = new Map(q.queue.map((e) => [e.pr, e]));

		// Every queued PR is in exactly one place: a stack, or needing attention.
		const placed = [...m.stacks.flatMap((s) => s.members), ...m.attention.map((h) => h.pr)];
		expect([...placed].sort((a, b) => a - b)).toEqual([...queued.keys()].sort((a, b) => a - b));

		const held = new Set(m.attention.map((h) => h.pr));
		for (const s of m.stacks) {
			expect(s.members.length).toBeGreaterThan(0);
			expect(s.root).toBe(s.members[0]);
			const seen = new Set<number>();
			for (const p of s.members) {
				const up = parentOf(p);
				// Parents first, within the stack; only the root may sit on a PR being tested.
				if (p === s.root) {
					expect(up === null || q.inflight.includes(up), `#${p} roots a stack on #${up}`).toBe(true);
					expect(s.on).toBe(up);
					expect(s.parentOf.get(p)).toBe(null);
				} else {
					expect(seen.has(up!), `#${p} before its parent #${up}`).toBe(true);
					expect(s.parentOf.get(p)).toBe(up);
				}
				seen.add(p);
				// Nothing below a stack member is held.
				for (let a = parentOf(p); a !== null; a = parentOf(a)) expect(held.has(a), `#${p} in a stack over held #${a}`).toBe(false);
			}
			// Preorder: each member's subtree is contiguous.
			for (const p of s.members) {
				const sub = s.members.filter((x) => {
					for (let a: number | null = x; a !== null; a = s.parentOf.get(a) ?? null) if (a === p) return true;
					return false;
				});
				const at = s.members.indexOf(p);
				expect(s.members.slice(at, at + sub.length)).toEqual(sub);
			}
			// Its priority is its most urgent member's.
			expect(RANK[s.priority]).toBe(Math.min(...s.members.map((p) => RANK[queued.get(p)!.priority])));
		}
		// Stacks in queue order: priority, then the earliest place, then the oldest.
		const key = (s: QueueModel['stacks'][number]) => [RANK[s.priority], Math.min(...s.members.map((p) => queued.get(p)!.position ?? 0)), Math.min(...s.members.map((p) => queued.get(p)!.enqueuedAt))];
		for (let k = 1; k < m.stacks.length; k++) {
			const a = key(m.stacks[k - 1]);
			const b = key(m.stacks[k]);
			const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || m.stacks[k - 1].root - m.stacks[k].root;
			expect(cmp, `stack #${m.stacks[k - 1].root} before #${m.stacks[k].root}`).toBeLessThan(0);
		}
		// A held PR's branch is held with it; a held PR has a reason.
		for (const h of m.attention) {
			expect(h.reason.length).toBeGreaterThan(0);
			for (const c of q.queue.map((e) => e.pr).filter((c) => parentOf(c) === h.pr)) expect(held.has(c), `#${c} on held #${h.pr}`).toBe(true);
		}

		// A new batch: whole stacks, then the longest fitting part of the next one; nothing held.
		const room = 2 + (seed % 7);
		const f = fillBatch(m, { config: { ...config, maxBatch: room }, inflightBatches: 0, now: NOW });
		if (f.batch) {
			expect(new Set(f.batch).size).toBe(f.batch.length);
			for (const p of f.batch) expect(held.has(p)).toBe(false);
			const inBatch = new Set<number>();
			for (const p of f.batch) {
				const up = parentOf(p);
				expect(up === null || inBatch.has(up) || q.inflight.includes(up), `#${p} without its parent #${up}`).toBe(true);
				inBatch.add(p);
			}
			if (!f.express) {
				const takeable = m.stacks.reduce((n, s) => n + s.members.length, 0);
				expect(f.batch.length).toBe(Math.min(room, takeable));
				// Stacks in order: each stack is in whole except the last one touched.
				let k = 0;
				let left = room;
				for (const s of m.stacks) {
					if (left === 0) break;
					const take = s.members.slice(0, left);
					expect(f.batch.slice(k, k + take.length)).toEqual(take);
					k += take.length;
					left -= take.length;
				}
			}
		}

		// One by one: the first stack that sits on nothing being tested, whole.
		const s = serialPick(m, { inflight: 0 });
		const head = m.stacks.find((x) => x.on === null);
		expect(s).toEqual(head ? head.members : null);
	});
});

describe('the queue page: the model from what the planner recorded', () => {
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

	test('stacks as grouped rows, each with its depth and parent, in the order the queue takes them', () => {
		const b = queueBoard([item(1, 50), item(2, 40), item(3, 30), item(4, 20), item(5, 10, { priority: 'urgent' })], stacks([1, 2, 3, 4, 5], { 2: 1, 3: 2, 4: 1 }), new Set());
		expect(b).toEqual({
			stacks: [
				{ root: 5, on: null, priority: 'urgent', rows: [{ pr: 5, depth: 0, parent: null }] },
				{
					root: 1,
					on: null,
					priority: 'normal',
					rows: [
						{ pr: 1, depth: 0, parent: null },
						{ pr: 2, depth: 1, parent: 1 },
						{ pr: 3, depth: 2, parent: 2 },
						{ pr: 4, depth: 1, parent: 1 }
					]
				}
			],
			attention: []
		});
	});

	test("a PR the planner holds is held for the planner's reason, and its branch with it", () => {
		const b = queueBoard(
			[item(1, 50), item(2, 40, { hold: { code: 'draft', reason: 'Draft' }, message: 'Draft' }), item(3, 30), item(4, 20, { hold: { code: 'not-approved', reason: 'Not approved' }, message: 'Not approved' })],
			stacks([1, 2, 3, 4], { 2: 1, 3: 2 }),
			new Set()
		);
		expect(b.stacks.map((s) => s.rows.map((r) => r.pr))).toEqual([[1]]);
		expect(b.attention).toEqual([
			{ pr: 2, code: 'draft', reason: 'Draft', cause: null },
			{ pr: 3, code: 'parent-held', reason: 'Waits for #2: draft', cause: 2 },
			{ pr: 4, code: 'not-approved', reason: 'Not approved', cause: null }
		]);
	});

	test('a conflict or a failure needs someone, whatever the PR is stacked on', () => {
		const b = queueBoard(
			[item(1, 50, { status: 'conflict', message: 'Conflicts with main in src/a.ts' }), item(2, 40), item(3, 30, { status: 'failed', message: null })],
			stacks([1, 2, 3], { 2: 1 }),
			new Set()
		);
		expect(b.stacks).toEqual([]);
		expect(b.attention).toEqual([
			{ pr: 1, code: 'conflict', reason: 'Conflicts with main in src/a.ts', cause: null },
			{ pr: 2, code: 'parent-held', reason: 'Waits for #1: conflicts with main in src/a.ts', cause: 1 },
			{ pr: 3, code: 'failed', reason: 'Failed', cause: null }
		]);
	});

	test('a deferred PR needs no one: it is in line, after the PRs it waits for', () => {
		const why = 'Conflicts with #7 ahead of it; waits for them to land';
		const b = queueBoard(
			[item(1, 50, { message: why, after: [7] }), item(2, 40, { hold: { code: 'deferred', reason: why }, message: why, after: [7] }), item(3, 30)],
			stacks([1, 2, 3], { 3: 2 }),
			new Set()
		);
		expect(b.attention).toEqual([]);
		expect(b.stacks).toEqual([
			{ root: 1, on: null, priority: 'normal', rows: [{ pr: 1, depth: 0, parent: null, after: [7] }] },
			{ root: 2, on: null, priority: 'normal', rows: [{ pr: 2, depth: 0, parent: null, after: [7] }, { pr: 3, depth: 1, parent: 2 }] }
		]);
	});

	test('PRs being tested are left out; a stack on one of them sits on it', () => {
		const b = queueBoard([item(1, 50, { status: 'checking' }), item(2, 40), item(3, 30, { status: 'merged' })], stacks([1, 2, 3], { 2: 1 }), new Set([1]));
		expect(b).toEqual({ stacks: [{ root: 2, on: 1, priority: 'normal', rows: [{ pr: 2, depth: 0, parent: null }] }], attention: [] });
	});

	test('a PR left checking by an interrupted run is in line again', () => {
		const b = queueBoard([item(1, 50, { status: 'checking' })], stacks([1]), new Set());
		expect(b.stacks.map((s) => s.root)).toEqual([1]);
	});
});
