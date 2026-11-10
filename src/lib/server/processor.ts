import { env } from '$env/dynamic/private';
import * as db from './db';
import * as github from './github';
import { closedPRReason, stackMergeBlocker } from './stack-runtime';
import { getQueueSettings, updateQueueSettings } from './batch-store';
import { GitHubError } from './github-retry';
import { emitEvent } from './events';
import { recoverInterrupted, tickBatchQueue } from './batch-queue';
import { liveDeps } from './batch-live';
import { takeDirty } from './wake';
import { withRepoLock } from './repo-lock';
import { RateLimitedError } from './rate-limit';
import { clearTickError, noteTickError } from './tick-errors';
import { recordRunCosts } from './ci-savings';
import { noteVisibility, readOnlyViewers, visibilityDue } from './public-view';
import { repoVisibility } from './api-service';
import { dashboardStackAnalysis } from './stack-runtime';
import { pipelineView } from './pipeline-view';

/** The reset time last logged per repo, so a rate limit is logged once, not every cycle. */
const loggedLimit = new Map<number, number>();
async function rateLimited(repo: RepoRef): Promise<boolean> {
	const until = (await github.rateLimitOf(repo.owner).catch(() => null))?.blockedUntil ?? null;
	if (!until) return false;
	noteTickError(repo.id, new Error(`GitHub rate limit for this app is used up; the queue resumes at ${new Date(until).toISOString().slice(11, 16)} UTC`));
	if (loggedLimit.get(repo.id) !== until) {
		loggedLimit.set(repo.id, until);
		console.warn(`[merge-queue] ${repo.owner}/${repo.name}: GitHub rate limit reached; the queue waits until ${new Date(until).toISOString()}`);
	}
	return true;
}

type RepoRef = { id: number; owner: string; name: string; default_branch: string };

let intervalId: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startProcessor() {
	if (intervalId) return;
	const interval = parseInt(env.PROCESSOR_INTERVAL || '15', 10) * 1000;
	console.log(`[merge-queue] Processor started (interval: ${interval / 1000}s)`);
	intervalId = setInterval(processAll, interval);
	setTimeout(processAll, 3000);
}

export function stopProcessor() {
	if (intervalId) {
		clearInterval(intervalId);
		intervalId = null;
	}
}

/**
 * On shutdown: start no new cycle and let the running one finish (within `timeoutMs`). Not needed
 * for correctness, since the queue picks up after a kill at any point, but it saves redoing work.
 */
export async function drainProcessor(timeoutMs = 25_000): Promise<void> {
	stopProcessor();
	stopping = true;
	const deadline = Date.now() + timeoutMs;
	while (running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
	console.log(`[merge-queue] Processor stopped${running ? ' (a cycle was still running)' : ''}`);
}
let stopping = false;

async function processAll() {
	if (running || stopping) return;
	running = true;

	try {
		const repos = db.getRepos();
		for (const repo of repos) {
			if (stopping) break;
			await processRepo(repo);
		}
	} catch (err) {
		console.error('[merge-queue] Processor error:', err);
	} finally {
		running = false;
	}
}

// Head SHAs are recorded from webhooks too; polling covers missed deliveries
// so a later rebase of a lower PR is still recognisable.
const HEAD_POLL_MS = 60_000;
const lastHeadPoll = new Map<number, number>();

async function recordOpenPRHeads(repo: RepoRef) {
	const last = lastHeadPoll.get(repo.id) ?? 0;
	if (Date.now() - last < HEAD_POLL_MS) return;
	lastHeadPoll.set(repo.id, Date.now());
	try {
		const prs: Array<{ number: number; head: { sha: string } }> = await github.getOpenPRs(repo.owner, repo.name);
		db.stackStore(repo.id).recordHeads(prs.map((p) => ({ pr: p.number, sha: p.head.sha })));
		db.prunePRHeads(repo.id, prs.map((p) => p.number));
	} catch (err) {
		console.error(`[merge-queue] Head polling failed for ${repo.owner}/${repo.name}:`, err instanceof Error ? err.message : err);
	}
}

// What finished queue runs cost, for the time-saved card: a few calls a minute at most, and
// none while the rate-limit budget is low (the queue needs it more).
const RUN_COST_MS = 60_000;
const lastRunCost = new Map<number, number>();

async function recordCosts(repo: RepoRef) {
	if (Date.now() - (lastRunCost.get(repo.id) ?? 0) < RUN_COST_MS) return;
	lastRunCost.set(repo.id, Date.now());
	if ((await github.rateLimitOf(repo.owner).catch(() => null))?.low) return;
	try {
		await recordRunCosts(repo, (sha) => github.actionsJobTimesForSha(repo.owner, repo.name, sha));
	} catch (err) {
		console.warn(`[merge-queue] Recording CI run times for ${repo.owner}/${repo.name} failed:`, err instanceof Error ? err.message : err);
	}
}

/**
 * For a repository with a public page: asks GitHub every 10 minutes whether it is still public
 * (turning the page off when not), and while read-only viewers are around, refreshes what their
 * page shows at most once a minute, as one signed-in viewer would. Read-only loads never call GitHub.
 */
const lastWarm = new Map<number, number>();
async function keepPublicPage(repo: RepoRef) {
	if (!getQueueSettings(repo.id).publicView) return;
	if (visibilityDue(repo.id)) {
		noteVisibility(repo.id, await repoVisibility(() => github.getRepo(repo.owner, repo.name)), () => {
			updateQueueSettings(repo.id, { publicView: false });
			emitEvent(repo.id, null, 'settings', { by: 'merge-queue', changes: { publicView: { from: true, to: false } }, why: 'the repository is private on GitHub' });
			console.warn(`[merge-queue] ${repo.owner}/${repo.name} is private on GitHub: its public queue page is turned off`);
		});
	}
	if (!readOnlyViewers(repo.id) || Date.now() - (lastWarm.get(repo.id) ?? 0) < 60_000) return;
	lastWarm.set(repo.id, Date.now());
	if ((await github.rateLimitOf(repo.owner).catch(() => null))?.low) return;
	await dashboardStackAnalysis(repo).catch(() => {});
	await pipelineView(repo, new Map()).catch(() => {});
}

// A batch tick costs several GitHub calls per queued PR, so it runs at most
// once a minute, or sooner when a webhook says something changed.
const BATCH_TICK_MS = 60_000;
/** Even a webhook can't make it tick more often than this; a burst of events becomes one tick. */
const MIN_BATCH_TICK_MS = 30_000;
const lastBatchTick = new Map<number, number>();
/** A tick slower than this is logged, so a slow GitHub or git shows up in the logs. */
const SLOW_TICK_MS = 5_000;

/** A 403 GitHub answers when the App was not granted a permission the call needs. */
export function missingPermission(err: unknown): err is GitHubError {
	return err instanceof GitHubError && err.status === 403 && /not accessible by integration/i.test(err.message);
}

async function processRepo(repo: ReturnType<typeof db.getRepos>[number]) {
	// Every call would fail until GitHub's reset; the queue picks up where it stopped then.
	if (await rateLimited(repo)) return;
	await recordOpenPRHeads(repo);
	await recordCosts(repo);
	await keepPublicPage(repo).catch((err) => console.warn(`[merge-queue] Public page upkeep for ${repo.owner}/${repo.name} failed:`, err instanceof Error ? err.message : err));

	if (getQueueSettings(repo.id).mode === 'batch') {
		const last = lastBatchTick.get(repo.id) ?? 0;
		const since = Date.now() - last;
		if (since < MIN_BATCH_TICK_MS || (since < BATCH_TICK_MS && !takeDirty(repo.id))) return;
		takeDirty(repo.id);
		lastBatchTick.set(repo.id, Date.now());
		const started = Date.now();
		try {
			await withRepoLock(repo.id, () => tickBatchQueue(liveDeps(repo)));
			clearTickError(repo.id);
		} catch (err) {
			noteTickError(repo.id, err);
			if (missingPermission(err)) {
				// Retrying can't fix it; say so once, where the dashboard shows it, instead of every tick.
				const reason = `The GitHub App lacks a permission (${err.message}). Grant it in the App's settings, approve it on this account's installation, then resume.`;
				updateQueueSettings(repo.id, { pausedReason: reason });
				emitEvent(repo.id, null, 'paused', { reason });
				console.error(`[merge-queue] Paused ${repo.owner}/${repo.name}: ${reason}`);
				return;
			}
			if (err instanceof RateLimitedError) return; // logged once by `rateLimited` on the next cycle
			// Transient GitHub or git errors: the next cycle picks up where this one stopped.
			console.error(`[merge-queue] Batch queue error for ${repo.owner}/${repo.name}:`, err instanceof Error ? err.message : err);
		} finally {
			const took = Date.now() - started;
			if (took >= SLOW_TICK_MS) console.log(`[merge-queue] Batch tick for ${repo.owner}/${repo.name} took ${took} ms`);
		}
		return;
	}

	// A crash in batch mode may have left a landing half done, even if the repo switched mode since.
	try {
		await withRepoLock(repo.id, () => recoverInterrupted(liveDeps(repo)));
	} catch (err) {
		console.error(`[merge-queue] Recovery for ${repo.owner}/${repo.name} failed:`, err instanceof Error ? err.message : err);
	}

	// Reconcile ALL queued items (not just head) to detect externally merged/closed PRs
	const allItems = db.getQueueItems(repo.id);
	for (const item of allItems) {
		try {
			const pr = await github.getPR(repo.owner, repo.name, item.pr_number);
			await reconcilePR(pr, repo, item);
		} catch (err) {
			console.error(`[merge-queue] Reconcile error for #${item.pr_number}:`, err instanceof Error ? err.message : err);
		}
	}

	// Now process the head of the queue
	const item = db.getActiveQueueItem(repo.id);
	if (!item) return;

	try {
		switch (item.status) {
			case 'queued':
				await handleQueued(repo, item);
				break;
			case 'updating':
				await handleUpdating(repo, item);
				break;
			case 'checking':
				await handleChecking(repo, item);
				break;
			case 'merging':
				await handleMerging(repo, item);
				break;
			case 'conflict':
				await handleConflict(repo, item);
				break;
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		// Don't fail permanently on transient GitHub API errors (or a rate limit) — retry next cycle
		if (err instanceof RateLimitedError || /GitHub API (5\d\d|timeout)/i.test(msg)) {
			console.warn(`[merge-queue] Transient error for #${item.pr_number}, will retry: ${msg}`);
			return;
		}
		console.error(
			`[merge-queue] Error processing ${repo.owner}/${repo.name}#${item.pr_number}: ${msg}`
		);
		db.updateQueueItemStatus(item.id, 'failed', msg);
	}
}

// Returns true if the PR was closed/merged externally and the item was handled
async function reconcilePR(
	pr: {
		number: number;
		state: string;
		merged: boolean;
		merge_commit_sha: string | null;
		closed_at: string | null;
		head: { ref: string; sha: string };
		base: { ref: string };
	},
	repo: RepoRef,
	item: { id: number; pr_number: number; pr_title: string; pr_url: string; author_login: string; created_at: string }
): Promise<boolean> {
	if (pr.state === 'open') return false;

	if (pr.merged) {
		console.log(`[merge-queue] PR #${item.pr_number} was merged externally`);
		db.removeFromQueue(item.id);
		try {
			db.addToHistory(
				repo.id,
				item.pr_number,
				item.pr_title,
				item.pr_url,
				item.author_login,
				pr.merge_commit_sha,
				'merged',
				null,
				item.created_at
			);
		} catch (err) {
			console.error(`[merge-queue] Failed to add history for #${item.pr_number}:`, err instanceof Error ? err.message : err);
		}
	} else {
		db.updateQueueItemStatus(item.id, 'cancelled', await closedPRReason(repo, pr));
	}

	return true;
}

async function handleQueued(
	repo: RepoRef,
	item: {
		id: number;
		pr_number: number;
		pr_title: string;
		pr_url: string;
		author_login: string;
		head_sha: string | null;
		created_at: string;
		error_message?: string | null;
	}
) {
	console.log(`[merge-queue] Processing ${repo.owner}/${repo.name}#${item.pr_number}`);
	const pr = await github.getPR(repo.owner, repo.name, item.pr_number);

	if (await reconcilePR(pr, repo, item)) return;

	// GitHub's base field can't be trusted for stacks, so check ancestry:
	// a PR sitting on an unmerged or rewritten PR must not be merged yet. It
	// stays queued but moves to the back, so the PRs behind it go first; a
	// failed check (rate limit, GitHub hiccup) is retried next cycle, never a failure.
	let stackBlocker: string | null = null;
	try {
		stackBlocker = await stackMergeBlocker(repo, item.pr_number);
	} catch (err) {
		console.warn(`[merge-queue] Stack check for #${item.pr_number} failed, will retry: ${err instanceof Error ? err.message : err}`);
		return;
	}
	if (stackBlocker) {
		const msg = `Stacked PR: ${stackBlocker}`;
		if (item.error_message !== msg) db.updateQueueItemStatus(item.id, 'queued', msg);
		const order = db.getQueueItems(repo.id).map((i) => i.id);
		if (order[order.length - 1] !== item.id) db.reorderQueue(repo.id, [...order.filter((id) => id !== item.id), item.id]);
		return;
	}

	if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
		db.updateQueueItemStatus(item.id, 'conflict', 'Branch has merge conflicts — resolve them on GitHub');
		return;
	}

	if (pr.mergeable_state === 'clean' || pr.mergeable_state === 'unstable') {
		db.updateQueueItemHeadSha(item.id, pr.head.sha);
		db.updateQueueItemStatus(item.id, 'checking');
		return;
	}

	try {
		await github.updateBranch(repo.owner, repo.name, item.pr_number);
		db.updateQueueItemStatus(item.id, 'updating');
	} catch {
		db.updateQueueItemHeadSha(item.id, pr.head.sha);
		db.updateQueueItemStatus(item.id, 'checking');
	}
}

async function handleUpdating(
	repo: RepoRef,
	item: {
		id: number;
		pr_number: number;
		pr_title: string;
		pr_url: string;
		author_login: string;
		created_at: string;
	}
) {
	const pr = await github.getPR(repo.owner, repo.name, item.pr_number);

	if (await reconcilePR(pr, repo, item)) return;

	if (pr.mergeable === null) return;

	if (pr.mergeable === false) {
		db.updateQueueItemStatus(item.id, 'conflict', 'Branch has merge conflicts — resolve them on GitHub');
		return;
	}

	db.updateQueueItemHeadSha(item.id, pr.head.sha);
	db.updateQueueItemStatus(item.id, 'checking');
}

async function handleConflict(
	repo: RepoRef,
	item: { id: number; pr_number: number; pr_title: string; pr_url: string; author_login: string; created_at: string }
) {
	const pr = await github.getPR(repo.owner, repo.name, item.pr_number);

	if (await reconcilePR(pr, repo, item)) return;

	// mergeable is null while GitHub is computing — wait for next cycle
	if (pr.mergeable === null) return;

	if (pr.mergeable === true) {
		console.log(`[merge-queue] Conflict resolved for ${repo.owner}/${repo.name}#${item.pr_number}`);
		db.updateQueueItemStatus(item.id, 'queued');
	}
}

async function handleChecking(
	repo: RepoRef,
	item: {
		id: number;
		pr_number: number;
		pr_title: string;
		pr_url: string;
		author_login: string;
		head_sha: string | null;
		created_at: string;
	}
) {
	if (!item.head_sha) {
		const pr = await github.getPR(repo.owner, repo.name, item.pr_number);
		if (await reconcilePR(pr, repo, item)) return;
		db.updateQueueItemHeadSha(item.id, pr.head.sha);
		return;
	}

	// Check if PR was merged/closed externally
	const pr = await github.getPR(repo.owner, repo.name, item.pr_number);
	if (await reconcilePR(pr, repo, item)) return;

	const checks = await github.getCheckStatus(repo.owner, repo.name, item.head_sha);

	if (checks.anyPending) return;

	if (checks.anyFailed) {
		db.updateQueueItemStatus(item.id, 'failed', 'CI checks failed');
		return;
	}

	db.updateQueueItemStatus(item.id, 'merging');
}

async function handleMerging(
	repo: RepoRef,
	item: {
		id: number;
		pr_number: number;
		pr_title: string;
		pr_url: string;
		author_login: string;
		created_at: string;
	}
) {
	console.log(`[merge-queue] Merging ${repo.owner}/${repo.name}#${item.pr_number}`);
	const result = await github.mergePR(repo.owner, repo.name, item.pr_number);

	if (result.merged) {
		db.updateQueueItemStatus(item.id, 'merged');
		db.addToHistory(
			repo.id,
			item.pr_number,
			item.pr_title,
			item.pr_url,
			item.author_login,
			result.sha,
			'merged',
			null,
			item.created_at
		);
		db.removeFromQueue(item.id);
		console.log(`[merge-queue] Merged ${repo.owner}/${repo.name}#${item.pr_number}`);
	} else {
		db.updateQueueItemStatus(item.id, 'failed', result.message || 'Merge failed');
	}
}
