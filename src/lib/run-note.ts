// Why a run is still going when it could have stopped. Runs of several PRs stop at their first
// failed job; a run of one PR is that PR's verdict and runs to the end, so its author gets every error.

interface RunLike {
	prs: { pr: number }[];
	ci: string;
	finishedAt: string | null;
	progress: { total: number; done: number; failed: number } | null;
}

export function runNote(run: RunLike): string | null {
	if (run.prs.length !== 1 || run.ci !== 'pending' || run.finishedAt) return null;
	const n = `#${run.prs[0].pr}`;
	const p = run.progress;
	if (p && p.failed > 0) return `${n} breaks it. It runs to the end so its author gets every error: ${p.total - p.done} jobs left.`;
	return `Runs to the end: ${n} is tested alone, so its author gets every error. Runs of several PRs stop at their first failure.`;
}
