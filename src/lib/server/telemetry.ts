// Queue metrics, pushed over OTLP/HTTP like the rest of infragnite's services (Alloy's OTLP
// receiver forwards them to VictoriaMetrics). On when OTEL_EXPORTER_OTLP_ENDPOINT (or the
// metrics-only OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) is set; without it every call is a no-op.
// Labels stay few and bounded: the repository, a kind, an outcome. PR numbers, batch ids and
// logins belong in the logs (log.ts), never in a label.

import type { Attributes, Counter, Histogram, Meter } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { getDb } from './db';
import { log } from './log';

/** Seconds, from a second to a day: waits, CI jobs, ticks and batches all fit. */
const SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 2700, 3600, 7200, 14400, 28800, 86400];
const PRS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

interface Instruments {
	events: Counter;
	batchSize: Histogram;
	batchEnded: Counter;
	batchDuration: Histogram;
	timeInQueue: Histogram;
	jobDuration: Histogram;
	runnerWait: Histogram;
	runDuration: Histogram;
	tick: Histogram;
	githubErrors: Counter;
	webhooks: Counter;
}

let provider: MeterProvider | null = null;
let inst: Instruments | null = null;

const labels = new Map<number, string>();
/** `owner/name` of a repository, the one label every queue metric carries. */
export function repoLabel(repoId: number): string {
	let l = labels.get(repoId);
	if (!l) {
		const r = getDb().prepare('SELECT owner, name FROM repositories WHERE id = ?').get(repoId) as { owner: string; name: string } | undefined;
		l = r ? `${r.owner}/${r.name}` : String(repoId);
		labels.set(repoId, l);
	}
	return l;
}

function instruments(meter: Meter): Instruments {
	const seconds = (name: string, description: string) => meter.createHistogram(name, { unit: 's', description, advice: { explicitBucketBoundaries: SECONDS } });
	const instr: Instruments = {
		events: meter.createCounter('merge_queue.queue.events', { description: 'Queue events (queued, batched, ejected, merged, held, ...), by kind' }),
		batchSize: meter.createHistogram('merge_queue.batch.size', { unit: '{pr}', description: 'PRs in each run started', advice: { explicitBucketBoundaries: PRS } }),
		batchEnded: meter.createCounter('merge_queue.batch.ended', { description: 'Runs that ended, by status and why when early' }),
		batchDuration: seconds('merge_queue.batch.duration', 'A run from its start to its end'),
		timeInQueue: seconds('merge_queue.pr.time_in_queue', 'A PR from being queued to leaving the queue, by outcome'),
		jobDuration: seconds('merge_queue.ci.job.duration', 'Run time of each Actions job attempt of a queue run'),
		runnerWait: seconds('merge_queue.ci.job.runner_wait', 'Wait of each Actions job attempt for a runner'),
		runDuration: seconds('merge_queue.ci.run.duration', "A queue run's CI, first job start to last job end"),
		tick: seconds('merge_queue.tick.duration', 'One pass of the queue over a repository'),
		githubErrors: meter.createCounter('merge_queue.github.errors', { description: 'GitHub API calls that failed, by HTTP status (or rate_limited)' }),
		webhooks: meter.createCounter('merge_queue.webhook.deliveries', { description: 'Webhook deliveries, by event and outcome' })
	};
	// Read when exported, from what the queue stores.
	meter.createObservableGauge('merge_queue.queue.prs', { description: 'PRs in the queue, by status' }).addCallback((r) => {
		const rows = getDb().prepare('SELECT repo_id, status, COUNT(*) AS n FROM queue_items GROUP BY repo_id, status').all() as Array<{ repo_id: number; status: string; n: number }>;
		for (const row of rows) r.observe(row.n, { repo: repoLabel(row.repo_id), status: row.status });
	});
	meter.createObservableGauge('merge_queue.batches.active', { description: 'Runs in flight, by status' }).addCallback((r) => {
		const rows = getDb()
			.prepare(`SELECT repo_id, status, COUNT(*) AS n FROM batches WHERE status IN ('testing', 'retrying', 'bisecting', 'passed') AND kind = 'batch' GROUP BY repo_id, status`)
			.all() as Array<{ repo_id: number; status: string; n: number }>;
		for (const row of rows) r.observe(row.n, { repo: repoLabel(row.repo_id), status: row.status });
	});
	meter.createObservableGauge('merge_queue.queue.paused', { description: '1 while the queue of a repository is paused' }).addCallback((r) => {
		const rows = getDb().prepare('SELECT q.repo_id, q.paused_reason FROM queue_settings q JOIN repositories r ON r.id = q.repo_id').all() as Array<{ repo_id: number; paused_reason: string | null }>;
		for (const row of rows) r.observe(row.paused_reason ? 1 : 0, { repo: repoLabel(row.repo_id) });
	});
	meter.createObservableGauge('merge_queue.default_branch.red', { description: '1 while the default branch fails on its own' }).addCallback((r) => {
		const rows = getDb().prepare('SELECT repo_id, state FROM master_health').all() as Array<{ repo_id: number; state: string }>;
		for (const row of rows) r.observe(row.state === 'red' ? 1 : 0, { repo: repoLabel(row.repo_id) });
	});
	return instr;
}

/** Records into `p` from now on (null: records nothing). Tests give it an in-memory reader. */
export function useMeterProvider(p: MeterProvider | null) {
	provider = p;
	inst = p ? instruments(p.getMeter('merge-queue')) : null;
}

/** Starts pushing metrics when an OTLP endpoint is configured; says whether it did. */
export function startTelemetry(env: Record<string, string | undefined> = process.env): boolean {
	if (provider) return true;
	if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) {
		log.info('metrics are off: OTEL_EXPORTER_OTLP_ENDPOINT is not set');
		return false;
	}
	const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL) || 30_000;
	useMeterProvider(
		new MeterProvider({
			resource: resourceFromAttributes({ 'service.name': env.OTEL_SERVICE_NAME || 'merge-queue' }),
			readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: interval })]
		})
	);
	log.info('metrics are pushed over OTLP', { endpoint: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT, interval_ms: interval });
	return true;
}

/** Pushes what is left, on shutdown. */
export async function stopTelemetry() {
	const p = provider;
	useMeterProvider(null);
	await p?.shutdown().catch((err) => log.warn('could not push the last metrics', { err }));
}

/** Guards every recording: telemetry must never break the queue. */
function record(f: (i: Instruments) => void) {
	if (!inst) return;
	try {
		f(inst);
	} catch (err) {
		log.warn('could not record a metric', { err });
	}
}

const secs = (ms: number) => Math.max(0, ms) / 1000;

export function recordQueueEvent(repoId: number, kind: string) {
	record((i) => i.events.add(1, { repo: repoLabel(repoId), kind }));
}

export function recordBatchStarted(repoId: number, kind: string, prs: number, express: boolean) {
	record((i) => i.batchSize.record(prs, { repo: repoLabel(repoId), kind, express }));
}

/** `reason` is a batch's end_reason; who cancelled it is left out of the label. */
export function recordBatchEnded(repoId: number, kind: string, status: string, reason: string | null, durationMs: number) {
	const attrs: Attributes = { repo: repoLabel(repoId), kind, status };
	record((i) => {
		i.batchEnded.add(1, { ...attrs, reason: reason ? reason.replace(/^cancelled by .*/, 'cancelled') : 'none' });
		i.batchDuration.record(secs(durationMs), attrs);
	});
}

export function recordTimeInQueue(repoId: number, outcome: string, ms: number) {
	record((i) => i.timeInQueue.record(secs(ms), { repo: repoLabel(repoId), outcome }));
}

export function recordRun(
	repoId: number,
	kind: string,
	jobs: Array<{ conclusion?: string | null; created_at?: string | null; started_at: string | null; completed_at: string | null }>,
	wallMs: number
) {
	record((i) => {
		const repo = repoLabel(repoId);
		for (const j of jobs) {
			const start = j.started_at ? Date.parse(j.started_at) : NaN;
			const end = j.completed_at ? Date.parse(j.completed_at) : NaN;
			if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
			i.jobDuration.record(secs(end - start), { repo, kind, conclusion: j.conclusion ?? 'unknown' });
			const queued = j.created_at ? Date.parse(j.created_at) : NaN;
			if (Number.isFinite(queued) && queued <= start) i.runnerWait.record(secs(start - queued), { repo, kind });
		}
		if (wallMs > 0) i.runDuration.record(secs(wallMs), { repo, kind });
	});
}

export function recordTick(repoId: number, ms: number, outcome: 'ok' | 'error' | 'paused' | 'rate_limited') {
	record((i) => i.tick.record(secs(ms), { repo: repoLabel(repoId), outcome }));
}

export function recordGitHubError(status: number | 'rate_limited') {
	record((i) => i.githubErrors.add(1, { status: String(status) }));
}

export function recordWebhook(event: string, outcome: string) {
	record((i) => i.webhooks.add(1, { event, outcome }));
}
