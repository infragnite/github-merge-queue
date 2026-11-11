import { beforeAll, describe, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');
const store = await import('./batch-store');

describe('what a batch keeps for later analysis', () => {
	let repoId: number;
	beforeAll(() => {
		const user = db.upsertUser(1, 'dev', null, null);
		db.addRepo('acme', 'repo', 'main', user);
		repoId = db.getRepoByOwnerName('acme', 'repo')!.id;
	});
	const insert = () => store.insertBatch({ repoId, kind: 'batch', branch: `mq/b-${Math.random()}`, baseSha: 'b', headSha: 'h', treeSha: 't', baseTree: 'bt', members: [1], heads: {} });

	test('the mode and config it was planned with', () => {
		store.updateQueueSettings(repoId, { mode: 'batch', config: { maxBatch: 7 } });
		const b = insert();
		expect(b.settings).toEqual({ mode: 'batch', config: store.getQueueSettings(repoId).config });
		store.updateQueueSettings(repoId, { config: { maxBatch: 3 } });
		expect(store.getBatch(b.id)!.settings?.config.maxBatch).toBe(7);
	});

	test('when its CI result came in, and how often failed jobs were re-run', () => {
		const b = insert();
		expect(b).toMatchObject({ ci_done_at: null, retries: 0, end_reason: null });
		store.setBatchCI(b.id, 'failure');
		const first = store.getBatch(b.id)!.ci_done_at;
		expect(first).not.toBeNull();
		store.setBatchRetried(b.id, Date.now());
		store.setBatchRetried(b.id, Date.now());
		expect(store.getBatch(b.id)).toMatchObject({ retries: 2, ci_result: 'pending' });
		store.setBatchCI(b.id, 'pending');
		expect(store.getBatch(b.id)!.ci_done_at).toBe(first);
	});

	test('why it ended, when it ended early; a later status without a reason keeps it', () => {
		const b = insert();
		store.setBatchStatus(b.id, 'superseded', 'master-moved');
		expect(store.getBatch(b.id)).toMatchObject({ status: 'superseded', end_reason: 'master-moved' });
		store.setBatchStatus(b.id, 'superseded');
		expect(store.getBatch(b.id)!.end_reason).toBe('master-moved');
	});

	test('rows from before it was recorded read as unknown', () => {
		const b = insert();
		db.getDb().prepare('UPDATE batches SET settings = NULL WHERE id = ?').run(b.id);
		expect(store.getBatch(b.id)!.settings).toBeNull();
	});
});
