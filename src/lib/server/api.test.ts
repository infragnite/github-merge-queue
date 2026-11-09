import { beforeEach, describe, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');
const store = await import('./batch-store');
const api = await import('./api-service');
const { resolveCaller, clearAuthCache, AuthError } = await import('./api-auth');
import type { AuthGitHub, Caller } from './api-auth';
import type { PRStackInfo, StackAnalysis, StackIssue } from './stacks';
import type { Repo } from '$lib/types';

describe('auth with the caller’s gh token', () => {
	let calls: string[];
	const gh = (over: Partial<AuthGitHub> = {}): AuthGitHub => ({
		user: async (t) => {
			calls.push(`user:${t}`);
			return t.startsWith('ghs_') ? null : t === 'bad' ? null : { login: t === 'maint' ? 'mia' : 'agent' };
		},
		permission: async (_o, _r, login) => {
			calls.push(`perm:${login}`);
			return login === 'mia' ? 'maintain' : 'write';
		},
		repoAsCaller: async (t): Promise<{ permissions?: Record<string, boolean> } | null> => {
			calls.push(`repo:${t}`);
			if (t === 'ghs_ok') return { permissions: { push: true } };
			if (t === 'bad' || t === 'other-repos') return null;
			if (t === 'readonly-token') return { permissions: { pull: true } };
			return { permissions: { admin: true, maintain: true, push: true, pull: true } };
		},
		...over
	});

	beforeEach(() => {
		calls = [];
		clearAuthCache();
	});

	test('maps the token to the user and their repo role', async () => {
		expect(await resolveCaller(gh(), 'Bearer gho_x', 'acme', 'r')).toEqual({ login: 'agent', role: 'write', app: false });
		expect((await resolveCaller(gh(), 'token maint', 'acme', 'r')).role).toBe('maintain');
	});

	test('caches per token and repo, so GitHub is asked once', async () => {
		await resolveCaller(gh(), 'Bearer gho_x', 'acme', 'r');
		await resolveCaller(gh(), 'Bearer gho_x', 'acme', 'r');
		expect(calls).toEqual(['repo:gho_x', 'user:gho_x', 'perm:agent']);
		await resolveCaller(gh(), 'Bearer gho_x', 'acme', 'r', Date.now() + 6 * 60 * 1000);
		expect(calls).toHaveLength(6);
	});

	test('an installation token gets repo-level access, at most write', async () => {
		expect(await resolveCaller(gh(), 'Bearer ghs_ok', 'acme', 'r')).toEqual({ login: 'github-app', role: 'write', app: true });
	});

	test('the token itself must see the repo, and its permissions bound the role', async () => {
		await expect(resolveCaller(gh(), 'Bearer other-repos', 'acme', 'r')).rejects.toMatchObject({ status: 403 });
		expect((await resolveCaller(gh(), 'Bearer readonly-token', 'acme', 'r')).role).toBe('read');
	});

	test('denials are cached, so a stranger costs one lookup', async () => {
		const g = gh({ permission: async (_o, _r, login) => (calls.push(`perm:${login}`), 'none') });
		await expect(resolveCaller(g, 'Bearer x', 'acme', 'r')).rejects.toMatchObject({ status: 403 });
		await expect(resolveCaller(g, 'Bearer x', 'acme', 'r')).rejects.toMatchObject({ status: 403 });
		expect(calls.filter((c) => c.startsWith('perm:'))).toHaveLength(1);
	});

	test('rejects a missing or unknown token, and users without access', async () => {
		await expect(resolveCaller(gh(), null, 'acme', 'r')).rejects.toMatchObject({ status: 401 });
		await expect(resolveCaller(gh(), 'Bearer bad', 'acme', 'r')).rejects.toMatchObject({ status: 401 });
		await expect(resolveCaller(gh({ permission: async () => 'none' }), 'Bearer x', 'acme', 'r')).rejects.toBeInstanceOf(
			AuthError
		);
	});
});

function analysis(open: number[], parents: Record<number, number> = {}, issues: StackIssue[] = []): StackAnalysis {
	const prs = new Map<number, PRStackInfo>();
	for (const n of open) {
		prs.set(n, {
			number: n,
			parent: parents[n] ?? null,
			link: parents[n] ? 'healthy' : null,
			children: open.filter((c) => parents[c] === n),
			depth: 0,
			expectedBase: parents[n] ? `pr${parents[n]}` : 'main',
			issues: issues.filter((i) => i.pr === n),
			broken: issues.some((i) => i.pr === n && i.severity === 'blocking')
		});
	}
	const roots = open.filter((n) => !parents[n] && open.some((c) => parents[c] === n));
	return { prs, stacks: roots.map((r) => [r]), issues };
}

const writer: Caller = { login: 'agent', role: 'write', app: false };
const maintainer: Caller = { login: 'mia', role: 'maintain', app: false };
const admin: Caller = { login: 'root', role: 'admin', app: false };
const pull = (n: number) => ({
	number: n,
	title: `PR ${n}`,
	html_url: `https://example.test/${n}`,
	state: 'open',
	user: { login: 'dev', avatar_url: '' }
});

let repo: Repo;
let seq = 0;
beforeEach(() => {
	const user = db.upsertUser(1, 'dev', null, null);
	db.addRepo('acme', `api${++seq}`, 'main', user);
	repo = db.getRepoByOwnerName('acme', `api${seq}`)!;
});

describe('stack state for agents', () => {
	test('a stacked child waiting on its queued parent', () => {
		const a = analysis([1, 2, 3], { 2: 1, 3: 2 });
		api.enqueue(repo, writer, pull(1), {});
		const s = api.stackState(repo, 2, a);
		expect(s).toMatchObject({ number: 2, parent: 1, children: [3], queue: null });
		expect(s.stack).toEqual({
			pr: 1,
			link: null,
			broken: false,
			children: [{ pr: 2, link: 'healthy', broken: false, children: [{ pr: 3, link: 'healthy', broken: false, children: [] }] }]
		});
		expect(s.nextActions).toEqual([{ do: 'wait-for', pr: 1, why: expect.any(String) }]);
		expect(api.stackState(repo, 3, a).nextActions).toEqual([{ do: 'queue', pr: 2, why: expect.stringMatching(/isn't queued/) }]);
	});

	test('a child of a rebased parent gets the exact restack command', () => {
		const issue: StackIssue = {
			kind: 'parent-rebased',
			pr: 2,
			parent: 1,
			severity: 'blocking',
			message: '#1 was rebased',
			staleCommits: ['aaa111', 'bbb222']
		};
		const s = api.stackState(repo, 2, analysis([1, 2], { 2: 1 }, [issue]));
		expect(s.nextActions).toEqual([
			{ do: 'restack', onto: '#1', cmd: 'git fetch origin pull/1/head && git rebase --onto FETCH_HEAD bbb222', why: '#1 was rebased' }
		]);
	});

	test('an unknown PR is a 404', () => {
		expect(() => api.stackState(repo, 99, analysis([1]))).toThrow(/not an open pull request/);
	});

	test('queue state shows waiting PRs with priority and in-flight batches', () => {
		api.enqueue(repo, writer, pull(1), {});
		api.enqueue(repo, maintainer, pull(2), { priority: 'urgent' });
		store.insertBatch({
			repoId: repo.id,
			kind: 'batch',
			branch: 'mq/batch-1',
			baseSha: 'b',
			headSha: 'h',
			treeSha: 't',
			baseTree: 'bt',
			members: [1],
			heads: { 1: 'x' }
		});
		const q = api.queueState(repo);
		expect(q.inFlight.map((b) => b.prs)).toEqual([[1]]);
		expect(q.waiting.map((w) => [w.pr, w.priority, w.status])).toEqual([
			[1, 'normal', 'testing'],
			[2, 'urgent', 'queued']
		]);
		expect(api.stackState(repo, 1, analysis([1])).queue).toMatchObject({ status: 'testing', batch: { prs: [1] } });
	});
});

describe('queue control', () => {
	test('writers queue and dequeue; urgent needs maintain', () => {
		expect(api.enqueue(repo, writer, pull(1), {})).toMatchObject({ position: 1, priority: 'normal' });
		expect(() => api.enqueue(repo, writer, pull(2), { priority: 'urgent' })).toThrow(/needs maintain/);
		expect(() => api.enqueue(repo, writer, pull(1), {})).toThrow(/already queued/);
		expect(() => api.enqueue(repo, writer, pull(3), { priority: 'asap' })).toThrow(/priority must be/);
		expect(api.dequeue(repo, writer, 1)).toEqual({ removed: 1 });
		expect(() => api.dequeue(repo, writer, 1)).toThrow(/not queued/);
	});

	test('a PR in a running batch cannot be dequeued', () => {
		api.enqueue(repo, writer, pull(1), {});
		store.insertBatch({
			repoId: repo.id,
			kind: 'batch',
			branch: 'mq/b',
			baseSha: 'b',
			headSha: 'h',
			treeSha: 't',
			baseTree: 'bt',
			members: [1],
			heads: {}
		});
		expect(() => api.dequeue(repo, writer, 1)).toThrow(/being tested/);
	});

	test('maintainers move a PR to the front', () => {
		api.enqueue(repo, writer, pull(1), {});
		api.enqueue(repo, writer, pull(2), {});
		expect(() => api.changeEntry(repo, writer, 2, { jumpTo: 'front' })).toThrow(/needs maintain/);
		expect(api.changeEntry(repo, maintainer, 2, { jumpTo: 'front' })).toMatchObject({ position: 1, priority: 'urgent' });
	});

	test('admins change settings, with validation', () => {
		expect(() => api.patchConfig(repo, maintainer, { mode: 'batch' })).toThrow(/needs admin/);
		const c = api.patchConfig(repo, admin, {
			mode: 'batch',
			config: { maxBatch: 12, collectWindowMs: 0 },
			ci: { requiredCheck: 'ci-and-conformance' }
		});
		expect(c).toMatchObject({ mode: 'batch', config: { maxBatch: 12, collectWindowMs: 0, depth: 2 }, ci: { requiredCheck: 'ci-and-conformance' } });
		expect(() => api.patchConfig(repo, admin, { config: { maxBatch: 0 } })).toThrow(/maxBatch/);
		expect(() => api.patchConfig(repo, admin, { config: { bogus: 1 } })).toThrow(/Unknown setting/);
		expect(() => api.patchConfig(repo, admin, { config: { depth: '2' } })).toThrow(/must be a number/);
		expect(() => api.patchConfig(repo, admin, { mode: 'fast' })).toThrow(/mode must be/);
	});

	test('maintainers pause and resume', () => {
		expect(() => api.pause(repo, writer, 'x')).toThrow(/needs maintain/);
		expect(api.pause(repo, maintainer, 'release freeze').paused).toBe('release freeze');
		expect(api.resume(repo, maintainer).paused).toBeNull();
	});
});
