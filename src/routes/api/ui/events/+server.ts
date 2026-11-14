import { error } from '@sveltejs/kit';
import { getRepos } from '$lib/server/db';
import { getQueueSettings } from '$lib/server/batch-store';
import { knownPublic } from '$lib/server/public-view';
import { visibleRepos } from '$lib/server/visible-repos';
import { repoChangeResponse } from '$lib/server/repo-stream';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, request, url }) => {
	const selected = url.searchParams.get('repo');
	if (selected === null && !locals.user) error(401, 'Sign in first');
	const candidates = getRepos().filter((r) => selected === null || String(r.id) === selected);
	// Match the queue page's public-view policy without asking GitHub for anonymous readers.
	const publicRepo = selected !== null && candidates.length === 1 && getQueueSettings(candidates[0].id).publicView && knownPublic(candidates[0].id);
	const allowed = publicRepo ? candidates : locals.user ? await visibleRepos(candidates, locals.user.login) : [];
	if (selected !== null && !allowed.length) error(404, 'Repository not found');
	return repoChangeResponse(allowed.map((r) => r.id), request.signal);
};
