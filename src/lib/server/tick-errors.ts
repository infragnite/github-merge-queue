// The errors the queue's steps hit per repository. A one-off failure (a GitHub 500, a dropped
// connection) is only logged: the next step retries it and nobody can do anything about it. The
// queue page shows a failure once it persists, so it explains why nothing moves. Cleared by the
// next clean step.
import { GitHubError } from './github-retry';

interface TickError {
	/** The latest failure, described for the log and the page. */
	detail: string;
	/** Whether the latest failure was GitHub failing or unreachable, rather than the queue itself. */
	github: boolean;
	/** Epoch ms of the first of the consecutive failures, and of the latest. */
	since: number;
	at: number;
	count: number;
}

/** What the queue page shows: `github` means GitHub is failing and the queue keeps retrying. */
export interface TickErrorView {
	kind: 'github' | 'stuck';
	detail: string;
	since: number;
	count: number;
}

/** Consecutive failed steps before the page shows them. */
export const SHOW_AFTER_FAILURES = 3;

const errors = new Map<number, TickError>();

/** The error with the GitHub call and status it came from, for the log and the page. */
export function describeTickError(err: unknown): string {
	if (err instanceof GitHubError) return `GitHub API ${err.status}${err.call ? ` on ${err.call}` : ''}: ${err.message}`;
	return err instanceof Error ? err.message : String(err);
}

/** A GitHub 5xx or a failure to reach it at all (fetch throws a TypeError, possibly with a cause). */
function githubFailing(err: unknown): boolean {
	if (err instanceof GitHubError) return err.status >= 500;
	return err instanceof TypeError && /fetch failed|network|socket|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(`${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`);
}

export function noteTickError(repoId: number, err: unknown, now = Date.now()) {
	const prev = errors.get(repoId);
	errors.set(repoId, { detail: describeTickError(err), github: githubFailing(err), since: prev?.since ?? now, at: now, count: (prev?.count ?? 0) + 1 });
}

export function clearTickError(repoId: number) {
	errors.delete(repoId);
}

/** The failure to show on the queue page, or null while there is none or it hasn't persisted. */
export function tickErrorView(repoId: number): TickErrorView | null {
	const e = errors.get(repoId);
	if (!e || e.count < SHOW_AFTER_FAILURES) return null;
	return { kind: e.github ? 'github' : 'stuck', since: e.since, count: e.count, detail: e.detail };
}
