import { afterEach, expect, test, vi } from 'vitest';
import { getUser } from './github';
import { GitHubError } from './github-retry';

afterEach(() => vi.unstubAllGlobals());

test('a failed GitHub call records its method and path, without the query', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Server Error' }), { status: 500 })));
	const err = await getUser('tok').catch((e) => e);
	expect(err).toBeInstanceOf(GitHubError);
	expect(err).toMatchObject({ status: 500, message: 'Server Error', call: 'GET /user' });
});
