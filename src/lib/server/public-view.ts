// What a read-only viewer of a repository page is sent: an allowlist of fields, so a column added
// to the queue later isn't published by default, and links the server builds itself.

import type { HistoryItem, ViewItem } from '$lib/types';

const NAME = /^[A-Za-z0-9._-]+$/;

/** A pull request's GitHub link, built from the repository's name and the number alone. */
export function prUrl(repo: { owner: string; name: string }, n: number): string {
	if (!NAME.test(repo.owner) || !NAME.test(repo.name) || !Number.isSafeInteger(n) || n < 1) return 'https://github.com/';
	return `https://github.com/${repo.owner}/${repo.name}/pull/${n}`;
}

/** A queue row as a read-only viewer sees it: who queued it, heads and timestamps are left out. */
export function publicQueueItem(i: ViewItem): ViewItem {
	return {
		id: i.id,
		repo_id: 0,
		pr_number: i.pr_number,
		pr_title: i.pr_title,
		pr_url: i.pr_url,
		author_login: i.author_login,
		author_avatar: '',
		head_sha: null,
		status: i.status,
		position: i.position,
		// The planner's own note on why a PR waits is shown; raw errors (GitHub's, git's) are not.
		error_message: i.holdWait !== null ? i.error_message : i.status === 'failed' ? 'Failed in the queue' : null,
		queued_by: '',
		created_at: '',
		started_at: null,
		completed_at: null,
		priority: i.priority ?? null,
		holdWait: i.holdWait,
		deferred: i.deferred
	};
}

export function publicHistory(h: HistoryItem): HistoryItem {
	return {
		id: h.id,
		repo_id: 0,
		pr_number: h.pr_number,
		pr_title: h.pr_title,
		pr_url: h.pr_url,
		author_login: h.author_login,
		merged_sha: null,
		status: h.status,
		error_message: null,
		queued_at: null,
		completed_at: h.completed_at,
		repo_owner: '',
		repo_name: ''
	};
}

// --- the repository must still be public ---
//
// A read-only viewer never makes the app call GitHub. The processor asks GitHub whether each repo
// with a public page is still public (every 10 minutes) and keeps the page's caches warm while
// read-only viewers are around; a viewer only reads what it found.

/** How often the processor re-asks GitHub; an answer older than three times this is not trusted. */
export const VISIBILITY_TTL_MS = 10 * 60_000;
const visibility = new Map<number, { at: number; public: boolean }>();

/** Whether the repository was public on GitHub when last asked, recently enough to trust; else false. */
export function knownPublic(repoId: number, now = Date.now()): boolean {
	const v = visibility.get(repoId);
	return !!v && v.public && now - v.at < 3 * VISIBILITY_TTL_MS;
}

export function visibilityDue(repoId: number, now = Date.now()): boolean {
	const v = visibility.get(repoId);
	return !v || now - v.at >= VISIBILITY_TTL_MS;
}

/** Records what GitHub said (null: it couldn't say, and the last answer ages out); private turns the page off. */
export function noteVisibility(repoId: number, v: 'public' | 'private' | null, onPrivate: () => void, now = Date.now()) {
	if (v === null) return;
	visibility.set(repoId, { at: now, public: v === 'public' });
	if (v === 'private') onPrivate();
}

export function forgetVisibility(repoId?: number) {
	if (repoId === undefined) visibility.clear();
	else visibility.delete(repoId);
}

/** When a read-only viewer last loaded each repo's page: the processor keeps its caches warm meanwhile. */
const viewed = new Map<number, number>();
export const WARM_FOR_MS = 5 * 60_000;

export function noteReadOnlyView(repoId: number, now = Date.now()) {
	viewed.set(repoId, now);
}

export function readOnlyViewers(repoId: number, now = Date.now()): boolean {
	return now - (viewed.get(repoId) ?? -Infinity) < WARM_FOR_MS;
}
