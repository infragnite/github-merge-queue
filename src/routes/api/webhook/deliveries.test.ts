// Every webhook delivery leaves a log line with GitHub's delivery id, so a missed or mishandled
// event can be traced after GitHub's own record of it is gone.
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createHmac } from 'node:crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
vi.mock('$lib/server/pr-commands-live', () => ({ runLiveCommand: vi.fn(async () => {}) }));

const db = await import('$lib/server/db');
const route = await import('./+server');
const { setLogSink } = await import('$lib/server/log');

const logs: Array<Record<string, unknown>> = [];
beforeAll(() => {
	const id = db.upsertUser(1, 'dev', null, null);
	db.addRepo('acme', 'repo', 'main', id);
	setLogSink((_, line) => logs.push(JSON.parse(line)));
});
afterEach(() => {
	logs.length = 0;
});

async function deliver(body: unknown, opts: { event?: string; secret?: string; id?: string } = {}) {
	const text = JSON.stringify(body);
	const sig = 'sha256=' + createHmac('sha256', opts.secret ?? 'test-secret').update(text).digest('hex');
	const request = new Request('http://localhost/api/webhook', {
		method: 'POST',
		headers: { 'x-github-event': opts.event ?? 'pull_request', 'x-github-delivery': opts.id ?? 'd-1', 'x-hub-signature-256': sig, 'content-type': 'application/json' },
		body: text
	});
	return (await (route.POST as (e: unknown) => Promise<Response>)({ request })).status;
}

const delivery = () => logs.find((l) => l.msg === 'webhook delivery');

test('a delivery for a managed repo: its id, event, action, repo and PR', async () => {
	await deliver({ action: 'synchronize', repository: { full_name: 'acme/repo', default_branch: 'main' }, pull_request: { number: 5, head: { sha: 'abc' } } }, { id: 'guid-42' });
	expect(delivery()).toMatchObject({ level: 'info', delivery: 'guid-42', event: 'pull_request', action: 'synchronize', repo: 'acme/repo', pr: 5, outcome: 'handled' });
});

test('one for a repository the queue does not manage, and one with a bad signature', async () => {
	await deliver({ action: 'opened', repository: { full_name: 'acme/other' } }, { id: 'guid-1' });
	expect(delivery()).toMatchObject({ delivery: 'guid-1', repo: 'acme/other', outcome: 'unknown-repo' });
	logs.length = 0;
	expect(await deliver({ repository: { full_name: 'acme/repo' } }, { id: 'guid-2', secret: 'wrong' })).toBe(401);
	expect(delivery()).toMatchObject({ level: 'warn', delivery: 'guid-2', outcome: 'bad-signature' });
});
