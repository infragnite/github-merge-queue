// What a read-only viewer of a repository page is sent: an allowlist of fields, so a column added
// to the queue later isn't published by default, and links the server builds itself.

import type { HistoryItem } from '$lib/types';
import type { ViewItem } from '$lib/queue-view';

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

/** A visibility GitHub reported is trusted this long; a page turned public is re-checked after it. */
const VISIBILITY_TTL_MS = 10 * 60_000;
const visibility = new Map<number, { at: number; public: boolean }>();

/**
 * Whether a repository whose queue page was made public is still public on GitHub. Checked when a
 * read-only viewer loads the page (at most once per 10 minutes per repository); a repository that
 * went private has its public page turned off. When GitHub can't say and nothing recent is known,
 * the page is refused.
 */
export async function stillPublic(
	repo: { id: number; owner: string; name: string },
	lookup: () => Promise<'public' | 'private' | null>,
	onPrivate: () => void,
	now = Date.now()
): Promise<boolean> {
	const hit = visibility.get(repo.id);
	if (hit && now - hit.at < VISIBILITY_TTL_MS) return hit.public;
	const v = await lookup();
	if (v === null) return !!hit && hit.public && now - hit.at < 3 * VISIBILITY_TTL_MS;
	visibility.set(repo.id, { at: now, public: v === 'public' });
	if (v === 'private') onPrivate();
	return v === 'public';
}

export function forgetVisibility(repoId?: number) {
	if (repoId === undefined) visibility.clear();
	else visibility.delete(repoId);
}
