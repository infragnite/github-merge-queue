import { env } from '$env/dynamic/private';
import * as db from './db';
import * as github from './github';
import { closedPRReason, stackMergeBlocker } from './stack-runtime';

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

async function processAll() {
	if (running) return;
	running = true;

	try {
		const repos = db.getRepos();
		for (const repo of repos) {
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
	} catch (err) {
		console.error(`[merge-queue] Head polling failed for ${repo.owner}/${repo.name}:`, err instanceof Error ? err.message : err);
	}
}

async function processRepo(repo: ReturnType<typeof db.getRepos>[number]) {
	await recordOpenPRHeads(repo);

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
		// Don't fail permanently on transient GitHub API errors — retry next cycle
		if (/GitHub API (5\d\d|timeout)/i.test(msg)) {
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
	item: { id: number; pr_number: number; pr_title: string; pr_url: string; author_login: string; head_sha: string | null; created_at: string }
) {
	console.log(`[merge-queue] Processing ${repo.owner}/${repo.name}#${item.pr_number}`);
	const pr = await github.getPR(repo.owner, repo.name, item.pr_number);

	if (await reconcilePR(pr, repo, item)) return;

	// GitHub's base field can't be trusted for stacks, so check ancestry:
	// a PR sitting on an unmerged or rewritten PR must not be merged.
	const stackBlocker = await stackMergeBlocker(repo, item.pr_number);
	if (stackBlocker) {
		db.updateQueueItemStatus(item.id, 'failed', `Stacked PR: ${stackBlocker}`);
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
