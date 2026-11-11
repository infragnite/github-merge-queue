// What batching saves in CI: every queue-started run (batch, bisection step, try, check of the
// default branch) has its Actions jobs' run time recorded once it is over, and that is compared
// with running each landed PR's CI on its own.

import { getDb } from './db';
import type { BatchRow } from './batch-store';

/**
 * An Actions job attempt, as the workflow-jobs API gives it. Check runs (and older callers) carry
 * only the name, status and times.
 */
export type Job = {
	id?: number;
	run_id?: number;
	run_attempt?: number;
	workflow_name?: string | null;
	runner_name?: string | null;
	name: string;
	status: string;
	conclusion?: string | null;
	/** When the job was queued: its wait for a runner is from here to `started_at`. */
	created_at?: string | null;
	started_at: string | null;
	completed_at: string | null;
};

export interface JobCost {
	/** Summed run time of every job, every attempt. */
	jobMs: number;
	/** Of it, attempts before the latest of a job (re-runs of failed jobs). */
	rerunMs: number;
	/** First job's start to last job's end. */
	wallMs: number;
	jobs: number;
	/** Every job finished. */
	done: boolean;
	/** Summed wait of the jobs for a runner (0 when the jobs don't say when they were queued). */
	queueMs: number;
	/** First job's start and last job's end, epoch ms; null without a finished job. */
	startMs: number | null;
	endMs: number | null;
	/** Highest workflow run attempt among the jobs (1 when they don't say). */
	attempts: number;
}

export function jobCost(jobs: Job[]): JobCost {
	let jobMs = 0;
	let queueMs = 0;
	let attempts = 1;
	let first = Infinity;
	let last = -Infinity;
	const latest = new Map<string, { start: number; ms: number }>();
	for (const j of jobs) {
		if (!j.started_at || !j.completed_at) continue;
		const start = Date.parse(j.started_at);
		const end = Date.parse(j.completed_at);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
		const ms = end - start;
		jobMs += ms;
		const queued = j.created_at ? Date.parse(j.created_at) : NaN;
		if (Number.isFinite(queued) && queued <= start) queueMs += start - queued;
		if (j.run_attempt && j.run_attempt > attempts) attempts = j.run_attempt;
		first = Math.min(first, start);
		last = Math.max(last, end);
		const l = latest.get(j.name);
		if (!l || start > l.start) latest.set(j.name, { start, ms });
	}
	const latestMs = [...latest.values()].reduce((n, l) => n + l.ms, 0);
	return {
		jobMs,
		rerunMs: jobMs - latestMs,
		wallMs: last > first ? last - first : 0,
		jobs: jobs.length,
		done: jobs.length > 0 && jobs.every((j) => j.status === 'completed'),
		queueMs,
		startMs: Number.isFinite(first) ? first : null,
		endMs: Number.isFinite(last) ? last : null,
		attempts
	};
}

/**
 * Every job attempt of every workflow run on a commit, through `get` (a GitHub API GET returning
 * parsed JSON). The workflow-jobs API, unlike check runs, says when each job was queued.
 */
export async function actionsJobsFor(get: (path: string) => Promise<any>, owner: string, repo: string, sha: string): Promise<Job[]> {
	const runs = ((await get(`/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=100`)).workflow_runs ?? []) as Array<{ id: number }>;
	const out: Job[] = [];
	for (const run of runs) {
		for (let page = 1; page <= 5; page++) {
			const jobs = ((await get(`/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`)).jobs ?? []) as Job[];
			out.push(...jobs);
			if (jobs.length < 100) break;
		}
	}
	return out;
}

const msOf = (t: string | null | undefined) => {
	const ms = t ? Date.parse(t) : NaN;
	return Number.isFinite(ms) ? ms : null;
};

const FINISHED = ['landed', 'failed', 'superseded', 'cancelled'];
/** A finished run whose jobs still haven't all completed this long after is recorded as it is. */
const SETTLE_MS = 30 * 60_000;

const toMs = (t: string) => Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);

/** Runs that are over and not recorded yet, oldest first. */
function unrecorded(repoId: number, limit: number): BatchRow[] {
	return (
		getDb()
			.prepare(
				`SELECT b.* FROM batches b LEFT JOIN ci_runs c ON c.batch_id = b.id
				 WHERE b.repo_id = ? AND c.batch_id IS NULL
				   AND (b.finished_at IS NOT NULL OR (b.ci_result != 'pending' AND b.status != 'retrying'))
				 ORDER BY b.id LIMIT ?`
			)
			.all(repoId, limit) as Array<BatchRow & { members: string }>
	).map((r) => ({ ...r, members: JSON.parse(r.members as unknown as string) }));
}

/**
 * Records what finished runs cost, at most `maxCalls` GitHub calls per call (it is called every
 * processor cycle, so a backlog drains over a few minutes without spending the rate limit).
 */
export async function recordRunCosts(
	repo: { id: number },
	jobsFor: (sha: string) => Promise<Job[]>,
	now = Date.now(),
	maxCalls = 4
): Promise<number> {
	let calls = 0;
	let recorded = 0;
	for (const b of unrecorded(repo.id, 50)) {
		if (calls >= maxCalls) break;
		calls++;
		const jobs = await jobsFor(b.head_sha);
		const cost = jobCost(jobs);
		// Over by its status but still showing running jobs, or none at all (a run that never
		// started, or an old bisection row without a finish time): recorded as it is once it has
		// been over long enough, so such rows can't hold up the ones behind them.
		const settled = now - toMs(b.finished_at ?? b.created_at) > SETTLE_MS;
		if (!cost.done && !settled) continue;
		const job = getDb().prepare(
			`INSERT OR REPLACE INTO ci_jobs (job_id, batch_id, repo_id, run_id, attempt, workflow, name, conclusion, runner, created_ms, started_ms, completed_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		getDb().transaction(() => {
			getDb()
				.prepare(
					`INSERT OR REPLACE INTO ci_runs (batch_id, repo_id, job_ms, rerun_ms, wall_ms, jobs, queue_ms, started_ms, ended_ms, attempts)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(b.id, repo.id, cost.jobMs, cost.rerunMs, cost.wallMs, cost.jobs, cost.queueMs, cost.startMs, cost.endMs, cost.attempts);
			// Per job attempt, for analysis by job (slow or flaky jobs, runner waits); check runs have no job id.
			for (const j of jobs) {
				if (j.id == null) continue;
				job.run(j.id, b.id, repo.id, j.run_id ?? null, j.run_attempt ?? 1, j.workflow_name ?? null, j.name, j.conclusion ?? null, j.runner_name ?? null, msOf(j.created_at), msOf(j.started_at), msOf(j.completed_at));
			}
		})();
		recorded++;
	}
	return recorded;
}

export interface RunSample {
	kind: BatchRow['kind'];
	status: BatchRow['status'];
	/** PRs in the tree it tested. */
	prs: number;
	atMs: number;
	jobMs: number;
	rerunMs: number;
	wallMs: number;
}

export interface Landing {
	atMs: number;
	prs: number;
}

export interface Savings {
	key: string;
	label: string;
	landed: number;
	runs: number;
	/** CI time the queue's runs took. */
	spentMs: number;
	/** The same PRs, each run on its own once. */
	aloneMs: number;
	savedMs: number;
	/** Back-to-back CI time to land them one at a time. */
	aloneWallMs: number;
	/** Part of `spentMs` that didn't land anything by itself. */
	overhead: { bisectMs: number; rerunMs: number; wastedMs: number; baselineMs: number };
}

export interface SavingsView {
	/** Typical CI time of one run, and how many runs it is measured from; null before any. */
	perRun: { jobMs: number; wallMs: number; samples: number; single: boolean } | null;
	windows: Savings[];
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const DAY = 24 * 60 * 60_000;
export const WINDOWS = [
	{ key: '24h', label: 'Last 24 hours', ms: DAY },
	{ key: '7d', label: 'Last 7 days', ms: 7 * DAY },
	{ key: '30d', label: 'Last 30 days', ms: 30 * DAY },
	{ key: 'all', label: 'All time', ms: Infinity }
];

const wasted = (r: RunSample) => r.status === 'superseded' || r.status === 'cancelled';

/**
 * What a PR's CI costs on its own is the typical run on this repo: CI runs the same suite
 * whatever a run holds. Runs of one PR measure it best; with too few of them, every run that
 * ran to the end counts.
 */
export function computeSavings(runs: RunSample[], landings: Landing[], now: number): SavingsView {
	const complete = runs.filter((r) => !wasted(r) && r.jobMs > 0);
	const singles = complete.filter((r) => r.prs === 1);
	const sample = singles.length >= 3 ? singles : complete;
	// A run's own cost, without the re-runs of its flaky jobs: a PR alone would have those too, but
	// they are counted as overhead here, so the comparison doesn't flatter batching.
	const perRun = sample.length
		? { jobMs: median(sample.map((r) => r.jobMs - r.rerunMs)), wallMs: median(sample.map((r) => r.wallMs)), samples: sample.length, single: sample === singles }
		: null;
	const windows = WINDOWS.map((w) => {
		const since = now - w.ms;
		const rs = runs.filter((r) => r.atMs >= since);
		const landed = landings.filter((l) => l.atMs >= since).reduce((n, l) => n + l.prs, 0);
		const spentMs = rs.reduce((n, r) => n + r.jobMs, 0);
		const aloneMs = perRun ? landed * perRun.jobMs : 0;
		const sum = (f: (r: RunSample) => boolean, v: (r: RunSample) => number = (r) => r.jobMs) => rs.filter(f).reduce((n, r) => n + v(r), 0);
		return {
			key: w.key,
			label: w.label,
			landed,
			runs: rs.length,
			spentMs,
			aloneMs,
			savedMs: aloneMs - spentMs,
			aloneWallMs: perRun ? landed * perRun.wallMs : 0,
			overhead: {
				bisectMs: sum((r) => r.kind === 'bisect' && !wasted(r), (r) => r.jobMs - r.rerunMs),
				rerunMs: sum((r) => !wasted(r), (r) => r.rerunMs),
				wastedMs: sum(wasted),
				baselineMs: sum((r) => (r.kind === 'baseline' || r.kind === 'try') && !wasted(r), (r) => r.jobMs - r.rerunMs)
			}
		};
	});
	return { perRun, windows };
}

/** PRs a top-level batch landed: all of them, or those its bisection landed. */
export function landedBy(b: Pick<BatchRow, 'kind' | 'status' | 'members' | 'landed'>): number {
	if (b.kind !== 'batch') return 0;
	if (b.landed.length) return b.landed.length;
	return b.status === 'landed' ? b.members.length : 0;
}

/** The savings view of a repository, from what is stored (no GitHub calls). */
export function savingsFor(repoId: number, now = Date.now()): SavingsView {
	const rows = getDb()
		.prepare(
			`SELECT b.kind, b.status, b.members, b.context, b.created_at, c.job_ms, c.rerun_ms, c.wall_ms
			 FROM ci_runs c JOIN batches b ON b.id = c.batch_id WHERE c.repo_id = ?`
		)
		.all(repoId) as Array<{ kind: BatchRow['kind']; status: BatchRow['status']; members: string; context: string; created_at: string; job_ms: number; rerun_ms: number; wall_ms: number }>;
	const runs: RunSample[] = rows.map((r) => ({
		kind: r.kind,
		status: r.status,
		prs: (JSON.parse(r.members) as number[]).length + (JSON.parse(r.context) as number[]).length,
		atMs: toMs(r.created_at),
		jobMs: r.job_ms,
		rerunMs: r.rerun_ms,
		wallMs: r.wall_ms
	}));
	const landings = (
		getDb()
			.prepare(`SELECT kind, status, members, landed, created_at, finished_at FROM batches WHERE repo_id = ? AND kind = 'batch' AND (status = 'landed' OR landed != '[]')`)
			.all(repoId) as Array<{ kind: 'batch'; status: BatchRow['status']; members: string; landed: string; created_at: string; finished_at: string | null }>
	).map((b) => ({
		atMs: toMs(b.finished_at ?? b.created_at),
		prs: landedBy({ kind: b.kind, status: b.status, members: JSON.parse(b.members), landed: JSON.parse(b.landed) })
	}));
	return computeSavings(runs, landings, now);
}
