import { redirect, error, fail } from '@sveltejs/kit';
import {
	getRepoByOwnerName,
	getQueueItems,
	getRepoHistory,
	getRepoPulse,
	addToQueue,
	removeFromQueue,
	reorderQueue,
	updateQueueItemStatus
} from '$lib/server/db';
import { getOpenPRs, rateLimitOf } from '$lib/server/github';
import { atLeast, type Role } from '$lib/server/api-auth';
import { pageCaller } from '$lib/server/page-caller';
import { pipelineView, type PipelineView } from '$lib/server/pipeline-view';
import { currentHold, deferredFor, getQueueSettings, setQueuePriority, updateQueueSettings } from '$lib/server/batch-store';
import { withRepoLock } from '$lib/server/repo-lock';
import { cancelBatch } from '$lib/server/batch-queue';
import { liveDeps } from '$lib/server/batch-live';
import { emitEvent } from '$lib/server/events';
import { markDirty } from '$lib/server/wake';
import { dashboardStackAnalysis } from '$lib/server/stack-runtime';
import { stackView, type StackView } from '$lib/server/stack-view';
import type { PageServerLoad, Actions } from './$types';

// The page refreshes every few seconds per viewer: the open PRs it reads from GitHub are shared and
// reused for a while, so open dashboards don't spend the App's rate limit (the queue needs it).
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

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');

	const repo = getRepoByOwnerName(params.owner, params.name);
	if (!repo) error(404, 'Repository not found');

	const queueItems = getQueueItems(repo.id).map((i) => ({ ...i, holdWait: currentHold(i)?.wait ?? null, deferred: deferredFor(i as typeof i & { deferred_for?: string | null }).length > 0 }));

	let openPrs: Array<{
		number: number;
		title: string;
		html_url: string;
		user: { login: string; avatar_url: string };
		draft: boolean;
	}> = [];
	try {
		openPrs = await openPRsOf(repo.owner, repo.name, repo.id);
	} catch {
		// GitHub API error — user sees empty PR list
	}

	// Streamed: the page renders while the analysis (a call per changed PR) finishes.
	// Queue items keep a title even when GitHub can't be reached; open PRs have the current one.
	const prMeta = new Map(queueItems.map((i) => [i.pr_number, { title: i.pr_title, url: i.pr_url }]));
	for (const pr of openPrs) prMeta.set(pr.number, { title: pr.title, url: pr.html_url });
	// Merged PRs keep their titles in finished batches.
	for (const h of getRepoHistory(repo.id, 200)) if (!prMeta.has(h.pr_number)) prMeta.set(h.pr_number, { title: h.pr_title, url: h.pr_url });
	const queueStatus = new Map(queueItems.map((i) => [i.pr_number, i.status as string]));
	const stacks: Promise<{ stacks: StackView[]; error: string | null }> = dashboardStackAnalysis(repo)
		.then((a) => ({ stacks: stackView(a, prMeta, queueStatus), error: null }))
		.catch((e) => {
			console.error(`[stacks] ${repo.owner}/${repo.name}: analysis for the dashboard failed:`, e instanceof Error ? e.message : e);
			return { stacks: [], error: `Stack analysis failed: ${e instanceof Error ? e.message : e}` };
		});

	const pipeline: Promise<PipelineView> = pipelineView(repo, prMeta).catch((e) => {
		const why = e instanceof Error ? e.message : String(e);
		console.error(`[batches] ${repo.owner}/${repo.name}: batch view failed:`, why);
		return { mode: 'serial', paused: null, master: null, active: [], recent: [], error: `Loading batches failed: ${why}`, rateLimitedUntil: null, tickError: null, progressErrors: {}, current: null };
	});

	const queuedNumbers = new Set(queueItems.map((i) => i.pr_number));
	const availablePrs = openPrs
		.filter((pr) => !queuedNumbers.has(pr.number))
		.map((pr) => ({
			number: pr.number,
			title: pr.title,
			url: pr.html_url,
			author: pr.user.login,
			authorAvatar: pr.user.avatar_url,
			draft: pr.draft
		}));

	const settings = getQueueSettings(repo.id);
	const me = await pageCaller(repo.owner, repo.name, locals.user.login);
	return {
		role: me.role,
		can: { cancel: atLeast(me.role, 'maintain') },
		repo,
		queueItems,
		openPrs: availablePrs,
		stacks,
		pipeline,
		mode: settings.mode,
		limits: { maxBatch: settings.config.maxBatch, expressMax: settings.config.expressMax },
		history: getRepoHistory(repo.id),
		pulse: getRepoPulse(repo.id)
	};
};

/** A form action's role check, as the API's: a failure to return, or null when allowed. */
async function requireRole(repo: { owner: string; name: string }, login: string, role: Role, what: string) {
	const me = await pageCaller(repo.owner, repo.name, login);
	return atLeast(me.role, role) ? null : fail(403, { error: `${what} needs ${role} access; you have ${me.role}` });
}

export const actions: Actions = {
	/** Stops a batch (and its bisection); its PRs go back in line, blamed for nothing. */
	cancelBatch: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401);
		const repo = getRepoByOwnerName(params.owner, params.name);
		if (!repo) return fail(404);
		const me = await pageCaller(repo.owner, repo.name, locals.user.login);
		if (!atLeast(me.role, 'maintain')) return fail(403, { error: `Cancelling a batch needs maintain access; you have ${me.role}` });
		const id = parseInt((await request.formData()).get('batch_id') as string, 10);
		if (!id) return fail(400, { error: 'batch_id is required' });
		// Its CI could not be stopped nor its branches deleted until the reset.
		const limit = (await rateLimitOf(repo.owner).catch(() => null))?.blockedUntil;
		if (limit) return fail(409, { error: `GitHub's rate limit is used up; cancel again after ${new Date(limit).toLocaleTimeString()}` });
		try {
			await withRepoLock(repo.id, () => cancelBatch(liveDeps(repo), id, me.login));
		} catch (e) {
			return fail(409, { error: e instanceof Error ? e.message : String(e) });
		}
		markDirty(repo.id);
		return { success: true };
	},

	/** Batch mode's order: urgent PRs go first, in an express batch. */
	setPriority: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401);
		const repo = getRepoByOwnerName(params.owner, params.name);
		if (!repo) return fail(404);
		const form = await request.formData();
		const n = parseInt(form.get('pr_number') as string, 10);
		const priority = form.get('priority');
		if (!n || (priority !== 'urgent' && priority !== 'normal' && priority !== 'low')) return fail(400);
		const denied = await requireRole(repo, locals.user.login, priority === 'urgent' ? 'maintain' : 'write', `Setting priority ${priority}`);
		if (denied) return denied;
		if (!getQueueItems(repo.id).some((i) => i.pr_number === n)) return fail(404);
		setQueuePriority(repo.id, n, priority);
		emitEvent(repo.id, n, 'priority', { priority, by: locals.user.login });
		markDirty(repo.id);
		return { success: true };
	},

	/** Lifts a pause of the batch queue; it acts on the next processor cycle. */
	resume: async ({ params, locals }) => {
		if (!locals.user) return fail(401);
		const repo = getRepoByOwnerName(params.owner, params.name);
		if (!repo) return fail(404);
		const denied = await requireRole(repo, locals.user.login, 'maintain', 'Resuming the queue');
		if (denied) return denied;
		const was = getQueueSettings(repo.id).pausedReason;
		if (was === null) return { success: true };
		updateQueueSettings(repo.id, { pausedReason: null });
		emitEvent(repo.id, null, 'resumed', { by: locals.user.login });
		markDirty(repo.id);
		console.log(`[merge-queue] ${repo.owner}/${repo.name} resumed by ${locals.user.login} (was paused: ${was})`);
		return { success: true };
	},

	addToQueue: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401);

		const repo = getRepoByOwnerName(params.owner, params.name);
		if (!repo) return fail(404);
		const denied = await requireRole(repo, locals.user.login, 'write', 'Queueing a PR');
		if (denied) return denied;

		const formData = await request.formData();
		const prNumber = parseInt(formData.get('pr_number') as string, 10);
		const prTitle = formData.get('pr_title') as string;
		const prUrl = formData.get('pr_url') as string;
		const authorLogin = formData.get('author_login') as string;
		const authorAvatar = formData.get('author_avatar') as string;

		if (!prNumber || !prTitle || !prUrl || !authorLogin) {
			return fail(400, { error: 'Missing required fields' });
		}
		if (prTitle.length > 500 || prUrl.length > 2000 || authorLogin.length > 100) {
			return fail(400, { error: 'Invalid field values' });
		}

		try {
			addToQueue(
				repo.id,
				prNumber,
				prTitle,
				prUrl,
				authorLogin,
				authorAvatar,
				locals.user.login
			);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes('UNIQUE')) {
				return fail(409, { error: 'PR is already in the queue' });
			}
			return fail(500, { error: 'Failed to add PR to queue' });
		}

		return { success: true };
	},

	removeFromQueue: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401);

		const repo = getRepoByOwnerName(params.owner, params.name);
		if (!repo) return fail(404);
		const denied = await requireRole(repo, locals.user.login, 'write', 'Removing a PR from the queue');
		if (denied) return denied;

		const formData = await request.formData();
		const itemId = parseInt(formData.get('item_id') as string, 10);
		if (!itemId) return fail(400);

		const items = getQueueItems(repo.id);
		if (!items.some((i) => i.id === itemId)) return fail(403);

		removeFromQueue(itemId);
		return { success: true };
	},

	reorder: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401);

		const repo = getRepoByOwnerName(params.owner, params.name);
		if (!repo) return fail(404);
		const denied = await requireRole(repo, locals.user.login, 'maintain', 'Reordering the queue');
		if (denied) return denied;

		const formData = await request.formData();
		const orderJson = formData.get('order') as string;
		if (!orderJson) return fail(400);

		let orderedIds: number[];
		try {
			orderedIds = JSON.parse(orderJson);
		} catch {
			return fail(400);
		}

		if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'number')) {
			return fail(400);
		}

		const items = getQueueItems(repo.id);
		const validIds = new Set(items.map((i) => i.id));
		if (orderedIds.length !== validIds.size || !orderedIds.every((id) => validIds.has(id))) {
			return fail(400, { error: 'Invalid item order' });
		}

		reorderQueue(repo.id, orderedIds);
		return { success: true };
	},

	retry: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401);

		const repo = getRepoByOwnerName(params.owner, params.name);
		if (!repo) return fail(404);
		const denied = await requireRole(repo, locals.user.login, 'write', 'Retrying a PR');
		if (denied) return denied;

		const formData = await request.formData();
		const itemId = parseInt(formData.get('item_id') as string, 10);
		if (!itemId) return fail(400);

		const items = getQueueItems(repo.id);
		const item = items.find((i) => i.id === itemId);
		if (!item) return fail(403);
		if (item.status !== 'failed') return fail(400, { error: 'Only failed items can be retried' });

		updateQueueItemStatus(itemId, 'queued');
		return { success: true };
	}
};
