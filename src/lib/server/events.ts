// Queue events for agents: stored in sqlite (so an agent that wasn't
// listening still gets them on its next call) and pushed to long-poll
// waiters in this process.

import { EventEmitter } from 'node:events';
import { getDb } from './db';

export type QueueEventKind =
	| 'queued'
	| 'dequeued'
	| 'batched'
	| 'rebased'
	| 'conflict'
	| 'deferred'
	| 'held'
	| 'released'
	| 'ejected'
	| 'requeued'
	| 'changed'
	| 'master-broken'
	| 'master-green'
	| 'merged'
	| 'tried'
	| 'paused'
	| 'resumed'
	| 'mode'
	| 'priority'
	| 'settings'
	| 'cancelled'
	| 'hung';

export interface QueueEvent {
	id: number;
	pr: number | null;
	kind: QueueEventKind;
	data: Record<string, unknown>;
	at: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

// Kept long enough to analyse the queue's history later (wait times, holds, ejections, pauses).
const KEEP_DAYS = 400;
let inserts = 0;

export function emitEvent(repoId: number, pr: number | null, kind: QueueEventKind, data: Record<string, unknown> = {}) {
	const db = getDb();
	db.prepare('INSERT INTO queue_events (repo_id, pr_number, kind, data) VALUES (?, ?, ?, ?)').run(
		repoId,
		pr,
		kind,
		JSON.stringify(data)
	);
	if (++inserts % 500 === 0) {
		db.prepare(`DELETE FROM queue_events WHERE created_at < datetime('now', ?)`).run(`-${KEEP_DAYS} days`);
	}
	bus.emit(`repo:${repoId}`);
}

type Row = { id: number; pr_number: number | null; kind: QueueEventKind; data: string; created_at: string };

export function listEvents(repoId: number, opts: { after?: number | null; pr?: number | null; limit?: number }): QueueEvent[] {
	const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
	const prFilter = opts.pr != null ? 'AND pr_number = ?' : '';
	const args: unknown[] = [repoId];
	let rows: Row[];
	if (opts.after == null) {
		// No cursor yet: the most recent events, oldest first.
		if (opts.pr != null) args.push(opts.pr);
		rows = (
			getDb()
				.prepare(`SELECT * FROM queue_events WHERE repo_id = ? ${prFilter} ORDER BY id DESC LIMIT ?`)
				.all(...args, Math.min(limit, 20)) as Row[]
		).reverse();
	} else {
		args.push(opts.after);
		if (opts.pr != null) args.push(opts.pr);
		rows = getDb()
			.prepare(`SELECT * FROM queue_events WHERE repo_id = ? AND id > ? ${prFilter} ORDER BY id LIMIT ?`)
			.all(...args, limit) as Row[];
	}
	return rows.map((r) => ({
		id: r.id,
		pr: r.pr_number,
		kind: r.kind,
		data: JSON.parse(r.data),
		at: r.created_at.includes('T') ? r.created_at : `${r.created_at.replace(' ', 'T')}Z`
	}));
}

/** PRs whose agent was last told they need attention (`held`), and not released since. */
export function heldPRs(repoId: number): number[] {
	const rows = getDb()
		.prepare(
			`SELECT pr_number, kind FROM queue_events e WHERE repo_id = ? AND kind IN ('held', 'released') AND pr_number IS NOT NULL
			 AND id = (SELECT MAX(id) FROM queue_events f WHERE f.repo_id = e.repo_id AND f.pr_number = e.pr_number AND f.kind IN ('held', 'released'))`
		)
		.all(repoId) as Array<{ pr_number: number; kind: string }>;
	return rows.filter((r) => r.kind === 'held').map((r) => r.pr_number);
}

/** The kind of the PR's newest event among `kinds`; null when it has none (events are kept about a year). */
export function lastEventOf(repoId: number, pr: number, kinds: QueueEventKind[]): { kind: QueueEventKind; data: Record<string, unknown> } | null {
	const r = getDb()
		.prepare(`SELECT kind, data FROM queue_events WHERE repo_id = ? AND pr_number = ? AND kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 1`)
		.get(repoId, pr, ...kinds) as { kind: QueueEventKind; data: string } | undefined;
	return r ? { kind: r.kind, data: JSON.parse(r.data) } : null;
}

/** The newest event id for a repo (the cursor to start from when there are no events yet). */
export function latestEventId(repoId: number): number {
	const r = getDb().prepare('SELECT MAX(id) AS id FROM queue_events WHERE repo_id = ?').get(repoId) as { id: number | null };
	return r.id ?? 0;
}

export const MAX_WAIT_MS = 60_000;

/**
 * Events after `after`, waiting up to `waitMs` for the first one to arrive.
 * Returns the events and the cursor for the next call.
 */
export async function waitForEvents(
	repoId: number,
	opts: { after?: number | null; pr?: number | null; waitMs?: number; signal?: AbortSignal }
): Promise<{ events: QueueEvent[]; cursor: number }> {
	const wait = Math.min(Math.max(opts.waitMs ?? 0, 0), MAX_WAIT_MS);
	const read = () => {
		const events = listEvents(repoId, opts);
		const cursor = events.length ? events[events.length - 1].id : Math.max(opts.after ?? 0, latestEventId(repoId));
		return { events, cursor };
	};
	let r = read();
	// Without a cursor the caller gets recent history and a cursor right away.
	if (r.events.length || opts.after == null || wait === 0 || opts.signal?.aborted) return r;
	const deadline = Date.now() + wait;
	while (!r.events.length && Date.now() < deadline && !opts.signal?.aborted) {
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				bus.off(`repo:${repoId}`, done);
				opts.signal?.removeEventListener('abort', done);
				resolve();
			};
			const timer = setTimeout(done, deadline - Date.now());
			bus.on(`repo:${repoId}`, done);
			opts.signal?.addEventListener('abort', done);
		});
		r = read();
	}
	return r;
}
