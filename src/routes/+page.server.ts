import { redirect, fail } from '@sveltejs/kit';
import { getRepos, getHistory, addRepo } from '$lib/server/db';
import { listInstallationRepos, getRepo as getGhRepo, appInstallUrl } from '$lib/server/github';
import { atLeast } from '$lib/server/api-auth';
import { webCaller } from '$lib/server/web-auth';
import { visibleRepos } from '$lib/server/visible-repos';
import { repoSummary } from '$lib/server/repo-summary';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	// Only repositories the user can read on GitHub, and only their history.
	const repos = await visibleRepos(getRepos(), locals.user.login);
	const ids = new Set(repos.map((r) => r.id));
	const added = new Set(repos.map((r) => `${r.owner}/${r.name}`));

	// Streamed: listing the App's installations is a GitHub call per installation, and the
	// repository list shouldn't wait for it.
	const addable = (async () => {
		let available: Array<{ full_name: string; default_branch: string }> = [];
		const installUrl = await appInstallUrl();
		try {
			available = await listInstallationRepos();
		} catch {
			return { repos: [], installUrl, error: 'GitHub could not be asked which repositories the app is installed on' };
		}
		// Only repositories the user administers on GitHub can be added, so only those are listed: the
		// App's other installations (private repos among them) aren't every org member's business.
		const mine = await visibleRepos(
			available.filter((r) => !added.has(r.full_name)).map((r) => ({ ...r, owner: r.full_name.split('/')[0], name: r.full_name.split('/')[1] })),
			locals.user!.login,
			'admin'
		);
		return { repos: [...new Set(mine.map((r) => r.full_name))].sort((a, b) => a.localeCompare(b)), installUrl, error: null as string | null };
	})().catch((e) => {
		console.error('[dashboard] listing addable repositories failed:', e instanceof Error ? e.message : e);
		return { repos: [] as string[], installUrl: null, error: 'Repositories you can add could not be listed' };
	});

	return {
		repos: repos.map((r) => ({ id: r.id, owner: r.owner, name: r.name, default_branch: r.default_branch, summary: repoSummary(r.id) })),
		addable,
		history: getHistory(100).filter((h) => ids.has(h.repo_id)).slice(0, 15)
	};
};

export const actions: Actions = {
	add: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Sign in first' });

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

		return { added: fullName };
	}
};
