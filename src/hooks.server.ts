import type { Handle } from '@sveltejs/kit';
import { verifySessionToken } from '$lib/server/auth';
import { getUserById } from '$lib/server/db';
import { drainProcessor, startProcessor } from '$lib/server/processor';
import { watchEventLoop } from '$lib/server/loop-watch';
import { RequestLimiter } from '$lib/server/request-limit';
import { env } from '$env/dynamic/private';

startProcessor();
watchEventLoop();
// adapter-node emits this on SIGTERM/SIGINT once it stops taking requests.
process.on('sveltekit:shutdown' as 'beforeExit', () => void drainProcessor());

// Without a session: a public queue page refreshes every 10 s (with its data request), so 120 a
// minute per address is several open tabs; sign-in gets less. Behind a reverse proxy, set
// adapter-node's ADDRESS_HEADER (and XFF_DEPTH) so the address is the client's, not the proxy's.
const anonymous = new RequestLimiter(120, 120);
const signIn = new RequestLimiter(10, 10);
// Signed GitHub deliveries, health probes and the token-authenticated API have their own checks.
const UNLIMITED = /^\/api\/(webhook|health|v1)\b/;

const SECURITY_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'x-frame-options': 'DENY',
	'cross-origin-opener-policy': 'same-origin',
	'cross-origin-resource-policy': 'same-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
};

function clientAddress(event: Parameters<Handle>[0]['event']): string {
	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	const response = await authorize({ event, resolve });
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!response.headers.has(k)) response.headers.set(k, v);
	if ((env.APP_URL || '').startsWith('https')) response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
	// Pages and their data depend on who is signed in: no shared cache may keep them.
	const type = response.headers.get('content-type') ?? '';
	if ((type.startsWith('text/html') || type.startsWith('application/json')) && !response.headers.has('cache-control')) {
		response.headers.set('cache-control', 'private, no-store');
	}
	return response;
};

const authorize: Handle = async ({ event, resolve }) => {
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

	const path = event.url.pathname;
	if (!event.locals.user && !UNLIMITED.test(path)) {
		const limiter = path.startsWith('/auth/') ? signIn : anonymous;
		const wait = limiter.take(clientAddress(event));
		if (wait > 0) return new Response('Too many requests; try again shortly.', { status: 429, headers: { 'retry-after': String(wait), 'content-type': 'text/plain' } });
	}
	return resolve(event);
};
