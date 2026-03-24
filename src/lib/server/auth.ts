import { createHmac } from 'crypto';
import { env } from '$env/dynamic/private';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function secret() {
	if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET environment variable is required');
	return env.SESSION_SECRET;
}

export function createSessionToken(userId: number): string {
	const payload = `${userId}.${Date.now()}`;
	const sig = createHmac('sha256', secret()).update(payload).digest('hex');
	return `${payload}.${sig}`;
}

export function verifySessionToken(token: string): number | null {
	if (!env.SESSION_SECRET) return null;

	const lastDot = token.lastIndexOf('.');
	if (lastDot === -1) return null;

	const payload = token.slice(0, lastDot);
	const sig = token.slice(lastDot + 1);
	const expected = createHmac('sha256', secret()).update(payload).digest('hex');

	if (sig.length !== expected.length) return null;

	// Constant-time comparison
	let diff = 0;
	for (let i = 0; i < sig.length; i++) {
		diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
	}
	if (diff !== 0) return null;

	const parts = payload.split('.');
	if (parts.length !== 2) return null;

	const userId = parseInt(parts[0], 10);
	const issuedAt = parseInt(parts[1], 10);
	if (isNaN(userId) || isNaN(issuedAt)) return null;

	if (Date.now() - issuedAt > MAX_AGE_MS) return null;

	return userId;
}
