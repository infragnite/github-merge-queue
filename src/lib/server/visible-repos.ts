import { atLeast, type Role } from './api-auth';
import { webCaller } from './web-auth';

/** The repositories `login` has at least `role` on, on GitHub (roles are cached, so refreshing is cheap). */
export async function visibleRepos<R extends { owner: string; name: string }>(repos: R[], login: string, role: Role = 'read'): Promise<R[]> {
	const roles = await Promise.all(repos.map((r) => webCaller(r.owner, r.name, login)));
	return repos.filter((_, i) => atLeast(roles[i].role, role));
}
