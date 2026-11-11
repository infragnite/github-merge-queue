// Why a run is still going after a job failed. Runs of several PRs stop at their first failed
// job; a run of one PR is that PR's verdict and runs to the end, so its author gets every error.
// Before anything fails there is nothing to explain.

interface RunLike {
	prs: { pr: number }[];
	ci: string;
	finishedAt: string | null;
	progress: { total: number; done: number; failed: number } | null;
}

/** `stopsEarly`: the repo's stop-on-first-failure setting. */
export function runNote(run: RunLike, stopsEarly = true): string | null {
	const p = run.progress;
	// Decided at its first failed job: the rest of its CI goes on for the author, holding nothing.
	if (run.ci === 'failure' && run.prs.length === 1 && p && p.done < p.total)
		return `Failed at its first failed job. Its other ${p.total - p.done} jobs go on only for #${run.prs[0].pr}'s full log; nothing waits for them.`;
	if (run.ci !== 'pending' || run.finishedAt || !p || p.failed === 0) return null;
	if (!stopsEarly) return 'A job failed. It runs to the end: stop on first failure is off in the settings.';
	if (run.prs.length !== 1) return null;
	// A failed job isn't the queue's verdict yet (another workflow, a re-run, a red default branch).
	return `A job failed. #${run.prs[0].pr} runs to the end so its author gets every error: ${p.total - p.done} jobs left.`;
}
