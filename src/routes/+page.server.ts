import { redirect } from '@sveltejs/kit';
import { getRepos, getHistory } from '$lib/server/db';
import { visibleRepos } from '$lib/server/visible-repos';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	// Only repositories the user can read on GitHub, and only their history.
	const repos = await visibleRepos(getRepos(), locals.user.login);
	const ids = new Set(repos.map((r) => r.id));
	return {
		repos: repos.map((r) => ({ ...r, webhook_secret: null })),
		history: getHistory(100).filter((h) => ids.has(h.repo_id)).slice(0, 15)
	};
};
