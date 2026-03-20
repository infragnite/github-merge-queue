import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	const clientId = env.GITHUB_CLIENT_ID;
	const publicUrl = env.PUBLIC_URL || 'http://localhost:3000';
	const redirectUri = `${publicUrl}/auth/callback`;

	const params = new URLSearchParams({
		client_id: clientId!,
		redirect_uri: redirectUri,
		scope: 'repo'
	});

	redirect(302, `https://github.com/login/oauth/authorize?${params}`);
};
