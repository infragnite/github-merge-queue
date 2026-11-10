// Who can see and change a repository's queue from the web page: GitHub's role on the repo,
// checked on the server for every action, and the read-only public page for everyone else.
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const role = { value: 'admin' as string, fail: false };
vi.mock('$lib/server/github', async (orig) => ({
	...(await orig<typeof import('$lib/server/github')>()),
	collaboratorRole: vi.fn(async () => {
		if (role.fail) throw new Error('GitHub down');
		return role.value;
	}),
	getOpenPRs: vi.fn(async () => []),
	getRepo: vi.fn(async () => ({ private: false })),
	getPR: vi.fn(async (_o: string, _r: string, n: number) => ({
		number: n,
		title: 'From GitHub',
		html_url: `https://github.com/acme/repo/pull/${n}`,
		state: 'open',
		user: { login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' }
	})),
	rateLimitOf: vi.fn(async () => ({ low: false, blockedUntil: null }))
}));
vi.mock('$lib/server/stack-runtime', async (orig) => ({
	...(await orig<typeof import('$lib/server/stack-runtime')>()),
	dashboardStackAnalysis: vi.fn(async () => {
		throw new Error('secret internals');
	})
}));
vi.mock('$lib/server/pipeline-view', () => ({
	pipelineView: vi.fn(async () => ({ mode: 'serial', paused: 'App lacks permission X', master: null, active: [], recent: [], error: null, rateLimitedUntil: null, tickError: { message: 'boom', count: 1, since: 0 }, progressErrors: { a: 'b' } }))
}));

const db = await import('$lib/server/db');
const store = await import('$lib/server/batch-store');
const { clearWebRoles } = await import('$lib/server/web-auth');
const page = await import('./+page.server');

let repoId: number;
const user = { id: 1, login: 'dev', name: null, avatarUrl: null };

beforeAll(() => {
	const id = db.upsertUser(1, 'dev', null, null);
	db.addRepo('acme', 'repo', 'main', id);
	repoId = db.getRepoByOwnerName('acme', 'repo')!.id;
});
beforeEach(() => {
	clearWebRoles();
	role.value = 'admin';
	role.fail = false;
	store.updateQueueSettings(repoId, { publicView: false, pausedReason: null, mode: 'serial' });
});

function form(fields: Record<string, string>) {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
}

/** Runs action `name` as `who` (null: signed out); the result, or the failure's status and data. */
async function act(name: keyof typeof page.actions, who: typeof user | null, fields: Record<string, string> = {}) {
	const request = new Request('http://localhost/repos/acme/repo', { method: 'POST', body: form(fields) });
	const r = await (page.actions[name] as (e: unknown) => Promise<unknown>)({ request, params: { owner: 'acme', name: 'repo' }, locals: { user: who }, url: new URL(request.url) });
	return r as { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;
}

async function load(who: typeof user | null) {
	try {
		return await (page.load as (e: unknown) => Promise<Record<string, unknown>>)({ params: { owner: 'acme', name: 'repo' }, locals: { user: who }, url: new URL('http://localhost/repos/acme/repo') });
	} catch (e) {
		return { thrown: e as { status: number; location?: string } };
	}
}

describe('actions need the same role as the API', () => {
	const cases: Array<[keyof typeof page.actions, string, Record<string, string>]> = [
		['setMode', 'admin', { mode: 'batch' }],
		['saveSettings', 'admin', {}],
		['resume', 'maintain', {}],
		['cancelBatch', 'maintain', { batch_id: '1' }],
		['reorder', 'maintain', { order: '[]' }],
		['addToQueue', 'write', { pr_number: '5' }],
		['removeFromQueue', 'write', { item_id: '1' }],
		['retry', 'write', { item_id: '1' }],
		['setPriority', 'write', { pr_number: '5', priority: 'low' }]
	];
	const below: Record<string, string> = { admin: 'maintain', maintain: 'write', write: 'read' };
	for (const [name, need, fields] of cases) {
		test(`${name} needs ${need}`, async () => {
			expect((await act(name, null, fields)).status).toBe(401);
			role.value = below[need];
			const r = await act(name, user, fields);
			expect(r.status).toBe(403);
			expect(String(r.data?.error ?? r.data?.settingsError)).toMatch(`needs ${need}`);
		});
	}

	test('a read-only user cannot switch the mode', async () => {
		role.value = 'read';
		await act('setMode', user, { mode: 'batch' });
		expect(store.getQueueSettings(repoId).mode).toBe('serial');
	});

	test('making a PR urgent needs maintain', async () => {
		role.value = 'write';
		await act('addToQueue', user, { pr_number: '7' });
		const r = await act('setPriority', user, { pr_number: '7', priority: 'urgent' });
		expect(r.status).toBe(403);
		role.value = 'maintain';
		clearWebRoles();
		expect((await act('setPriority', user, { pr_number: '7', priority: 'urgent' })).status).toBeUndefined();
	});

	test('what is queued comes from GitHub, not the form', async () => {
		role.value = 'write';
		await act('addToQueue', user, { pr_number: '9', pr_title: '<img onerror=x>', pr_url: 'javascript:alert(1)', author_login: 'mallory' });
		const it = db.getQueueItems(repoId).find((i) => i.pr_number === 9)!;
		expect(it).toMatchObject({ pr_title: 'From GitHub', pr_url: 'https://github.com/acme/repo/pull/9', author_login: 'alice' });
	});

	test('when GitHub cannot say, nobody gets a role', async () => {
		role.fail = true;
		expect((await act('resume', user)).status).toBe(403);
	});
});

describe('who sees the page', () => {
	test('signed out, a repository that is not public asks to sign in', async () => {
		const r = await load(null);
		expect(r.thrown).toMatchObject({ status: 302, location: '/login?next=%2Frepos%2Facme%2Frepo' });
	});

	test('signed in without access, a repository that is not public is not found', async () => {
		role.value = 'none';
		expect((await load(user)).thrown).toMatchObject({ status: 404 });
	});

	test('the public page is read-only and leaves internals out', async () => {
		store.updateQueueSettings(repoId, { publicView: true, pausedReason: 'App lacks permission X' });
		const d = await load(null);
		expect(d).toMatchObject({ anonymous: true, readonly: true, role: 'none', settings: null, openPrs: [] });
		expect(Object.values(d.can as Record<string, boolean>).every((v) => v === false)).toBe(true);
		expect(d.repo).toEqual({ id: repoId, owner: 'acme', name: 'repo', default_branch: 'main' });
		const pipe = (await d.pipeline) as Record<string, unknown>;
		expect(pipe).toMatchObject({ paused: 'The queue is paused', tickError: null, progressErrors: {} });
		expect(((await d.stacks) as { error: string }).error).not.toMatch(/secret/);
		for (const i of d.queueItems as Array<Record<string, unknown>>) expect(i).toMatchObject({ queued_by: '', head_sha: null });
	});

	test('signed in without access, a public repository shows read-only', async () => {
		store.updateQueueSettings(repoId, { publicView: true });
		role.value = 'none';
		expect(await load(user)).toMatchObject({ anonymous: false, readonly: true, settings: null });
	});

	test('a collaborator sees it all', async () => {
		role.value = 'read';
		const d = await load(user);
		expect(d).toMatchObject({ readonly: false, role: 'read' });
		expect((d.can as Record<string, boolean>).queue).toBe(false);
	});
});
