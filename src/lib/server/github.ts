import { env } from '$env/dynamic/private';
import { createSign } from 'crypto';

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

// --- JWT and Installation Token ---

let cachedInstallationToken: { token: string; expiresAt: number } | null = null;

function createJWT(): string {
	const appId = env.GITHUB_APP_ID;
	const privateKey = env.GITHUB_APP_PRIVATE_KEY;
	if (!appId || !privateKey) throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY required');

	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(
		JSON.stringify({ iss: appId, iat: now - 60, exp: now + 600 })
	).toString('base64url');

	const sign = createSign('RSA-SHA256');
	sign.update(`${header}.${payload}`);
	const signature = sign.sign(privateKey.replace(/\\n/g, '\n'), 'base64url');

	return `${header}.${payload}.${signature}`;
}

export async function getInstallationToken(): Promise<string> {
	if (cachedInstallationToken && cachedInstallationToken.expiresAt > Date.now() + 60_000) {
		return cachedInstallationToken.token;
	}

	const jwt = createJWT();
	const installationId = env.GITHUB_INSTALLATION_ID;
	if (!installationId) throw new Error('GITHUB_INSTALLATION_ID required');

	const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
		method: 'POST',
		headers: { ...headers(jwt) }
	});
	if (!res.ok) throw new Error(`Failed to create installation token: ${res.status}`);

	const data = await res.json();
	cachedInstallationToken = {
		token: data.token,
		expiresAt: new Date(data.expires_at).getTime()
	};
	return data.token;
}

// --- User-token operations (login flow only, token is discarded after) ---

export async function getUser(token: string) {
	return ghFetch(token, '/user');
}

export async function checkOrgMembership(username: string, org: string): Promise<boolean> {
	try {
		const token = await getInstallationToken();
		const res = await fetch(`${API}/orgs/${org}/members/${username}`, {
			headers: headers(token)
		});
		return res.status === 204;
	} catch {
		return false;
	}
}

// --- Installation-token operations (all repo operations) ---

export async function listInstallationRepos(): Promise<
	Array<{ full_name: string; default_branch: string }>
> {
	const token = await getInstallationToken();
	const data = await ghFetch(token, '/installation/repositories?per_page=100');
	return data.repositories.map((r: { full_name: string; default_branch: string }) => ({
		full_name: r.full_name,
		default_branch: r.default_branch
	}));
}

export async function getRepo(owner: string, repo: string) {
	const token = await getInstallationToken();
	return ghFetch(token, `/repos/${owner}/${repo}`);
}

export async function getOpenPRs(owner: string, repo: string) {
	const token = await getInstallationToken();
	return ghFetch(
		token,
		`/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=desc&per_page=100`
	);
}

export async function getPR(owner: string, repo: string, prNumber: number) {
	const token = await getInstallationToken();
	return ghFetch(token, `/repos/${owner}/${repo}/pulls/${prNumber}`);
}

export async function updateBranch(owner: string, repo: string, prNumber: number) {
	const token = await getInstallationToken();
	return ghFetch(token, `/repos/${owner}/${repo}/pulls/${prNumber}/update-branch`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ expected_head_sha: undefined })
	});
}

export async function getCheckStatus(owner: string, repo: string, ref: string) {
	const token = await getInstallationToken();
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
		(status.state === 'pending' && status.statuses.length > 0) ||
		checks.check_runs.some((c: { status: string }) => c.status !== 'completed');
	const anyFailed =
		status.state === 'failure' ||
		status.state === 'error' ||
		checks.check_runs.some(
			(c: { conclusion: string; status: string }) =>
				c.status === 'completed' &&
				(c.conclusion === 'failure' ||
					c.conclusion === 'cancelled' ||
					c.conclusion === 'timed_out')
		);

	return { allPassed, anyPending, anyFailed };
}

export async function commentOnPR(owner: string, repo: string, prNumber: number, body: string) {
	const token = await getInstallationToken();
	return ghFetch(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ body })
	});
}

export async function mergePR(
	owner: string,
	repo: string,
	prNumber: number,
	method: 'merge' | 'squash' | 'rebase' = 'squash'
) {
	const token = await getInstallationToken();
	const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
		method: 'PUT',
		headers: { ...headers(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ merge_method: method })
	});
	const body = await res.json();
	return { merged: res.ok && body.merged, sha: body.sha, message: body.message };
}
