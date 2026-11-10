import { expect, test } from 'vitest';
import { RequestLimiter } from './request-limit';

test('a burst, then requests at the refill rate, per key', () => {
	const l = new RequestLimiter(3, 60);
	expect([l.take('a', 0), l.take('a', 0), l.take('a', 0)]).toEqual([0, 0, 0]);
	expect(l.take('a', 0)).toBe(1);
	expect(l.take('b', 0)).toBe(0);
	expect(l.take('a', 1000)).toBe(0);
	expect(l.take('a', 1000)).toBe(1);
});

test('memory stays bounded under many keys', () => {
	const l = new RequestLimiter(1, 60, 100);
	for (let i = 0; i < 1000; i++) l.take(`k${i}`, i);
	expect((l as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(101);
});
