import { beforeAll, describe, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');
const store = await import('./batch-store');
const { jobCost, computeSavings, recordRunCosts, savingsFor, landedBy } = await import('./ci-savings');

const MIN = 60_000;
const t = (min: number) => new Date(Date.UTC(2026, 10, 10, 0, min)).toISOString();

describe('jobCost', () => {
	test('sums every attempt, counts the earlier attempts of a job as re-runs', () => {
		const c = jobCost([
			{ name: 'test', status: 'completed', started_at: t(0), completed_at: t(10) },
			{ name: 'test', status: 'completed', started_at: t(12), completed_at: t(20) },
			{ name: 'lint', status: 'completed', started_at: t(0), completed_at: t(2) }
		]);
		expect(c).toEqual({ jobMs: 20 * MIN, rerunMs: 10 * MIN, wallMs: 20 * MIN, jobs: 3, done: true });
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
