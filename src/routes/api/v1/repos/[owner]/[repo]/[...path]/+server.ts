// Agent API: stack state and queue control for one repository.
// Auth: the caller's own GitHub token, `Authorization: Bearer $(gh auth token)`.
//
//   GET    pulls/{n}/stack     stack, queue entry and next actions for a PR
//   GET    stacks              every open stack as a tree
//   GET    queue               batches in flight and waiting PRs
//   POST   pulls/{n}/queue     enqueue {priority?: urgent|normal|low}
//   PATCH  pulls/{n}/queue     {priority?, jumpTo?: "front"}
//   DELETE pulls/{n}/queue     dequeue
//   GET    queue/config        settings
//   PATCH  queue/config        {mode?, config?, ci?, publicView?}  (admin; publicView only on a public repo)
//   POST   queue/pause         {reason?}                         (maintain)
//   POST   queue/resume                                          (maintain)
//                                 lifts a pause; on an unpaused queue whose default branch is
//                                 red, vouches for the branch (it is treated as green)
//   GET    batches             recent batches
//   GET    batches/{number}    one batch, by the number the app shows, with its bisection runs
//   POST   batches/{number}/cancel stops a batch (and its bisection); its PRs go back in line   (maintain)
//   GET    history?limit=      merged and bounced PRs
//   GET    events?after=&pr=&wait=   queue events after a cursor; waits up to `wait` s (max 60)
//                                    for the first one (long poll). No `after`: recent events + cursor.
//   POST   pulls/{n}/try       one CI run of the PR on top of the default branch   (write)

import { json, type RequestHandler } from '@sveltejs/kit';
import * as github from '$lib/server/github';
import { getRepoByOwnerName } from '$lib/server/db';
import { getQueueSettings, getRecentBatches } from '$lib/server/batch-store';
import { cancelBatch, retireBatches, startTry } from '$lib/server/batch-queue';
import { withRepoLock } from '$lib/server/repo-lock';
import { liveDeps } from '$lib/server/batch-live';
import { withActivity } from '$lib/server/activity';
import { requireRole } from '$lib/server/api-auth';
import { analyzeRepoStacks, dashboardStackAnalysis } from '$lib/server/stack-runtime';
import { AuthError, bearer, resolveCaller, type AuthGitHub } from '$lib/server/api-auth';
import * as api from '$lib/server/api-service';
import { RequestLimiter, addressKey } from '$lib/server/request-limit';
import { GitHubError } from '$lib/server/github-retry';
import { log } from '$lib/server/log';

// Per address before the token is checked, per user after: agents poll, but not this much.
const byAddress = new RequestLimiter(240, 240);
const byCaller = new RequestLimiter(120, 120);
/** The same answer for a repo that isn't managed, one the token can't see, and a token GitHub refuses. */
const NOT_FOUND = 'Not found, or this token cannot see the repository';

function tooMany(wait: number) {
	return json({ error: 'Too many requests; slow down' }, { status: 429, headers: { 'retry-after': String(wait) } });
}

const authGitHub: AuthGitHub = {
	user: (token) => github.userForToken(token),
	permission: (owner, repo, login) => github.collaboratorRole(owner, repo, login),
	repoAsCaller: (token, owner, repo) => github.repoForToken(token, owner, repo)
};

const handle: RequestHandler = async ({ params, request, url, getClientAddress }) => {
	let address = 'unknown';
	try {
		address = addressKey(getClientAddress());
	} catch {
		// no address (tests)
	}
	const wait = byAddress.take(address);
	if (wait) return tooMany(wait);
	try {
		// Unmanaged repos are refused before any GitHub call, so arbitrary owner/repo paths can't
		// spend the app's rate limit; they answer like a repo the token can't see, so which private
		// repositories the queue manages can't be probed with a made-up token.
		if (!bearer(request.headers.get('authorization'))) throw new AuthError(401, 'Send your GitHub token: Authorization: Bearer $(gh auth token)');
		const repo = getRepoByOwnerName(params.owner!, params.repo!);
		if (!repo) return json({ error: NOT_FOUND }, { status: 404 });
		let caller;
		try {
			caller = await resolveCaller(authGitHub, request.headers.get('authorization'), params.owner!, params.repo!);
		} catch (e) {
			if (e instanceof AuthError && e.cantSee) return json({ error: NOT_FOUND }, { status: 404 });
			// GitHub couldn't say who this is: nobody is let in on a guess.
			if (!(e instanceof AuthError) && (e instanceof GitHubError || e instanceof TypeError)) return json({ error: 'GitHub is unreachable; try again shortly' }, { status: 503, headers: { 'retry-after': '30' } });
			throw e;
		}
		const callerWait = byCaller.take(caller.login);
		if (callerWait) return tooMany(callerWait);
		const parts = (params.path ?? '').split('/').filter(Boolean);
		const m = request.method;
		const body = async (): Promise<Record<string, unknown>> => {
			if (m === 'GET' || m === 'DELETE') return {};
			const b = await request.json().catch(() => ({}));
			return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
		};
		const route = `${m} ${parts.map((p) => (/^\d+$/.test(p) ? ':n' : p)).join('/')}`;
		const n = Number(parts.find((p) => /^\d+$/.test(p)));

		switch (route) {
			case 'GET pulls/:n/stack':
				return json(api.stackState(repo, n, await analyzeRepoStacks(repo)));
			case 'GET stacks':
				return json(api.stacksState(await analyzeRepoStacks(repo)));
			case 'GET queue':
				// The dashboard's analysis: at most one fresh one a minute, none while the rate limit is low.
				// Without the stacks (GitHub unreachable) every PR is a stack of its own.
				return json(api.queueState(repo, await dashboardStackAnalysis(repo).catch(() => null)));
			case 'POST pulls/:n/queue': {
				const pr = await github.getPR(repo.owner, repo.name, n);
				return json(api.enqueue(repo, caller, pr, await body()), { status: 201 });
			}
			case 'PATCH pulls/:n/queue':
				return json(api.changeEntry(repo, caller, n, await body()));
			case 'DELETE pulls/:n/queue':
				return json(api.dequeue(repo, caller, n));
			case 'GET queue/config':
				return json(api.getConfig(repo));
			case 'PATCH queue/config': {
				const b = await body();
				const visibility = b.publicView === true ? await api.repoVisibility(() => github.getRepo(repo.owner, repo.name)) : null;
				// Under the repo lock, so a running tick finishes before the mode flips and none
				// starts a run after the retire.
				const r = await withRepoLock(repo.id, async () => {
					const was = getQueueSettings(repo.id).mode;
					const out = api.patchConfig(repo, caller, b, visibility);
					if (getQueueSettings(repo.id).mode !== was) await retireBatches(liveDeps(repo));
					return out;
				});
				return json(r);
			}
			case 'POST queue/pause':
				return json(api.pause(repo, caller, (await body()).reason));
			case 'POST queue/resume':
				return json(api.resume(repo, caller));
			case 'GET batches':
				return json({ batches: getRecentBatches(repo.id).map(api.batchSummary) });
			case 'GET batches/:n':
				return json(api.batchDetail(repo, n));
			case 'POST batches/:n/cancel': {
				const batch = api.canCancelBatch(repo, caller, n);
				// Its CI could not be stopped nor its branches deleted until the reset.
				const limit = (await github.rateLimitOf(repo.owner).catch(() => null))?.blockedUntil;
				if (limit) throw new api.ApiError(409, `GitHub rate limit reached; cancel again after ${new Date(limit).toISOString()}`);
				try {
					return json(await withRepoLock(repo.id, () => withActivity(liveDeps(repo), (d) => cancelBatch(d, batch.id, caller.login))));
				} catch (e) {
					if (e instanceof Error && /only a batch being tested/.test(e.message)) throw new api.ApiError(409, e.message);
					throw e;
				}
			}
			case 'GET history':
				return json(api.history(repo, api.intParam(url.searchParams.get('limit'), 'limit', 50)!));
			case 'GET events':
				return json(
					await api.events(
						repo,
						{
							after: api.intParam(url.searchParams.get('after'), 'after', null),
							pr: api.intParam(url.searchParams.get('pr'), 'pr', null),
							waitSec: api.intParam(url.searchParams.get('wait'), 'wait', 0)
						},
						request.signal
					)
				);
			case 'POST pulls/:n/try': {
				requireRole(caller, 'write', 'Starting a try run');
				if (getQueueSettings(repo.id).mode !== 'batch') throw new api.ApiError(409, 'Try runs need the queue in batch mode');
				try {
					return json(api.tryRunState(await withRepoLock(repo.id, () => withActivity(liveDeps(repo), (d) => startTry(d, n), { buildKind: () => 'try' }))), { status: 201 });
				} catch (e) {
					if (e instanceof Error && /is not open|does not apply/.test(e.message)) throw new api.ApiError(409, e.message);
					throw e;
				}
			}
			default:
				return json({ error: `No endpoint ${m} ${parts.join('/')}` }, { status: 404 });
		}
	} catch (e) {
		if (e instanceof AuthError || e instanceof api.ApiError) return json({ error: e.message }, { status: e.status });
		log.error('agent API call failed', { err: e });
		return json({ error: 'Internal error' }, { status: 500 });
	}
};

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
