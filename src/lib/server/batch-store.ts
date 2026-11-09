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
	kind: 'batch' | 'bisect' | 'try' | 'baseline';
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
	/** When failed jobs were last re-run (epoch ms); check runs finished before it are stale. */
	retried_at: number | null;
	/** PRs tested in this commit beyond `context`, in order. */
	members: number[];
	/** PRs applied below `members` that are already known to pass (bisection only). */
	context: number[];
	/** PRs of a bisecting batch that already landed, in landing order. */
	landed: number[];
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
			retried_at INTEGER,
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

		-- The last default-branch commit the queue knows the state of. 'green': its tree passed CI
		-- (a batch the queue landed, or a baseline run). 'verifying': green by tree, while the
		-- default-branch run started after landing it hasn't finished. 'checking': a baseline run of
		-- it alone is going (it moved outside the queue). 'red': it fails on its own; \`tried\` lists
		-- the PR heads that failed on top of it (pr@sha in a batch, pr@sha! alone).
		-- Queue branches about to be pushed (written before the push, removed once the batch row
		-- that owns the branch exists): after a crash in between, the branch is an orphan to delete.
		-- A landing in progress (written before the first merge, removed after the last): after a
		-- crash, what was merged is recorded and green statuses on unmerged PRs are taken back.
		CREATE TABLE IF NOT EXISTS landing_intents (
			repo_id INTEGER PRIMARY KEY,
			batch_id INTEGER NOT NULL,
			src_id INTEGER NOT NULL,
			prs TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS branch_intents (
			repo_id INTEGER NOT NULL,
			branch TEXT NOT NULL,
			sha TEXT NOT NULL,
			PRIMARY KEY (repo_id, branch)
		);
		CREATE TABLE IF NOT EXISTS master_health (
			repo_id INTEGER PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
			sha TEXT NOT NULL,
			tree TEXT NOT NULL,
			state TEXT NOT NULL,
			since INTEGER NOT NULL,
			retried_at INTEGER,
			tried TEXT NOT NULL DEFAULT '[]'
		);
	`);
	const batchCols = database.prepare(`PRAGMA table_info(batches)`).all() as Array<{ name: string }>;
	for (const [name, ddl] of [
		['steps', `TEXT NOT NULL DEFAULT '{}'`],
		['retried_at', 'INTEGER'],
		// Bisection lands passing groups as it goes: the PRs of this batch that landed so far.
		['landed', `TEXT NOT NULL DEFAULT '[]'`]
	]) {
		if (!batchCols.some((c) => c.name === name)) database.exec(`ALTER TABLE batches ADD COLUMN ${name} ${ddl}`);
	}
	const cols = database.prepare(`PRAGMA table_info(queue_items)`).all() as Array<{ name: string }>;
	const add = (name: string, ddl: string) => {
		if (!cols.some((c) => c.name === name)) database.exec(`ALTER TABLE queue_items ADD COLUMN ${name} ${ddl}`);
	};
	add('priority', `TEXT NOT NULL DEFAULT 'normal'`);
	// PRs this one conflicts with in a batch; it waits until they have left the queue.
	add('deferred_for', `TEXT`);
	// Batches this PR failed in without being found the culprit (flaky or unclear failures).
	add('batch_failures', `INTEGER NOT NULL DEFAULT 0`);
	// Why the planner holds this queued PR back: { code, wait, reason } (see setHold).
	add('hold', `TEXT`);
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

type RawBatch = Omit<BatchRow, 'members' | 'context' | 'express' | 'heads' | 'steps' | 'landed'> & {
	members: string;
	landed: string | null;
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
		landed: JSON.parse(r.landed ?? '[]'),
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

/** A bisecting batch landed `prs` on master `sha` (tree `tree`): the rest bisects on top of it. */
export function recordBisectLanding(id: number, prs: number[], sha: string, tree: string) {
	const b = getBatch(id)!;
	getDb()
		.prepare('UPDATE batches SET landed = ?, base_sha = ?, base_tree = ? WHERE id = ?')
		.run(JSON.stringify([...b.landed, ...prs]), sha, tree, id);
}

/** The default branch moved under a bisecting batch: it follows it. */
export function rebaseBatch(id: number, sha: string, tree: string) {
	getDb().prepare('UPDATE batches SET base_sha = ?, base_tree = ? WHERE id = ?').run(sha, tree, id);
}

// --- crash recovery ---

/** About to push queue branch `branch` at `sha`; `branchPushed` clears it once a batch row owns it. */
export function intendBranch(repoId: number, branch: string, sha: string) {
	getDb().prepare('INSERT OR REPLACE INTO branch_intents (repo_id, branch, sha) VALUES (?, ?, ?)').run(repoId, branch, sha);
}

export function branchPushed(repoId: number, branch: string) {
	getDb().prepare('DELETE FROM branch_intents WHERE repo_id = ? AND branch = ?').run(repoId, branch);
}

/** Branches whose push may have happened without the queue recording what they belong to. */
export function branchIntents(repoId: number): Array<{ branch: string; sha: string }> {
	return getDb().prepare('SELECT branch, sha FROM branch_intents WHERE repo_id = ?').all(repoId) as Array<{ branch: string; sha: string }>;
}

export function setLandingIntent(repoId: number, i: { batchId: number; srcId: number; prs: number[] } | null) {
	if (!i) getDb().prepare('DELETE FROM landing_intents WHERE repo_id = ?').run(repoId);
	else
		getDb()
			.prepare('INSERT OR REPLACE INTO landing_intents (repo_id, batch_id, src_id, prs) VALUES (?, ?, ?, ?)')
			.run(repoId, i.batchId, i.srcId, JSON.stringify(i.prs));
}

export function getLandingIntent(repoId: number): { batchId: number; srcId: number; prs: number[] } | null {
	const r = getDb().prepare('SELECT batch_id, src_id, prs FROM landing_intents WHERE repo_id = ?').get(repoId) as
		| { batch_id: number; src_id: number; prs: string }
		| undefined;
	return r ? { batchId: r.batch_id, srcId: r.src_id, prs: JSON.parse(r.prs) } : null;
}

export function getBatchByBranch(repoId: number, branch: string): BatchRow | undefined {
	const r = getDb().prepare('SELECT * FROM batches WHERE repo_id = ? AND branch = ?').get(repoId, branch) as RawBatch | undefined;
	return r ? parse(r) : undefined;
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

export function setBatchRetried(id: number, at: number) {
	getDb().prepare(`UPDATE batches SET retried_at = ?, ci_result = 'pending' WHERE id = ?`).run(at, id);
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

/**
 * Why the planner holds a queued PR back, so the dashboard can tell a PR that waits by itself
 * (CI running, parent pending) from one that needs someone. The reason matches the item's
 * error_message while the hold is current.
 */
export interface Hold {
	code: string;
	wait: boolean;
	reason: string;
}

export function setHold(itemId: number, hold: Hold | null) {
	getDb()
		.prepare('UPDATE queue_items SET hold = ? WHERE id = ?')
		.run(hold ? JSON.stringify(hold) : null, itemId);
}

/** The item's hold, when it still describes the item's current message. */
export function currentHold(item: { hold?: string | null; status: string; error_message: string | null }): Hold | null {
	if (item.status !== 'queued' || !item.hold || !item.error_message) return null;
	try {
		const h = JSON.parse(item.hold) as Hold;
		return h.reason === item.error_message ? h : null;
	} catch {
		return null;
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

// --- default-branch health ---

export type MasterState = 'green' | 'verifying' | 'checking' | 'red';

export interface MasterHealth {
	sha: string;
	tree: string;
	state: MasterState;
	/** When this state began (epoch ms); its run's results from before then don't count. */
	since: number;
	/** When its failed run was re-run (epoch ms), or null. */
	retriedAt: number | null;
	/** While red: PR heads (`pr@sha`) that failed alone on top of it, so each is tried once. */
	tried: string[];
}

export function getMasterHealth(repoId: number): MasterHealth | null {
	const r = getDb()
		.prepare('SELECT sha, tree, state, since, retried_at, tried FROM master_health WHERE repo_id = ?')
		.get(repoId) as { sha: string; tree: string; state: MasterState; since: number; retried_at: number | null; tried: string } | undefined;
	return r ? { sha: r.sha, tree: r.tree, state: r.state, since: r.since, retriedAt: r.retried_at, tried: JSON.parse(r.tried) } : null;
}

export function setMasterHealth(
	repoId: number,
	h: { sha: string; tree: string; state: MasterState; since: number; retriedAt?: number | null; tried?: string[] }
) {
	getDb()
		.prepare(
			`INSERT INTO master_health (repo_id, sha, tree, state, since, retried_at, tried) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(repo_id) DO UPDATE SET sha = excluded.sha, tree = excluded.tree, state = excluded.state,
			   since = excluded.since, retried_at = excluded.retried_at, tried = excluded.tried`
		)
		.run(repoId, h.sha, h.tree, h.state, h.since, h.retriedAt ?? null, JSON.stringify(h.tried ?? []));
}

export function clearMasterHealth(repoId: number) {
	getDb().prepare('DELETE FROM master_health WHERE repo_id = ?').run(repoId);
}

export function getRunningBaseline(repoId: number): BatchRow | null {
	const r = getDb()
		.prepare(`SELECT * FROM batches WHERE repo_id = ? AND kind = 'baseline' AND status = 'testing' ORDER BY id DESC LIMIT 1`)
		.get(repoId) as RawBatch | undefined;
	return r ? parse(r) : null;
}
