// The signed-in user of a dashboard page, as a caller of the queue with their role on the
// repository. Pages refresh every few seconds per viewer, so the role GitHub reports is reused
// for a while instead of being asked again on every load.

import { collaboratorRole } from './github';
import type { Caller, Role } from './api-auth';

const ROLES: Role[] = ['none', 'read', 'write', 'maintain', 'admin'];

const ROLE_TTL_MS = 60_000;
const roles = new Map<string, { at: number; role: Role }>();

/** The signed-in user as a caller of the queue, with their role on the repository. */
export async function pageCaller(owner: string, name: string, login: string): Promise<Caller> {
	const key = `${owner}/${name}:${login}`;
	const hit = roles.get(key);
	if (hit && Date.now() - hit.at < ROLE_TTL_MS) return { login, role: hit.role, app: false };
	let role: Role;
	try {
		const r = await collaboratorRole(owner, name, login);
		// triage reads; a custom role's base permission is one of the others
		role = ROLES.includes(r as Role) ? (r as Role) : r === 'triage' ? 'read' : 'none';
		roles.set(key, { at: Date.now(), role });
	} catch {
		// GitHub unreachable or rate limited: the last known role, else none (nothing to change)
		role = hit?.role ?? 'none';
	}
	return { login, role, app: false };
}

