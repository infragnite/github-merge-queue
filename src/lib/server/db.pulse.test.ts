import { beforeAll, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');

let repoId: number;

beforeAll(() => {
	const user = db.upsertUser(1, 'dev', null, null);
	db.addRepo('acme', 'repo', 'main', user);
	repoId = db.getRepoByOwnerName('acme', 'repo')!.id;
});

test('the pulse is the last merge and the merges of the last day, failures left out', () => {
	expect(db.getRepoPulse(repoId)).toEqual({ lastLanded: null, landed24h: 0 });
	const at = (n: number, status: string, when: string) => {
		db.addToHistory(repoId, n, `PR ${n}`, `u${n}`, 'a', null, status, null, null);
		db.getDb().prepare(`UPDATE merge_history SET completed_at = datetime('now', ?) WHERE pr_number = ?`).run(when, n);
	};
	at(1, 'merged', '-2 days');
	at(2, 'merged', '-3 hours');
	at(3, 'merged', '-1 hours');
	at(4, 'failed', '-5 minutes');
	const pulse = db.getRepoPulse(repoId);
	expect(pulse.landed24h).toBe(2);
	expect(pulse.lastLanded?.pr).toBe(3);
	expect(pulse.lastLanded?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('work on a PR starts when it leaves the line, with or without an update first', () => {
	const id = Number(db.addToQueue(repoId, 50, 't', 'u', 'a', '', 'dev').lastInsertRowid);
	const started = () => (db.getDb().prepare('SELECT started_at FROM queue_items WHERE id = ?').get(id) as { started_at: string | null }).started_at;
	expect(started()).toBeNull();
	db.updateQueueItemStatus(id, 'checking');
	const first = started();
	expect(first).not.toBeNull();
	db.getDb().prepare(`UPDATE queue_items SET started_at = datetime('now', '-1 hour') WHERE id = ?`).run(id);
	db.updateQueueItemStatus(id, 'merging');
	expect(started()).not.toBe(first); // still the hour-old start: merging continues the same work
	db.updateQueueItemStatus(id, 'queued');
	db.updateQueueItemStatus(id, 'checking');
	expect(Date.parse(started()!.replace(' ', 'T') + 'Z')).toBeGreaterThan(Date.now() - 60_000);
});
