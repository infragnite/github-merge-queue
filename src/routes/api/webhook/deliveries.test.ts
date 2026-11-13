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

test('unsigned deliveries cannot flood the logs: one line a minute, saying how many were left out', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	try {
		vi.setSystemTime(new Date('2026-11-13T08:00:00Z'));
		for (let i = 0; i < 50; i++) await deliver({ repository: { full_name: 'acme/repo' } }, { id: `bad-${i}`, secret: 'wrong' });
		vi.setSystemTime(new Date('2026-11-13T08:01:01Z'));
		await deliver({ repository: { full_name: 'acme/repo' } }, { id: 'bad-late', secret: 'wrong' });
		const bad = logs.filter((l) => l.outcome === 'bad-signature');
		expect(bad.map((l) => [l.delivery, l.left_out])).toEqual([
			['bad-0', undefined],
			['bad-late', 49]
		]);
	} finally {
		vi.useRealTimers();
	}
});

test("an unsigned delivery's event header is not a metric label: anyone could make up new ones", async () => {
	const { MeterProvider, MetricReader } = await import('@opentelemetry/sdk-metrics');
	const telemetry = await import('$lib/server/telemetry');
	class TestReader extends MetricReader {
		protected async onForceFlush() {}
		protected async onShutdown() {}
	}
	const reader = new TestReader();
	telemetry.useMeterProvider(new MeterProvider({ readers: [reader] }));
	try {
		await deliver({ repository: { full_name: 'acme/repo' } }, { event: 'made-up-1', secret: 'wrong' });
		await deliver({ repository: { full_name: 'acme/repo' } }, { event: 'made-up-2', secret: 'wrong' });
		await deliver({ action: 'opened', repository: { full_name: 'acme/other' } }, { event: 'pull_request' });
		const { resourceMetrics } = await reader.collect();
		const m = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((x) => x.descriptor.name === 'merge_queue.webhook.deliveries')!;
		expect(m.dataPoints.map((p) => [p.attributes.event, p.attributes.outcome, p.value]).sort()).toEqual([
			['pull_request', 'unknown-repo', 1],
			['unverified', 'bad-signature', 2]
		]);
	} finally {
		telemetry.useMeterProvider(null);
	}
});
