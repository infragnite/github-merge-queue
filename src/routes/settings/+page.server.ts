import { redirect, fail } from '@sveltejs/kit';
import { getRepos, getRepoById, addRepo, removeRepo } from '$lib/server/db';
import { listInstallationRepos, getRepo as getGhRepo } from '$lib/server/github';
import { atLeast } from '$lib/server/api-auth';
import { webCaller } from '$lib/server/web-auth';
import { visibleRepos } from '$lib/server/visible-repos';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	let availableRepos: Array<{ full_name: string; default_branch: string }> = [];
	try {
		availableRepos = await listInstallationRepos();
	} catch {
		// GitHub API error — user sees empty list
	}

	const repos = await visibleRepos(getRepos(), locals.user.login);
	// Who may remove each: repository admins, and whoever added it.
	const removable = await Promise.all(
		repos.map(async (r) => r.added_by === locals.user!.id || atLeast((await webCaller(r.owner, r.name, locals.user!.login)).role, 'admin'))
	);
	return { repos: repos.map((r, i) => ({ ...r, webhook_secret: null, canRemove: removable[i] })), availableRepos };
};

export const actions: Actions = {
	add: async ({ request, locals }) => {
		if (!locals.user) return fail(401);

		const formData = await request.formData();
		const fullName = (formData.get('repo') as string)?.trim();

		if (!fullName || !fullName.includes('/') || fullName.length > 255) {
			return fail(400, { error: 'Select a repository' });
		}

		const [owner, name] = fullName.split('/');
		if (!owner || !name || !/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(name)) {
			return fail(400, { error: 'Invalid repository name' });
		}

		// Managing a repository's queue is its admins' call.
		if (!atLeast((await webCaller(owner, name, locals.user.login)).role, 'admin')) {
			return fail(403, { error: `Adding ${owner}/${name} needs admin access to it on GitHub` });
		}

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
			return fail(500, { error: 'Failed to add repository' });
		}

		return { success: true };
	},

	remove: async ({ request, locals }) => {
		if (!locals.user) return fail(401);

		const formData = await request.formData();
		const repoId = parseInt(formData.get('repo_id') as string, 10);
		if (!repoId) return fail(400);

		const repo = getRepoById(repoId);
		if (!repo) return fail(404, { error: 'Repository not found' });
		if (repo.added_by !== locals.user.id && !atLeast((await webCaller(repo.owner, repo.name, locals.user.login)).role, 'admin')) {
			return fail(403, { error: `Removing ${repo.owner}/${repo.name} needs admin access to it on GitHub` });
		}

		removeRepo(repoId);
		return { success: true };
	}
};
