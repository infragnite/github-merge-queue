import { redirect, fail } from '@sveltejs/kit';
import { getRepos, addRepo, removeRepo } from '$lib/server/db';
import { listInstallationRepos, getRepo as getGhRepo } from '$lib/server/github';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	let availableRepos: Array<{ full_name: string; default_branch: string }> = [];
	try {
		availableRepos = await listInstallationRepos();
	} catch (err) {
		console.error('Failed to list installation repos:', err);
	}

	return { repos: getRepos(), availableRepos };
};

export const actions: Actions = {
	add: async ({ request, locals }) => {
		if (!locals.user) return fail(401);

		const formData = await request.formData();
		const fullName = (formData.get('repo') as string)?.trim();

		if (!fullName || !fullName.includes('/')) {
			return fail(400, { error: 'Select a repository' });
		}

		const [owner, name] = fullName.split('/');

		let defaultBranch = 'main';
		try {
			const ghRepo = await getGhRepo(owner, name);
			defaultBranch = ghRepo.default_branch;
		} catch {
			return fail(400, {
				error: `Cannot access ${fullName}. Is the GitHub App installed on this repo?`
			});
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
