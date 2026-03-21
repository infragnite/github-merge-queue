import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { createSessionToken } from '$lib/server/auth';
import { upsertUser } from '$lib/server/db';
import { getUser, checkOrgMembership } from '$lib/server/github';
import type { RequestHandler } from './$types';

const ALLOWED_ORG = 'infragnite';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const savedState = cookies.get('oauth_state');
	cookies.delete('oauth_state', { path: '/' });

	if (!code) redirect(302, '/login?error=no_code');
	if (!state || !savedState || state !== savedState) {
		redirect(302, '/login?error=invalid_state');
	}

	const publicUrl = env.APP_URL || 'http://localhost:3000';
	const redirectUri = `${publicUrl}/auth/callback`;

	const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: redirectUri
		})
	});

	const tokenData = await tokenRes.json();
	if (!tokenData.access_token) {
		console.error('[auth] Token exchange failed:', tokenData.error, tokenData.error_description);
		redirect(302, '/login?error=auth_failed');
	}

	// Use the temporary OAuth token for identity, then discard it
	const ghUser = await getUser(tokenData.access_token);
	// Check org membership via installation token (requires members:read on app)
	const isMember = await checkOrgMembership(ghUser.login, ALLOWED_ORG);
	if (!isMember) {
		redirect(302, '/login?error=not_member');
	}

	// Token is NOT stored — only user identity is persisted
	const userId = upsertUser(ghUser.id, ghUser.login, ghUser.name, ghUser.avatar_url);

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
