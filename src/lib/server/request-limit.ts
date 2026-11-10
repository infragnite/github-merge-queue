// Per-client request budgets for traffic without a session (a public queue page, sign-in), so a
// link shared widely, or a script, can't make the server busy. A token bucket per key, in memory.

export interface Bucket {
	tokens: number;
	at: number;
}

export class RequestLimiter {
	private buckets = new Map<string, Bucket>();

	constructor(
		/** Requests a key may make in a burst. */
		readonly burst: number,
		/** Requests a key regains per minute. */
		readonly perMinute: number,
		readonly maxKeys = 20_000
	) {}

	/** Takes one request from `key`'s budget; the seconds to wait when there is none left, else 0. */
	take(key: string, now = Date.now()): number {
		const rate = this.perMinute / 60_000;
		const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
		b.tokens = Math.min(this.burst, b.tokens + (now - b.at) * rate);
		b.at = now;
		if (b.tokens < 1) {
			this.buckets.set(key, b);
			return Math.ceil((1 - b.tokens) / rate / 1000);
		}
		b.tokens -= 1;
		this.buckets.set(key, b);
		if (this.buckets.size > this.maxKeys) this.prune(now);
		return 0;
	}

	/** Drops buckets that are full again (they'd behave the same as a new one). */
	private prune(now: number) {
		const full = (this.burst / this.perMinute) * 60_000;
		for (const [k, b] of this.buckets) if (now - b.at >= full) this.buckets.delete(k);
		// Still too many (a flood of distinct keys): start over rather than grow without bound.
		if (this.buckets.size > this.maxKeys) this.buckets.clear();
	}
}
