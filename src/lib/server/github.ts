import { actionsJobsFor } from './ci-savings';
import { env } from '$env/dynamic/private';
import { createSign } from 'crypto';
import { mergeInStack, needsAsyncMerge } from './stacked-merge';
import {
	mergeResultFromData,
	mergeResultFromError,
	withTokenRefreshOn401,
	GitHubError
} from './github-retry';
import type { StackGitHub } from './stack-source';
import { Installations, ownerOfPath } from './installations';
import { budgetLow, budgetOf, checkBudget, noteResponse } from './rate-limit';

const API = 'https://api.github.com';

function headers(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github.v3+json',
		'X-GitHub-Api-Version': '2022-11-28'
	};
}

/** `budget` names the rate-limit budget the call spends (an installation's); it is tracked when given. */
async function ghFetch(token: string, path: string, init?: RequestInit, budget?: string) {
	// REST and GraphQL spend separate budgets.
	if (budget) budget = `${budget}:${path === '/graphql' ? 'graphql' : 'core'}`;
	if (budget) checkBudget(budget);
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: { ...headers(token), ...init?.headers }
	});
	if (res.status === 204) {
		if (budget) noteResponse(budget, res.status, res.headers, '');
		return null;
	}
	const body = await res.json().catch(() => ({}));
	if (budget) {
		const graphqlLimited = Array.isArray(body?.errors) && body.errors.some((e: { type?: string }) => e?.type === 'RATE_LIMITED');
		const message = graphqlLimited ? body.errors.map((e: { message?: string }) => e.message).join('; ') : (body.message ?? '');
		const limited = noteResponse(budget, res.status, res.headers, message, Date.now(), graphqlLimited);
		if (limited) throw limited;
	}
	if (!res.ok) {
		// A missing App permission names only the symptom; the call says which permission it is.
		const call = `${init?.method ?? 'GET'} ${path.split('?')[0]}`;
		const missingPermission = res.status === 403 && /not accessible by integration/i.test(body.message ?? '');
		const message = missingPermission ? `${body.message}: ${call}` : body.message;
		throw new GitHubError(res.status, message || `GitHub API ${res.status}: ${call}`, body, call);
	}
	return body;
}

// --- JWT and Installation Token ---

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

// Installation tokens, one per account the App is installed on. The 401 retry in
// `ghFetchAsApp` / `withTokenRefreshOn401` is load-bearing — see comment
// on `withTokenRefreshOn401` in ./github-retry.ts.
const installations = new Installations({
	async listInstallations() {
		const out = [];
		for (let page = 1; page <= 10; page++) {
			const batch = await ghFetch(createJWT(), `/app/installations?per_page=100&page=${page}`);
			out.push(...batch);
			if (batch.length < 100) break;
		}
		return out;
	},
	createToken: (id) => ghFetch(createJWT(), `/app/installations/${id}/access_tokens`, { method: 'POST' })
});

/** A token of the installation on `owner`, the account whose repositories it acts on. */
export async function getInstallationToken(owner: string): Promise<string> {
	return installations.token(await installations.idFor(owner));
}

async function withInstallation<T>(installationId: number, call: (token: string) => Promise<T>): Promise<T> {
	return withTokenRefreshOn401(
		() => installations.token(installationId),
		() => installations.forget(installationId),
		call
	);
}

/** Calls `path` as the installation on the account it acts on; a path that names none passes `owner`. */
async function ghFetchAsApp(path: string, init?: RequestInit, owner: string | null = ownerOfPath(path)) {
	if (!owner) throw new Error(`No account to pick an installation token for: ${path}`);
	const id = await installations.idFor(owner);
	return withInstallation(id, (token) => ghFetch(token, path, init, `installation:${id}`));
}

/** The App's rate-limit budget on `owner`'s installation, as GitHub last reported it. */
export async function rateLimitOf(owner: string) {
	// The REST budget: it is what the queue and the dashboard mostly spend.
	const key = `installation:${await installations.idFor(owner)}:core`;
	return { ...budgetOf(key), low: budgetLow(key) };
}

// --- User-token operations (login flow only, token is discarded after) ---

export async function getUser(token: string) {
	return ghFetch(token, '/user');
}

// GET /orgs/{org}/members/{username} returns 204 if member, 404 if not.
// The 302 redirect case (requester not a public-org member) does not apply
// under an installation token, so a successful ghFetchAsApp resolution
// reliably indicates membership here.
export async function checkOrgMembership(username: string, org: string): Promise<boolean> {
	try {
		await ghFetchAsApp(`/orgs/${org}/members/${username}`);
		return true;
	} catch {
		return false;
	}
}

// --- Installation-token operations (all repo operations) ---

/** Every repository of every account the App is installed on. */
export async function listInstallationRepos(): Promise<
	Array<{ full_name: string; default_branch: string }>
> {
	const out: Array<{ full_name: string; default_branch: string }> = [];
	for (const id of await installations.ids()) {
		for (let page = 1; page <= 10; page++) {
			const data = await withInstallation(id, (token) =>
				ghFetch(token, `/installation/repositories?per_page=100&page=${page}`)
			);
			for (const r of data.repositories as Array<{ full_name: string; default_branch: string }>) {
				out.push({ full_name: r.full_name, default_branch: r.default_branch });
			}
			if (data.repositories.length < 100) break;
		}
	}
	return out.sort((a, b) => a.full_name.localeCompare(b.full_name));
}

let installUrl: string | null = null;

/** Where an admin installs the App on more repositories (its GitHub page), or null if GitHub can't say. */
export async function appInstallUrl(): Promise<string | null> {
	if (installUrl) return installUrl;
	try {
		const app = (await ghFetch(createJWT(), '/app')) as { html_url?: string } | null;
		if (app?.html_url?.startsWith('https://github.com/')) installUrl = `${app.html_url}/installations/new`;
	} catch {
		// Shown without the link.
	}
	return installUrl;
}

export async function getRepo(owner: string, repo: string) {
	return ghFetchAsApp(`/repos/${owner}/${repo}`);
}

export async function getOpenPRs(owner: string, repo: string) {
	// All of them: a stack's parent may be older than the newest hundred.
	const out = [];
	for (let page = 1; page <= 20; page++) {
		const batch = await ghFetchAsApp(
			`/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=desc&per_page=100&page=${page}`
		);
		out.push(...batch);
		if (batch.length < 100) break;
	}
	return out;
}

export async function getPR(owner: string, repo: string, prNumber: number) {
	return ghFetchAsApp(`/repos/${owner}/${repo}/pulls/${prNumber}`);
}

export async function updateBranch(owner: string, repo: string, prNumber: number) {
	return ghFetchAsApp(`/repos/${owner}/${repo}/pulls/${prNumber}/update-branch`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ expected_head_sha: undefined })
	});
}

export async function getCheckStatus(owner: string, repo: string, ref: string) {
	const [status, checks] = await Promise.all([
		ghFetchAsApp(`/repos/${owner}/${repo}/commits/${ref}/status`),
		ghFetchAsApp(`/repos/${owner}/${repo}/commits/${ref}/check-runs`)
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
	return ghFetchAsApp(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ body })
	});
}

/** Reacts to an issue or PR comment, e.g. to acknowledge a `/mq` command. */
export async function reactToComment(owner: string, repo: string, commentId: number, content: '+1' | 'confused' | 'eyes') {
	return ghFetchAsApp(`/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ content })
	});
}

export async function mergePR(
	owner: string,
	repo: string,
	prNumber: number,
	method: 'merge' | 'squash' | 'rebase' = 'squash'
) {
	try {
		const data = await ghFetchAsApp(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ merge_method: method })
		});
		return mergeResultFromData(data);
	} catch (e) {
		return mergeResultFromError(e);
	}
}

// --- Stack detection ---

export async function getRecentlyClosedPRs(owner: string, repo: string) {
	return ghFetchAsApp(
		`/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`
	);
}

function refPath(ref: string) {
	return ref.split('/').map(encodeURIComponent).join('/');
}

export async function getBranchSha(owner: string, repo: string, branch: string): Promise<string | null> {
	try {
		const data = await ghFetchAsApp(`/repos/${owner}/${repo}/git/ref/heads/${refPath(branch)}`);
		return data?.object?.sha ?? null;
	} catch (e) {
		if (e instanceof GitHubError && e.status === 404) return null;
		throw e;
	}
}

export async function compareCommits(
	owner: string,
	repo: string,
	base: string,
	head: string,
	page: number,
	perPage: number
) {
	try {
		return await ghFetchAsApp(
			`/repos/${owner}/${repo}/compare/${base}...${head}?page=${page}&per_page=${perPage}`
		);
	} catch (e) {
		// 404: a SHA GitHub no longer has (e.g. garbage-collected after a force-push).
		if (e instanceof GitHubError && (e.status === 404 || e.status === 422)) return null;
		throw e;
	}
}

export function stackClient(owner: string, repo: string): StackGitHub {
	return {
		listOpenPRs: () => getOpenPRs(owner, repo),
		listRecentlyClosedPRs: () => getRecentlyClosedPRs(owner, repo),
		getBranchSha: (branch) => getBranchSha(owner, repo, branch),
		compare: (base, head, page, perPage) => compareCommits(owner, repo, base, head, page, perPage)
	};
}

// --- Batch queue ---

export async function getInstallationTokenForGit(owner: string): Promise<string> {
	return getInstallationToken(owner);
}

export interface GhReview {
	user: { login: string } | null;
	state: string;
	commit_id: string;
	author_association: string;
	submitted_at: string;
}

export async function listReviews(owner: string, repo: string, n: number): Promise<GhReview[]> {
	const out: GhReview[] = [];
	for (let page = 1; page <= 10; page++) {
		const batch: GhReview[] = await ghFetchAsApp(`/repos/${owner}/${repo}/pulls/${n}/reviews?per_page=100&page=${page}`);
		out.push(...batch);
		if (batch.length < 100) break;
	}
	return out;
}

/** A rule from `GET /repos/{owner}/{repo}/rules/branches/{branch}`. */
export interface BranchRule {
	type: string;
	parameters?: Record<string, unknown>;
}

/**
 * Classic branch protection's review settings: the body of
 * `GET .../branches/{branch}/protection/required_pull_request_reviews`, null when the branch has
 * none, or 'unreadable' when the App may not read them (they need the Administration permission).
 */
export type ClassicReviews = Record<string, unknown> | null | 'unreadable';

/** A branch's rules that decide whether a push to a PR costs its approval. */
export interface PushRules {
	rules: BranchRule[];
	classic: ClassicReviews;
}

/**
 * Whether a push to a PR's head leaves the PR mergeable without a new approval under these rules:
 * no rule that requires an approval also dismisses one on a push, asks the last push to be
 * approved by someone else, or asks one more approval for unattributed changes; and, where the
 * queue requires an approval itself (`queueRequiresApproval`), no rule dismisses one on a push
 * (the queue's check counts only approvals GitHub still has). Classic protection's review
 * settings need the Administration permission, which the App doesn't ask for: when it can't read
 * them it goes by the rulesets alone, as the queue did before it read any rules.
 */
export function pushKeepsApprovalFrom(rules: BranchRule[], classic: ClassicReviews, opts: { queueRequiresApproval: boolean }): boolean {
	if (classic === 'unreadable') classic = null;
	const costs = (p: Record<string, unknown>, dismiss: string) => {
		// GitHub applies the last-push and unattributed-change rules only with a non-zero count.
		if (Number(p.required_approving_review_count ?? 0) > 0) return !!p[dismiss] || !!p.require_last_push_approval || !!p.require_extra_approval_for_unattributed_changes;
		return opts.queueRequiresApproval && !!p[dismiss];
	};
	if (rules.some((r) => r.type === 'pull_request' && costs(r.parameters ?? {}, 'dismiss_stale_reviews_on_push'))) return false;
	return !(classic && costs(classic, 'dismiss_stale_reviews'));
}

/** `branch`'s rules as GitHub has them now, for `pushKeepsApprovalFrom`: two or three API calls. */
export async function pushRules(owner: string, repo: string, branch: string): Promise<PushRules> {
	const path = `/repos/${owner}/${repo}`;
	const [rules, b] = await Promise.all([
		ghFetchAsApp(`${path}/rules/branches/${refPath(branch)}?per_page=100`) as Promise<BranchRule[]>,
		ghFetchAsApp(`${path}/branches/${refPath(branch)}`)
	]);
	let classic: ClassicReviews = null;
	// `protected` is also true for a branch only rulesets cover; `protection.enabled` is classic protection.
	if (b?.protected && b?.protection?.enabled !== false) {
		classic = await readClassicReviews(() => ghFetchAsApp(`${path}/branches/${refPath(branch)}/protection/required_pull_request_reviews`));
		if (classic === 'unreadable') console.warn(`[merge-queue] ${owner}/${repo}: can't read ${branch}'s review protection (it needs the Administration permission); going by its rulesets`);
	}
	return { rules, classic };
}

/**
 * Classic review protection, read with `read`. A 404 is none, and a 403 (the App lacks the
 * Administration permission) is 'unreadable', which leaves the rulesets to decide. Any other error
 * throws: a 5xx is no answer, and taking it for no protection could dismiss approvals.
 */
export async function readClassicReviews(read: () => Promise<Record<string, unknown>>): Promise<ClassicReviews> {
	try {
		return await read();
	} catch (e) {
		if (e instanceof GitHubError && e.status === 404) return null;
		if (e instanceof GitHubError && e.status === 403) return 'unreadable';
		throw e;
	}
}

export async function deleteBranch(owner: string, repo: string, branch: string) {
	try {
		await ghFetchAsApp(`/repos/${owner}/${repo}/git/refs/heads/${refPath(branch)}`, { method: 'DELETE' });
	} catch (e) {
		if (e instanceof GitHubError && (e.status === 404 || e.status === 422)) return;
		throw e;
	}
}

export async function setPRBase(owner: string, repo: string, n: number, base: string) {
	return ghFetchAsApp(`/repos/${owner}/${repo}/pulls/${n}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ base })
	});
}

/**
 * Squash-merges PR `n` at exactly `sha` with an empty body. REST can't send an empty body (its
 * default lists every commit message of the PR); GraphQL `mergePullRequest` can. GitHub credits
 * the squash to whoever opened the PR, which is the author a repo's rules expect.
 */
export async function squashMergeAt(owner: string, repo: string, n: number, title: string, sha: string) {
	try {
		const pr = await ghFetchAsApp(`/repos/${owner}/${repo}/pulls/${n}`);
		// A PR in one of GitHub's stacks only merges through the async merge API (see stacked-merge.ts).
		const inStack = () =>
			mergeInStack(
				{
					put: (path, body) => ghFetchAsApp(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, owner),
					get: (path) => ghFetchAsApp(path, undefined, owner),
					sleep: (ms) => new Promise((r) => setTimeout(r, ms))
				},
				{ pulls: `/repos/${owner}/${repo}/pulls`, n, title, sha, pr }
			);
		if (needsAsyncMerge(pr, null)) return await inStack();
		const data = await ghFetchAsApp(
			'/graphql',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					query: `mutation($input: MergePullRequestInput!) {
						mergePullRequest(input: $input) { pullRequest { merged mergeCommit { oid } } }
					}`,
					variables: {
						input: {
							pullRequestId: pr.node_id,
							mergeMethod: 'SQUASH',
							commitHeadline: title,
							commitBody: '',
							expectedHeadOid: sha
						}
					}
				})
			},
			owner
		);
		if (data.errors?.length) {
			const message = data.errors.map((e: { message: string }) => e.message).join('; ');
			// A PR GitHub stacked without saying so in the PR it returned.
			if (needsAsyncMerge({}, message)) return await inStack();
			return { merged: false, sha: null, message };
		}
		const r = data.data?.mergePullRequest?.pullRequest;
		return mergeResultFromData({ merged: !!r?.merged, sha: r?.mergeCommit?.oid });
	} catch (e) {
		return mergeResultFromError(e);
	}
}

export async function createCommitStatus(
	owner: string,
	repo: string,
	sha: string,
	status: { state: 'success' | 'failure' | 'pending'; context: string; description: string; target_url?: string }
) {
	return ghFetchAsApp(`/repos/${owner}/${repo}/statuses/${sha}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...status, description: status.description.slice(0, 140) })
	});
}

/** A check run on `head_sha`, as this app; GitHub shows the latest one of each name. Needs the Checks write permission. */
export async function createCheckRun(owner: string, repo: string, run: CheckRunRequest) {
	return ghFetchAsApp(`/repos/${owner}/${repo}/check-runs`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(run)
	});
}

export interface CheckRunRequest {
	name: string;
	head_sha: string;
	details_url: string;
	status: 'queued' | 'in_progress' | 'completed';
	conclusion?: 'action_required' | 'failure' | 'success' | 'neutral';
	output: { title: string; summary: string };
}

export async function dispatchWorkflow(
	owner: string,
	repo: string,
	workflow: string,
	ref: string,
	inputs: Record<string, string>
) {
	return ghFetchAsApp(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ref, inputs })
	});
}

/** GitHub Actions' app: only its check runs count, so no other app (or job) can fake the required check. */
const ACTIONS_APP_ID = 15368;

export async function checkRunsNamed(owner: string, repo: string, sha: string, name: string) {
	const data = await ghFetchAsApp(
		`/repos/${owner}/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&app_id=${ACTIONS_APP_ID}`
	);
	return data.check_runs as Array<{
		status: string;
		conclusion: string | null;
		html_url: string;
		completed_at: string | null;
		check_suite?: { id: number };
	}>;
}

/** Every Actions job on a commit (latest attempt), for showing a batch's progress. */
export async function actionsJobsForSha(owner: string, repo: string, sha: string) {
	const data = await ghFetchAsApp(`/repos/${owner}/${repo}/commits/${sha}/check-runs?filter=latest&app_id=${ACTIONS_APP_ID}&per_page=100`);
	return data.check_runs as Array<{
		name: string;
		status: string;
		conclusion: string | null;
		html_url: string;
		started_at: string | null;
		completed_at: string | null;
		check_suite?: { id: number };
	}>;
}

/** Every Actions job ever run on a commit pushed to `branch`, every attempt, with its times (for what CI cost). */
export function actionsJobAttemptsForSha(owner: string, repo: string, sha: string, branch: string, spend: () => void = () => {}) {
	return actionsJobsFor((path) => (spend(), ghFetchAsApp(path)), owner, repo, sha, branch);
}

export async function workflowRunsForSha(owner: string, repo: string, sha: string) {
	const data = await ghFetchAsApp(`/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=20`);
	return data.workflow_runs as Array<{ id: number; status: string; conclusion: string | null; event: string; check_suite_id: number; path?: string }>;
}

export async function cancelWorkflowRun(owner: string, repo: string, runId: number) {
	try {
		await ghFetchAsApp(`/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, { method: 'POST' });
	} catch (e) {
		// 409: the run already finished.
		if (e instanceof GitHubError && e.status === 409) return;
		throw e;
	}
}

export async function addLabel(owner: string, repo: string, n: number, label: string) {
	return ghFetchAsApp(`/repos/${owner}/${repo}/issues/${n}/labels`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ labels: [label] })
	});
}

export async function removeLabel(owner: string, repo: string, n: number, label: string) {
	try {
		await ghFetchAsApp(`/repos/${owner}/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' });
	} catch (e) {
		if (e instanceof GitHubError && e.status === 404) return;
		throw e;
	}
}

export async function rerunFailedJobs(owner: string, repo: string, runId: number) {
	return ghFetchAsApp(`/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST' });
}

// --- Agent API auth ---

/** The caller's own identity, from their token; null when GitHub rejects it as a user token. */
export async function userForToken(token: string): Promise<{ login: string } | null> {
	try {
		return await ghFetch(token, '/user');
	} catch (e) {
		if (e instanceof GitHubError && (e.status === 401 || e.status === 403)) return null;
		throw e;
	}
}

export async function collaboratorRole(owner: string, repo: string, login: string): Promise<string> {
	let role: string;
	try {
		const data = await ghFetchAsApp(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
		// role_name distinguishes maintain and triage; permission only says admin/write/read/none.
		// A custom repository role has its own name: fall back to the base permission it grants.
		const known = ['admin', 'maintain', 'write', 'triage', 'read'];
		role = known.includes(data.role_name) ? data.role_name : data.permission || 'none';
	} catch (e) {
		if (e instanceof GitHubError && e.status === 404) return 'none';
		throw e;
	}
	// On a public repository GitHub reports read for anyone at all. Read is the queue's access, so
	// it counts only for collaborators (direct, team, org base permission or owner); everyone else
	// gets the public page, if the repository has one.
	return role === 'read' && !(await isCollaborator(owner, repo, login)) ? 'none' : role;
}

/** Whether `login` is a collaborator of the repository in any way GitHub counts one. */
export async function isCollaborator(owner: string, repo: string, login: string): Promise<boolean> {
	try {
		await ghFetchAsApp(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}`);
		return true;
	} catch (e) {
		if (e instanceof GitHubError && e.status === 404) return false;
		throw e;
	}
}

/**
 * The repo as the caller's token sees it, with the token's OAuth scopes (`X-OAuth-Scopes`, sent
 * for classic and OAuth-app tokens only; null otherwise). Null when the token can't see the repo.
 */
export async function repoForToken(token: string, owner: string, repo: string) {
	const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: headers(token) });
	if (res.status === 401 || res.status === 403 || res.status === 404) return null;
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new GitHubError(res.status, body.message || `GitHub API ${res.status}`, body);
	return { permissions: body.permissions as Record<string, boolean> | undefined, scopes: res.headers.get('x-oauth-scopes') };
}
