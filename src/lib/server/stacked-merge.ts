// Merging a PR that is part of one of GitHub's own stacks (stacked pull requests).
//
// GitHub refuses the plain merge (REST `PUT .../merge`, GraphQL `mergePullRequest`) for such a PR:
// it must go through the asynchronous merge API, `PUT .../merge-async`, which merges in the
// background and is polled for its result. That merge also merges every open PR below it in the
// stack, so the queue only asks for it on a PR with none below it: the PRs below are either already
// landed, earlier in the same batch, or not tested with it at all.

import { GitHubError, mergeResultFromError, type MergeResult } from './github-retry';

export interface AsyncMergeApi {
	put(path: string, body: unknown): Promise<unknown>;
	get(path: string): Promise<unknown>;
	sleep(ms: number): Promise<void>;
}

/** What the REST API says about a PR's GitHub stack: the stack's number, and its position from the bottom (1) and size. */
export interface StackedPR {
	stack?: { number?: number; position?: number; size?: number } | null;
}

/** A stack as `GET /repos/{o}/{r}/stacks/{number}` returns it: its PRs, bottom first. */
type Stack = { pull_requests?: Array<{ number: number; state: string }> };

type AsyncResult = { status?: string; details?: { message?: string; uuid?: string; sha?: string } };

/** How long the queue waits for GitHub to finish a background merge before it stops landing. */
const WAIT_MS = 90_000;
const POLL_MS = 3_000;

const REFUSED_AS_STACKED = /part of a stack and must be merged using the asynchronous merge/i;

/** Whether `pr` has to be merged through the async merge API: it is in a GitHub stack, or GitHub said so. */
export function needsAsyncMerge(pr: StackedPR, refusal: string | null | undefined): boolean {
	return !!pr.stack || (!!refusal && REFUSED_AS_STACKED.test(refusal));
}

/**
 * Squash-merges PR `n` at `sha` with `title`, directly (not through a GitHub merge queue), through
 * the async merge API, and waits for its merge commit. A PR with open PRs below it in its stack is
 * refused without asking GitHub, which would merge those too.
 */
export async function mergeInStack(
	api: AsyncMergeApi,
	req: { pulls: string; n: number; title: string; sha: string; pr: StackedPR }
): Promise<MergeResult> {
	// The PR's position still counts the PRs below it that merged: only the stack says which are open.
	const number = req.pr.stack?.number;
	let below: number[] = [];
	const unchecked = (why: string): MergeResult => ({ merged: false, sha: null, message: `${why}, so the PRs below it can't be checked; GitHub's merge would merge them with it` });
	if ((req.pr.stack?.position ?? 1) > 1 && number === undefined) return unchecked(`GitHub did not say which stack #${req.n} is in`);
	if (number !== undefined && (req.pr.stack?.position ?? 1) > 1) {
		let stack: Stack;
		try {
			stack = (await api.get(`${req.pulls.replace(/\/pulls$/, '')}/stacks/${number}`)) as Stack;
		} catch (e) {
			return mergeResultFromError(e);
		}
		const prs = stack.pull_requests ?? [];
		const at = prs.findIndex((p) => p.number === req.n);
		if (at < 0) return unchecked(`GitHub's stack ${number} does not list #${req.n}`);
		below = prs.slice(0, at).filter((p) => p.state === 'open').map((p) => p.number);
	}
	if (below.length) {
		const k = below.length;
		return {
			merged: false,
			sha: null,
			message: `#${req.n} sits above ${k} open PR${k === 1 ? '' : 's'} in its GitHub stack (${below.map((b) => `#${b}`).join(', ')}), and GitHub's merge would merge them with it; merge or unstack the PRs below it first`
		};
	}
	const base = `${req.pulls}/${req.n}/merge-async`;
	let r: AsyncResult;
	try {
		r = (await api.put(base, { merge_method: 'squash', merge_action: 'direct_merge', sha: req.sha, commit_title: req.title, commit_message: '' })) as AsyncResult;
	} catch (e) {
		// One already pending for this PR (a stop mid-landing, then a resume): wait for that one.
		const body = e instanceof GitHubError ? (e.body as AsyncResult | undefined) : undefined;
		if (e instanceof GitHubError && e.status === 409 && !('until' in e) && body?.details?.uuid) r = { status: 'pending', details: body.details };
		else return mergeResultFromError(e);
	}
	for (let waited = 0; r.status === 'pending' && r.details?.uuid && waited < WAIT_MS; waited += POLL_MS) {
		await api.sleep(POLL_MS);
		try {
			r = (await api.get(`${base}/${r.details.uuid}`)) as AsyncResult;
		} catch (e) {
			return mergeResultFromError(e);
		}
	}
	if (r.status === 'merged') return { merged: true, sha: r.details?.sha ?? null, message: undefined };
	if (r.status === 'pending') return { merged: false, sha: null, message: `GitHub is still merging #${req.n} in the background; resume the queue once it has merged` };
	if (r.status === 'enqueued') return { merged: false, sha: null, message: `GitHub put #${req.n} in its own merge queue instead of merging it` };
	return { merged: false, sha: null, message: r.details?.message ?? `GitHub's async merge of #${req.n} failed` };
}
