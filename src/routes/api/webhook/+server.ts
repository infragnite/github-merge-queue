import { json } from '@sveltejs/kit';
import { createHmac } from 'crypto';
import { env } from '$env/dynamic/private';
import {
	getRepoByOwnerName,
	getQueueItems,
	updateQueueItemStatus,
	updateQueueItemHeadSha,
	addToHistory,
	removeFromQueue,
	addToQueue,
	recordPRHead,
	recordBranchDeleted
} from '$lib/server/db';
import { closedPRReason } from '$lib/server/stack-runtime';
import { getActiveBatches, getQueueSettings, updateQueueSettings } from '$lib/server/batch-store';
import { forgetVisibility } from '$lib/server/public-view';
import { bumpGeneration, markDirty } from '$lib/server/wake';
import { commentFromPayload } from '$lib/server/pr-commands';
import { runLiveCommand } from '$lib/server/pr-commands-live';
import type { RequestHandler } from './$types';

function verifySignature(payload: string, signature: string | null, secret: string): boolean {
	if (!signature) return false;
	const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
	if (signature.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < signature.length; i++) {
		diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Events that can change what the batch queue should do next. Not the queue's own `mq/*` pushes
 * and branch deletions, nor each job's check_run: a PR change, a review, master moving, or a
 * queue branch's checks finishing.
 */
function wakesQueue(event: string | null, payload: Record<string, unknown>): boolean {
	const defaultBranch = (payload.repository as { default_branch?: string } | undefined)?.default_branch;
	switch (event) {
		case 'pull_request':
		case 'pull_request_review':
			return true;
		case 'push':
			return !!defaultBranch && payload.ref === `refs/heads/${defaultBranch}`;
		case 'check_suite': {
			const branch = (payload.check_suite as { head_branch?: string | null } | undefined)?.head_branch ?? '';
			return payload.action === 'completed' && branch.startsWith('mq/');
		}
		default:
			return false;
	}
}

/** Events after which PR state derived earlier (stacks, reviews) is stale. */
function changesPRs(event: string | null, payload: Record<string, unknown>): boolean {
	if (event === 'push' || event === 'delete') {
		const ref = String(payload.ref ?? '');
		return !ref.startsWith('refs/heads/mq/') && !ref.startsWith('mq/');
	}
	return event === 'pull_request' || event === 'pull_request_review';
}

export const POST: RequestHandler = async ({ request }) => {
	const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
	if (!webhookSecret) return json({ error: 'Webhook secret not configured' }, { status: 500 });

	const body = await request.text();
	const event = request.headers.get('x-github-event');
	const signature = request.headers.get('x-hub-signature-256');

	// Mandatory signature verification
	if (!verifySignature(body, signature, webhookSecret)) {
		return json({ error: 'Invalid signature' }, { status: 401 });
	}

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(body);
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const repository = payload.repository as { full_name?: string } | undefined;
	if (!repository?.full_name || !repository.full_name.includes('/')) return json({ ok: true });

	const [owner, name] = repository.full_name.split('/');
	const repo = getRepoByOwnerName(owner, name);
	if (!repo) return json({ ok: true });
	if (changesPRs(event, payload)) bumpGeneration(repo.id);
	if (wakesQueue(event, payload)) {
		markDirty(repo.id);
		if (event === 'check_suite') {
			const branch = (payload.check_suite as { head_branch?: string } | undefined)?.head_branch;
			console.log(`[webhook] ${owner}/${name}: CI finished on ${branch}; waking the queue`);
		}
	}

	const queueItems = getQueueItems(repo.id);

	switch (event) {
		case 'repository': {
			// A repository made private can't keep a public queue page.
			const action = (payload as { action?: string }).action;
			if ((action === 'privatized' || (payload.repository as { private?: boolean }).private === true) && getQueueSettings(repo.id).publicView) {
				updateQueueSettings(repo.id, { publicView: false });
				forgetVisibility(repo.id);
				console.warn(`[webhook] ${owner}/${name} is now private: its public queue page is turned off`);
			}
			break;
		}

		case 'check_suite':
		case 'check_run': {
			if (queueItems.length === 0) break;
			const headSha =
				(payload as { check_suite?: { head_sha: string }; check_run?: { head_sha: string } })
					.check_suite?.head_sha ||
				(payload as { check_run?: { head_sha: string } }).check_run?.head_sha;
			if (headSha) {
				const item = queueItems.find((i) => i.head_sha === headSha && i.status === 'checking');
				if (item) {
					console.log(`[webhook] Check event for ${owner}/${name}#${item.pr_number}`);
				}
			}
			break;
		}

		case 'pull_request': {
			try {
				const action = (payload as { action: string }).action;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const pullRequest = (payload as any).pull_request;
				const prNumber = pullRequest?.number as number;
				const prUser = pullRequest?.user;

				if (!prNumber) break;

				// Head history for stack detection: `before` is the pre-push head
				// on synchronize, which is what a child of this PR still sits on.
				if (pullRequest.head?.sha) recordPRHead(repo.id, prNumber, pullRequest.head.sha);
				const before = (payload as { before?: string }).before;
				if (action === 'synchronize' && before) recordPRHead(repo.id, prNumber, before);

				// Auto-add dependabot PRs to the queue
				if (action === 'opened' && prUser?.login === 'dependabot[bot]' && !pullRequest.draft) {
					const alreadyQueued = queueItems.some((i) => i.pr_number === prNumber);
					if (!alreadyQueued) {
						addToQueue(
							repo.id,
							prNumber,
							pullRequest.title || `Dependabot PR #${prNumber}`,
							pullRequest.html_url || `https://github.com/${owner}/${name}/pull/${prNumber}`,
							prUser.login,
							prUser.avatar_url || '',
							'auto (dependabot)'
						);
						console.log(`[webhook] Auto-queued dependabot PR #${prNumber}: ${pullRequest.title}`);
					}
					break;
				}

				const item = queueItems.find((i) => i.pr_number === prNumber);

				// The queue's own landing: it records that merge itself once GitHub confirms it.
				const landing =
					action === 'closed' && pullRequest.merged && getActiveBatches(repo.id).some((b) => b.members.includes(prNumber));

				if (item && !landing) {
					if (action === 'closed' && pullRequest.merged) {
						updateQueueItemStatus(item.id, 'merged');
						addToHistory(
							repo.id,
							item.pr_number,
							item.pr_title,
							item.pr_url,
							item.author_login,
							pullRequest.merge_commit_sha,
							'merged',
							null,
							item.created_at
						);
						removeFromQueue(item.id);
						console.log(`[webhook] PR #${prNumber} merged externally, removed from queue`);
					} else if (action === 'closed') {
						const reason = await closedPRReason(repo, pullRequest);
						updateQueueItemStatus(item.id, 'cancelled', reason);
						console.log(`[webhook] PR #${prNumber} closed, removed from queue: ${reason}`);
					} else if (action === 'synchronize') {
						const newSha = pullRequest.head?.sha;
						if (newSha) {
							// In batch mode the queue itself notices a stale head when it lands
							// (and rebuilds); resetting a batch member here could plan it twice.
							const batchMode = getQueueSettings(repo.id).mode === 'batch';
							if (!batchMode) updateQueueItemHeadSha(item.id, newSha);
							if (item.status === 'checking' && !batchMode) {
								updateQueueItemStatus(item.id, 'queued');
							}
							console.log(`[webhook] PR #${prNumber} updated, new SHA: ${newSha.slice(0, 8)}`);
						}
					}
				}
			} catch (err) {
				console.error(`[webhook] Error handling pull_request event:`, err instanceof Error ? err.message : err);
			}
			break;
		}

		case 'issue_comment': {
			// A `/mq` command. It runs after GitHub has its answer: role lookups, the try run's
			// build and the reply can take longer than GitHub waits for a webhook.
			const comment = commentFromPayload(payload);
			if (comment) {
				void runLiveCommand(repo, comment).catch((err) =>
					console.error(`[webhook] /mq command on ${owner}/${name}#${comment.pr}:`, err instanceof Error ? err.message : err)
				);
			}
			break;
		}

		case 'delete': {
			// A deleted branch closes every PR based on it (unless GitHub
			// retargets them after a merge); remember when, to explain it.
			const { ref, ref_type } = payload as { ref?: string; ref_type?: string };
			if (ref_type === 'branch' && ref) recordBranchDeleted(repo.id, ref);
			break;
		}

		case 'status': {
			if (queueItems.length === 0) break;
			const sha = (payload as { sha: string }).sha;
			const item = queueItems.find((i) => i.head_sha === sha && i.status === 'checking');
			if (item) {
				console.log(`[webhook] Status event for ${owner}/${name}#${item.pr_number}`);
			}
			break;
		}
	}

	return json({ ok: true });
};
