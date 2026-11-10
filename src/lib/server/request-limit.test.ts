import { expect, test } from 'vitest';
import { RequestLimiter, addressKey } from './request-limit';

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

test('a flood of new keys evicts the least recently used, not a client that keeps asking', () => {
	const l = new RequestLimiter(2, 1, 100);
	l.take('victim', 0);
	l.take('victim', 0);
	for (let i = 0; i < 500; i++) {
		l.take(`k${i}`, 0);
		if (i % 20 === 0) expect(l.take('victim', 0)).toBeGreaterThan(0);
	}
	expect(l.take('victim', 0)).toBeGreaterThan(0);
	expect((l as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(101);
});

test('addresses: IPv4 as is, IPv6 by its /64', () => {
	expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
	expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
	expect(addressKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
	expect(addressKey('2001:0DB8:0001:0002:ffff:0:0:2')).toBe('2001:db8:1:2::/64');
	expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
});
