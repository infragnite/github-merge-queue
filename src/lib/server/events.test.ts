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

	test('times out empty, keeping the cursor', async () => {
		const r = repo();
		const got = await waitForEvents(r, { after: 0, waitMs: 50 });
		expect(got).toEqual({ events: [], cursor: 0 });
	});
});
