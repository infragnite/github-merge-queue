// The agent API's access rules, through the real route: the same GitHub roles as the web pages.
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const gh = { user: 'dev' as string | null, sees: true, role: 'admin', down: false, stackCalls: 0 };
vi.mock('$lib/server/github', async (orig) => ({
	...(await orig<typeof import('$lib/server/github')>()),
	userForToken: vi.fn(async () => (gh.user ? { login: gh.user } : null)),
	repoForToken: vi.fn(async () => {
		if (gh.down) throw new TypeError('fetch failed');
		return gh.sees ? { permissions: { admin: true, maintain: true, push: true, pull: true }, scopes: 'repo' } : null;
	}),
	collaboratorRole: vi.fn(async () => gh.role),
	// Counts what the stack analysis asks GitHub for.
	stackClient: vi.fn(() => ({
		listOpenPRs: async () => (gh.stackCalls++, []),
		listRecentlyClosedPRs: async () => (gh.stackCalls++, []),
		getBranchSha: async () => (gh.stackCalls++, 'base'),
		compare: async () => (gh.stackCalls++, null)
	})),
	rateLimitOf: vi.fn(async () => ({ low: false }))
}));

const db = await import('$lib/server/db');
const { clearAuthCache } = await import('$lib/server/api-auth');
const route = await import('./+server');

beforeAll(() => {
	const id = db.upsertUser(1, 'dev', null, null);
	db.addRepo('acme', 'repo', 'main', id);
});
beforeEach(() => {
	clearAuthCache();
	Object.assign(gh, { user: 'dev', sees: true, role: 'admin', down: false });
});

async function call(method: string, path: string, opts: { token?: string | null; repo?: string; body?: unknown; ip?: string } = {}) {
	const token = opts.token === undefined ? 'ghp_test' : opts.token;
	const request = new Request(`http://localhost/api/v1/repos/acme/${opts.repo ?? 'repo'}/${path}`, {
		method,
		headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
		body: opts.body ? JSON.stringify(opts.body) : undefined
	});
	const handler = (route as Record<string, (e: unknown) => Promise<Response>>)[method];
	const res = await handler({ params: { owner: 'acme', repo: opts.repo ?? 'repo', path }, request, url: new URL(request.url), getClientAddress: () => opts.ip ?? '198.51.100.1' });
	return { status: res.status, body: await res.json() };
}

describe('agent API access', () => {
	test('an unmanaged repo, a repo the token cannot see and a refused token answer the same', async () => {
		const unmanaged = await call('GET', 'queue', { repo: 'secret' });
		gh.sees = false;
		const cantSee = await call('GET', 'queue');
		clearAuthCache();
		gh.user = null;
		const refused = await call('GET', 'queue', { token: 'ghp_bad' });
		expect(unmanaged).toEqual(cantSee);
		expect(refused).toEqual(cantSee);
		expect(cantSee.status).toBe(404);
	});

	test('no token is a 401', async () => {
		expect((await call('GET', 'queue', { token: null })).status).toBe(401);
	});

	test('a stranger on a public repo (no collaborator role) gets nothing', async () => {
		gh.role = 'none';
		expect((await call('GET', 'queue')).status).toBe(403);
	});

	test('writes need the same roles as the pages', async () => {
		gh.role = 'maintain';
		expect((await call('PATCH', 'queue/config', { body: { mode: 'batch' } })).status).toBe(403);
		clearAuthCache();
		gh.role = 'write';
		expect((await call('POST', 'queue/resume')).status).toBe(403);
		clearAuthCache();
		gh.role = 'read';
		expect((await call('DELETE', 'pulls/5/queue')).status).toBe(403);
	});

	test('when GitHub cannot say who is calling, the call is refused, not let through', async () => {
		gh.down = true;
		const r = await call('GET', 'queue');
		expect(r.status).toBe(503);
	});

	test('one address is limited', async () => {
		let last = 0;
		for (let i = 0; i < 300 && last !== 429; i++) last = (await call('GET', 'queue', { ip: '203.0.113.9', token: null })).status;
		expect(last).toBe(429);
	});

	test('polling the queue reuses the stack analysis, so it costs no GitHub calls per request', async () => {
		expect((await call('GET', 'queue')).status).toBe(200);
		gh.stackCalls = 0;
		for (let i = 0; i < 5; i++) expect((await call('GET', 'queue', { ip: `198.51.100.${10 + i}` })).status).toBe(200);
		expect(gh.stackCalls).toBe(0);
	});
});
