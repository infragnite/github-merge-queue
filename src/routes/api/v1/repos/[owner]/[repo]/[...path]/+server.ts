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
//   PATCH  queue/config        {mode?, config?, ci?}            (admin)
//   POST   queue/pause         {reason?}                         (maintain)
//   POST   queue/resume                                          (maintain)
//   GET    batches             recent batches
//   GET    batches/{id}        one batch with its bisection runs
//   GET    history?limit=      merged and bounced PRs

import { json, type RequestHandler } from '@sveltejs/kit';
import * as github from '$lib/server/github';
import { getRepoByOwnerName } from '$lib/server/db';
import { getRecentBatches } from '$lib/server/batch-store';
import { analyzeRepoStacks } from '$lib/server/stack-runtime';
import { AuthError, resolveCaller, type AuthGitHub } from '$lib/server/api-auth';
import * as api from '$lib/server/api-service';

const authGitHub: AuthGitHub = {
	user: (token) => github.userForToken(token),
	permission: (owner, repo, login) => github.collaboratorRole(owner, repo, login),
	repoAsCaller: (token, owner, repo) => github.repoForToken(token, owner, repo)
};

const handle: RequestHandler = async ({ params, request, url }) => {
	try {
		const repo = getRepoByOwnerName(params.owner!, params.repo!);
		if (!repo) return json({ error: `${params.owner}/${params.repo} is not managed by this queue` }, { status: 404 });
		const caller = await resolveCaller(authGitHub, request.headers.get('authorization'), repo.owner, repo.name);
		const parts = (params.path ?? '').split('/').filter(Boolean);
		const m = request.method;
		const body = async () => (m === 'GET' || m === 'DELETE' ? {} : await request.json().catch(() => ({})));
		const route = `${m} ${parts.map((p) => (/^\d+$/.test(p) ? ':n' : p)).join('/')}`;
		const n = Number(parts.find((p) => /^\d+$/.test(p)));

		switch (route) {
			case 'GET pulls/:n/stack':
				return json(api.stackState(repo, n, await analyzeRepoStacks(repo)));
			case 'GET stacks':
				return json(api.stacksState(await analyzeRepoStacks(repo)));
			case 'GET queue':
				return json(api.queueState(repo));
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
			case 'PATCH queue/config':
				return json(api.patchConfig(repo, caller, await body()));
			case 'POST queue/pause':
				return json(api.pause(repo, caller, (await body()).reason));
			case 'POST queue/resume':
				return json(api.resume(repo, caller));
			case 'GET batches':
				return json({ batches: getRecentBatches(repo.id).map(api.batchSummary) });
			case 'GET batches/:n':
				return json(api.batchDetail(repo, n));
			case 'GET history':
				return json(api.history(repo, Number(url.searchParams.get('limit') ?? 50)));
			default:
				return json({ error: `No endpoint ${m} ${parts.join('/')}` }, { status: 404 });
		}
	} catch (e) {
		if (e instanceof AuthError || e instanceof api.ApiError) return json({ error: e.message }, { status: e.status });
		console.error('[api] error:', e instanceof Error ? e.message : e);
		return json({ error: 'Internal error' }, { status: 500 });
	}
};

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
