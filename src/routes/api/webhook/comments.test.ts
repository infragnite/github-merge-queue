// The webhook hands `/mq` PR comments to the command runner, and nothing else.
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHmac } from 'node:crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';

const ran: Array<{ repo: string; comment: unknown }> = [];
vi.mock('$lib/server/pr-commands-live', () => ({
	runLiveCommand: vi.fn(async (repo: { owner: string; name: string }, comment: unknown) => {
		ran.push({ repo: `${repo.owner}/${repo.name}`, comment });
	})
}));

const db = await import('$lib/server/db');
const route = await import('./+server');

beforeAll(() => {
	const id = db.upsertUser(1, 'dev', null, null);
	db.addRepo('acme', 'repo', 'main', id);
});
beforeEach(() => {
	ran.length = 0;
});

function payload(over: Record<string, unknown> = {}, comment: Record<string, unknown> = {}) {
	return {
		action: 'created',
		repository: { full_name: 'acme/repo', default_branch: 'main' },
		issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/repo/pulls/7' } },
		comment: { id: 99, body: '/mq queue --priority low', user: { login: 'dev', type: 'User' }, ...comment },
		...over
	};
}

async function deliver(body: unknown, opts: { event?: string; secret?: string } = {}) {
	const text = JSON.stringify(body);
	const sig = 'sha256=' + createHmac('sha256', opts.secret ?? 'test-secret').update(text).digest('hex');
	const request = new Request('http://localhost/api/webhook', {
		method: 'POST',
		headers: { 'x-github-event': opts.event ?? 'issue_comment', 'x-hub-signature-256': sig, 'content-type': 'application/json' },
		body: text
	});
	const res = await (route.POST as (e: unknown) => Promise<Response>)({ request });
	// The command runs after the answer; let it start.
	await new Promise((r) => setTimeout(r, 0));
	return res.status;
}

describe('issue_comment webhook', () => {
	test('a new /mq comment on a PR of a managed repo runs the command', async () => {
		expect(await deliver(payload())).toBe(200);
		expect(ran).toEqual([{ repo: 'acme/repo', comment: { pr: 7, commentId: 99, body: '/mq queue --priority low', login: 'dev', bot: false } }]);
	});

	test('edited comments, issue comments, other comments and unmanaged repos run nothing', async () => {
		await deliver(payload({ action: 'edited' }));
		await deliver(payload({ issue: { number: 7 } }));
		await deliver(payload({}, { body: 'nice work' }));
		await deliver(payload({ repository: { full_name: 'acme/other' } }));
		expect(ran).toEqual([]);
	});

	test('a comment delivered as another event runs nothing', async () => {
		await deliver(payload(), { event: 'pull_request_review_comment' });
		expect(ran).toEqual([]);
	});

	test('a payload with a bad signature is refused before anything runs', async () => {
		expect(await deliver(payload(), { secret: 'wrong' })).toBe(401);
		expect(ran).toEqual([]);
	});
});
