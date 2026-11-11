// `/mq` commands in PR comments: parsing, who may do what, and what each command does.
import { beforeEach, describe, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');
const store = await import('./batch-store');
const api = await import('./api-service');
const { emitEvent } = await import('./events');
const { readNotice } = await import('./hold-format');
const cmd = await import('./pr-commands');
import type { CommandDeps, CommandResult, PRComment } from './pr-commands';
import type { Role, Caller } from './api-auth';
import type { PRStackInfo, StackAnalysis } from './stacks';
import type { Repo } from '$lib/types';

describe('parsing a comment', () => {
	const p = cmd.parseCommand;

	test('only a comment that starts with /mq is a command', () => {
		for (const body of ['', 'LGTM', 'please /mq queue', '> /mq queue', '`/mq queue`', '/mqueue', '/mq-queue', 'thanks\n/mq queue', '/m q queue']) {
			expect(p(body), JSON.stringify(body)).toBeNull();
		}
	});

	test('the six commands', () => {
		expect(p('/mq queue')).toEqual({ name: 'queue', priority: 'normal' });
		expect(p('/mq dequeue')).toEqual({ name: 'dequeue' });
		expect(p('/mq retry')).toEqual({ name: 'retry' });
		expect(p('/mq try')).toEqual({ name: 'try' });
		expect(p('/mq status')).toEqual({ name: 'status' });
		expect(p('/mq help')).toEqual({ name: 'help' });
	});

	test('/mq alone is help', () => {
		expect(p('/mq')).toEqual({ name: 'help' });
		expect(p('/mq   \nwhat can you do?')).toEqual({ name: 'help' });
	});

	test('leading blank space, case and trailing space do not matter', () => {
		expect(p('  \n /MQ Queue  ')).toEqual({ name: 'queue', priority: 'normal' });
		expect(p('\t/mq   status')).toEqual({ name: 'status' });
	});

	test('only the first line counts; the rest is free text', () => {
		expect(p('/mq queue\nFixed the flaky test, trying again')).toEqual({ name: 'queue', priority: 'normal' });
		expect(p('/mq retry\r\n\r\n/mq dequeue')).toEqual({ name: 'retry' });
	});

	test('queue takes a priority, as a separate or an = value', () => {
		expect(p('/mq queue --priority low')).toEqual({ name: 'queue', priority: 'low' });
		expect(p('/mq queue --priority=normal')).toEqual({ name: 'queue', priority: 'normal' });
		expect(p('/mq queue --priority URGENT')).toEqual({ name: 'queue', priority: 'urgent' });
	});

	test('a bad priority, a missing value or an unknown argument is refused with the reason', () => {
		expect(p('/mq queue --priority')).toEqual({ name: 'invalid', error: expect.stringMatching(/--priority needs a value/) });
		expect(p('/mq queue --priority asap')).toEqual({ name: 'invalid', error: expect.stringMatching(/asap.*urgent, normal, low|urgent, normal, low.*asap/) });
		expect(p('/mq queue now')).toEqual({ name: 'invalid', error: expect.stringMatching(/now/) });
		expect(p('/mq queue --stack')).toEqual({ name: 'invalid', error: expect.stringMatching(/--stack/) });
	});

	test('commands without arguments refuse any', () => {
		for (const c of ['dequeue', 'retry', 'try', 'status', 'help']) {
			expect(p(`/mq ${c} please`)).toEqual({ name: 'invalid', error: expect.stringMatching(new RegExp(`${c}.*please|please.*${c}`)) });
		}
	});

	test('an unknown command is named in the refusal', () => {
		expect(p('/mq merge')).toEqual({ name: 'invalid', error: expect.stringMatching(/Unknown command `merge`/) });
	});
});

describe('reading a webhook payload', () => {
	const payload = (over: Record<string, unknown> = {}, comment: Record<string, unknown> = {}) => ({
		action: 'created',
		issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/r/pulls/7' } },
		comment: { id: 99, body: '/mq queue', user: { login: 'dev', type: 'User' }, ...comment },
		...over
	});

	test('a new /mq comment on a pull request', () => {
		expect(cmd.commentFromPayload(payload())).toEqual({ pr: 7, commentId: 99, body: '/mq queue', login: 'dev', bot: false });
	});

	test('a bot comment is marked as one', () => {
		expect(cmd.commentFromPayload(payload({}, { user: { login: 'helper[bot]', type: 'Bot' } }))).toMatchObject({ login: 'helper[bot]', bot: true });
	});

	test('edits, deletions, issues and comments that are not commands are ignored', () => {
		expect(cmd.commentFromPayload(payload({ action: 'edited' }))).toBeNull();
		expect(cmd.commentFromPayload(payload({ action: 'deleted' }))).toBeNull();
		expect(cmd.commentFromPayload(payload({ issue: { number: 7 } }))).toBeNull();
		expect(cmd.commentFromPayload(payload({}, { body: 'Looks good to me' }))).toBeNull();
		expect(cmd.commentFromPayload(payload({}, { body: null }))).toBeNull();
		expect(cmd.commentFromPayload({ action: 'created' })).toBeNull();
	});
});

// --- running commands ---

function analysis(open: number[], parents: Record<number, number> = {}): StackAnalysis {
	const prs = new Map<number, PRStackInfo>();
	for (const n of open) {
		prs.set(n, {
			number: n,
			parent: parents[n] ?? null,
			link: parents[n] ? 'healthy' : null,
			children: open.filter((c) => parents[c] === n),
			depth: 0,
			expectedBase: parents[n] ? `pr${parents[n]}` : 'main',
			issues: [],
			broken: false
		});
	}
	return { prs, stacks: [], issues: [] };
}

type Fake = CommandDeps & {
	roles: Record<string, Role>;
	open: Set<number>;
	parents: Record<number, number>;
	reactions: Array<[number, string]>;
	replies: Array<[number, string]>;
	woke: number;
	tries: number[];
	tryError: Error | null;
	roleError: Error | null;
	reactError: Error | null;
};

function fake(): Fake {
	const f: Fake = {
		roles: { dev: 'write', mia: 'maintain', rae: 'read', root: 'admin', 'helper[bot]': 'admin' },
		open: new Set([1, 2, 3, 4, 5, 7]),
		parents: {},
		reactions: [],
		replies: [],
		woke: 0,
		tries: [],
		tryError: null,
		roleError: null,
		reactError: null,
		queueUrl: 'https://mq.example.test/repos/acme/r',
		async role(login) {
			if (f.roleError) throw f.roleError;
			return f.roles[login] ?? 'none';
		},
		async pr(n) {
			return { number: n, title: `PR ${n}`, html_url: `https://github.test/acme/r/pull/${n}`, state: f.open.has(n) ? 'open' : 'closed', user: { login: 'author', avatar_url: '' } };
		},
		async analysis() {
			return analysis([...f.open], f.parents);
		},
		async startTry(n) {
			if (f.tryError) throw f.tryError;
			f.tries.push(n);
			return { branch: `mq/try-${n}-1700000000000` };
		},
		async react(id, content) {
			if (f.reactError) throw f.reactError;
			f.reactions.push([id, content]);
		},
		async reply(n, body) {
			f.replies.push([n, body]);
		},
		wake() {
			f.woke++;
		}
	};
	return f;
}

let repo: Repo;
let seq = 0;
let deps: Fake;
let commentId = 0;
beforeEach(() => {
	const user = db.upsertUser(1, 'dev', null, null);
	db.addRepo('acme', `cmd${++seq}`, 'main', user);
	repo = db.getRepoByOwnerName('acme', `cmd${seq}`)!;
	deps = fake();
	cmd.resetCommandLimits();
});

const comment = (body: string, login = 'dev', pr = 1, bot = false): PRComment => ({ pr, commentId: ++commentId, body, login, bot });
const run = (body: string, login = 'dev', pr = 1, bot = false) => cmd.runCommand(repo, deps, comment(body, login, pr, bot));
const queued = () => db.getQueueItems(repo.id).map((i) => i.pr_number);
const item = (n: number) => db.getQueueItems(repo.id).find((i) => i.pr_number === n) as (ReturnType<typeof db.getQueueItems>[number] & { priority: string }) | undefined;
const writer: Caller = { login: 'dev', role: 'write', app: false };
const pull = (n: number) => ({ number: n, title: `PR ${n}`, html_url: `https://github.test/${n}`, state: 'open', user: { login: 'author', avatar_url: '' } });

/** The queue throws a PR out, as `Tick.eject` does: an `ejected` event, and its row is gone. */
function eject(n: number, reason = 'CI failed in mq/batch-1') {
	const it = item(n)!;
	db.updateQueueItemStatus(it.id, 'failed', reason);
	db.removeFromQueue(it.id);
	emitEvent(repo.id, n, 'ejected', { reason });
}

function batchOf(members: number[]) {
	return store.insertBatch({ repoId: repo.id, kind: 'batch', branch: 'mq/batch-1', baseSha: 'b', headSha: 'h', treeSha: 't', baseTree: 'bt', members, heads: {} });
}

describe('acknowledging', () => {
	test('a done command gets a thumbs-up on the comment itself', async () => {
		const c = comment('/mq queue');
		const r = await cmd.runCommand(repo, deps, c);
		expect(r).toMatchObject({ command: 'queue', ok: true, reaction: '+1' });
		expect(deps.reactions).toEqual([[c.commentId, '+1']]);
	});

	test('a refused command gets a confused reaction and a reply saying why', async () => {
		const r = await run('/mq queue', 'rae');
		expect(r).toMatchObject({ command: 'queue', ok: false, reaction: 'confused' });
		expect(deps.reactions.map((x) => x[1])).toEqual(['confused']);
		expect(deps.replies).toHaveLength(1);
		expect(deps.replies[0][0]).toBe(1);
		expect(deps.replies[0][1]).toMatch(/needs write access; rae has read/);
	});

	test('a reply quotes the command it answers', async () => {
		await run('/mq dequeue\nnot ready yet');
		expect(deps.replies[0][1]).toMatch(/^> \/mq dequeue\n/);
	});

	test('an unknown command gets a short reply that points to help', async () => {
		const r = await run('/mq merge');
		expect(r).toMatchObject({ command: 'invalid', ok: false, reaction: 'confused' });
		expect(deps.replies[0][1]).toMatch(/Unknown command `merge`/);
		expect(deps.replies[0][1]).toMatch(/\/mq help/);
		expect(deps.replies[0][1].length).toBeLessThan(400);
	});

	test('a comment that is not a command does nothing, and asks GitHub nothing', async () => {
		deps.roleError = new Error('should not be asked');
		expect(await run('LGTM, thanks')).toBeNull();
		expect(deps.reactions).toEqual([]);
		expect(deps.replies).toEqual([]);
	});

	test('no reply starts with /mq, so the app never runs its own replies', async () => {
		const bodies = ['/mq queue', '/mq queue', '/mq dequeue', '/mq dequeue', '/mq retry', '/mq try', '/mq status', '/mq help', '/mq', '/mq nope', '/mq queue --priority asap'];
		for (const b of bodies) await run(b, 'dev');
		await run('/mq status', 'stranger');
		expect(deps.replies.length).toBeGreaterThan(5);
		for (const [, body] of deps.replies) expect(cmd.parseCommand(body), body).toBeNull();
	});

	test('when GitHub cannot say who commented, nothing is done and nothing is said', async () => {
		deps.roleError = new TypeError('fetch failed');
		expect(await run('/mq queue')).toBeNull();
		expect(queued()).toEqual([]);
		expect(deps.reactions).toEqual([]);
		expect(deps.replies).toEqual([]);
	});

	test('a reaction GitHub refuses does not stop the command or its reply', async () => {
		deps.reactError = new Error('403');
		const r = await run('/mq status');
		expect(r).toMatchObject({ ok: true });
		expect(deps.replies).toHaveLength(1);
	});

	test('replies to one commenter are limited; past the limit only the reaction answers', async () => {
		const results: CommandResult[] = [];
		for (let i = 0; i < 12; i++) results.push((await run('/mq nope'))!);
		expect(deps.replies.length).toBe(10);
		expect(results.at(-1)).toMatchObject({ reaction: 'confused', reply: null });
		expect(deps.reactions).toHaveLength(12);
		// Someone else still gets an answer.
		await run('/mq nope', 'mia');
		expect(deps.replies.length).toBe(11);
	});
});

describe('replies never name their own PR', () => {
	const own = (pr: number) => new RegExp(`#${pr}(?!\\d)`);

	test('not in any command’s reply, done or refused, nor in the reasons it passes on', async () => {
		store.updateQueueSettings(repo.id, { mode: 'batch' });
		deps.parents = { 2: 1 };
		// #1 is in batch #1, so the batch number and the PR number are the same.
		api.enqueue(repo, writer, pull(1), {});
		batchOf([1]);
		api.enqueue(repo, writer, pull(3), {});
		const held = item(3)!;
		db.updateQueueItemStatus(held.id, 'queued', '#3 has changes requested');
		store.setHold(held.id, { code: 'changes-requested', reason: '#3 has changes requested' });
		api.enqueue(repo, writer, pull(4), {});
		eject(4, '#4 failed CI in mq/batch-1');
		deps.open.delete(5);
		const bodies = ['/mq queue', '/mq queue --priority urgent', '/mq dequeue', '/mq retry', '/mq try', '/mq status', '/mq help', '/mq nope', '/mq queue --priority asap'];
		let total = 0;
		for (const pr of [1, 2, 3, 4, 5, 7]) {
			for (const b of bodies) {
				cmd.resetCommandLimits();
				const before = deps.replies.length;
				await run(b, 'mia', pr);
				for (const [on, body] of deps.replies.slice(before)) {
					total++;
					expect(on).toBe(pr);
					expect(body, `${b} on #${pr}`).not.toMatch(own(pr));
				}
			}
		}
		deps.tryError = new Error('#7 does not apply on main: conflict in a.ts');
		await run('/mq try', 'mia', 7);
		expect(deps.replies.at(-1)![1]).not.toMatch(own(7));
		expect(total).toBeGreaterThan(30);
	});

	test('other PRs are still named', async () => {
		deps.parents = { 2: 1 };
		api.enqueue(repo, writer, pull(2), {});
		await run('/mq status', 'rae', 2);
		expect(deps.replies[0][1]).toMatch(/Queue #1\b/);
	});
});

describe('who may do what', () => {
	test('the commenter’s role on the repository decides, as on the API', async () => {
		expect(await run('/mq status', 'rae')).toMatchObject({ ok: true });
		expect(await run('/mq help', 'rae')).toMatchObject({ ok: true });
		for (const c of ['/mq queue', '/mq dequeue', '/mq retry', '/mq try']) {
			expect(await run(c, 'rae'), c).toMatchObject({ ok: false });
		}
		expect(queued()).toEqual([]);
		expect(deps.tries).toEqual([]);
	});

	test('someone without access is told so, and nothing else happens', async () => {
		const r = await run('/mq status', 'stranger');
		expect(r).toMatchObject({ ok: false, reaction: 'confused' });
		expect(deps.replies[0][1]).toMatch(/needs read access; stranger has none/);
		expect(deps.replies[0][1]).not.toMatch(/position|priority/);
	});

	test('a bot reads at most, whatever its role, as an installation token on the API', async () => {
		expect(await run('/mq status', 'helper[bot]', 1, true)).toMatchObject({ ok: true });
		expect(await run('/mq queue', 'helper[bot]', 1, true)).toMatchObject({ ok: false });
		expect(deps.replies.at(-1)![1]).toMatch(/needs write access; helper\[bot\] has read/);
		expect(queued()).toEqual([]);
	});

	test('an urgent queue needs maintain', async () => {
		expect(await run('/mq queue --priority urgent', 'dev')).toMatchObject({ ok: false });
		expect(deps.replies[0][1]).toMatch(/needs maintain access/);
		expect(await run('/mq queue --priority urgent', 'mia')).toMatchObject({ ok: true });
		expect(item(1)!.priority).toBe('urgent');
	});
});

describe('/mq queue', () => {
	test('queues the PR as the commenter, and wakes the queue', async () => {
		expect(await run('/mq queue', 'dev', 3)).toMatchObject({ ok: true, reply: null });
		expect(queued()).toEqual([3]);
		expect(item(3)).toMatchObject({ queued_by: 'dev', pr_title: 'PR 3', priority: 'normal' });
		expect(deps.woke).toBe(1);
	});

	test('with a priority', async () => {
		await run('/mq queue --priority low', 'dev', 2);
		expect(item(2)!.priority).toBe('low');
	});

	test('a PR already queued is refused, and keeps its place', async () => {
		await run('/mq queue', 'dev', 1);
		await run('/mq queue', 'dev', 2);
		expect(await run('/mq queue', 'dev', 1)).toMatchObject({ ok: false });
		expect(deps.replies[0][1]).toMatch(/This PR is already queued/);
		expect(queued()).toEqual([1, 2]);
	});

	test('a closed PR is refused', async () => {
		deps.open.delete(5);
		expect(await run('/mq queue', 'dev', 5)).toMatchObject({ ok: false });
		expect(deps.replies[0][1]).toMatch(/This PR is not open/);
		expect(queued()).toEqual([]);
	});

	test('its parent is not queued with it', async () => {
		deps.parents = { 2: 1 };
		expect(await run('/mq queue', 'dev', 2)).toMatchObject({ ok: true });
		expect(queued()).toEqual([2]);
	});
});

describe('/mq dequeue', () => {
	test('takes the PR out of the queue', async () => {
		api.enqueue(repo, writer, pull(1), {});
		api.enqueue(repo, writer, pull(2), {});
		expect(await run('/mq dequeue', 'dev', 1)).toMatchObject({ ok: true, reaction: '+1', reply: null });
		expect(queued()).toEqual([2]);
		expect(deps.woke).toBe(1);
	});

	test('a PR not in the queue is refused', async () => {
		expect(await run('/mq dequeue', 'dev', 4)).toMatchObject({ ok: false });
		expect(deps.replies[0][1]).toMatch(/This PR is not queued/);
	});

	test('a PR being tested in a batch stays, and the reply says why', async () => {
		api.enqueue(repo, writer, pull(1), {});
		batchOf([1]);
		expect(await run('/mq dequeue', 'dev', 1)).toMatchObject({ ok: false });
		expect(deps.replies[0][1]).toMatch(/being tested in a batch/);
		expect(queued()).toEqual([1]);
	});
});

describe('/mq retry', () => {
	test('puts a PR the queue threw out back in line, with the priority it had', async () => {
		api.enqueue(repo, writer, pull(2), { priority: 'low' });
		eject(2);
		expect(queued()).toEqual([]);
		expect(await run('/mq retry', 'dev', 2)).toMatchObject({ command: 'retry', ok: true, reaction: '+1' });
		expect(queued()).toEqual([2]);
		expect(item(2)).toMatchObject({ priority: 'low', queued_by: 'dev' });
		expect(deps.woke).toBe(1);
	});

	test('an urgent PR retried by a writer comes back at normal priority, and the reply says so', async () => {
		api.enqueue(repo, { login: 'mia', role: 'maintain', app: false }, pull(2), { priority: 'urgent' });
		eject(2);
		expect(await run('/mq retry', 'dev', 2)).toMatchObject({ ok: true });
		expect(item(2)!.priority).toBe('normal');
		expect(deps.replies[0][1]).toMatch(/normal priority/);
		expect(deps.replies[0][1]).toMatch(/urgent needs maintain/);
	});

	test('a maintainer keeps it urgent', async () => {
		api.enqueue(repo, { login: 'mia', role: 'maintain', app: false }, pull(2), { priority: 'urgent' });
		eject(2);
		await run('/mq retry', 'mia', 2);
		expect(item(2)!.priority).toBe('urgent');
	});

	test('a PR the queue never threw out is refused, pointing to /mq queue', async () => {
		expect(await run('/mq retry', 'dev', 3)).toMatchObject({ ok: false });
		expect(deps.replies[0][1]).toMatch(/^Not removed from the queue by a failure/m);
		expect(deps.replies[0][1]).toMatch(/`\/mq queue`/);
		expect(queued()).toEqual([]);
	});

	test('only the last way out counts: thrown out, queued again, then dequeued by hand is not retried', async () => {
		api.enqueue(repo, writer, pull(2), {});
		eject(2);
		api.enqueue(repo, writer, pull(2), {});
		api.dequeue(repo, writer, 2);
		expect(await run('/mq retry', 'dev', 2)).toMatchObject({ ok: false });
		expect(queued()).toEqual([]);
	});

	test('a PR still in the queue is not queued twice; the reply gives where it stands', async () => {
		api.enqueue(repo, writer, pull(1), {});
		api.enqueue(repo, writer, pull(2), {});
		expect(await run('/mq retry', 'dev', 2)).toMatchObject({ ok: true });
		expect(queued()).toEqual([1, 2]);
		expect(deps.replies[0][1]).toMatch(/^Already in the queue.*position 2/ms);
		expect(deps.woke).toBe(1);
	});

	test('a closed PR is refused', async () => {
		api.enqueue(repo, writer, pull(5), {});
		eject(5);
		deps.open.delete(5);
		expect(await run('/mq retry', 'dev', 5)).toMatchObject({ ok: false });
		expect(deps.replies[0][1]).toMatch(/This PR is not open/);
		expect(queued()).toEqual([]);
	});
});

describe('/mq try', () => {
	const batchMode = () => store.updateQueueSettings(repo.id, { mode: 'batch' });

	test('starts a try run and replies with its branch', async () => {
		batchMode();
		expect(await run('/mq try', 'dev', 4)).toMatchObject({ ok: true, reaction: '+1' });
		expect(deps.tries).toEqual([4]);
		expect(deps.replies[0][1]).toMatch(/^Started a try run on top of `main`, on branch `mq\/try-4-1700000000000`/m);
	});

	test('the reply says a pass carries over to the queue while the default branch stays as it is', async () => {
		batchMode();
		await run('/mq try', 'dev', 4);
		expect(deps.replies[0][1]).toMatch(/If it passes and neither this PR nor `main` changes, `\/mq queue` lands it without another run\./);
	});

	test('needs the queue in batch mode', async () => {
		store.updateQueueSettings(repo.id, { mode: 'serial' });
		expect(await run('/mq try', 'dev', 4)).toMatchObject({ ok: false });
		expect(deps.replies[0][1]).toMatch(/batch mode/);
		expect(deps.tries).toEqual([]);
	});

	test('a PR that does not apply, or a fork PR not approved, is refused with the queue’s reason', async () => {
		batchMode();
		deps.tryError = new Error('#4 does not apply on main: conflict in a.ts');
		expect(await run('/mq try', 'dev', 4)).toMatchObject({ ok: false });
		expect(deps.replies[0][1]).toMatch(/This PR does not apply on main: conflict in a.ts/);
		deps.tryError = new Error('#4 comes from a fork; a writer must approve its head first');
		await run('/mq try', 'dev', 4);
		expect(deps.replies[1][1]).toMatch(/This PR comes from a fork/);
	});

	test('an unexpected failure is not shown in the comment', async () => {
		batchMode();
		deps.tryError = new Error('ENOENT /var/lib/mq/git/objects');
		expect(await run('/mq try', 'dev', 4)).toMatchObject({ ok: false, reaction: 'confused' });
		expect(deps.replies[0][1]).not.toMatch(/ENOENT|\/var\/lib/);
		expect(deps.replies[0][1]).toMatch(/could not start/i);
	});
});

describe('/mq status', () => {
	/** The reply's hidden block, read as agents read every queue comment. */
	const hidden = (body: string) => {
		expect(body).not.toContain('merge-queue:status');
		const n = readNotice(body);
		expect(n, body).not.toBeNull();
		expect(n!.kind).toBe('status');
		return n!;
	};

	test('a PR not in the queue says so, and how to queue it', async () => {
		await run('/mq status', 'rae', 3);
		const body = deps.replies[0][1];
		expect(body).toMatch(/^Not in the merge queue/m);
		expect(body).toMatch(/`\/mq queue`/);
		expect(hidden(body)).toMatchObject({ v: 1, kind: 'status', pr: 3, queue: null, nextActions: [], steps: [] });
		expect(hidden(body).code).toBeUndefined();
	});

	test('a queued PR gives its position, priority and state, and links the queue page', async () => {
		api.enqueue(repo, writer, pull(1), {});
		api.enqueue(repo, writer, pull(2), { priority: 'low' });
		await run('/mq status', 'rae', 2);
		const body = deps.replies[0][1];
		expect(body).toMatch(/^In the merge queue: position 2 of 2/m);
		expect(body).toMatch(/low priority/);
		expect(body).toMatch(/queued/);
		expect(body).toContain('https://mq.example.test/repos/acme/r');
		expect(hidden(body)).toMatchObject({ pr: 2, queue: { position: 2, priority: 'low', status: 'queued' } });
	});

	test('a PR in a batch names the batch', async () => {
		api.enqueue(repo, writer, pull(1), {});
		const b = batchOf([1]);
		await run('/mq status', 'rae', 1);
		expect(deps.replies[0][1]).toMatch(new RegExp(`testing in batch ${b.number}\\b`));
	});

	test('a held PR gives the hold code, the reason and what to do', async () => {
		api.enqueue(repo, writer, pull(2), {});
		const it = item(2)!;
		db.updateQueueItemStatus(it.id, 'queued', '#2 is a draft');
		store.setHold(it.id, { code: 'draft', reason: '#2 is a draft' });
		await run('/mq status', 'rae', 2);
		const body = deps.replies[0][1];
		expect(body).toMatch(/Held \(`draft`\): This PR is a draft/);
		expect(body).toMatch(/mark-ready/);
		expect(hidden(body)).toMatchObject({ code: 'draft', reason: 'This PR is a draft', nextActions: ['mark-ready'], steps: [{ do: 'mark-ready', why: 'This PR is a draft' }] });
		expect(hidden(body).queue).toMatchObject({ position: 1, status: 'queued' });
	});

	test('a child waiting for a parent nobody queued is told to queue it', async () => {
		deps.parents = { 2: 1 };
		api.enqueue(repo, writer, pull(2), {});
		await run('/mq status', 'rae', 2);
		const body = deps.replies[0][1];
		expect(body).toMatch(/queue #1/i);
		expect(hidden(body).steps).toEqual([{ do: 'queue', pr: 1, why: expect.any(String) }]);
		// The same id a hold notice gives for this hold.
		expect(hidden(body).nextActions).toEqual(['queue-parent']);
	});

	test('the head the status was about is in the block, when the queue knows it', async () => {
		api.enqueue(repo, writer, pull(1), {});
		db.updateQueueItemHeadSha(item(1)!.id, 'abc123');
		await run('/mq status', 'rae', 1);
		expect(hidden(deps.replies[0][1]).head).toBe('abc123');
		await run('/mq status', 'rae', 2);
		expect(hidden(deps.replies[1][1]).head).toBeNull();
	});

	test('restack steps carry their command, and the restack id', async () => {
		deps.open.add(8);
		deps.analysis = async () => {
			const a = analysis([1, 8], { 8: 1 });
			a.prs.get(8)!.issues = [{ kind: 'parent-merged', pr: 8, parent: 1, severity: 'blocking', message: '#1 was merged' }];
			return a;
		};
		await run('/mq status', 'rae', 8);
		const n = hidden(deps.replies[0][1]);
		expect(n.steps).toContainEqual({ do: 'restack', onto: 'main', cmd: 'git fetch origin main && git rebase origin/main', why: '#1 was merged' });
		expect(n.nextActions).toContain('restack');
	});

	test('restack commands are shown as code', async () => {
		deps.open.add(8);
		deps.analysis = async () => {
			const a = analysis([1, 8], { 8: 1 });
			a.prs.get(8)!.issues = [{ kind: 'parent-merged', pr: 8, parent: 1, severity: 'blocking', message: '#1 was merged' }];
			return a;
		};
		await run('/mq status', 'rae', 8);
		expect(deps.replies[0][1]).toContain('`git fetch origin main && git rebase origin/main`');
	});

	test('a PR the stack analysis does not know (just closed) still gets its queue state', async () => {
		api.enqueue(repo, writer, pull(1), {});
		deps.open.delete(1);
		await run('/mq status', 'rae', 1);
		expect(deps.replies[0][1]).toMatch(/position 1 of 1/);
	});

	test('a failed stack analysis still answers with the queue state', async () => {
		api.enqueue(repo, writer, pull(1), {});
		deps.analysis = async () => {
			throw new Error('rate limited');
		};
		expect(await run('/mq status', 'rae', 1)).toMatchObject({ ok: true });
		expect(deps.replies[0][1]).toMatch(/position 1 of 1/);
	});

	test('status changes nothing', async () => {
		await run('/mq status', 'root', 1);
		expect(queued()).toEqual([]);
		expect(deps.woke).toBe(0);
	});
});

describe('/mq help', () => {
	test('lists every command with the access it needs', async () => {
		expect(await run('/mq help', 'rae')).toMatchObject({ ok: true, reaction: '+1' });
		const body = deps.replies[0][1];
		for (const c of ['/mq queue', '--priority', '/mq dequeue', '/mq retry', '/mq try', '/mq status', '/mq help']) expect(body).toContain(c);
		expect(body).toMatch(/write/);
		expect(body).toMatch(/maintain/);
	});
});
