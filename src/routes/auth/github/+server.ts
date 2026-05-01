import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { randomBytes } from 'crypto';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ cookies }) => {
	const clientId = env.GITHUB_CLIENT_ID;
	const appUrl = env.APP_URL || 'http://localhost:3000';
	const redirectUri = `${appUrl}/auth/callback`;

	const isSecure = appUrl.startsWith('https');
	const state = randomBytes(32).toString('hex');
	cookies.set('oauth_state', state, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: isSecure,
		maxAge: 600
	});

	const params = new URLSearchParams({
		client_id: clientId!,
		redirect_uri: redirectUri,
		state
	});

	redirect(302, `https://github.com/login/oauth/authorize?${params}`);
};
