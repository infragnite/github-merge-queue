/** The GitHub Actions runs of a branch: a batch's or bisection run's CI, one click away, no API call. */
export function actionsUrl(owner: string, repo: string, branch: string): string {
	return `https://github.com/${owner}/${repo}/actions?query=${encodeURIComponent(`branch:${branch}`)}`;
}

/** Where a run's CI is: the run itself once CI listed it, its branch's runs before that. */
export function runHref(owner: string, repo: string, run: { branch: string; runUrl: string | null }): string {
	return run.runUrl ?? actionsUrl(owner, repo, run.branch);
}
