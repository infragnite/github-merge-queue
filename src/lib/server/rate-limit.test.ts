import { beforeEach, expect, test } from 'vitest';
import { budgetLow, budgetOf, checkBudget, noteResponse, RateLimitedError, resetBudgets } from './rate-limit';

const NOW = Date.UTC(2026, 10, 10, 0, 10);
const h = (o: Record<string, string>) => new Headers(o);

beforeEach(resetBudgets);

test('a primary rate-limit refusal blocks calls without a request until the reset', () => {
	const reset = Math.floor(NOW / 1000) + 1800;
	const err = noteResponse('i:1', 403, h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(reset) }), 'API rate limit exceeded', NOW);
	expect(err).toBeInstanceOf(RateLimitedError);
	expect(err!.until).toBe(reset * 1000);
	expect(() => checkBudget('i:1', NOW + 60_000)).toThrow(/calls resume at 00:40 UTC/);
	expect(() => checkBudget('i:1', reset * 1000 + 1)).not.toThrow();
	expect(() => checkBudget('i:2', NOW)).not.toThrow();
});

test('a secondary limit waits as long as Retry-After says', () => {
	const err = noteResponse('i:1', 403, h({ 'retry-after': '90' }), 'You have exceeded a secondary rate limit', NOW);
	expect(err!.until).toBe(NOW + 90_000);
});

test('other 403s are not rate limits', () => {
	expect(noteResponse('i:1', 403, h({ 'x-ratelimit-remaining': '4000' }), 'Resource not accessible by integration', NOW)).toBeNull();
	expect(() => checkBudget('i:1', NOW)).not.toThrow();
});

test('the budget is low under a tenth of the limit, until the reset', () => {
	const reset = Math.floor(NOW / 1000) + 600;
	noteResponse('i:1', 200, h({ 'x-ratelimit-remaining': '499', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(reset) }), '', NOW);
	expect(budgetLow('i:1', NOW)).toBe(true);
	expect(budgetLow('i:1', reset * 1000 + 1)).toBe(false);
	noteResponse('i:1', 200, h({ 'x-ratelimit-remaining': '501' }), '', NOW);
	expect(budgetLow('i:1', NOW)).toBe(false);
	expect(budgetOf('i:1', NOW)).toMatchObject({ remaining: 501, limit: 5000, blockedUntil: null });
});
