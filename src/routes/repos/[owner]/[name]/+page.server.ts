import { redirect, error, fail } from '@sveltejs/kit';
import {
	getRepoByOwnerName,
	getQueueItems,
	getRepoHistory,
	addToQueue,
	removeFromQueue
} from '$lib/server/db';
import { getOpenPRs } from '$lib/server/github';
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

		if (!prNumber || !prTitle) return fail(400, { error: 'Missing required fields' });

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
	}
};
