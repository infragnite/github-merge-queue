import { redirect, error, fail, type RequestEvent } from '@sveltejs/kit';
import {
	getRepoByOwnerName,
	getQueueItems,
	getRepoHistory,
	removeFromQueue,
	reorderQueue,
	updateQueueItemStatus
} from '$lib/server/db';
import { getOpenPRs, rateLimitOf, getPR } from '$lib/server/github';
import { atLeast, AuthError, requireRole, type Caller, type Role } from '$lib/server/api-auth';
import { ApiError, boardItem, changeEntry, enqueue } from '$lib/server/api-service';
import { webCaller } from '$lib/server/web-auth';
import { knownPublic, noteReadOnlyView, publicHistory, publicQueueItem, prUrl } from '$lib/server/public-view';
import { savingsFor } from '$lib/server/ci-savings';
import { pipelineView, publicActivity, publicPipeline, type PipelineView } from '$lib/server/pipeline-view';
import { activityOf, withActivity } from '$lib/server/activity';
import { currentHold, deferredFor, getQueueSettings, updateQueueSettings } from '$lib/server/batch-store';
import { withRepoLock } from '$lib/server/repo-lock';
import { cancelBatch } from '$lib/server/batch-queue';
import { liveDeps } from '$lib/server/batch-live';
import { emitEvent } from '$lib/server/events';
import { markDirty } from '$lib/server/wake';
import { dashboardStackAnalysis } from '$lib/server/stack-runtime';
import { queueBoard, type BoardItem, type QueueBoard } from '$lib/server/queue-model';
import type { StackAnalysis } from '$lib/server/stacks';
import type { Repo } from '$lib/types';
import type { PageServerLoad, Actions } from './$types';

// The page refreshes every few seconds per viewer: what it reads from GitHub is shared and reused
// for a while, so open dashboards don't spend the App's rate limit (the queue needs it).
const OPEN_PRS_TTL_MS = 60_000;
const openPrsCache = new Map<number, { at: number; value: Awaited<ReturnType<typeof getOpenPRs>> }>();

async function openPRsOf(owner: string, name: string, repoId: number) {
	const hit = openPrsCache.get(repoId);
	if (hit && Date.now() - hit.at < OPEN_PRS_TTL_MS) return hit.value;
	try {
		const value = await getOpenPRs(owner, name);
		openPrsCache.set(repoId, { at: Date.now(), value });
		return value;
	} catch (e) {
		if (hit) return hit.value;
		throw e;
	}
}

export const load: PageServerLoad = async ({ params, locals, url, setHeaders }) => {
	const repo = getRepoByOwnerName(params.owner, params.name);
	const anonymous = !locals.user;
	// Signed in: the user's own role on the repository, as GitHub says; read access or more sees it all.
	const me: Caller | null = repo && locals.user ? await webCaller(repo.owner, repo.name, locals.user.login) : null;
	const member = !!me && atLeast(me.role, 'read');
	// Anyone else sees the read-only page of a repository that made it public, or nothing: an unknown
	// repository and one they can't see answer the same.
	const readonly = !member;
	// Public only while the stored setting is on and GitHub last said the repository is public.
	if (readonly && !(repo && getQueueSettings(repo.id).publicView && knownPublic(repo.id))) {
		if (anonymous) redirect(302, `/login?next=${encodeURIComponent(url.pathname)}`);
		error(404, 'Repository not found');
	}
	if (!repo) error(404, 'Repository not found');

	// Links are built here, never taken from what was stored: a stored URL came from a form once.
	const rawItems = getQueueItems(repo.id);
	const queueItems = rawItems.map((i) => {
		const item = { ...i, pr_url: prUrl(repo, i.pr_number), held: currentHold(i) !== null, deferred: deferredFor(i as typeof i & { deferred_for?: string | null }).length > 0 };
		return readonly ? publicQueueItem(item) : item;
	});
	// The queue as the planners see it: the rows, with the holds the planner recorded. A read-only
	// viewer gets only the messages the public row keeps.
	const boardItems: BoardItem[] = rawItems.map((i, k) => boardItem(i, queueItems[k].error_message));

	let openPrs: Array<{
		number: number;
		title: string;
		html_url: string;
		user: { login: string; avatar_url: string };
		draft: boolean;
	}> = [];
	try {
		// Signed-out visitors only see what signed-in ones fetched (titles of PRs in stacks).
		openPrs = readonly ? (openPrsCache.get(repo.id)?.value ?? []) : await openPRsOf(repo.owner, repo.name, repo.id);
	} catch {
		// GitHub API error — user sees empty PR list
	}

	// Streamed: the page renders while the analysis (a call per changed PR) finishes.
	// Queue items keep a title even when GitHub can't be reached; open PRs have the current one.
	const prMeta = new Map(queueItems.map((i) => [i.pr_number, { title: i.pr_title, url: i.pr_url }]));
	for (const pr of openPrs) prMeta.set(pr.number, { title: pr.title, url: prUrl(repo, pr.number) });
	// A read-only viewer only gets what is cached: none of their loads calls GitHub.
	if (readonly) {
		noteReadOnlyView(repo.id);
		// Only the viewer's own browser may keep it, briefly; a shared cache never (it varies by sign-in).
		setHeaders({ 'cache-control': 'private, max-age=5', vary: 'Cookie' });
	}
	const analysis: Promise<{ analysis: StackAnalysis; error: string | null }> = dashboardStackAnalysis(repo, { cachedOnly: readonly })
		.then((a) => ({ analysis: a, error: null }))
		.catch((e) => {
			if (!readonly) console.error(`[stacks] ${repo.owner}/${repo.name}: analysis for the dashboard failed:`, e instanceof Error ? e.message : e);
			return { analysis: { prs: new Map(), stacks: [], issues: [] }, error: readonly ? 'Stacks could not be loaded' : `Stack analysis failed: ${e instanceof Error ? e.message : e}` };
		});

	const pipeline: Promise<PipelineView> = pipelineView(repo, prMeta, { cachedOnly: readonly })
		// Why the queue stopped can name internals (App permissions, GitHub errors): only signed-in users see it.
		.then((p) => (readonly ? publicPipeline(p) : p))
		.catch((e) => {
		const why = e instanceof Error ? e.message : String(e);
		console.error(`[batches] ${repo.owner}/${repo.name}: batch view failed:`, why);
		return { mode: 'serial', paused: null, master: null, active: [], recent: [], error: readonly ? 'Batches could not be loaded' : `Loading batches failed: ${why}`, rateLimitedUntil: null, tickError: null, progressErrors: {}, activity: readonly ? publicActivity(activityOf(repo.id)) : activityOf(repo.id), serverTime: Date.now() };
	});

	// Built by the planners' own queue model; PRs being tested are in the batches, not in line.
	const board: Promise<QueueBoard & { warnings: Record<number, string[]>; error: string | null }> = Promise.all([analysis, pipeline]).then(([a, p]) => {
		// Without the batches (they failed to load), a PR a batch carries is known by its status.
		const inflight = new Set(
			'error' in p && p.error
				? rawItems.filter((i) => i.status === 'checking' || i.status === 'updating' || i.status === 'merging').map((i) => i.pr_number)
				: p.active.flatMap((b) => b.prs.filter((x) => x.activity !== 'landed' && x.activity !== 'left').map((x) => x.pr))
		);
		const warnings: Record<number, string[]> = {};
		for (const i of boardItems) {
			const w = a.analysis.prs.get(i.pr)?.issues.filter((x) => x.severity === 'warning').map((x) => x.message) ?? [];
			if (w.length) warnings[i.pr] = w;
		}
		return { ...queueBoard(boardItems, a.analysis, inflight), warnings, error: a.error };
	});

	const queuedNumbers = new Set(queueItems.map((i) => i.pr_number));
	const availablePrs = openPrs
		.filter((pr) => !queuedNumbers.has(pr.number))
		.map((pr) => ({
			number: pr.number,
			title: pr.title,
			url: prUrl(repo, pr.number),
			author: pr.user.login,
			authorAvatar: pr.user.avatar_url,
			draft: pr.draft
		}));

	const settings = getQueueSettings(repo.id);
	const role: Role = member ? me!.role : 'none';
	return {
		anonymous,
		readonly,
		role,
		// What the page offers; every action checks the role again on the server.
		can: {
			queue: atLeast(role, 'write'),
			reorder: atLeast(role, 'maintain'),
			urgent: atLeast(role, 'maintain'),
			cancel: atLeast(role, 'maintain'),
			resume: atLeast(role, 'maintain'),
			settings: atLeast(role, 'admin')
		},
		repo: { id: repo.id, owner: repo.owner, name: repo.name, default_branch: repo.default_branch },
		savings: savingsFor(repo.id),
		queueItems,
		openPrs: atLeast(role, 'write') ? availablePrs : [],
		board,
		pipeline,
		mode: settings.mode,
		limits: { maxBatch: settings.config.maxBatch, expressMax: settings.config.expressMax },
		// Whether runs of several PRs stop at their first failure, for why a run goes on.
		stopsEarly: settings.config.stopOnFirstFailure,
		history: getRepoHistory(repo.id).map((h) => {
			const item = { ...h, pr_url: prUrl(repo, h.pr_number) };
			return readonly ? publicHistory(item) : item;
		})
	};
};

type Guarded = { repo: Repo; me: Caller; form: FormData };

/**
 * Runs a page action for a signed-in user with at least `need` on the repository (the role the
 * agent API requires for the same change). The role is GitHub's, looked up on the server: what
 * the page shows or hides is only a convenience. Errors become a failed action under `key`.
 */
async function guarded(
	event: RequestEvent,
	need: Role,
	what: string,
	run: (c: Guarded) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void,
	key = 'error'
) {
	const { locals, params, request } = event;
	if (!locals.user) return fail(401, { [key]: 'Sign in first' });
	const repo = getRepoByOwnerName(params.owner!, params.name!);
	if (!repo) return fail(404, { [key]: 'Repository not found' });
	const me = await webCaller(repo.owner, repo.name, locals.user.login);
	try {
		requireRole(me, need, what);
		return (await run({ repo, me, form: await request.formData() })) ?? { success: true };
	} catch (e) {
		if (e instanceof AuthError || e instanceof ApiError) return fail(e.status, { [key]: e.message });
		throw e;
	}
}

/** A positive whole number from a form field, or a 400. */
function intField(form: FormData, name: string): number {
	const v = String(form.get(name) ?? '');
	if (!/^[1-9]\d{0,9}$/.test(v)) throw new ApiError(400, `${name} must be a positive whole number`);
	return Number(v);
}

export const actions: Actions = {
	/** Stops a batch (and its bisection); its PRs go back in line, blamed for nothing. */
	cancelBatch: (event) =>
		guarded(event, 'maintain', 'Cancelling a batch', async ({ repo, me, form }) => {
			const id = intField(form, 'batch_id');
			// Its CI could not be stopped nor its branches deleted until the reset.
			const limit = (await rateLimitOf(repo.owner).catch(() => null))?.blockedUntil;
			if (limit) throw new ApiError(409, `GitHub's rate limit is used up; cancel again after ${new Date(limit).toLocaleTimeString()}`);
			try {
				await withRepoLock(repo.id, () => withActivity(liveDeps(repo), (d) => cancelBatch(d, id, me.login)));
			} catch (e) {
				throw new ApiError(409, e instanceof Error ? e.message : String(e));
			}
			markDirty(repo.id);
		}),

	/** Batch mode's order: urgent PRs go first, in an express batch (urgent needs maintain). */
	setPriority: (event) =>
		guarded(event, 'write', 'Changing a priority', async ({ repo, me, form }) => {
			const n = intField(form, 'pr_number');
			const priority = form.get('priority');
			if (priority !== 'urgent' && priority !== 'normal' && priority !== 'low') throw new ApiError(400, 'priority must be urgent, normal or low');
			changeEntry(repo, me, n, { priority });
			markDirty(repo.id);
		}),

	/** Lifts a pause of the batch queue; it acts on the next processor cycle. */
	resume: (event) =>
		guarded(event, 'maintain', 'Resuming the queue', ({ repo, me }) => {
			const was = getQueueSettings(repo.id).pausedReason;
			if (was === null) return;
			updateQueueSettings(repo.id, { pausedReason: null });
			emitEvent(repo.id, null, 'resumed', { by: me.login });
			markDirty(repo.id);
			console.log(`[merge-queue] ${repo.owner}/${repo.name} resumed by ${me.login} (was paused: ${was})`);
		}),

	/** Queues an open PR. What is stored about it comes from GitHub, not from the form. */
	addToQueue: (event) =>
		guarded(event, 'write', 'Queueing a PR', async ({ repo, me, form }) => {
			const n = intField(form, 'pr_number');
			let pr;
			try {
				pr = await getPR(repo.owner, repo.name, n);
			} catch {
				throw new ApiError(404, `#${n} was not found on GitHub`);
			}
			enqueue(repo, me, pr, {});
			markDirty(repo.id);
		}),

	removeFromQueue: (event) =>
		guarded(event, 'write', 'Removing a PR from the queue', ({ repo, me, form }) => {
			const itemId = intField(form, 'item_id');
			const item = getQueueItems(repo.id).find((i) => i.id === itemId);
			if (!item) throw new ApiError(404, 'Not in this queue');
			removeFromQueue(itemId);
			emitEvent(repo.id, item.pr_number, 'dequeued', { by: me.login });
			markDirty(repo.id);
		}),

	/** The whole line's order (one by one mode); like moving a PR to the front, it needs maintain. */
	reorder: (event) =>
		guarded(event, 'maintain', 'Reordering the queue', ({ repo, form }) => {
			let orderedIds: unknown;
			try {
				orderedIds = JSON.parse(String(form.get('order') ?? ''));
			} catch {
				throw new ApiError(400, 'order must be a JSON list of item ids');
			}
			if (!Array.isArray(orderedIds) || orderedIds.some((id) => !Number.isSafeInteger(id))) throw new ApiError(400, 'order must be a JSON list of item ids');
			const validIds = new Set(getQueueItems(repo.id).map((i) => i.id));
			if (orderedIds.length !== validIds.size || new Set(orderedIds).size !== validIds.size || !orderedIds.every((id) => validIds.has(id))) {
				throw new ApiError(400, 'Invalid item order');
			}
			reorderQueue(repo.id, orderedIds as number[]);
			markDirty(repo.id);
		}),

	retry: (event) =>
		guarded(event, 'write', 'Putting a PR back in the queue', ({ repo, me, form }) => {
			const itemId = intField(form, 'item_id');
			const item = getQueueItems(repo.id).find((i) => i.id === itemId);
			if (!item) throw new ApiError(404, 'Not in this queue');
			if (item.status !== 'failed') throw new ApiError(400, 'Only failed items can be retried');
			updateQueueItemStatus(itemId, 'queued');
			emitEvent(repo.id, item.pr_number, 'requeued', { by: me.login });
			markDirty(repo.id);
		})
};
