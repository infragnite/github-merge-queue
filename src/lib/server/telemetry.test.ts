import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');
const store = await import('./batch-store');
const { emitEvent } = await import('./events');
const { recordRunCosts } = await import('./ci-savings');
const telemetry = await import('./telemetry');
const { setLogSink } = await import('./log');

class TestReader extends MetricReader {
	protected async onForceFlush() {}
	protected async onShutdown() {}
}

let reader: TestReader;
async function points(name: string): Promise<Array<{ attributes: Record<string, unknown>; value: unknown }>> {
	const { resourceMetrics } = await reader.collect();
	const metric = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
	return (metric?.dataPoints ?? []).map((p: DataPoint<unknown>) => ({ attributes: p.attributes, value: p.value }));
}
const sum = (v: unknown) => (v as { sum: number }).sum;
const count = (v: unknown) => (v as { count: number }).count;

let repoId: number;
const logs: Array<Record<string, unknown>> = [];
beforeAll(() => {
	const user = db.upsertUser(1, 'dev', null, null);
	db.addRepo('acme', 'repo', 'main', user);
	repoId = db.getRepoByOwnerName('acme', 'repo')!.id;
});
beforeEach(() => {
	reader = new TestReader();
	telemetry.useMeterProvider(new MeterProvider({ readers: [reader] }));
	setLogSink((_, line) => logs.push(JSON.parse(line)));
});
afterEach(() => {
	telemetry.useMeterProvider(null);
	setLogSink(null);
	logs.length = 0;
});

const insert = (o: { kind?: 'batch' | 'bisect' | 'try' | 'baseline'; members?: number[]; express?: boolean; head?: string } = {}) =>
	store.insertBatch({ repoId, kind: o.kind ?? 'batch', branch: `mq/b-${Math.random()}`, baseSha: 'b', headSha: o.head ?? 'h', treeSha: 't', baseTree: 'bt', members: o.members ?? [1, 2, 3], heads: {}, express: o.express });

describe('metrics for VictoriaMetrics (labels stay few: repository, kind, outcome; never a PR)', () => {
	test('batch sizes, and how batches end, with why when early', async () => {
		const a = insert({ members: [1, 2, 3] });
		const b = insert({ members: [4], express: true });
		store.setBatchStatus(a.id, 'landed');
		store.setBatchStatus(b.id, 'superseded', 'master-moved');
		store.setBatchStatus(b.id, 'superseded');
		const c = insert({ members: [5, 6] });
		store.setBatchStatus(c.id, 'cancelled', 'cancelled by anton');

		const sizes = await points('merge_queue.batch.size');
		expect(sizes.find((p) => p.attributes.express === false)).toMatchObject({ attributes: { repo: 'acme/repo', kind: 'batch' } });
		expect(sum(sizes.find((p) => p.attributes.express === false)!.value)).toBe(5);
		expect(sum(sizes.find((p) => p.attributes.express === true)!.value)).toBe(1);

		const ended = await points('merge_queue.batch.ended');
		// Counted once each, however often the status is set again; who cancelled is not a label.
		expect(ended.map((p) => [p.attributes.status, p.attributes.reason, p.value]).sort()).toEqual([
			['cancelled', 'cancelled', 1],
			['landed', 'none', 1],
			['superseded', 'master-moved', 1]
		]);
		expect(count((await points('merge_queue.batch.duration'))[0].value)).toBeGreaterThan(0);
	});

	test('time in the queue of each PR that leaves it, by outcome', async () => {
		const hourAgo = new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').slice(0, 19);
		db.addToHistory(repoId, 1, 't', 'u', 'dev', 'sha', 'merged', null, hourAgo);
		db.addToHistory(repoId, 2, 't', 'u', 'dev', null, 'failed', 'CI failed', hourAgo);
		const ps = await points('merge_queue.pr.time_in_queue');
		const merged = ps.find((p) => p.attributes.outcome === 'merged')!;
		expect(merged.attributes.repo).toBe('acme/repo');
		expect(sum(merged.value)).toBeGreaterThanOrEqual(3599);
		expect(sum(merged.value)).toBeLessThan(3700);
		expect(ps.find((p) => p.attributes.outcome === 'failed')).toBeDefined();
	});

	test('queue events counted by kind, and logged with where they happened', async () => {
		emitEvent(repoId, 7, 'ejected', { reason: 'CI failed in mq/batch-1' });
		emitEvent(repoId, 8, 'queued', {});
		emitEvent(repoId, 9, 'queued', {});
		const ps = await points('merge_queue.queue.events');
		expect(ps.map((p) => [p.attributes.kind, p.value]).sort()).toEqual([
			['ejected', 1],
			['queued', 2]
		]);
		expect(logs.find((l) => l.event === 'ejected')).toMatchObject({ msg: 'queue event', repo: 'acme/repo', pr: 7, data: { reason: 'CI failed in mq/batch-1' } });
	});

	test('CI job time and runner wait of each recorded run, by kind and conclusion', async () => {
		const run = insert({ kind: 'bisect', head: 'ci1' });
		store.setBatchCI(run.id, 'success');
		store.setBatchStatus(run.id, 'passed');
		const t = (min: number) => new Date(Date.UTC(2026, 10, 10, 0, min)).toISOString();
		const jobs = [
			{ id: 501, run_id: 1, run_attempt: 1, name: 'test', status: 'completed', conclusion: 'success', created_at: t(0), started_at: t(2), completed_at: t(12) },
			{ id: 502, run_id: 1, run_attempt: 1, name: 'lint', status: 'completed', conclusion: 'failure', created_at: t(0), started_at: t(1), completed_at: t(3) }
		];
		await recordRunCosts({ id: repoId }, async (sha) => (sha === 'ci1' ? jobs : []));
		const dur = await points('merge_queue.ci.job.duration');
		expect(dur.map((p) => [p.attributes.kind, p.attributes.conclusion, sum(p.value)]).sort()).toEqual([
			['bisect', 'failure', 120],
			['bisect', 'success', 600]
		]);
		const wait = await points('merge_queue.ci.job.runner_wait');
		expect(sum(wait[0].value)).toBe(180);
		expect(sum((await points('merge_queue.ci.run.duration'))[0].value)).toBe(660);
	});

	test('queue depth, pause and a red default branch, read when exported', async () => {
		db.addToQueue(repoId, 30, 't', 'u', 'dev', '', 'dev');
		db.addToQueue(repoId, 31, 't', 'u', 'dev', '', 'dev');
		store.updateQueueSettings(repoId, { pausedReason: 'x' });
		store.setMasterHealth(repoId, { sha: 's', tree: 't', state: 'red', since: Date.now() });
		const prs = await points('merge_queue.queue.prs');
		expect(prs.find((p) => p.attributes.status === 'queued')).toMatchObject({ attributes: { repo: 'acme/repo' }, value: 2 });
		expect((await points('merge_queue.queue.paused'))[0]).toMatchObject({ attributes: { repo: 'acme/repo' }, value: 1 });
		expect((await points('merge_queue.default_branch.red'))[0].value).toBe(1);
		store.updateQueueSettings(repoId, { pausedReason: null });
		expect((await points('merge_queue.queue.paused'))[0].value).toBe(0);
	});

	test('ticks, GitHub errors and webhook deliveries', async () => {
		telemetry.recordTick(repoId, 1500, 'ok');
		telemetry.recordGitHubError(502);
		telemetry.recordGitHubError('rate_limited');
		telemetry.recordWebhook('pull_request', 'handled');
		expect((await points('merge_queue.tick.duration'))[0]).toMatchObject({ attributes: { repo: 'acme/repo', outcome: 'ok' } });
		expect((await points('merge_queue.github.errors')).map((p) => p.attributes.status).sort()).toEqual(['502', 'rate_limited']);
		expect((await points('merge_queue.webhook.deliveries'))[0]).toMatchObject({ attributes: { event: 'pull_request', outcome: 'handled' }, value: 1 });
	});
});

test('without an exporter configured, metrics are off and recording does nothing', () => {
	telemetry.useMeterProvider(null);
	expect(telemetry.startTelemetry({})).toBe(false);
	expect(() => telemetry.recordTick(repoId, 1, 'ok')).not.toThrow();
	expect(() => insert()).not.toThrow();
});
