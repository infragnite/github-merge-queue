import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';
import type { User, Repo, RepoWithStats, QueueItem, HistoryItem } from '$lib/types';
import type { StackStore } from './stack-source';

let db: Database.Database;

export function getDb(): Database.Database {
	if (!db) {
		const dbPath = env.DATABASE_PATH || './data/merge-queue.db';
		db = new Database(dbPath);
		db.pragma('journal_mode = WAL');
		db.pragma('foreign_keys = ON');
		migrate(db);
	}
	return db;
}

function migrate(database: Database.Database) {
	database.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			github_id INTEGER UNIQUE NOT NULL,
			login TEXT NOT NULL,
			name TEXT,
			avatar_url TEXT,
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS repositories (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			owner TEXT NOT NULL,
			name TEXT NOT NULL,
			default_branch TEXT DEFAULT 'main',
			webhook_secret TEXT,
			added_by INTEGER REFERENCES users(id),
			created_at TEXT DEFAULT (datetime('now')),
			UNIQUE(owner, name)
		);

		CREATE TABLE IF NOT EXISTS queue_items (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
			pr_number INTEGER NOT NULL,
			pr_title TEXT,
			pr_url TEXT,
			author_login TEXT,
			author_avatar TEXT,
			head_sha TEXT,
			status TEXT DEFAULT 'queued',
			position INTEGER NOT NULL,
			error_message TEXT,
			queued_by TEXT NOT NULL,
			created_at TEXT DEFAULT (datetime('now')),
			started_at TEXT,
			completed_at TEXT,
			UNIQUE(repo_id, pr_number)
		);

		CREATE TABLE IF NOT EXISTS merge_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
			pr_number INTEGER NOT NULL,
			pr_title TEXT,
			pr_url TEXT,
			author_login TEXT,
			merged_sha TEXT,
			status TEXT NOT NULL,
			error_message TEXT,
			queued_at TEXT,
			completed_at TEXT DEFAULT (datetime('now'))
		);

		-- Every head SHA seen per PR, so stack detection can tell that a
		-- child still sits on a parent's pre-rebase commits.
		CREATE TABLE IF NOT EXISTS pr_heads (
			repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
			pr_number INTEGER NOT NULL,
			head_sha TEXT NOT NULL,
			seen_at TEXT DEFAULT (datetime('now')),
			PRIMARY KEY (repo_id, pr_number, head_sha)
		);

		-- Branch deletions from the \`delete\` webhook, to recognise PRs GitHub
		-- closes because their base branch went away.
		CREATE TABLE IF NOT EXISTS deleted_branches (
			repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
			ref TEXT NOT NULL,
			deleted_at TEXT DEFAULT (datetime('now')),
			PRIMARY KEY (repo_id, ref)
		);
	`);

}

// --- Users ---

export function upsertUser(
	githubId: number,
	login: string,
	name: string | null,
	avatarUrl: string | null
): number {
	const database = getDb();
	database
		.prepare(
			`INSERT INTO users (github_id, login, name, avatar_url)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(github_id) DO UPDATE SET
			 login = excluded.login,
			 name = excluded.name,
			 avatar_url = excluded.avatar_url`
		)
		.run(githubId, login, name, avatarUrl);
	const user = database
		.prepare('SELECT id FROM users WHERE github_id = ?')
		.get(githubId) as { id: number };
	return user.id;
}

export function getUserById(id: number): User | undefined {
	return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

// --- Repositories ---

export function getRepos(): RepoWithStats[] {
	return getDb()
		.prepare(
			`SELECT r.*,
			 (SELECT COUNT(*) FROM queue_items qi
				WHERE qi.repo_id = r.id
				AND qi.status NOT IN ('merged', 'failed', 'cancelled')) as queue_count,
			 (SELECT qi.status FROM queue_items qi
				WHERE qi.repo_id = r.id
				AND qi.status NOT IN ('merged', 'failed', 'cancelled')
				ORDER BY qi.position LIMIT 1) as current_status
		 FROM repositories r
		 ORDER BY r.owner, r.name`
		)
		.all() as RepoWithStats[];
}

export function getRepoByOwnerName(owner: string, name: string): Repo | undefined {
	return getDb()
		.prepare('SELECT * FROM repositories WHERE owner = ? AND name = ?')
		.get(owner, name) as Repo | undefined;
}

export function getRepoById(id: number): Repo | undefined {
	return getDb().prepare('SELECT * FROM repositories WHERE id = ?').get(id) as Repo | undefined;
}

export function addRepo(owner: string, name: string, defaultBranch: string, addedBy: number) {
	return getDb()
		.prepare(
			'INSERT INTO repositories (owner, name, default_branch, added_by) VALUES (?, ?, ?, ?)'
		)
		.run(owner, name, defaultBranch, addedBy);
}

export function removeRepo(id: number) {
	return getDb().prepare('DELETE FROM repositories WHERE id = ?').run(id);
}

// --- Queue ---

export function getQueueItems(repoId: number): QueueItem[] {
	return getDb()
		.prepare(
			`SELECT * FROM queue_items
		 WHERE repo_id = ? AND status NOT IN ('merged', 'cancelled')
		 ORDER BY position`
		)
		.all(repoId) as QueueItem[];
}

export function getAllQueueItems(repoId: number): QueueItem[] {
	return getDb()
		.prepare('SELECT * FROM queue_items WHERE repo_id = ? ORDER BY position')
		.all(repoId) as QueueItem[];
}

export function getActiveQueueItem(repoId: number): QueueItem | undefined {
	return getDb()
		.prepare(
			`SELECT * FROM queue_items
		 WHERE repo_id = ? AND status NOT IN ('merged', 'failed', 'cancelled')
		 ORDER BY position LIMIT 1`
		)
		.get(repoId) as QueueItem | undefined;
}

export function addToQueue(
	repoId: number,
	prNumber: number,
	prTitle: string,
	prUrl: string,
	authorLogin: string,
	authorAvatar: string,
	queuedBy: string
) {
	const database = getDb();
	const maxPos = database
		.prepare(
			`SELECT COALESCE(MAX(position), 0) as max_pos
		 FROM queue_items WHERE repo_id = ? AND status NOT IN ('merged', 'failed', 'cancelled')`
		)
		.get(repoId) as { max_pos: number };

	return database
		.prepare(
			`INSERT INTO queue_items
		 (repo_id, pr_number, pr_title, pr_url, author_login, author_avatar, position, queued_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(repoId, prNumber, prTitle, prUrl, authorLogin, authorAvatar, maxPos.max_pos + 1, queuedBy);
}

export function removeFromQueue(itemId: number) {
	return getDb().prepare('DELETE FROM queue_items WHERE id = ?').run(itemId);
}

export function updateQueueItemStatus(itemId: number, status: string, errorMessage?: string) {
	const database = getDb();
	if (status === 'updating') {
		database
			.prepare(`UPDATE queue_items SET status = ?, started_at = datetime('now') WHERE id = ?`)
			.run(status, itemId);
	} else if (['merged', 'failed', 'cancelled'].includes(status)) {
		database
			.prepare(
				`UPDATE queue_items SET status = ?, error_message = ?, completed_at = datetime('now') WHERE id = ?`
			)
			.run(status, errorMessage ?? null, itemId);
	} else {
		database
			.prepare('UPDATE queue_items SET status = ?, error_message = ? WHERE id = ?')
			.run(status, errorMessage ?? null, itemId);
	}
}

export function updateQueueItemHeadSha(itemId: number, headSha: string) {
	getDb().prepare('UPDATE queue_items SET head_sha = ? WHERE id = ?').run(headSha, itemId);
}

export function reorderQueue(repoId: number, orderedItemIds: number[]) {
	const database = getDb();
	const update = database.prepare('UPDATE queue_items SET position = ? WHERE id = ? AND repo_id = ?');
	const txn = database.transaction(() => {
		for (let i = 0; i < orderedItemIds.length; i++) {
			update.run(i + 1, orderedItemIds[i], repoId);
		}
	});
	txn();
}

// --- History ---

export function addToHistory(
	repoId: number,
	prNumber: number,
	prTitle: string,
	prUrl: string,
	authorLogin: string,
	mergedSha: string | null,
	status: string,
	errorMessage: string | null,
	queuedAt: string | null
) {
	return getDb()
		.prepare(
			`INSERT INTO merge_history
		 (repo_id, pr_number, pr_title, pr_url, author_login, merged_sha, status, error_message, queued_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(repoId, prNumber, prTitle, prUrl, authorLogin, mergedSha, status, errorMessage, queuedAt);
}

export function getRepoHistory(repoId: number, limit = 20): HistoryItem[] {
	return getDb()
		.prepare(
			`SELECT mh.*, r.owner as repo_owner, r.name as repo_name
		 FROM merge_history mh
		 JOIN repositories r ON r.id = mh.repo_id
		 WHERE mh.repo_id = ?
		 ORDER BY mh.completed_at DESC LIMIT ?`
		)
		.all(repoId, limit) as HistoryItem[];
}

export function getHistory(limit = 50): HistoryItem[] {
	return getDb()
		.prepare(
			`SELECT mh.*, r.owner as repo_owner, r.name as repo_name
		 FROM merge_history mh
		 JOIN repositories r ON r.id = mh.repo_id
		 ORDER BY mh.completed_at DESC LIMIT ?`
		)
		.all(limit) as HistoryItem[];
}

// --- Stack detection ---

// SQLite's datetime('now') is UTC without a zone marker.
function sqliteToIso(ts: string): string {
	return ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
}

export function recordPRHead(repoId: number, prNumber: number, headSha: string) {
	getDb()
		.prepare('INSERT OR IGNORE INTO pr_heads (repo_id, pr_number, head_sha) VALUES (?, ?, ?)')
		.run(repoId, prNumber, headSha);
}

export function getKnownPRHeads(repoId: number): Map<number, string[]> {
	const rows = getDb()
		.prepare('SELECT pr_number, head_sha FROM pr_heads WHERE repo_id = ?')
		.all(repoId) as Array<{ pr_number: number; head_sha: string }>;
	const heads = new Map<number, string[]>();
	for (const r of rows) {
		const list = heads.get(r.pr_number) ?? [];
		list.push(r.head_sha);
		heads.set(r.pr_number, list);
	}
	return heads;
}

export function recordBranchDeleted(repoId: number, ref: string) {
	getDb()
		.prepare(
			`INSERT INTO deleted_branches (repo_id, ref) VALUES (?, ?)
		 ON CONFLICT(repo_id, ref) DO UPDATE SET deleted_at = datetime('now')`
		)
		.run(repoId, ref);
}

export function getDeletedBranches(repoId: number): Map<string, string> {
	const rows = getDb()
		.prepare('SELECT ref, deleted_at FROM deleted_branches WHERE repo_id = ?')
		.all(repoId) as Array<{ ref: string; deleted_at: string }>;
	return new Map(rows.map((r) => [r.ref, sqliteToIso(r.deleted_at)]));
}

export function stackStore(repoId: number): StackStore {
	return {
		recordHeads: (heads) => {
			const txn = getDb().transaction(() => {
				for (const h of heads) recordPRHead(repoId, h.pr, h.sha);
			});
			txn();
		},
		knownHeads: () => getKnownPRHeads(repoId),
		deletedBranches: () => getDeletedBranches(repoId)
	};
}
