import { env } from '$env/dynamic/private';
import * as db from './db';
import * as github from './github';

let intervalId: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startProcessor() {
	if (intervalId) return;
	const interval = parseInt(env.PROCESSOR_INTERVAL || '15', 10) * 1000;
	console.log(`[merge-queue] Processor started (interval: ${interval / 1000}s)`);
	intervalId = setInterval(processAll, interval);
	// First run after a short delay to let the server start
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

async function processRepo(repo: ReturnType<typeof db.getRepos>[number]) {
	const item = db.getActiveQueueItem(repo.id);
	if (!item) return;

	const user = db.getUserById(repo.added_by);
	if (!user) return;

	try {
		switch (item.status) {
			case 'queued':
				await handleQueued(repo, item, user.access_token);
				break;
			case 'updating':
				await handleUpdating(repo, item, user.access_token);
				break;
			case 'checking':
				await handleChecking(repo, item, user.access_token);
				break;
			case 'merging':
				await handleMerging(repo, item, user.access_token);
				break;
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[merge-queue] Error processing ${repo.owner}/${repo.name}#${item.pr_number}: ${msg}`);
		db.updateQueueItemStatus(item.id, 'failed', msg);
		db.addToHistory(
			repo.id, item.pr_number, item.pr_title, item.pr_url,
			item.author_login, null, 'failed', msg, item.created_at
		);
	}
}

async function handleQueued(
	repo: { owner: string; name: string },
	item: { id: number; pr_number: number; head_sha: string | null },
	token: string
) {
	console.log(`[merge-queue] Processing ${repo.owner}/${repo.name}#${item.pr_number}`);
	const pr = await github.getPR(token, repo.owner, repo.name, item.pr_number);

	if (pr.state !== 'open') {
		db.updateQueueItemStatus(item.id, 'cancelled', `PR is ${pr.state}`);
		return;
	}

	// If already mergeable, skip straight to checking CI
	if (pr.mergeable_state === 'clean' || pr.mergeable_state === 'unstable') {
		db.updateQueueItemHeadSha(item.id, pr.head.sha);
		db.updateQueueItemStatus(item.id, 'checking');
		return;
	}

	try {
		await github.updateBranch(token, repo.owner, repo.name, item.pr_number);
		db.updateQueueItemStatus(item.id, 'updating');
	} catch {
		// Branch might already be up to date, try checking directly
		db.updateQueueItemHeadSha(item.id, pr.head.sha);
		db.updateQueueItemStatus(item.id, 'checking');
	}
}

async function handleUpdating(
	repo: { owner: string; name: string },
	item: { id: number; pr_number: number; pr_title: string; pr_url: string; author_login: string; created_at: string },
	token: string
) {
	const pr = await github.getPR(token, repo.owner, repo.name, item.pr_number);

	if (pr.mergeable === null) return; // GitHub still computing

	if (pr.mergeable === false) {
		db.updateQueueItemStatus(item.id, 'failed', 'Merge conflicts detected');
		db.addToHistory(
			repo.id as number, item.pr_number, item.pr_title, item.pr_url,
			item.author_login, null, 'failed', 'Merge conflicts', item.created_at
		);
		return;
	}

	db.updateQueueItemHeadSha(item.id, pr.head.sha);
	db.updateQueueItemStatus(item.id, 'checking');
}

async function handleChecking(
	repo: { id: number; owner: string; name: string },
	item: { id: number; pr_number: number; pr_title: string; pr_url: string; author_login: string; head_sha: string | null; created_at: string },
	token: string
) {
	if (!item.head_sha) {
		const pr = await github.getPR(token, repo.owner, repo.name, item.pr_number);
		db.updateQueueItemHeadSha(item.id, pr.head.sha);
		return;
	}

	const checks = await github.getCheckStatus(token, repo.owner, repo.name, item.head_sha);

	if (checks.anyPending) return; // Still running

	if (checks.anyFailed) {
		db.updateQueueItemStatus(item.id, 'failed', 'CI checks failed');
		db.addToHistory(
			repo.id, item.pr_number, item.pr_title, item.pr_url,
			item.author_login, null, 'failed', 'CI checks failed', item.created_at
		);
		return;
	}

	db.updateQueueItemStatus(item.id, 'merging');
}

async function handleMerging(
	repo: { id: number; owner: string; name: string },
	item: { id: number; pr_number: number; pr_title: string; pr_url: string; author_login: string; created_at: string },
	token: string
) {
	console.log(`[merge-queue] Merging ${repo.owner}/${repo.name}#${item.pr_number}`);
	const result = await github.mergePR(token, repo.owner, repo.name, item.pr_number);

	if (result.merged) {
		db.updateQueueItemStatus(item.id, 'merged');
		db.addToHistory(
			repo.id, item.pr_number, item.pr_title, item.pr_url,
			item.author_login, result.sha, 'merged', null, item.created_at
		);
		db.removeFromQueue(item.id);
		console.log(`[merge-queue] Merged ${repo.owner}/${repo.name}#${item.pr_number}`);
	} else {
		db.updateQueueItemStatus(item.id, 'failed', result.message || 'Merge failed');
		db.addToHistory(
			repo.id, item.pr_number, item.pr_title, item.pr_url,
			item.author_login, null, 'failed', result.message, item.created_at
		);
	}
}
