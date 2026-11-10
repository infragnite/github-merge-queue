import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// POST only: a GET could be triggered by any page linking here. SvelteKit refuses cross-site form posts.
export const POST: RequestHandler = ({ cookies }) => {
	cookies.delete('session', { path: '/' });
	redirect(303, '/login');
};
