const API = 'https://api.github.com';

function headers(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github.v3+json',
		'X-GitHub-Api-Version': '2022-11-28'
	};
}

async function ghFetch(token: string, path: string, init?: RequestInit) {
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: { ...headers(token), ...init?.headers }
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.message || `GitHub API ${res.status}: ${path}`);
	}
	return res.json();
}

export async function getUser(token: string) {
	return ghFetch(token, '/user');
}

export async function getRepo(token: string, owner: string, repo: string) {
	return ghFetch(token, `/repos/${owner}/${repo}`);
}

export async function getOpenPRs(token: string, owner: string, repo: string) {
	return ghFetch(token, `/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=desc&per_page=100`);
}

export async function getPR(token: string, owner: string, repo: string, prNumber: number) {
	return ghFetch(token, `/repos/${owner}/${repo}/pulls/${prNumber}`);
}

export async function updateBranch(token: string, owner: string, repo: string, prNumber: number) {
	return ghFetch(token, `/repos/${owner}/${repo}/pulls/${prNumber}/update-branch`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ expected_head_sha: undefined })
	});
}

export async function getCheckStatus(token: string, owner: string, repo: string, ref: string) {
	const [status, checks] = await Promise.all([
		ghFetch(token, `/repos/${owner}/${repo}/commits/${ref}/status`),
		ghFetch(token, `/repos/${owner}/${repo}/commits/${ref}/check-runs`)
	]);

	const statusOk = status.state === 'success' || status.statuses.length === 0;
	const checksComplete = checks.check_runs.every(
		(c: { status: string }) => c.status === 'completed'
	);
	const checksOk = checks.check_runs.every(
		(c: { conclusion: string }) =>
			c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral'
	);

	const allPassed = statusOk && checksComplete && checksOk;
	const anyPending =
		status.state === 'pending' ||
		checks.check_runs.some((c: { status: string }) => c.status !== 'completed');
	const anyFailed =
		status.state === 'failure' ||
		status.state === 'error' ||
		checks.check_runs.some(
			(c: { conclusion: string; status: string }) =>
				c.status === 'completed' &&
				(c.conclusion === 'failure' || c.conclusion === 'cancelled' || c.conclusion === 'timed_out')
		);

	return { allPassed, anyPending, anyFailed };
}

export async function mergePR(
	token: string,
	owner: string,
	repo: string,
	prNumber: number,
	method: 'merge' | 'squash' | 'rebase' = 'squash'
) {
	const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
		method: 'PUT',
		headers: { ...headers(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ merge_method: method })
	});
	const body = await res.json();
	return { merged: res.ok && body.merged, sha: body.sha, message: body.message };
}
