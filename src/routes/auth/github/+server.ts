import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { randomBytes } from 'crypto';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ cookies }) => {
	const clientId = env.GITHUB_CLIENT_ID;
	const publicUrl = env.APP_URL || 'http://localhost:3000';
	const redirectUri = `${publicUrl}/auth/callback`;

	const state = randomBytes(32).toString('hex');
	cookies.set('oauth_state', state, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: env.NODE_ENV === 'production',
		maxAge: 600
	});

	const params = new URLSearchParams({
		client_id: clientId!,
		redirect_uri: redirectUri,
		state
	});

	redirect(302, `https://github.com/login/oauth/authorize?${params}`);
};
