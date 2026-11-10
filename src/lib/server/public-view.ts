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
		error_message: i.error_message,
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
