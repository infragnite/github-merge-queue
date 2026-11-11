import { describe, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');
const { emitEvent, waitForEvents } = await import('./events');

function repo() {
	const user = db.upsertUser(1, 'dev', null, null);
	const name = `ev${Math.random().toString(36).slice(2)}`;
	db.addRepo('acme', name, 'main', user);
	return db.getRepoByOwnerName('acme', name)!.id;
}

describe('queue events', () => {
	test('without a cursor: recent events and a cursor, right away', async () => {
		const r = repo();
		emitEvent(r, 1, 'queued');
		const first = await waitForEvents(r, { waitMs: 10_000 });
		expect(first.events.map((e) => e.kind)).toEqual(['queued']);
		expect(first.cursor).toBe(first.events[0].id);
	});

	test('a long poll returns as soon as an event arrives, filtered by PR', async () => {
		const r = repo();
		const { cursor } = await waitForEvents(r, {});
		const started = Date.now();
		const wait = waitForEvents(r, { after: cursor, pr: 2, waitMs: 5000 });
		setTimeout(() => emitEvent(r, 1, 'queued'), 20);
		setTimeout(() => emitEvent(r, 2, 'conflict', { files: ['a'] }), 60);
		const got = await wait;
		expect(got.events).toMatchObject([{ pr: 2, kind: 'conflict', data: { files: ['a'] } }]);
		expect(Date.now() - started).toBeLessThan(2000);
		// nothing is lost: the next call from the new cursor sees only later events
		expect((await waitForEvents(r, { after: got.cursor, pr: 2 })).events).toEqual([]);
	});

	test('history is kept for about a year, not a week, so it can be analysed later', () => {
		const r = repo();
		const at = (days: number) =>
			db.getDb().prepare(`INSERT INTO queue_events (repo_id, pr_number, kind, created_at) VALUES (?, 1, 'queued', datetime('now', ?))`).run(r, `-${days} days`);
		at(30);
		at(300);
		at(500);
		// pruning runs every few hundred events
		for (let i = 0; i < 500; i++) emitEvent(r, 2, 'queued');
		const ages = db
			.getDb()
			.prepare(`SELECT CAST(round(julianday('now') - julianday(created_at)) AS INTEGER) AS days FROM queue_events WHERE repo_id = ? AND pr_number = 1 ORDER BY id`)
			.all(r) as Array<{ days: number }>;
		expect(ages.map((a) => a.days)).toEqual([30, 300]);
	});

	test('times out empty, keeping the cursor', async () => {
		const r = repo();
		const got = await waitForEvents(r, { after: 0, waitMs: 50 });
		expect(got).toEqual({ events: [], cursor: 0 });
	});
});
