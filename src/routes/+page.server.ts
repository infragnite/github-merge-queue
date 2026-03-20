import { redirect } from '@sveltejs/kit';
import { getRepos, getHistory } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	return {
		repos: getRepos(),
		history: getHistory(15)
	};
};
