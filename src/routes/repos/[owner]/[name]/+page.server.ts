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
import { getOpenPRs } from '$lib/server/github';
import { pipelineView, type PipelineView } from '$lib/server/pipeline-view';
import { currentStackAnalysis } from '$lib/server/stack-runtime';
import { stackView, type StackView } from '$lib/server/stack-view';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');

	const repo = getRepoByOwnerName(params.owner, params.name);
	if (!repo) error(404, 'Repository not found');

	const queueItems = getQueueItems(repo.id);

	let openPrs: Array<{
		number: number;
		title: string;
		html_url: string;
		user: { login: string; avatar_url: string };
		draft: boolean;
	}> = [];
	try {
		openPrs = await getOpenPRs(params.owner, params.name);
	} catch {
		// GitHub API error — user sees empty PR list
	}

	// Streamed: the page renders while the analysis (a call per changed PR) finishes.
	// Queue items keep a title even when GitHub can't be reached; open PRs have the current one.
	const prMeta = new Map(queueItems.map((i) => [i.pr_number, { title: i.pr_title, url: i.pr_url }]));
	for (const pr of openPrs) prMeta.set(pr.number, { title: pr.title, url: pr.html_url });
	const queueStatus = new Map(queueItems.map((i) => [i.pr_number, i.status as string]));
	const stacks: Promise<{ stacks: StackView[]; error: string | null }> = currentStackAnalysis(repo)
		.then((a) => ({ stacks: stackView(a, prMeta, queueStatus), error: null }))
		.catch((e) => {
			console.error(`[stacks] ${repo.owner}/${repo.name}: analysis for the dashboard failed:`, e instanceof Error ? e.message : e);
			return { stacks: [], error: 'Stack analysis failed; it is retried on the next refresh.' };
		});

	const pipeline: Promise<PipelineView> = pipelineView(repo, prMeta).catch((e) => {
		console.error(`[batches] ${repo.owner}/${repo.name}: batch view failed:`, e instanceof Error ? e.message : e);
		return { mode: 'serial', paused: null, master: null, active: [], recent: [], error: 'Loading batches failed; it is retried on the next refresh.' };
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

	return {
		repo,
		queueItems,
		openPrs: availablePrs,
		stacks,
		pipeline,
		history: getRepoHistory(repo.id)
	};
};

export const actions: Actions = {
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
