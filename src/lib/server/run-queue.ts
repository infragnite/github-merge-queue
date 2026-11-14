import * as store from './batch-store';

/** CI admission, separate from the PRs waiting to merge. Merge/bisect runs bypass the try cap. */
export function runQueue(repoId: number) {
	const automatic = new Set(store.runningAutoTries(repoId).map((r) => r.id));
	const view = (r: store.BatchRow) => ({
		id: r.id, pr: r.members[0], branch: r.branch, headSha: r.heads[r.members[0]],
		automatic: automatic.has(r.id), queuedAt: r.created_at
	});
	return {
		parallelTries: store.getQueueSettings(repoId).config.parallelTries,
		running: store.getRunningTries(repoId).map(view),
		waiting: store.getQueuedTries(repoId).map((r, i) => ({ ...view(r), position: i + 1 }))
	};
}

export type RunQueue = ReturnType<typeof runQueue>;
