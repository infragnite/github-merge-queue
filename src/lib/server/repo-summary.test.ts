import { expect, test } from 'vitest';
import { summarize } from './repo-summary';
import type { BoardItem } from './queue-model';

function item(pr: number, over: Partial<BoardItem> = {}): BoardItem {
	return { pr, status: 'queued', priority: 'normal', position: pr, enqueuedAt: 1_000 + pr, hold: null, message: null, ...over };
}

const base = { mode: 'batch' as const, maxBatch: 8, paused: null, masterRed: false, inflight: [] as number[] };

test('batch mode counts the PRs in flight as testing, the rest as waiting, failures as attention', () => {
	const s = summarize({
		...base,
		items: [item(1, { status: 'checking' }), item(2, { status: 'checking' }), item(3), item(4), item(5, { status: 'failed', message: 'CI failed' }), item(6, { status: 'conflict' })],
		inflight: [1, 2]
	});
	expect(s).toMatchObject({ state: 'running', testing: 2, waiting: 2, attention: 2, modeLabel: 'Batches of up to 8' });
});

test('batch mode: a PR that landed or left its batch is not counted as testing', () => {
	const s = summarize({ ...base, items: [item(1, { status: 'merged' }), item(2), item(3)], inflight: [] });
	expect(s).toMatchObject({ state: 'waiting', testing: 0, waiting: 2 });
});

test('one by one counts the PR under test once, not also as waiting', () => {
	const s = summarize({ ...base, mode: 'serial', items: [item(1, { status: 'checking' }), item(2), item(3)] });
	expect(s).toMatchObject({ state: 'running', testing: 1, waiting: 2, attention: 0, modeLabel: 'One by one' });
});

test('a PR the planner holds for someone needs attention; one deferred behind a conflict ahead waits in line', () => {
	const s = summarize({
		...base,
		items: [
			item(1, { hold: { code: 'not-approved', reason: 'Needs an approval' }, message: 'Needs an approval' }),
			item(2, { hold: { code: 'deferred', reason: 'Conflicts with #9 ahead' }, after: [9] })
		]
	});
	expect(s).toMatchObject({ state: 'waiting', testing: 0, waiting: 1, attention: 1 });
});

test('a held PR needs attention and is not counted as waiting', () => {
	const s = summarize({ ...base, items: [item(1, { hold: { code: 'draft', reason: 'Draft' } }), item(2)] });
	expect(s).toMatchObject({ waiting: 1, attention: 1 });
});

test('paused wins over a red default branch, which wins over running', () => {
	const items = [item(1, { status: 'checking' })];
	const inflight = [1];
	expect(summarize({ ...base, items, inflight, paused: 'CI is misconfigured', masterRed: true }).state).toBe('paused');
	expect(summarize({ ...base, items, inflight, masterRed: true }).state).toBe('red');
	expect(summarize({ ...base, items: [] }).state).toBe('idle');
});
