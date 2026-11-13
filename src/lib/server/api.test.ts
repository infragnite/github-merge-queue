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
			return t.startsWith('ghs_') ? null : t === 'bad' ? null : { login: t === 'gho_maint' ? 'mia' : 'agent' };
		},
		permission: async (_o, _r, login) => {
			calls.push(`perm:${login}`);
			return login === 'mia' ? 'maintain' : 'write';
		},
		repoAsCaller: async (t): Promise<{ permissions?: Record<string, boolean>; scopes?: string | null } | null> => {
			calls.push(`repo:${t}`);
			if (t === 'ghs_ok') return { permissions: { push: true } };
			if (t === 'bad' || t === 'gho_other-repos') return null;
			if (t === 'gho_readonly') return { permissions: { pull: true }, scopes: 'repo' };
			const all = { admin: true, maintain: true, push: true, pull: true };
			if (t === 'gho_noscope') return { permissions: all, scopes: 'read:user' };
			if (t.startsWith('github_pat_')) return { permissions: all, scopes: null };
			return { permissions: all, scopes: 'repo, read:org, gist' };
		},
		...over
	});

	beforeEach(() => {
		calls = [];
		clearAuthCache();
	});

	test('maps the token to the user and their repo role', async () => {
		expect(await resolveCaller(gh(), 'Bearer gho_x', 'acme', 'r')).toEqual({ login: 'agent', role: 'write', app: false });
		expect((await resolveCaller(gh(), 'token gho_maint', 'acme', 'r')).role).toBe('maintain');
	});

	test('caches per token and repo, so GitHub is asked once', async () => {
		await resolveCaller(gh(), 'Bearer gho_x', 'acme', 'r');
		await resolveCaller(gh(), 'Bearer gho_x', 'acme', 'r');
		expect(calls).toEqual(['repo:gho_x', 'user:gho_x', 'perm:agent']);
		await resolveCaller(gh(), 'Bearer gho_x', 'acme', 'r', Date.now() + 6 * 60 * 1000);
		expect(calls).toHaveLength(6);
	});

	test('an installation token (any Actions GITHUB_TOKEN) only reads', async () => {
		expect(await resolveCaller(gh(), 'Bearer ghs_ok', 'acme', 'r')).toEqual({ login: 'github-app', role: 'read', app: true });
	});

	test('the token itself must see the repo, and its permissions bound the role', async () => {
		await expect(resolveCaller(gh(), 'Bearer gho_other-repos', 'acme', 'r')).rejects.toMatchObject({ status: 403 });
		expect((await resolveCaller(gh(), 'Bearer gho_readonly', 'acme', 'r')).role).toBe('read');
	});

	test('a token not shown to carry repo scope only reads, whatever its user may do', async () => {
		// e.g. a "Sign in with GitHub" token of some other app: GitHub still reports its user's permissions
		expect((await resolveCaller(gh(), 'Bearer gho_noscope', 'acme', 'r')).role).toBe('read');
		expect((await resolveCaller(gh(), 'Bearer github_pat_x', 'acme', 'r')).role).toBe('read');
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
	test.each<{ open: number[]; parents: Record<number, number>; pr: number }>([
		{ open: [1], parents: { 1: 1 }, pr: 1 },
		{ open: [1, 2], parents: { 1: 2, 2: 1 }, pr: 1 },
		{ open: [1, 2, 3], parents: { 1: 2, 2: 1, 3: 2 }, pr: 3 }
	])('rejects cyclic ancestry without blocking the server: $parents, PR $pr', ({ open, parents, pr }) => {
		expect(() => api.stackState(repo, pr, analysis(open, parents))).toThrow(
			expect.objectContaining({ status: 409, message: expect.stringContaining('Stack dependency cycle') })
		);
	});

	test('both stack endpoints reject a cycle in child links', () => {
		const a = analysis([1, 2], { 2: 1 });
		a.prs.get(2)!.children.push(1);
		for (const read of [() => api.stackState(repo, 1, a), () => api.stacksState(a)]) {
			expect(read).toThrow(expect.objectContaining({ status: 409, message: 'Stack dependency cycle involving #1' }));
		}
	});

	test('a cut ancestry cycle is reported as a blocking issue with a fix action', () => {
		const issue: StackIssue = { kind: 'stack-cycle', pr: 1, parent: 2, severity: 'blocking', message: 'Ambiguous stack ancestry cycle' };
		const a = analysis([1, 2, 3], { 3: 1 }, [issue]);
		expect(api.stackState(repo, 1, a)).toMatchObject({
			broken: true, issues: [issue], nextActions: [{ do: 'fix', why: issue.message }],
			stack: { pr: 1, children: [{ pr: 3, children: [] }] }
		});
	});

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

	test("a PR on its parent's branch but not on its latest commit is told to rebase onto it", () => {
		const issue: StackIssue = { kind: 'base-mismatch', pr: 2, parent: 1, severity: 'blocking', message: "Not on #1's latest commit" };
		const s = api.stackState(repo, 2, analysis([1, 2], {}, [issue]));
		expect(s.nextActions).toEqual([
			{ do: 'restack', onto: '#1', cmd: 'git fetch origin pull/1/head && git rebase FETCH_HEAD', why: "Not on #1's latest commit" }
		]);
	});

	test('a held PR lists what to do about its hold', () => {
		const hold = (n: number, code: string, reason: string) => {
			api.enqueue(repo, writer, pull(n), {});
			const it = db.getQueueItems(repo.id).find((i) => i.pr_number === n)!;
			db.updateQueueItemStatus(it.id, 'queued', reason);
			store.setHold(it.id, { code, reason });
			return it;
		};
		hold(1, 'draft', 'Draft');
		hold(2, 'changes-requested', 'Changes requested');
		const deferred = hold(3, 'deferred', 'Conflicts with #7 ahead of it; waits for them to land');
		store.setDeferredFor(deferred.id, [7]);
		const a = analysis([1, 2, 3, 7]);
		expect(api.stackState(repo, 1, a).nextActions).toEqual([{ do: 'mark-ready', why: 'Draft' }]);
		expect(api.stackState(repo, 2, a).nextActions).toEqual([{ do: 'fix', why: 'Changes requested' }]);
		expect(api.stackState(repo, 3, a).nextActions).toEqual([
			{ do: 'wait-for', pr: 7, why: 'Conflicts with #7 ahead of it; waits for them to land' }
		]);
	});

	test('a PR shows what it declares it depends on, what depends on it, and what to do about each', () => {
		const a = analysis([1, 2, 3, 4]);
		api.enqueue(repo, writer, pull(1), {});
		api.enqueue(repo, writer, pull(3), {});
		api.enqueue(repo, writer, pull(4), {});
		const item = (n: number) => db.getQueueItems(repo.id).find((i) => i.pr_number === n)!;
		// #3 declares #1 (queued) and #2 (not queued); #4 declares #3.
		store.setDependsOn(item(3).id, [1, 2]);
		store.setDependsOn(item(4).id, [3]);
		const s = api.stackState(repo, 3, a);
		expect(s).toMatchObject({ dependsOn: [1, 2], neededBy: [4] });
		expect(s.nextActions).toEqual([
			{ do: 'wait-for', pr: 1, why: 'Depends on #1; the queue lands #1 first, or in the same batch' },
			{ do: 'queue-dependency', pr: 2, why: "Depends on #2, which isn't queued; queue #2 so this PR can follow it" }
		]);
		expect(api.stackState(repo, 1, a)).toMatchObject({ dependsOn: [], neededBy: [3] });
	});

	test("a PR held for its declarations is told to fix that line", () => {
		api.enqueue(repo, writer, pull(5), {});
		const it = db.getQueueItems(repo.id).find((i) => i.pr_number === 5)!;
		const reason = 'Depends on #8, which was closed without merging';
		db.updateQueueItemStatus(it.id, 'queued', reason);
		store.setHold(it.id, { code: 'dependency-closed', reason });
		expect(api.stackState(repo, 5, analysis([5])).nextActions).toEqual([{ do: 'edit-dependencies', why: reason }]);
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

	test('queue state lists PRs in the order the queue takes them: being tested, then by priority, then by place in line', () => {
		api.enqueue(repo, writer, pull(1), { priority: 'low' });
		api.enqueue(repo, writer, pull(2), {});
		api.enqueue(repo, maintainer, pull(3), { priority: 'urgent' });
		api.enqueue(repo, writer, pull(4), {});
		api.enqueue(repo, writer, pull(5), { priority: 'low' });
		store.insertBatch({
			repoId: repo.id,
			kind: 'batch',
			branch: 'mq/batch-1',
			baseSha: 'b',
			headSha: 'h',
			treeSha: 't',
			baseTree: 'bt',
			members: [5],
			heads: { 5: 'x' }
		});
		expect(api.queueState(repo).waiting.map((w) => [w.pr, w.position])).toEqual([
			[5, 1],
			[3, 2],
			[2, 3],
			[4, 4],
			[1, 5]
		]);
		expect(api.queueEntry(repo.id, 3)).toMatchObject({ position: 2, priority: 'urgent' });
		expect(api.queueEntry(repo.id, 1)).toMatchObject({ position: 5, priority: 'low' });
	});

	test('queue state takes whole stacks: the most urgent member decides, children follow their parent, held PRs come last', () => {
		api.enqueue(repo, writer, pull(1), {});
		api.enqueue(repo, writer, pull(2), {});
		api.enqueue(repo, writer, pull(3), {});
		api.enqueue(repo, maintainer, pull(4), { priority: 'urgent' });
		api.enqueue(repo, writer, pull(5), {});
		// #1 is held (a draft); #4 is an urgent child of #2; #5 is a child of #1, held with it.
		const it = db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!;
		db.updateQueueItemStatus(it.id, 'queued', 'Draft');
		store.setHold(it.id, { code: 'draft', reason: 'Draft' });
		const a = analysis([1, 2, 3, 4, 5], { 4: 2, 5: 1 });
		expect(api.queueState(repo, a).waiting.map((w) => [w.pr, w.position])).toEqual([
			[2, 1],
			[4, 2],
			[3, 3],
			[1, 4],
			[5, 5]
		]);
		expect(api.queueEntry(repo.id, 2, a)).toMatchObject({ position: 1, priority: 'normal' });
		expect(api.stackState(repo, 4, a).queue).toMatchObject({ position: 2, priority: 'urgent' });
		expect(api.queueEntry(repo.id, 1, a)).toMatchObject({ position: 4 });
	});

	test('a PR that left a bisecting batch is back in line, not testing', () => {
		api.enqueue(repo, writer, pull(1), {});
		api.enqueue(repo, writer, pull(2), {});
		const b = store.insertBatch({
			repoId: repo.id,
			kind: 'batch',
			branch: 'mq/batch-1',
			baseSha: 'b',
			headSha: 'h',
			treeSha: 't',
			baseTree: 'bt',
			members: [1, 2],
			heads: { 1: 'x', 2: 'y' }
		});
		store.setBatchStatus(b.id, 'bisecting');
		store.leaveBatch(b.id, [2]);
		expect(api.queueState(repo).waiting.map((w) => [w.pr, w.status])).toEqual([
			[1, 'testing'],
			[2, 'queued']
		]);
		expect(api.stackState(repo, 2, analysis([2])).queue).toMatchObject({ status: 'queued' });
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

	test('a PR the queue cancelled or merged can be queued again', () => {
		// Closing a queued PR cancels its entry; reopened, it goes back in line (krusty #3474).
		api.enqueue(repo, writer, pull(1), {});
		db.updateQueueItemStatus(db.getQueueItems(repo.id)[0].id, 'cancelled', 'PR was closed');
		expect(api.enqueue(repo, writer, pull(1), {})).toMatchObject({ position: 1, priority: 'normal' });
		api.enqueue(repo, writer, pull(2), {});
		db.updateQueueItemStatus(db.getQueueItems(repo.id).find((i) => i.pr_number === 2)!.id, 'merged');
		expect(api.enqueue(repo, writer, pull(2), {})).toMatchObject({ position: 2 });
		expect(db.getAllQueueItems(repo.id).map((i) => [i.pr_number, i.status])).toEqual([[1, 'queued'], [2, 'queued']]);
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

	test('batches are addressed by the number the app shows, not their id', () => {
		const row = (kind: 'batch' | 'bisect', branch: string) =>
			store.insertBatch({ repoId: repo.id, kind, branch, baseSha: 'b', headSha: 'h', treeSha: 't', baseTree: 'bt', members: [1], heads: {} });
		const first = row('batch', 'mq/batch-a');
		row('bisect', 'mq/bisect-a');
		row('bisect', 'mq/bisect-b');
		const second = row('batch', 'mq/batch-b');
		expect([first.number, second.number]).toEqual([1, 2]);
		expect(second.id).not.toBe(2);
		expect(api.batchDetail(repo, 2)).toMatchObject({ id: second.id, number: 2, branch: 'mq/batch-b' });
		// The id of the second batch names no batch to an API caller: it is not a number shown.
		expect(() => api.batchDetail(repo, second.id)).toThrow(`No batch #${second.id}`);
		expect(() => api.canCancelBatch(repo, writer, 2)).toThrow(/needs maintain/);
		expect(api.canCancelBatch(repo, maintainer, 2).id).toBe(second.id);
		expect(() => api.canCancelBatch(repo, maintainer, second.id)).toThrow(`No batch #${second.id}`);
	});

	test('maintainers move a PR to the front', () => {
		api.enqueue(repo, writer, pull(1), {});
		api.enqueue(repo, writer, pull(2), {});
		expect(() => api.changeEntry(repo, writer, 2, { jumpTo: 'front' })).toThrow(/needs maintain/);
		expect(api.changeEntry(repo, maintainer, 2, { jumpTo: 'front' })).toMatchObject({ position: 1, priority: 'normal' });
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
		expect(api.patchConfig(repo, admin, { config: { comments: 'attention' } }).config.comments).toBe('attention');
		expect(() => api.patchConfig(repo, admin, { config: { comments: 'some' } })).toThrow(/comments must be one of all, attention, none/);
	});

	test('automatic tries: off by default; at least one at once, a whole number', () => {
		expect(api.patchConfig(repo, admin, {}).config).toMatchObject({ autoTry: false, autoTryMax: 2, autoTryDelayMs: 120_000, autoTryDrafts: false, requireTryPass: false });
		expect(api.patchConfig(repo, admin, { config: { autoTry: true, autoTryMax: 4, autoTryDelayMs: 0 } }).config).toMatchObject({ autoTry: true, autoTryMax: 4, autoTryDelayMs: 0 });
		expect(() => api.patchConfig(repo, admin, { config: { autoTryMax: 0 } })).toThrow('autoTryMax must be a whole number >= 1');
		expect(() => api.patchConfig(repo, admin, { config: { autoTryMax: 1.5 } })).toThrow('autoTryMax must be a whole number >= 1');
		expect(() => api.patchConfig(repo, admin, { config: { autoTry: 'yes' } })).toThrow(/autoTry must be a boolean/);
	});

	test('the PR report is a check run, a status, or both; both by default', () => {
		expect(api.patchConfig(repo, admin, {}).ci).toMatchObject({ prReport: 'both' });
		expect(api.patchConfig(repo, admin, { ci: { prReport: 'check-run' } }).ci).toMatchObject({ prReport: 'check-run' });
		expect(() => api.patchConfig(repo, admin, { ci: { prReport: 'checks' } })).toThrow(/prReport must be one of check-run, status, both/);
	});

	test('maintainers pause and resume', () => {
		expect(() => api.pause(repo, writer, 'x')).toThrow(/needs maintain/);
		expect(api.pause(repo, maintainer, 'release freeze').paused).toBe('release freeze');
		expect(api.resume(repo, maintainer).paused).toBeNull();
	});
});
