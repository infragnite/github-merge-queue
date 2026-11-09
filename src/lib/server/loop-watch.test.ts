import { afterEach, expect, test, vi } from 'vitest';
import { watchEventLoop } from './loop-watch';

afterEach(() => vi.useRealTimers());

test('logs a stall of the event loop, and nothing while it is free', () => {
	vi.useFakeTimers();
	const logs: string[] = [];
	watchEventLoop((m) => logs.push(m));
	vi.advanceTimersByTime(5_000);
	expect(logs).toEqual([]);
	vi.setSystemTime(Date.now() + 3_000);
	vi.advanceTimersByTime(1_000);
	expect(logs).toEqual(['[merge-queue] Event loop was blocked for 3000 ms']);
});
