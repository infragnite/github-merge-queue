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
import { changesBranchRules, forgetPushPolicy } from '$lib/server/push-policy';
import { bumpGeneration, markDirty } from '$lib/server/wake';
import { commentFromPayload } from '$lib/server/pr-commands';
import { runLiveCommand } from '$lib/server/pr-commands-live';
import { log } from '$lib/server/log';
import { recordWebhook } from '$lib/server/telemetry';
import type { RequestHandler } from './$types';

/**
 * Deliveries that fail the signature check (or don't parse) come from anyone who can reach the
 * endpoint: logged at most once a minute, with how many were left out since, so they can't flood
 * the logs. They are all counted in the metrics.
 */
const UNSIGNED_LOG_MS = 60_000;
let unsigned = { at: -Infinity, leftOut: 0 };
function logUnsigned(): number | undefined | false {
	const now = Date.now();
	if (now - unsigned.at < UNSIGNED_LOG_MS) {
		unsigned.leftOut++;
		return false;
	}
	const leftOut = unsigned.leftOut || undefined;
	unsigned = { at: now, leftOut: 0 };
	return leftOut;
}

/** The PR a delivery is about, when it is about one. */
function prOf(payload: Record<string, unknown>): number | undefined {
	const n = (payload.pull_request as { number?: number } | undefined)?.number ?? (payload.issue as { number?: number } | undefined)?.number;
	return typeof n === 'number' ? n : undefined;
}

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
	// GitHub's id of this delivery: what to look up under the App's "Recent Deliveries" (kept there a few days).
	const delivery = request.headers.get('x-github-delivery') ?? undefined;
	const noted = (outcome: string, fields: Record<string, unknown> = {}, level: 'info' | 'warn' = 'info') => {
		// Before the signature is checked the event header is anyone's text: not a label then.
		recordWebhook(level === 'warn' ? 'unverified' : (event ?? 'unknown'), outcome);
		if (level === 'warn') {
			const leftOut = logUnsigned();
			if (leftOut === false) return;
			fields = { ...fields, left_out: leftOut };
		}
		log[level]('webhook delivery', { delivery, event: event ?? undefined, outcome, ...fields });
	};

	// Mandatory signature verification
	if (!verifySignature(body, signature, webhookSecret)) {
		noted('bad-signature', {}, 'warn');
		return json({ error: 'Invalid signature' }, { status: 401 });
	}

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(body);
	} catch {
		noted('bad-json', {}, 'warn');
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const action = typeof payload.action === 'string' ? payload.action : undefined;
	const repository = payload.repository as { full_name?: string } | undefined;
	if (!repository?.full_name || !repository.full_name.includes('/')) {
		noted('no-repo', { action });
		return json({ ok: true });
	}

	const [owner, name] = repository.full_name.split('/');
	const repo = getRepoByOwnerName(owner, name);
	if (!repo) {
		noted('unknown-repo', { action, repo: repository.full_name, pr: prOf(payload) });
		return json({ ok: true });
	}
	noted('handled', { action, repo: repository.full_name, pr: prOf(payload) });
	if (changesPRs(event, payload)) bumpGeneration(repo.id);
	if (changesBranchRules(event)) forgetPushPolicy(repo.id);
	if (wakesQueue(event, payload)) {
		markDirty(repo.id);
		if (event === 'check_suite') {
			const branch = (payload.check_suite as { head_branch?: string } | undefined)?.head_branch;
			log.info('CI finished on a queue branch; waking the queue', { repo: `${owner}/${name}`, branch, delivery });
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
				log.warn('repository is now private: its public queue page is turned off', { repo: `${owner}/${name}`, delivery });
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
					log.debug('check event for a queued PR', { repo: `${owner}/${name}`, pr: item.pr_number, delivery });
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
						log.info('queued a dependabot PR', { repo: `${owner}/${name}`, pr: prNumber, title: pullRequest.title, delivery });
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
						log.info('PR merged outside the queue; removed from it', { repo: `${owner}/${name}`, pr: prNumber, delivery });
					} else if (action === 'closed') {
						const reason = await closedPRReason(repo, pullRequest);
						updateQueueItemStatus(item.id, 'cancelled', reason);
						log.info('PR closed; removed from the queue', { repo: `${owner}/${name}`, pr: prNumber, reason, delivery });
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
							log.info('PR pushed to', { repo: `${owner}/${name}`, pr: prNumber, sha: newSha, delivery });
						}
					}
				}
			} catch (err) {
				log.error('handling a pull_request delivery failed', { repo: `${owner}/${name}`, delivery, err });
			}
			break;
		}

		case 'issue_comment': {
			// A `/mq` command. It runs after GitHub has its answer: role lookups, the try run's
			// build and the reply can take longer than GitHub waits for a webhook.
			const comment = commentFromPayload(payload);
			if (comment) {
				void runLiveCommand(repo, comment).catch((err) =>
					log.error('/mq command failed', { repo: `${owner}/${name}`, pr: comment.pr, delivery, err })
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
				log.debug('status event for a queued PR', { repo: `${owner}/${name}`, pr: item.pr_number, delivery });
			}
			break;
		}
	}

	return json({ ok: true });
};
