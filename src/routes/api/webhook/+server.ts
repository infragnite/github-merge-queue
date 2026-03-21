import { json } from '@sveltejs/kit';
import { createHmac } from 'crypto';
import { env } from '$env/dynamic/private';
import {
	getRepoByOwnerName,
	getQueueItems,
	updateQueueItemStatus,
	updateQueueItemHeadSha,
	addToHistory,
	removeFromQueue
} from '$lib/server/db';
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

	const queueItems = getQueueItems(repo.id);
	if (queueItems.length === 0) return json({ ok: true });

	switch (event) {
		case 'check_suite':
		case 'check_run': {
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
			const action = (payload as { action: string }).action;
			const pr = (payload as { pull_request: { number: number; merged: boolean; merge_commit_sha: string | null } }).pull_request;
			const item = queueItems.find((i) => i.pr_number === pr.number);

			if (item) {
				if (action === 'closed' && pr.merged) {
					updateQueueItemStatus(item.id, 'merged');
					addToHistory(
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
					removeFromQueue(item.id);
					console.log(`[webhook] PR #${pr.number} merged externally, removed from queue`);
				} else if (action === 'closed') {
					updateQueueItemStatus(item.id, 'cancelled', 'PR was closed');
					console.log(`[webhook] PR #${pr.number} closed, removed from queue`);
				} else if (action === 'synchronize') {
					const newSha = (
						payload as { pull_request: { head: { sha: string } } }
					).pull_request.head.sha;
					updateQueueItemHeadSha(item.id, newSha);
					if (item.status === 'checking') {
						updateQueueItemStatus(item.id, 'queued');
					}
					console.log(`[webhook] PR #${pr.number} updated, new SHA: ${newSha.slice(0, 8)}`);
				}
			}
			break;
		}

		case 'status': {
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
