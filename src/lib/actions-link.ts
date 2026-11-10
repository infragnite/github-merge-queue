/** The GitHub Actions runs of a branch: a batch's or bisection run's CI, one click away, no API call. */
export function actionsUrl(owner: string, repo: string, branch: string): string {
	return `https://github.com/${owner}/${repo}/actions?query=${encodeURIComponent(`branch:${branch}`)}`;
}
