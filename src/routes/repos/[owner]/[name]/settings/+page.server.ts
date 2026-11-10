import { redirect, error, fail } from '@sveltejs/kit';
import { getRepoByOwnerName } from '$lib/server/db';
import { atLeast } from '$lib/server/api-auth';
import { ApiError, patchConfig, repoVisibility } from '$lib/server/api-service';
import { getRepo } from '$lib/server/github';
import { DEFAULT_BATCH_CONFIG } from '$lib/server/batching';
import { DEFAULT_CI, getQueueSettings } from '$lib/server/batch-store';
import { parseSettingsForm } from '$lib/settings-form';
import { webCaller } from '$lib/server/web-auth';
import { withRepoLock } from '$lib/server/repo-lock';
import { retireBatches } from '$lib/server/batch-queue';
import { liveDeps } from '$lib/server/batch-live';
import { markDirty } from '$lib/server/wake';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	if (!locals.user) redirect(302, `/login?next=${encodeURIComponent(url.pathname)}`);
	const repo = getRepoByOwnerName(params.owner, params.name);
	// Settings are for the repository's collaborators only, even when its queue page is public.
	const me = repo ? await webCaller(repo.owner, repo.name, locals.user.login) : null;
	if (!repo || !me || !atLeast(me.role, 'read')) error(404, 'Repository not found');
	const settings = getQueueSettings(repo.id);
	return {
		repo: { id: repo.id, owner: repo.owner, name: repo.name, default_branch: repo.default_branch },
		role: me.role,
		canEdit: atLeast(me.role, 'admin'),
		mode: settings.mode,
		settings: {
			config: settings.config,
			ci: settings.ci,
			view: { publicView: settings.publicView },
			defaults: { config: DEFAULT_BATCH_CONFIG, ci: DEFAULT_CI, view: { publicView: false } }
		}
	};
};

/** The repo and the caller, who must be an admin of it to change how its queue works. */
async function admin(params: { owner: string; name: string }, login: string | undefined, key: 'modeError' | 'error') {
	if (!login) return { failure: fail(401, { [key]: 'Sign in to change settings' }) };
	const repo = getRepoByOwnerName(params.owner, params.name);
	if (!repo) return { failure: fail(404, { [key]: 'Repository not found' }) };
	const me = await webCaller(repo.owner, repo.name, login);
	if (!atLeast(me.role, 'admin')) return { failure: fail(403, { [key]: `Changing queue settings needs admin access; you have ${me.role}` }) };
	return { repo, me };
}

export const actions: Actions = {
	/** Switches between merging PRs one by one and in batches; a switch stops the runs in flight. */
	setMode: async ({ request, params, locals }) => {
		const a = await admin(params, locals.user?.login, 'modeError');
		if ('failure' in a) return a.failure;
		const { repo, me } = a;
		const mode = (await request.formData()).get('mode');
		if (mode !== 'serial' && mode !== 'batch') return fail(400, { modeError: 'Choose one by one or batches' });
		// Under the repo lock, so a running tick finishes first and none starts a batch after the retire.
		await withRepoLock(repo.id, async () => {
			const was = getQueueSettings(repo.id).mode;
			if (was === mode) return;
			patchConfig(repo, me, { mode });
			await retireBatches(liveDeps(repo));
			markDirty(repo.id);
			console.log(`[merge-queue] ${repo.owner}/${repo.name} switched to ${mode} mode by ${me.login}`);
		});
		return { modeSaved: true };
	},

	/** The queue's settings, through the same validation as the settings API. */
	saveSettings: async ({ request, params, locals }) => {
		const a = await admin(params, locals.user?.login, 'error');
		if ('failure' in a) return a.failure;
		const { repo, me } = a;
		try {
			const cur = getQueueSettings(repo.id);
			const body = parseSettingsForm(await request.formData(), { ...cur, view: { publicView: cur.publicView } });
			// Only a public repository's queue page can be public: GitHub is asked when it is turned on.
			const visibility = body.publicView === true ? await repoVisibility(() => getRepo(repo.owner, repo.name)) : null;
			await withRepoLock(repo.id, async () => patchConfig(repo, me, body, visibility));
		} catch (e) {
			if (e instanceof ApiError || e instanceof Error) return fail(400, { error: e.message });
			throw e;
		}
		markDirty(repo.id);
		return { settingsSaved: true };
	}
};
