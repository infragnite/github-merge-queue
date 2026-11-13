import { expect, test } from 'vitest';
import { livenessProblem } from './liveness';

const MIN = 60_000;

test('healthy while cycles keep finishing', () => {
	expect(livenessProblem({ now: 10 * MIN, startedAt: 0, lastCycleEnd: 9 * MIN, runningSince: null })).toBeNull();
	expect(livenessProblem({ now: 10 * MIN, startedAt: 0, lastCycleEnd: 9 * MIN, runningSince: 9.5 * MIN })).toBeNull();
});

test('a cycle running longer than 10 minutes is a hang', () => {
	expect(livenessProblem({ now: 20 * MIN, startedAt: 0, lastCycleEnd: 9 * MIN, runningSince: 9.5 * MIN })).toBe('the processor cycle started 10 min ago has not finished');
});

test('no finished cycle for 10 minutes after start is a hang; a fresh start is not', () => {
	expect(livenessProblem({ now: 2 * MIN, startedAt: 0, lastCycleEnd: null, runningSince: null })).toBeNull();
	expect(livenessProblem({ now: 12 * MIN, startedAt: 0, lastCycleEnd: null, runningSince: null })).toBe('no processor cycle has finished in 12 min');
});
