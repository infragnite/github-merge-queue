import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { createSessionToken } from '$lib/server/auth';
import { upsertUser } from '$lib/server/db';
import { getUser } from '$lib/server/github';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const code = url.searchParams.get('code');
	if (!code) redirect(302, '/login?error=no_code');

	// Exchange code for access token
	const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code
		})
	});

	const tokenData = await tokenRes.json();
	if (!tokenData.access_token) {
		console.error('OAuth token exchange failed:', tokenData);
		redirect(302, '/login?error=auth_failed');
	}

	// Fetch GitHub user profile
	const ghUser = await getUser(tokenData.access_token);

	// Create or update user in database
	const userId = upsertUser(
		ghUser.id,
		ghUser.login,
		ghUser.name,
		ghUser.avatar_url,
		tokenData.access_token
	);

	// Set session cookie
	const token = createSessionToken(userId);
	cookies.set('session', token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: env.NODE_ENV === 'production',
		maxAge: 60 * 60 * 24 * 30
	});

	redirect(302, '/');
};
