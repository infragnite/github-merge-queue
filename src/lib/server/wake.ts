// Webhooks mark a repo dirty so the processor runs its batch tick right away
// instead of waiting for the next polling slot.

const dirty = new Set<number>();

export function markDirty(repoId: number) {
	dirty.add(repoId);
}

/** True (once) when something changed for this repo since the last call. */
export function takeDirty(repoId: number): boolean {
	return dirty.delete(repoId);
}

// What GitHub told us about a repo's PRs changes its generation; results derived
// from PR state (stack analysis, reviews) are reused until it does, or they age out.
const generations = new Map<number, number>();

export function bumpGeneration(repoId: number) {
	generations.set(repoId, (generations.get(repoId) ?? 0) + 1);
}

export function generation(repoId: number): number {
	return generations.get(repoId) ?? 0;
}

/** Memoizes `load` per key until the repo's generation changes or `ttlMs` passes. */
export function memoByGeneration<T>(ttlMs: number) {
	const cache = new Map<string, { gen: number; until: number; value: Promise<T> }>();
	return (repoId: number, key: string, load: () => Promise<T>): Promise<T> => {
		const gen = generation(repoId);
		const k = `${repoId}:${key}`;
		const hit = cache.get(k);
		if (hit && hit.gen === gen && hit.until > Date.now()) return hit.value;
		if (cache.size > 2000) cache.clear();
		const value = load();
		cache.set(k, { gen, until: Date.now() + ttlMs, value });
		value.catch(() => {
			if (cache.get(k)?.value === value) cache.delete(k);
		});
		return value;
	};
}
