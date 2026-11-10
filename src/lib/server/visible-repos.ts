import { atLeast } from './api-auth';
import { webCaller } from './web-auth';

/** The repositories `login` can read on GitHub (roles are cached, so this is cheap on refresh). */
export async function visibleRepos<R extends { owner: string; name: string }>(repos: R[], login: string): Promise<R[]> {
	const roles = await Promise.all(repos.map((r) => webCaller(r.owner, r.name, login)));
	return repos.filter((_, i) => atLeast(roles[i].role, 'read'));
}
