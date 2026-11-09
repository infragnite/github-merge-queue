// Storage for batches, bisection runs, queue priority and per-repo queue
// settings. Tables are created by `migrateBatches`, called from db.ts.

import type Database from 'better-sqlite3';
import { getDb } from './db';
import { DEFAULT_BATCH_CONFIG, type BatchConfig, type Priority } from './batching';

export type QueueMode = 'serial' | 'batch';

export type BatchStatus =
	/** Built and pushed; CI running. */
	| 'testing'
	/** Failed once; failed jobs re-running to rule out a flake. */
	| 'retrying'
	/** Failed twice; bisection running. */
	| 'bisecting'
	/** CI passed; waiting for the batches in front of it to land. */
	| 'passed'
	| 'landed'
	| 'failed'
	/** Rebuilt because a batch in front of it failed or master moved. */
	| 'superseded'
	| 'cancelled';

export interface BatchRow {
	id: number;
	repo_id: number;
	/** A batch in the pipeline, a bisection run of one, or a one-off `try` run of a single PR. */
	kind: 'batch' | 'bisect' | 'try';
	parent_batch_id: number | null;
	branch: string;
	base_sha: string;
	head_sha: string;
	tree_sha: string;
	/** Tree of `base_sha`; master is compared by tree because landing re-creates the commits. */
	base_tree: string;
	/** Head SHA of each PR when the batch was built. */
	heads: Record<number, string>;
	/**
	 * Per PR, as built: the batch commit after its squash (`sha`) and that commit's tree, which is
	 * what master must hold after landing it; for a stacked child, `fork` is the parent commit its
	 * own work starts after (it is restacked onto master from there at landing).
	 */
	steps: Record<number, BatchStep>;
	/** PRs tested in this commit beyond `context`, in order. */
	members: number[];
	/** PRs applied below `members` that are already known to pass (bisection only). */
	context: number[];
	status: BatchStatus;
	express: boolean;
	ci_result: 'pending' | 'success' | 'failure';
	created_at: string;
	finished_at: string | null;
}

export interface BatchStep {
	sha: string;
	tree: string;
	fork: string | null;
}

export interface CISettings {
	/** Workflow file the queue dispatches on batch branches. */
	workflow: string;
	/** The check run that decides a batch, e.g. krusty's `ci-and-conformance`. */
	requiredCheck: string;
	/** Commit status the queue sets on master when its tree was already tested. */
	testedStatus: string;
	/** Commit status the queue keeps on each queued PR's head; make it the one required check on the default branch. */
	prStatus: string;
	/** Ref the cache-refresh run is dispatched on; empty means the default branch. */
	dispatchRef: string;
}

export const DEFAULT_CI: CISettings = {
	workflow: 'ci.yml',
	requiredCheck: 'ci',
	testedStatus: 'merge-queue/tested',
	prStatus: 'merge-queue',
	dispatchRef: ''
};

export interface RepoQueueSettings {
	mode: QueueMode;
	config: BatchConfig;
	ci: CISettings;
	pausedReason: string | null;
}

export function migrateBatches(database: Database.Database) {
	database.exec(`
		CREATE TABLE IF NOT EXISTS queue_settings (
			repo_id INTEGER PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
			mode TEXT NOT NULL DEFAULT 'serial',
			config TEXT NOT NULL DEFAULT '{}',
			ci TEXT NOT NULL DEFAULT '{}',
			paused_reason TEXT
		);

		CREATE TABLE IF NOT EXISTS batches (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
			kind TEXT NOT NULL DEFAULT 'batch',
			parent_batch_id INTEGER REFERENCES batches(id) ON DELETE CASCADE,
			branch TEXT NOT NULL,
			base_sha TEXT NOT NULL,
			head_sha TEXT NOT NULL,
			tree_sha TEXT NOT NULL,
			base_tree TEXT NOT NULL,
			members TEXT NOT NULL,
			heads TEXT NOT NULL DEFAULT '{}',
			steps TEXT NOT NULL DEFAULT '{}',
			context TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'testing',
			express INTEGER NOT NULL DEFAULT 0,
			ci_result TEXT NOT NULL DEFAULT 'pending',
			created_at TEXT DEFAULT (datetime('now')),
			finished_at TEXT
		);
		CREATE INDEX IF NOT EXISTS batches_repo_status ON batches(repo_id, status);

		-- Heads the queue produced by restacking a PR, so the approval and CI of
		-- the head it replaced carry over (the change itself is the same).
		CREATE TABLE IF NOT EXISTS rebased_heads (
			repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
			pr_number INTEGER NOT NULL,
			from_sha TEXT NOT NULL,
			to_sha TEXT NOT NULL,
			ci_green INTEGER,
			created_at TEXT DEFAULT (datetime('now')),
			PRIMARY KEY (repo_id, pr_number, to_sha)
		);

		-- What happened in the queue, for the long-poll events API.
		CREATE TABLE IF NOT EXISTS queue_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
			pr_number INTEGER,
			kind TEXT NOT NULL,
			data TEXT NOT NULL DEFAULT '{}',
			created_at TEXT DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS queue_events_repo ON queue_events(repo_id, id);
	`);
	const cols = database.prepare(`PRAGMA table_info(queue_items)`).all() as Array<{ name: string }>;
	const add = (name: string, ddl: string) => {
		if (!cols.some((c) => c.name === name)) database.exec(`ALTER TABLE queue_items ADD COLUMN ${name} ${ddl}`);
	};
	add('priority', `TEXT NOT NULL DEFAULT 'normal'`);
	// PRs this one conflicts with in a batch; it waits until they have left the queue.
	add('deferred_for', `TEXT`);
	// Batches this PR failed in without being found the culprit (flaky or unclear failures).
	add('batch_failures', `INTEGER NOT NULL DEFAULT 0`);
}

// --- settings ---

export function getQueueSettings(repoId: number): RepoQueueSettings {
	const row = getDb()
		.prepare('SELECT mode, config, ci, paused_reason FROM queue_settings WHERE repo_id = ?')
		.get(repoId) as { mode: QueueMode; config: string; ci: string; paused_reason: string | null } | undefined;
	if (!row) return { mode: 'serial', config: { ...DEFAULT_BATCH_CONFIG }, ci: { ...DEFAULT_CI }, pausedReason: null };
	return {
		mode: row.mode,
		config: { ...DEFAULT_BATCH_CONFIG, ...(JSON.parse(row.config) as Partial<BatchConfig>) },
		ci: { ...DEFAULT_CI, ...(JSON.parse(row.ci) as Partial<CISettings>) },
		pausedReason: row.paused_reason
	};
}

export function updateQueueSettings(
	repoId: number,
	change: { mode?: QueueMode; config?: Partial<BatchConfig>; ci?: Partial<CISettings>; pausedReason?: string | null }
): RepoQueueSettings {
	const cur = getQueueSettings(repoId);
	const next: RepoQueueSettings = {
		mode: change.mode ?? cur.mode,
		config: { ...cur.config, ...change.config },
		ci: { ...cur.ci, ...change.ci },
		pausedReason: change.pausedReason === undefined ? cur.pausedReason : change.pausedReason
	};
	getDb()
		.prepare(
			`INSERT INTO queue_settings (repo_id, mode, config, ci, paused_reason) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(repo_id) DO UPDATE SET mode = excluded.mode, config = excluded.config,
			   ci = excluded.ci, paused_reason = excluded.paused_reason`
		)
		.run(repoId, next.mode, JSON.stringify(next.config), JSON.stringify(next.ci), next.pausedReason);
	return next;
}

// --- priority ---

export function setQueuePriority(repoId: number, prNumber: number, priority: Priority) {
	getDb()
		.prepare('UPDATE queue_items SET priority = ? WHERE repo_id = ? AND pr_number = ?')
		.run(priority, repoId, prNumber);
}

// --- batches ---

type RawBatch = Omit<BatchRow, 'members' | 'context' | 'express' | 'heads' | 'steps'> & {
	members: string;
	heads: string;
	steps: string;
	context: string;
	express: number;
};

function parse(r: RawBatch): BatchRow {
	return {
		...r,
		members: JSON.parse(r.members),
		context: JSON.parse(r.context),
		heads: JSON.parse(r.heads),
		steps: JSON.parse(r.steps),
		express: !!r.express
	};
}

export function insertBatch(b: {
	repoId: number;
	kind: BatchRow['kind'];
	parentBatchId?: number | null;
	branch: string;
	baseSha: string;
	headSha: string;
	treeSha: string;
	baseTree: string;
	members: number[];
	heads: Record<number, string>;
	steps?: Record<number, BatchStep>;
	context?: number[];
	express?: boolean;
}): BatchRow {
	const r = getDb()
		.prepare(
			`INSERT INTO batches (repo_id, kind, parent_batch_id, branch, base_sha, head_sha, tree_sha, base_tree, members, heads, steps, context, express)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			b.repoId,
			b.kind,
			b.parentBatchId ?? null,
			b.branch,
			b.baseSha,
			b.headSha,
			b.treeSha,
			b.baseTree,
			JSON.stringify(b.members),
			JSON.stringify(b.heads),
			JSON.stringify(b.steps ?? {}),
			JSON.stringify(b.context ?? []),
			b.express ? 1 : 0
		);
	return getBatch(Number(r.lastInsertRowid))!;
}

export function getBatch(id: number): BatchRow | undefined {
	const r = getDb().prepare('SELECT * FROM batches WHERE id = ?').get(id) as RawBatch | undefined;
	return r ? parse(r) : undefined;
}

const ACTIVE: BatchStatus[] = ['testing', 'retrying', 'bisecting', 'passed'];

/** Top-level batches still in the pipeline, oldest first. */
export function getActiveBatches(repoId: number): BatchRow[] {
	return (
		getDb()
			.prepare(
				`SELECT * FROM batches WHERE repo_id = ? AND kind = 'batch'
				 AND status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY id`
			)
			.all(repoId, ...ACTIVE) as RawBatch[]
	).map(parse);
}

export function getBisectRuns(batchId: number): BatchRow[] {
	return (
		getDb()
			.prepare(`SELECT * FROM batches WHERE parent_batch_id = ? AND kind = 'bisect' ORDER BY id`)
			.all(batchId) as RawBatch[]
	).map(parse);
}

export function getRecentBatches(repoId: number, limit = 50): BatchRow[] {
	return (
		getDb()
			.prepare(`SELECT * FROM batches WHERE repo_id = ? AND kind = 'batch' ORDER BY id DESC LIMIT ?`)
			.all(repoId, limit) as RawBatch[]
	).map(parse);
}

export function setBatchStatus(id: number, status: BatchStatus) {
	const done = ['landed', 'failed', 'superseded', 'cancelled'].includes(status);
	getDb()
		.prepare(
			`UPDATE batches SET status = ?, finished_at = CASE WHEN ? THEN datetime('now') ELSE finished_at END WHERE id = ?`
		)
		.run(status, done ? 1 : 0, id);
}

/** When a batch was created, in epoch ms. */
export function batchCreatedMs(b: BatchRow): number {
	return Date.parse(b.created_at.includes('T') ? b.created_at : `${b.created_at.replace(' ', 'T')}Z`);
}

export function setBatchCI(id: number, result: BatchRow['ci_result']) {
	getDb().prepare('UPDATE batches SET ci_result = ? WHERE id = ?').run(result, id);
}

// --- queue item extras ---

export function setDeferredFor(itemId: number, prs: number[] | null) {
	getDb()
		.prepare('UPDATE queue_items SET deferred_for = ? WHERE id = ?')
		.run(prs && prs.length ? JSON.stringify(prs) : null, itemId);
}

export function deferredFor(item: { deferred_for?: string | null }): number[] {
	try {
		return item.deferred_for ? (JSON.parse(item.deferred_for) as number[]) : [];
	} catch {
		return [];
	}
}

/** Counts a batch failure the PR was not found to cause; returns the new count. */
export function bumpBatchFailures(itemId: number): number {
	getDb().prepare('UPDATE queue_items SET batch_failures = batch_failures + 1 WHERE id = ?').run(itemId);
	const r = getDb().prepare('SELECT batch_failures FROM queue_items WHERE id = ?').get(itemId) as
		| { batch_failures: number }
		| undefined;
	return r?.batch_failures ?? 0;
}

// --- restacked heads ---

export function recordRebasedHead(repoId: number, pr: number, fromSha: string, toSha: string, ciGreen: boolean | null) {
	getDb()
		.prepare(
			`INSERT OR REPLACE INTO rebased_heads (repo_id, pr_number, from_sha, to_sha, ci_green) VALUES (?, ?, ?, ?, ?)`
		)
		.run(repoId, pr, fromSha, toSha, ciGreen === null ? null : ciGreen ? 1 : 0);
}

/** The heads `sha` was restacked from by the queue, newest first, following chains of restacks. */
export function rebasedFrom(repoId: number, pr: number, sha: string): { sha: string; ciGreen: boolean | null }[] {
	const out: { sha: string; ciGreen: boolean | null }[] = [];
	const seen = new Set<string>([sha]);
	let cur = sha;
	for (let i = 0; i < 20; i++) {
		const r = getDb()
			.prepare('SELECT from_sha, ci_green FROM rebased_heads WHERE repo_id = ? AND pr_number = ? AND to_sha = ?')
			.get(repoId, pr, cur) as { from_sha: string; ci_green: number | null } | undefined;
		if (!r || seen.has(r.from_sha)) break;
		out.push({ sha: r.from_sha, ciGreen: r.ci_green === null ? null : r.ci_green === 1 });
		seen.add(r.from_sha);
		cur = r.from_sha;
	}
	return out;
}

/** One-off `try` runs still waiting for CI. */
export function getRunningTries(repoId: number): BatchRow[] {
	return (
		getDb()
			.prepare(`SELECT * FROM batches WHERE repo_id = ? AND kind = 'try' AND status = 'testing' ORDER BY id`)
			.all(repoId) as RawBatch[]
	).map(parse);
}
