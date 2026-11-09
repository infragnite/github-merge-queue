// Auth for the agent API: callers send their own GitHub token
// (`Authorization: Bearer $(gh auth token)`), so agents need no separate
// login. The token only identifies the caller; every GitHub write is made
// with the app's installation token. Tokens are never stored or logged:
// results are cached for a few minutes under a SHA-256 of the token.

import { createHash } from 'node:crypto';

export type Role = 'none' | 'read' | 'write' | 'maintain' | 'admin';

const RANK: Record<Role, number> = { none: 0, read: 1, write: 2, maintain: 3, admin: 4 };

export function atLeast(role: Role, needed: Role): boolean {
	return RANK[role] >= RANK[needed];
}

export interface Caller {
	login: string;
	role: Role;
	/** True for a GitHub App installation token (no user behind it). */
	app: boolean;
}

export interface AuthGitHub {
	/** GET /user with the caller's token; null when GitHub rejects it (e.g. a `ghs_` token). */
	user(token: string): Promise<{ login: string } | null>;
	/** The user's permission on the repo, looked up with the app's own token. */
	permission(owner: string, repo: string, login: string): Promise<string>;
	/** GET /repos/{owner}/{repo} with the caller's token; null when it can't see the repo. */
	repoAsCaller(token: string, owner: string, repo: string): Promise<{ permissions?: Record<string, boolean> } | null>;
}

export class AuthError extends Error {
	constructor(
		readonly status: 401 | 403,
		message: string
	) {
		super(message);
	}
}

const TTL_MS = 5 * 60 * 1000;
/** Denials are cached too, so a stranger's token can't make the app spend its rate limit. */
const DENY_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 5000;
const cache = new Map<string, { caller: Caller | null; error?: AuthError; until: number }>();

export function clearAuthCache() {
	cache.clear();
}

function roleFrom(permission: string): Role {
	switch (permission) {
		case 'admin':
			return 'admin';
		case 'maintain':
			return 'maintain';
		case 'write':
		case 'push':
			return 'write';
		case 'triage':
		case 'read':
		case 'pull':
			return 'read';
		default:
			return 'none';
	}
}

export function bearer(header: string | null): string | null {
	const m = header?.match(/^(?:Bearer|token)\s+(\S+)$/i);
	return m ? m[1] : null;
}

/** Resolves who is calling and what they may do on `owner/repo`. */
export async function resolveCaller(
	gh: AuthGitHub,
	header: string | null,
	owner: string,
	repo: string,
	now = Date.now()
): Promise<Caller> {
	const token = bearer(header);
	if (!token) throw new AuthError(401, 'Send your GitHub token: Authorization: Bearer $(gh auth token)');
	const key = `${createHash('sha256').update(token).digest('hex')}:${owner}/${repo}`.toLowerCase();
	const hit = cache.get(key);
	if (hit && hit.until > now) {
		if (hit.caller) return hit.caller;
		throw hit.error!;
	}
	if (cache.size >= MAX_ENTRIES) {
		for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
		if (cache.size >= MAX_ENTRIES) cache.clear();
	}
	const deny = (error: AuthError): never => {
		cache.set(key, { caller: null, error, until: now + DENY_TTL_MS });
		throw error;
	};

	let caller: Caller;
	// The token itself must be able to see the repo, and its own permissions bound the role:
	// a token scoped to other repos, or without repo scope, doesn't carry its user's rights here.
	const asCaller = await gh.repoAsCaller(token, owner, repo);
	const user = await gh.user(token);
	if (!asCaller) return deny(new AuthError(user ? 403 : 401, user ? `This token can't see ${owner}/${repo}` : 'GitHub did not accept this token'));
	const tokenRole = roleFromPermissions(asCaller.permissions);
	if (user) {
		const userRole = roleFrom(await gh.permission(owner, repo, user.login));
		caller = { login: user.login, role: minRole(userRole, tokenRole), app: false };
	} else {
		// An installation token has no user; it either sees the repo or not, and gets at most write.
		caller = { login: 'github-app', role: minRole(tokenRole, 'write'), app: true };
	}
	if (caller.role === 'none') return deny(new AuthError(403, `${caller.login} has no access to ${owner}/${repo}`));
	cache.set(key, { caller, until: now + TTL_MS });
	return caller;
}

function roleFromPermissions(p: Record<string, boolean> | undefined): Role {
	if (!p) return 'read'; // a public repo seen without repo scope
	if (p.admin) return 'admin';
	if (p.maintain) return 'maintain';
	if (p.push) return 'write';
	if (p.triage || p.pull) return 'read';
	return 'none';
}

function minRole(a: Role, b: Role): Role {
	return RANK[a] <= RANK[b] ? a : b;
}

export function requireRole(caller: Caller, needed: Role, what: string) {
	if (!atLeast(caller.role, needed)) {
		throw new AuthError(403, `${what} needs ${needed} access; ${caller.login} has ${caller.role}`);
	}
}
