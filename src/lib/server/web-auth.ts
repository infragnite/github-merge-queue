// Who a signed-in web user is on a repository: their GitHub role, looked up as the App and
// shared for a minute, so a page refreshing every few seconds doesn't spend the rate limit.
// The web pages require the same roles as the agent API for the same changes.

import { collaboratorRole } from './github';
import { AuthError, type Caller, type Role } from './api-auth';

const ROLES: Role[] = ['none', 'read', 'write', 'maintain', 'admin'];

/** How long a looked-up role is used without asking GitHub again. */
const ROLE_TTL_MS = 60_000;
/** While GitHub can't be asked, a role this old is still used; after that, none (fail closed). */
const ROLE_STALE_MS = 10 * 60_000;

const roles = new Map<string, { at: number; role: Role }>();

export function roleOf(permission: string): Role {
	// triage reads; a custom role's base permission is one of the others
	return ROLES.includes(permission as Role) ? (permission as Role) : permission === 'triage' ? 'read' : 'none';
}

/** The signed-in user as a caller of the queue, with their role on the repository. */
export async function webCaller(
	owner: string,
	name: string,
	login: string,
	lookup: (owner: string, name: string, login: string) => Promise<string> = collaboratorRole,
	now = Date.now()
): Promise<Caller> {
	const key = `${owner}/${name}:${login}`.toLowerCase();
	const hit = roles.get(key);
	if (hit && now - hit.at < ROLE_TTL_MS) return { login, role: hit.role, app: false };
	let role: Role;
	try {
		role = roleOf(await lookup(owner, name, login));
		roles.set(key, { at: now, role });
		if (roles.size > 5000) for (const [k, v] of roles) if (now - v.at > ROLE_STALE_MS) roles.delete(k);
	} catch {
		// GitHub unreachable or rate limited: a recent role, else none (nothing can be changed).
		role = hit && now - hit.at < ROLE_STALE_MS ? hit.role : 'none';
	}
	return { login, role, app: false };
}

export function clearWebRoles() {
	roles.clear();
}

export { AuthError };
