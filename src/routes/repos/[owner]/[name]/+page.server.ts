import { redirect, error, fail } from '@sveltejs/kit';
import {
	getRepoByOwnerName,
	getQueueItems,
	getRepoHistory,
	addToQueue,
	removeFromQueue,
	reorderQueue,
	updateQueueItemStatus
} from '$lib/server/db';
import { getOpenPRs, collaboratorRole, rateLimitOf } from '$lib/server/github';
import { atLeast, type Caller, type Role } from '$lib/server/api-auth';
import { ApiError, patchConfig } from '$lib/server/api-service';
import { DEFAULT_BATCH_CONFIG } from '$lib/server/batching';
import { DEFAULT_CI } from '$lib/server/batch-store';
import { parseSettingsForm } from '$lib/settings-form';
import { pipelineView, type PipelineView } from '$lib/server/pipeline-view';
import { currentHold, deferredFor, getQueueSettings, setQueuePriority, updateQueueSettings } from '$lib/server/batch-store';
import { withRepoLock } from '$lib/server/repo-lock';
import { cancelBatch, retireBatches } from '$lib/server/batch-queue';
import { liveDeps } from '$lib/server/batch-live';
import { emitEvent } from '$lib/server/events';
import { markDirty } from '$lib/server/wake';
import { dashboardStackAnalysis } from '$lib/server/stack-runtime';
import { stackView, type StackView } from '$lib/server/stack-view';
import type { PageServerLoad, Actions } from './$types';

const ROLES: Role[] = ['none', 'read', 'write', 'maintain', 'admin'];

// The page refreshes every few seconds per viewer: what it reads from GitHub is shared and reused
// for a while, so open dashboards don't spend the App's rate limit (the queue needs it).
const ROLE_TTL_MS = 60_000;
const OPEN_PRS_TTL_MS = 60_000;
const roles = new Map<string, { at: number; role: Role }>();
const openPrsCache = new Map<number, { at: number; value: Awaited<ReturnType<typeof getOpenPRs>> }>();

/** The signed-in user as a caller of the queue, with their role on the repository. */
async function pageCaller(owner: string, name: string, login: string): Promise<Caller> {
	const key = `${owner}/${name}:${login}`;
	const hit = roles.get(key);
	if (hit && Date.now() - hit.at < ROLE_TTL_MS) return { login, role: hit.role, app: false };
	let role: Role;
	try {
		const r = await collaboratorRole(owner, name, login);
		// triage reads; a custom role's base permission is one of the others
		role = ROLES.includes(r as Role) ? (r as Role) : r === 'triage' ? 'read' : 'none';
		roles.set(key, { at: Date.now(), role });
	} catch {
		// GitHub unreachable or rate limited: the last known role, else none (nothing to change)
		role = hit?.role ?? 'none';
	}
	return { login, role, app: false };
}

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
		return { mode: 'serial', paused: null, master: null, active: [], recent: [], error: `Loading batches failed: ${why}`, rateLimitedUntil: null, tickError: null, progressErrors: {} };
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
		can: { cancel: atLeast(me.role, 'maintain'), settings: atLeast(me.role, 'admin') },
		settings: { config: settings.config, ci: settings.ci, defaults: { config: DEFAULT_BATCH_CONFIG, ci: DEFAULT_CI } },
		repo,
		queueItems,
		openPrs: availablePrs,
		stacks,
		pipeline,
		mode: settings.mode,
		limits: { maxBatch: settings.config.maxBatch, expressMax: settings.config.expressMax },
		history: getRepoHistory(repo.id)
	};
};

export const actions: Actions = {
	/** Switches between merging PRs one by one and in batches. */
	setMode: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401);
		const repo = getRepoByOwnerName(params.owner, params.name);
		if (!repo) return fail(404);
		const mode = (await request.formData()).get('mode');
		if (mode !== 'serial' && mode !== 'batch') return fail(400, { error: 'mode must be serial or batch' });
		// Under the repo lock, so a running tick finishes first and none starts a batch after the retire.
		await withRepoLock(repo.id, async () => {
			const was = getQueueSettings(repo.id).mode;
			if (was === mode) return;
			updateQueueSettings(repo.id, { mode });
			if (was === 'batch') await retireBatches(liveDeps(repo));
			emitEvent(repo.id, null, 'mode', { mode, by: locals.user!.login });
			markDirty(repo.id);
			console.log(`[merge-queue] ${repo.owner}/${repo.name} switched to ${mode} mode by ${locals.user!.login}`);
		});
		return { success: true };
	},

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

	/** The queue's settings, through the same validation as the settings API. */
	saveSettings: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401);
		const repo = getRepoByOwnerName(params.owner, params.name);
		if (!repo) return fail(404);
		const me = await pageCaller(repo.owner, repo.name, locals.user.login);
		if (!atLeast(me.role, 'admin')) return fail(403, { settingsError: `Changing queue settings needs admin access; you have ${me.role}` });
		try {
			const body = parseSettingsForm(await request.formData(), getQueueSettings(repo.id));
			await withRepoLock(repo.id, async () => patchConfig(repo, me, body));
		} catch (e) {
			if (e instanceof ApiError || e instanceof Error) return fail(400, { settingsError: e.message });
			throw e;
		}
		markDirty(repo.id);
		return { settingsSaved: true };
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
