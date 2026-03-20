import type { Handle } from '@sveltejs/kit';
import { verifySessionToken } from '$lib/server/auth';
import { getUserById } from '$lib/server/db';
import { startProcessor } from '$lib/server/processor';

startProcessor();

export const handle: Handle = async ({ event, resolve }) => {
	const sessionCookie = event.cookies.get('session');

	if (sessionCookie) {
		const userId = verifySessionToken(sessionCookie);
		if (userId) {
			const user = getUserById(userId);
			if (user) {
				event.locals.user = {
					id: user.id,
					login: user.login,
					name: user.name,
					avatarUrl: user.avatar_url
				};
			}
		}
	}

	event.locals.user ??= null;
	return resolve(event);
};
