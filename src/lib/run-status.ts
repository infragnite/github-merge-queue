// The status a run shows on the queue page. A run with a failed job whose other jobs still go is
// failing: its verdict is known, but it hasn't ended (a run of one PR is never stopped early).

interface RunLike {
	kind: string;
	status: string;
	ci: string;
	prs: { pr: number }[];
	finishedAt: string | null;
	progress: { total: number; done: number; failed: number } | null;
}

export function runStatus(run: RunLike): string {
	const p = run.progress;
	if ((run.kind === 'try' || run.kind === 'baseline') && run.status === 'landed') return 'passed';
	const failedJob = !!p && p.failed > 0;
	const stillGoing = !!p && p.done < p.total;
	if ((run.status === 'testing' || run.status === 'retrying') && failedJob) return 'failing';
	// Decided at its first failed job; its other jobs go on for the author's log.
	if (run.status === 'failed' && run.ci === 'failure' && run.prs.length === 1 && failedJob && stillGoing) return 'failing';
	return run.status;
}
