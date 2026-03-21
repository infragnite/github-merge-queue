import { createHmac } from 'crypto';
import { env } from '$env/dynamic/private';

function secret() {
	if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET environment variable is required');
	return env.SESSION_SECRET;
}

export function createSessionToken(userId: number): string {
	const payload = String(userId);
	const sig = createHmac('sha256', secret()).update(payload).digest('hex');
	return `${payload}.${sig}`;
}

export function verifySessionToken(token: string): number | null {
	const dot = token.indexOf('.');
	if (dot === -1) return null;

	const payload = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const expected = createHmac('sha256', secret()).update(payload).digest('hex');

	if (sig.length !== expected.length) return null;

	// Constant-time comparison
	let diff = 0;
	for (let i = 0; i < sig.length; i++) {
		diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
	}
	if (diff !== 0) return null;

	const userId = parseInt(payload, 10);
	return isNaN(userId) ? null : userId;
}
