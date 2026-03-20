import { redirect, fail } from '@sveltejs/kit';
import { getRepos, addRepo, removeRepo, getUserById } from '$lib/server/db';
import { getRepo as getGhRepo } from '$lib/server/github';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	return { repos: getRepos() };
};

export const actions: Actions = {
	add: async ({ request, locals }) => {
		if (!locals.user) return fail(401);

		const formData = await request.formData();
		const fullName = (formData.get('repo') as string)?.trim();

		if (!fullName || !fullName.includes('/')) {
			return fail(400, { error: 'Enter a repository in owner/name format' });
		}

		const [owner, name] = fullName.split('/');

		// Verify the repo exists and user has access
		const user = getUserById(locals.user.id);
		if (!user) return fail(401);

		let defaultBranch = 'main';
		try {
			const ghRepo = await getGhRepo(user.access_token, owner, name);
			defaultBranch = ghRepo.default_branch;
		} catch {
			return fail(400, { error: `Cannot access ${fullName}. Check the name and your permissions.` });
		}

		try {
			addRepo(owner, name, defaultBranch, locals.user.id);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes('UNIQUE')) {
				return fail(409, { error: 'Repository already added' });
			}
			return fail(500, { error: msg });
		}

		return { success: true };
	},

	remove: async ({ request, locals }) => {
		if (!locals.user) return fail(401);

		const formData = await request.formData();
		const repoId = parseInt(formData.get('repo_id') as string, 10);
		if (!repoId) return fail(400);

		removeRepo(repoId);
		return { success: true };
	}
};
