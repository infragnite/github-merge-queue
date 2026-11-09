// One batch-queue operation per repository at a time: the processor's tick and
// API calls that change the pipeline (a mode switch, a try run) must not interleave.

const tails = new Map<number, Promise<unknown>>();

export function withRepoLock<T>(repoId: number, fn: () => Promise<T>): Promise<T> {
	const prev = tails.get(repoId) ?? Promise.resolve();
	const next = prev.catch(() => {}).then(fn);
	const tail = next.catch(() => {});
	tails.set(repoId, tail);
	void tail.then(() => {
		if (tails.get(repoId) === tail) tails.delete(repoId);
	});
	return next;
}
