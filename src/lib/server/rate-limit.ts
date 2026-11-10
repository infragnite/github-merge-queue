// GitHub's rate limits, per installation. Every response says how much of the hour's budget is
// left; once GitHub refuses for the rate limit, calls for that installation fail at once, with no
// request, until GitHub's reset time, instead of spending the next hour's budget on retries.

import { GitHubError } from './github-retry';

export class RateLimitedError extends GitHubError {
	constructor(
		readonly until: number,
		message: string
	) {
		super(429, message);
	}
}

interface Budget {
	remaining: number | null;
	limit: number | null;
	/** Epoch ms when the hour's budget refills. */
	reset: number | null;
	/** Epoch ms until which calls are refused without asking GitHub. */
	blockedUntil: number | null;
}

const budgets = new Map<string, Budget>();
const budget = (key: string) => {
	let b = budgets.get(key);
	if (!b) budgets.set(key, (b = { remaining: null, limit: null, reset: null, blockedUntil: null }));
	return b;
};

const until = (t: number) => new Date(t).toISOString().slice(11, 16) + ' UTC';

/** Throws, without a request, while `key`'s calls wait for GitHub's reset. */
export function checkBudget(key: string, now = Date.now()) {
	const b = budgets.get(key);
	if (b?.blockedUntil && b.blockedUntil > now) throw new RateLimitedError(b.blockedUntil, `GitHub rate limit reached; calls resume at ${until(b.blockedUntil)}`);
}

/**
 * Records what a response says about the budget. Returns the error to throw when the response
 * is a rate-limit refusal (a 403 or 429 with no budget left, or a secondary limit).
 */
export function noteResponse(key: string, status: number, headers: Headers, message: string, now = Date.now()): RateLimitedError | null {
	const b = budget(key);
	const num = (h: string) => (headers.get(h) === null ? null : Number(headers.get(h)));
	b.remaining = num('x-ratelimit-remaining') ?? b.remaining;
	b.limit = num('x-ratelimit-limit') ?? b.limit;
	const reset = num('x-ratelimit-reset');
	if (reset !== null) b.reset = reset * 1000;
	if (status !== 403 && status !== 429) return null;
	const retryAfter = num('retry-after');
	const primary = num('x-ratelimit-remaining') === 0;
	if (!primary && retryAfter === null && !/rate limit/i.test(message)) return null;
	// Primary limit: until the reset. Secondary: as long as GitHub says, or a minute.
	b.blockedUntil = retryAfter !== null ? now + retryAfter * 1000 : primary && b.reset ? b.reset : now + 60_000;
	return new RateLimitedError(b.blockedUntil, `${message} (calls resume at ${until(b.blockedUntil)})`);
}

/** What is known about `key`'s budget, for the dashboard. */
export function budgetOf(key: string, now = Date.now()) {
	const b = budgets.get(key);
	if (!b) return null;
	return { ...b, blockedUntil: b.blockedUntil && b.blockedUntil > now ? b.blockedUntil : null };
}

/** Under a tenth of the hour's budget left: reads that are only for display wait for the reset. */
export function budgetLow(key: string, now = Date.now()): boolean {
	const b = budgetOf(key, now);
	if (!b) return false;
	if (b.blockedUntil) return true;
	return b.remaining !== null && b.limit !== null && b.remaining < b.limit / 10 && (b.reset === null || b.reset > now);
}

export function resetBudgets() {
	budgets.clear();
}
