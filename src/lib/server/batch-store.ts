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
	kind: 'batch' | 'bisect';
	parent_batch_id: number | null;
	branch: string;
	base_sha: string;
	head_sha: string;
	tree_sha: string;
	/** Tree of `base_sha`; master is compared by tree because landing re-creates the commits. */
	base_tree: string;
	/** Head SHA of each PR when the batch was built. */
	heads: Record<number, string>;
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

export interface CISettings {
	/** Workflow file the queue dispatches on batch branches. */
	workflow: string;
	/** The check run that decides a batch, e.g. krusty's `ci-and-conformance`. */
	requiredCheck: string;
	/** Commit status the queue sets on master when its tree was already tested. */
	testedStatus: string;
}

export const DEFAULT_CI: CISettings = {
	workflow: 'ci.yml',
	requiredCheck: 'ci',
	testedStatus: 'merge-queue/tested'
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
			context TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'testing',
			express INTEGER NOT NULL DEFAULT 0,
			ci_result TEXT NOT NULL DEFAULT 'pending',
			created_at TEXT DEFAULT (datetime('now')),
			finished_at TEXT
		);
		CREATE INDEX IF NOT EXISTS batches_repo_status ON batches(repo_id, status);
	`);
	const cols = database.prepare(`PRAGMA table_info(queue_items)`).all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === 'priority')) {
		database.exec(`ALTER TABLE queue_items ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`);
	}
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

type RawBatch = Omit<BatchRow, 'members' | 'context' | 'express' | 'heads'> & {
	members: string;
	heads: string;
	context: string;
	express: number;
};

function parse(r: RawBatch): BatchRow {
	return {
		...r,
		members: JSON.parse(r.members),
		context: JSON.parse(r.context),
		heads: JSON.parse(r.heads),
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
	context?: number[];
	express?: boolean;
}): BatchRow {
	const r = getDb()
		.prepare(
			`INSERT INTO batches (repo_id, kind, parent_batch_id, branch, base_sha, head_sha, tree_sha, base_tree, members, heads, context, express)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

export function setBatchCI(id: number, result: BatchRow['ci_result']) {
	getDb().prepare('UPDATE batches SET ci_result = ? WHERE id = ?').run(result, id);
}
