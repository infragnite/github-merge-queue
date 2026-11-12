import { beforeAll, describe, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');
const store = await import('./batch-store');
const { jobCost, computeSavings, recordRunCosts, savingsFor, landedBy, actionsJobsFor } = await import('./ci-savings');

const MIN = 60_000;
const t = (min: number) => new Date(Date.UTC(2026, 10, 10, 0, min)).toISOString();

describe('jobCost', () => {
	test('sums every attempt, counts the earlier attempts of a job as re-runs', () => {
		const c = jobCost([
			{ name: 'test', status: 'completed', started_at: t(0), completed_at: t(10) },
			{ name: 'test', status: 'completed', started_at: t(12), completed_at: t(20) },
			{ name: 'lint', status: 'completed', started_at: t(0), completed_at: t(2) }
		]);
		expect(c).toMatchObject({ jobMs: 20 * MIN, rerunMs: 10 * MIN, wallMs: 20 * MIN, jobs: 3, done: true });
	});

	test('when it ran, how long its jobs waited for a runner, and how many attempts it took', () => {
		const c = jobCost([
			{ id: 1, run_id: 9, run_attempt: 1, name: 'test', status: 'completed', conclusion: 'failure', created_at: t(0), started_at: t(2), completed_at: t(10) },
			{ id: 2, run_id: 9, run_attempt: 2, name: 'test', status: 'completed', conclusion: 'success', created_at: t(11), started_at: t(12), completed_at: t(20) },
			{ id: 3, run_id: 9, run_attempt: 1, name: 'lint', status: 'completed', conclusion: 'success', created_at: t(0), started_at: t(3), completed_at: t(4) }
		]);
		expect(c).toMatchObject({ queueMs: 6 * MIN, startMs: Date.parse(t(2)), endMs: Date.parse(t(20)), attempts: 2 });
	});

	test('jobs without a queue time or attempt (check runs) count as one attempt with no wait', () => {
		const c = jobCost([{ name: 'x', status: 'completed', started_at: t(0), completed_at: t(1) }]);
		expect(c).toMatchObject({ queueMs: 0, attempts: 1, startMs: Date.parse(t(0)), endMs: Date.parse(t(1)) });
		expect(jobCost([])).toMatchObject({ startMs: null, endMs: null });
	});

	test('a job still running means the run is not done', () => {
		expect(jobCost([{ name: 'x', status: 'in_progress', started_at: t(0), completed_at: null }]).done).toBe(false);
		expect(jobCost([]).done).toBe(false);
	});
});

describe('computeSavings', () => {
	const now = Date.UTC(2026, 10, 10, 12);
	const run = (o: Partial<Parameters<typeof computeSavings>[0][number]>) => ({ kind: 'batch' as const, status: 'landed' as const, prs: 4, atMs: now - 60 * MIN, jobMs: 30 * MIN, rerunMs: 0, wallMs: 10 * MIN, ...o });

	test('landed PRs times a typical run, minus what the runs took', () => {
		const v = computeSavings([run({}), run({}), run({ kind: 'bisect', status: 'failed', prs: 2 }), run({ status: 'superseded', jobMs: 5 * MIN })], [{ atMs: now - 30 * MIN, prs: 8 }], now);
		expect(v.perRun).toMatchObject({ jobMs: 30 * MIN, wallMs: 10 * MIN, samples: 3, single: false });
		const day = v.windows.find((w) => w.key === '24h')!;
		expect(day.landed).toBe(8);
		expect(day.aloneMs).toBe(8 * 30 * MIN);
		expect(day.spentMs).toBe(95 * MIN);
		expect(day.savedMs).toBe(240 * MIN - 95 * MIN);
		expect(day.aloneWallMs).toBe(80 * MIN);
		expect(day.overhead).toEqual({ bisectMs: 30 * MIN, rerunMs: 0, wastedMs: 5 * MIN, baselineMs: 0 });
	});

	test('runs of one PR measure the per-PR cost once there are a few; re-runs are left out of it', () => {
		const singles = [1, 2, 3].map(() => run({ kind: 'try', prs: 1, jobMs: 14 * MIN, rerunMs: 4 * MIN }));
		const v = computeSavings([run({ jobMs: 40 * MIN }), ...singles], [], now);
		expect(v.perRun).toMatchObject({ jobMs: 10 * MIN, samples: 3, single: true });
	});

	test('windows only count what happened in them', () => {
		const v = computeSavings([run({ atMs: now - 3 * 24 * 60 * MIN })], [{ atMs: now - 3 * 24 * 60 * MIN, prs: 5 }], now);
		expect(v.windows.find((w) => w.key === '24h')).toMatchObject({ landed: 0, runs: 0, savedMs: 0 });
		expect(v.windows.find((w) => w.key === '7d')).toMatchObject({ landed: 5, runs: 1, savedMs: 5 * 30 * MIN - 30 * MIN });
	});

	test('nothing measured yet', () => {
		expect(computeSavings([], [{ atMs: now, prs: 3 }], now).perRun).toBeNull();
	});
});

test('landedBy: all members of a landed batch, or what its bisection landed', () => {
	expect(landedBy({ kind: 'batch', status: 'landed', members: [1, 2, 3], landed: [] })).toBe(3);
	expect(landedBy({ kind: 'batch', status: 'failed', members: [1, 2, 3], landed: [1] })).toBe(1);
	expect(landedBy({ kind: 'try', status: 'landed', members: [1], landed: [] })).toBe(0);
});

describe('recording', () => {
	let repoId: number;
	beforeAll(() => {
		const user = db.upsertUser(1, 'dev', null, null);
		db.addRepo('acme', 'repo', 'main', user);
		repoId = db.getRepoByOwnerName('acme', 'repo')!.id;
	});

	const batch = (head: string, members: number[]) =>
		store.insertBatch({ repoId, kind: 'batch', branch: `mq/batch-${head}`, baseSha: 'b', headSha: head, treeSha: 't', baseTree: 'bt', members, heads: {} });

	test('records runs once their jobs are done, and only once', async () => {
		const a = batch('aaa', [1, 2]);
		store.setBatchCI(a.id, 'success');
		store.setBatchStatus(a.id, 'landed');
		const running = batch('bbb', [3]);
		const done = batch('ccc', [4]);
		store.setBatchCI(done.id, 'failure');
		store.setBatchStatus(done.id, 'failed');
		const calls: string[] = [];
		const jobs = async (sha: string) => {
			calls.push(sha);
			return sha === 'ccc'
				? [{ name: 'ci', status: 'in_progress', started_at: t(0), completed_at: null }]
				: [{ name: 'ci', status: 'completed', started_at: t(0), completed_at: t(20) }];
		};
		expect(await recordRunCosts({ id: repoId }, jobs)).toBe(1);
		// 'bbb' is still testing: not asked about. 'ccc' just finished with a job still going: asked, not recorded.
		expect(calls).toEqual(['aaa', 'ccc']);
		calls.length = 0;
		await recordRunCosts({ id: repoId }, jobs);
		expect(calls).toEqual(['ccc']);
		void running;

		const v = savingsFor(repoId);
		expect(v.perRun?.jobMs).toBe(20 * MIN);
		expect(v.windows.find((w) => w.key === 'all')).toMatchObject({ landed: 2, runs: 1, savedMs: 20 * MIN });
	});
});

test('every job attempt of a run is kept, with its runner wait, so CI can be analysed by job later', async () => {
	const user = db.upsertUser(4, 'dev4', null, null);
	db.addRepo('acme', 'jobs', 'main', user);
	const id = db.getRepoByOwnerName('acme', 'jobs')!.id;
	const b = store.insertBatch({ repoId: id, kind: 'batch', branch: 'mq/j', baseSha: 'b', headSha: 'jjj', treeSha: 't', baseTree: 'bt', members: [1, 2], heads: {} });
	store.setBatchCI(b.id, 'success');
	store.setBatchStatus(b.id, 'landed');
	const jobs = [
		{ id: 11, run_id: 7, run_attempt: 1, workflow_name: 'ci', runner_name: 'r-1', name: 'test', status: 'completed', conclusion: 'failure', created_at: t(0), started_at: t(2), completed_at: t(10) },
		{ id: 12, run_id: 7, run_attempt: 2, workflow_name: 'ci', runner_name: 'r-2', name: 'test', status: 'completed', conclusion: 'success', created_at: t(11), started_at: t(12), completed_at: t(20) }
	];
	expect(await recordRunCosts({ id }, async () => jobs)).toBe(1);
	expect(db.getDb().prepare('SELECT job_ms, rerun_ms, wall_ms, jobs, queue_ms, started_ms, ended_ms, attempts FROM ci_runs WHERE batch_id = ?').get(b.id)).toEqual({
		job_ms: 16 * MIN,
		rerun_ms: 8 * MIN,
		wall_ms: 18 * MIN,
		jobs: 2,
		queue_ms: 3 * MIN,
		started_ms: Date.parse(t(2)),
		ended_ms: Date.parse(t(20)),
		attempts: 2
	});
	expect(db.getDb().prepare('SELECT job_id, run_id, attempt, workflow, name, conclusion, runner, created_ms, started_ms, completed_ms FROM ci_jobs WHERE batch_id = ? ORDER BY job_id').all(b.id)).toEqual([
		{ job_id: 11, run_id: 7, attempt: 1, workflow: 'ci', name: 'test', conclusion: 'failure', runner: 'r-1', created_ms: Date.parse(t(0)), started_ms: Date.parse(t(2)), completed_ms: Date.parse(t(10)) },
		{ job_id: 12, run_id: 7, attempt: 2, workflow: 'ci', name: 'test', conclusion: 'success', runner: 'r-2', created_ms: Date.parse(t(11)), started_ms: Date.parse(t(12)), completed_ms: Date.parse(t(20)) }
	]);
});

test('actionsJobsFor: every attempt of every workflow run on the commit, page by page', async () => {
	const job = (id: number) => ({ id, run_id: 0, run_attempt: 1, name: `j${id}`, status: 'completed', conclusion: 'success', created_at: t(0), started_at: t(1), completed_at: t(2) });
	const asked: string[] = [];
	const get = async (path: string) => {
		asked.push(path);
		if (path.startsWith('/repos/o/r/actions/runs?')) return { workflow_runs: [{ id: 1 }, { id: 2 }] };
		if (path.includes('/runs/1/jobs') && path.endsWith('page=1')) return { jobs: Array.from({ length: 100 }, (_, i) => job(i)) };
		if (path.includes('/runs/1/jobs')) return { jobs: [job(100)] };
		return { jobs: [job(200)] };
	};
	const jobs = await actionsJobsFor(get, 'o', 'r', 'abc', 'mq/batch-1');
	expect(jobs.map((j) => j.id)).toEqual([...Array.from({ length: 101 }, (_, i) => i), 200]);
	expect(asked).toEqual([
		'/repos/o/r/actions/runs?head_sha=abc&branch=mq%2Fbatch-1&per_page=100',
		'/repos/o/r/actions/runs/1/jobs?filter=all&per_page=100&page=1',
		'/repos/o/r/actions/runs/1/jobs?filter=all&per_page=100&page=2',
		'/repos/o/r/actions/runs/2/jobs?filter=all&per_page=100&page=1'
	]);
});

test('a run over long ago with no jobs is recorded empty, so it cannot hold up the rest', async () => {
	const user = db.upsertUser(3, 'dev3', null, null);
	db.addRepo('acme', 'stale', 'main', user);
	const id = db.getRepoByOwnerName('acme', 'stale')!.id;
	const old = store.insertBatch({ repoId: id, kind: 'bisect', branch: 'mq/b', baseSha: 'b', headSha: 'old', treeSha: 't', baseTree: 'bt', members: [1], heads: {} });
	store.setBatchCI(old.id, 'success');
	db.getDb().prepare(`UPDATE batches SET status = 'passed', created_at = datetime('now', '-2 hours') WHERE id = ?`).run(old.id);
	expect(await recordRunCosts({ id }, async () => [])).toBe(1);
	expect(db.getDb().prepare('SELECT job_ms FROM ci_runs WHERE batch_id = ?').get(old.id)).toEqual({ job_ms: 0 });
});

test('the call budget counts GitHub calls, not runs: a commit with several workflow runs spends more of it', async () => {
	const user = db.upsertUser(5, 'dev5', null, null);
	db.addRepo('acme', 'budget', 'main', user);
	const id = db.getRepoByOwnerName('acme', 'budget')!.id;
	for (const h of ['b1', 'b2', 'b3', 'b4']) {
		const b = store.insertBatch({ repoId: id, kind: 'batch', branch: `mq/${h}`, baseSha: 'b', headSha: h, treeSha: 't', baseTree: 'bt', members: [1], heads: {} });
		store.setBatchCI(b.id, 'success');
		store.setBatchStatus(b.id, 'landed');
	}
	const asked: string[] = [];
	// One call for the commit's runs, then one per run: three calls a commit.
	const jobsFor = async (sha: string, spend: () => void) => {
		asked.push(sha);
		spend();
		spend();
		spend();
		return [{ name: 'ci', status: 'completed', started_at: t(0), completed_at: t(5) }];
	};
	expect(await recordRunCosts({ id }, jobsFor, Date.now(), 4)).toBe(2);
	expect(asked).toEqual(['b1', 'b2']);
});

test('only the runs on the batch\'s own branch count: a push of the same commit to master runs CI that the batch did not cause', async () => {
	const user = db.upsertUser(7, 'dev7', null, null);
	db.addRepo('acme', 'branch', 'main', user);
	const id = db.getRepoByOwnerName('acme', 'branch')!.id;
	const b = store.insertBatch({ repoId: id, kind: 'batch', branch: 'mq/batch-77', baseSha: 'b', headSha: 'ff', treeSha: 't', baseTree: 'bt', members: [1], heads: {} });
	store.setBatchCI(b.id, 'success');
	store.setBatchStatus(b.id, 'landed');
	const asked: Array<[string, string]> = [];
	await recordRunCosts({ id }, async (sha, _spend, branch) => {
		asked.push([sha, branch]);
		return [];
	});
	expect(asked).toEqual([['ff', 'mq/batch-77']]);
});

test('a run another batch row already owns (a landing on a passed try, same commit) is not counted twice', async () => {
	const user = db.upsertUser(6, 'dev6', null, null);
	db.addRepo('acme', 'reuse', 'main', user);
	const id = db.getRepoByOwnerName('acme', 'reuse')!.id;
	const tryRun = store.insertBatch({ repoId: id, kind: 'try', branch: 'mq/try-9', baseSha: 'b', headSha: 'same', treeSha: 't', baseTree: 'bt', members: [9], heads: {} });
	store.setBatchCI(tryRun.id, 'success');
	store.setBatchStatus(tryRun.id, 'landed');
	const landing = store.insertBatch({ repoId: id, kind: 'batch', branch: 'mq/try-9', baseSha: 'b', headSha: 'same', treeSha: 't', baseTree: 'bt', members: [9], heads: {}, passed: true });
	store.setBatchStatus(landing.id, 'landed');
	const asked: string[] = [];
	const jobs = async (sha: string) => {
		asked.push(sha);
		return [{ id: 31, run_id: 3, run_attempt: 1, name: 'ci', status: 'completed', conclusion: 'success', created_at: t(0), started_at: t(1), completed_at: t(11) }];
	};
	expect(await recordRunCosts({ id }, jobs)).toBe(2);
	expect(asked).toEqual(['same']);
	const run = (b: number) => db.getDb().prepare('SELECT job_ms, jobs FROM ci_runs WHERE batch_id = ?').get(b);
	expect(run(tryRun.id)).toEqual({ job_ms: 10 * MIN, jobs: 1 });
	expect(run(landing.id)).toEqual({ job_ms: 0, jobs: 0 });
	expect(db.getDb().prepare('SELECT batch_id FROM ci_jobs WHERE job_id = 31').get()).toEqual({ batch_id: tryRun.id });
});

describe('public view setting', () => {
	test('is off by default and kept apart from the batch config', async () => {
		const user = db.upsertUser(2, 'dev2', null, null);
		db.addRepo('acme', 'other', 'main', user);
		const id = db.getRepoByOwnerName('acme', 'other')!.id;
		expect(store.getQueueSettings(id).publicView).toBe(false);
		store.updateQueueSettings(id, { publicView: true });
		store.updateQueueSettings(id, { mode: 'batch' });
		expect(store.getQueueSettings(id)).toMatchObject({ mode: 'batch', publicView: true });
	});
});
