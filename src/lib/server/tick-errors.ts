// The last error the queue hit per repository, so the dashboard can show the real cause (and how
// often it repeats) instead of only the server log having it. Cleared by the next clean tick.

export interface TickError {
	message: string;
	/** Epoch ms of the first of the repeats, and of the latest. */
	since: number;
	at: number;
	count: number;
}

const errors = new Map<number, TickError>();

export function noteTickError(repoId: number, err: unknown, now = Date.now()) {
	const message = err instanceof Error ? err.message : String(err);
	const prev = errors.get(repoId);
	errors.set(repoId, prev && prev.message === message ? { ...prev, at: now, count: prev.count + 1 } : { message, since: now, at: now, count: 1 });
}

export function clearTickError(repoId: number) {
	errors.delete(repoId);
}

export function tickError(repoId: number): TickError | null {
	return errors.get(repoId) ?? null;
}
