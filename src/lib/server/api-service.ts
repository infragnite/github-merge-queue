// What the agent API returns and does. Route handlers in src/routes/api/v1
// only parse requests and call these; everything here reads the same state
// the queue acts on (stack analysis, queue items, batches).

import * as db from './db';
import * as store from './batch-store';
import { emitEvent, waitForEvents } from './events';
import { noteVisibility } from './public-view';
import { requireRole, type Caller } from './api-auth';
import { COMMENT_MODES, DEFAULT_BATCH_CONFIG, type BatchConfig, type CommentMode, type Priority } from './batching';
import type { BatchRow } from './batch-store';
import type { PRStackInfo, StackAnalysis, StackIssue } from './stacks';
import type { QueueItem, Repo } from '$lib/types';

export class ApiError extends Error {
	constructor(
		readonly status: 400 | 404 | 409,
		message: string
	) {
		super(message);
	}
}

export type NextAction =
	| { do: 'restack'; onto: string; cmd: string; why: string }
	| { do: 'retarget-base'; base: string; why: string }
	| { do: 'wait-for'; pr: number; why: string }
	| { do: 'queue'; pr: number; why: string }
	| { do: 'fix'; why: string }
	| { do: 'mark-ready'; why: string }
	| { do: 'resolve-conflict'; cmd: string; why: string };

type Q = QueueItem & { priority?: Priority };

/** A batch's PRs still in it: not landed from a bisection, nor back in line or ejected. */
function inBatchNow(b: BatchRow): number[] {
	return b.members.filter((n) => !b.landed.includes(n) && !b.left_prs.includes(n));
}

function queueEntry(repoId: number, n: number) {
	const items = db.getQueueItems(repoId) as Q[];
	const waiting = items.filter((i) => ['queued', 'checking', 'updating', 'merging', 'conflict'].includes(i.status));
	const idx = waiting.findIndex((i) => i.pr_number === n);
	if (idx < 0) return null;
	const it = waiting[idx];
	const batch = store.getActiveBatches(repoId).find((b) => inBatchNow(b).includes(n));
	return {
		status: batch ? 'testing' : it.status,
		position: idx + 1,
		priority: it.priority ?? 'normal',
		enqueuedAt: it.created_at,
		lastMessage: it.error_message,
		batch: batch ? batchSummary(batch) : null
	};
}

function nextActions(info: PRStackInfo, analysis: StackAnalysis, defaultBranch: string, queued: Set<number>): NextAction[] {
	const out: NextAction[] = [];
	const issue = (k: StackIssue['kind']) => info.issues.find((i) => i.kind === k);
	const p = info.parent;
	const rebased = issue('parent-rebased');
	if (rebased && p !== null) {
		const stale = rebased.staleCommits ?? [];
		const upstream = stale.length ? stale.at(-1)! : `<last commit of #${p} in your branch>`;
		out.push({
			do: 'restack',
			onto: `#${p}`,
			cmd: `git fetch origin pull/${p}/head && git rebase --onto FETCH_HEAD ${upstream}`,
			why: rebased.message
		});
	}
	const merged = issue('parent-merged');
	if (merged) {
		out.push({
			do: 'restack',
			onto: defaultBranch,
			cmd: `git fetch origin ${defaultBranch} && git rebase origin/${defaultBranch}`,
			why: merged.message
		});
	}
	if (issue('parent-closed')) out.push({ do: 'fix', why: issue('parent-closed')!.message });
	if (issue('base-branch-missing')) out.push({ do: 'retarget-base', base: info.expectedBase, why: issue('base-branch-missing')!.message });
	const mismatch = issue('base-mismatch');
	if (mismatch && p === null) out.push({ do: 'retarget-base', base: info.expectedBase, why: mismatch.message });
	if (p !== null && analysis.prs.has(p) && !rebased) {
		out.push(
			queued.has(p)
				? { do: 'wait-for', pr: p, why: `Stacked on #${p}; the queue lands #${p} first, or in the same batch` }
				: { do: 'queue', pr: p, why: `Stacked on #${p}, which isn't queued; queue #${p} so this PR can follow it` }
		);
	}
	return out;
}

/** What the queue itself is waiting on from the author, if anything. */
function queueActions(repo: Repo, n: number, info: PRStackInfo): NextAction[] {
	const it = db.getQueueItems(repo.id).find((i) => i.pr_number === n);
	if (!it) return [];
	const hold = store.currentHold(it);
	if (hold) return holdActions(it, hold);
	if (it.status !== 'conflict') return [];
	const onto = info.parent !== null ? `pull/${info.parent}/head` : repo.default_branch;
	return [
		{
			do: 'resolve-conflict',
			cmd: `git fetch origin ${onto} && git rebase FETCH_HEAD && git push --force-with-lease`,
			why: it.error_message ?? 'The queue could not apply this PR'
		}
	];
}

/**
 * What the PR's author does about the planner's hold on it. Holds that come from the stack (a
 * parent to queue or restack) are covered by the stack's own next actions.
 */
function holdActions(it: QueueItem, hold: store.Hold): NextAction[] {
	switch (hold.code) {
		case 'draft':
			return [{ do: 'mark-ready', why: hold.reason }];
		case 'ci-failed':
		case 'not-approved':
		case 'stale-approval':
		case 'changes-requested':
			return [{ do: 'fix', why: hold.reason }];
		case 'deferred': {
			// It conflicts with PRs ahead of it: rebased onto them, it is stacked on them and follows them.
			const ahead = store.deferredFor(it as QueueItem & { deferred_for?: string | null });
			return ahead.map((p) => ({ do: 'resolve-conflict' as const, cmd: `git fetch origin pull/${p}/head && git rebase FETCH_HEAD && git push --force-with-lease`, why: hold.reason }));
		}
		default:
			return [];
	}
}

/** Stack and queue state of one PR, with what to do next. */
export function stackState(repo: Repo, n: number, analysis: StackAnalysis) {
	const info = analysis.prs.get(n);
	if (!info) throw new ApiError(404, `#${n} is not an open pull request in ${repo.owner}/${repo.name}`);
	const queued = new Set(db.getQueueItems(repo.id).map((i) => i.pr_number));
	// The stack from its root down, parents before children.
	let root = n;
	while (analysis.prs.get(root)?.parent != null && analysis.prs.has(analysis.prs.get(root)!.parent!)) {
		root = analysis.prs.get(root)!.parent!;
	}
	return {
		asOf: new Date().toISOString(),
		number: n,
		parent: info.parent,
		children: info.children,
		depth: info.depth,
		link: info.link,
		broken: info.broken,
		expectedBase: info.expectedBase,
		stack: tree(analysis, root),
		issues: info.issues,
		queue: queueEntry(repo.id, n),
		nextActions: [...queueActions(repo, n, info), ...nextActions(info, analysis, repo.default_branch, queued)]
	};
}

export interface StackTree {
	pr: number;
	link: PRStackInfo['link'];
	broken: boolean;
	children: StackTree[];
}

function tree(analysis: StackAnalysis, n: number): StackTree {
	const info = analysis.prs.get(n)!;
	return {
		pr: n,
		link: info.link,
		broken: info.broken,
		children: [...info.children].sort((a, b) => a - b).map((c) => tree(analysis, c))
	};
}

/** Every open stack (two or more PRs) as a tree. */
export function stacksState(analysis: StackAnalysis) {
	return { asOf: new Date().toISOString(), stacks: analysis.stacks.map((s) => tree(analysis, s[0])) };
}

export function batchSummary(b: BatchRow) {
	return {
		id: b.id,
		/** As shown in the app: counts only this repository's batches. */
		number: b.number,
		branch: b.branch,
		status: b.status,
		express: b.express,
		prs: b.members,
		baseSha: b.base_sha,
		headSha: b.head_sha,
		ci: b.ci_result,
		createdAt: b.created_at,
		finishedAt: b.finished_at
	};
}

export function queueState(repo: Repo) {
	const s = store.getQueueSettings(repo.id);
	const inBatch = new Set(store.getActiveBatches(repo.id).flatMap(inBatchNow));
	const waiting = (db.getQueueItems(repo.id) as Q[])
		.filter((i) => !['merged', 'failed', 'cancelled'].includes(i.status))
		.map((i, idx) => ({
			pr: i.pr_number,
			title: i.pr_title,
			position: idx + 1,
			priority: i.priority ?? 'normal',
			status: inBatch.has(i.pr_number) ? 'testing' : i.status,
			enqueuedAt: i.created_at,
			lastMessage: i.error_message
		}));
	return {
		asOf: new Date().toISOString(),
		mode: s.mode,
		paused: s.pausedReason,
		/** The default branch as the queue knows it; on 'red' the queue looks for a batch that fixes it. */
		defaultBranch: store.getMasterHealth(repo.id),
		inFlight: store.getActiveBatches(repo.id).map(batchSummary),
		waiting
	};
}

/** A batch by its number, as the app and PR statuses show it (not its `id`). */
export function batchByNumber(repo: Repo, number: number): BatchRow {
	const b = store.getBatchByNumber(repo.id, number);
	if (!b) throw new ApiError(404, `No batch #${number}`);
	return b;
}

export function batchDetail(repo: Repo, number: number) {
	const b = batchByNumber(repo, number);
	return {
		...batchSummary(b),
		bisection: store.getBisectRuns(b.id).map((r) => ({ ...batchSummary(r), context: r.context }))
	};
}

const PRIORITIES: Priority[] = ['urgent', 'normal', 'low'];

function parsePriority(v: unknown): Priority {
	if (v === undefined) return 'normal';
	if (typeof v !== 'string' || !PRIORITIES.includes(v as Priority)) {
		throw new ApiError(400, `priority must be one of ${PRIORITIES.join(', ')}`);
	}
	return v as Priority;
}

export function enqueue(
	repo: Repo,
	caller: Caller,
	pr: { number: number; title: string; html_url: string; state: string; user: { login: string; avatar_url: string } },
	body: { priority?: unknown }
) {
	requireRole(caller, 'write', 'Queueing a PR');
	const priority = parsePriority(body.priority);
	if (priority === 'urgent') requireRole(caller, 'maintain', 'Queueing a PR as urgent');
	if (pr.state !== 'open') throw new ApiError(409, `#${pr.number} is not open`);
	const existing = db.getQueueItems(repo.id).find((i) => i.pr_number === pr.number);
	if (existing && !['merged', 'failed', 'cancelled'].includes(existing.status)) {
		throw new ApiError(409, `#${pr.number} is already queued`);
	}
	if (existing) db.removeFromQueue(existing.id);
	db.addToQueue(repo.id, pr.number, pr.title, pr.html_url, pr.user.login, pr.user.avatar_url, caller.login);
	store.setQueuePriority(repo.id, pr.number, priority);
	emitEvent(repo.id, pr.number, 'queued', { by: caller.login, priority });
	return queueEntry(repo.id, pr.number);
}

export function dequeue(repo: Repo, caller: Caller, n: number) {
	requireRole(caller, 'write', 'Removing a PR from the queue');
	const it = db.getQueueItems(repo.id).find((i) => i.pr_number === n);
	if (!it) throw new ApiError(404, `#${n} is not queued`);
	if (store.getActiveBatches(repo.id).some((b) => b.members.includes(n))) {
		throw new ApiError(409, `#${n} is being tested in a batch; cancel the batch or wait for it`);
	}
	db.removeFromQueue(it.id);
	emitEvent(repo.id, n, 'dequeued', { by: caller.login });
	return { removed: n };
}

export function changeEntry(repo: Repo, caller: Caller, n: number, body: { priority?: unknown; jumpTo?: unknown }) {
	const it = db.getQueueItems(repo.id).find((i) => i.pr_number === n);
	if (!it) throw new ApiError(404, `#${n} is not queued`);
	if (body.priority !== undefined) {
		const p = parsePriority(body.priority);
		requireRole(caller, p === 'urgent' ? 'maintain' : 'write', `Setting priority ${p}`);
		store.setQueuePriority(repo.id, n, p);
		emitEvent(repo.id, n, 'priority', { priority: p, by: caller.login });
	}
	if (body.jumpTo !== undefined) {
		if (body.jumpTo !== 'front') throw new ApiError(400, 'jumpTo must be "front"');
		requireRole(caller, 'maintain', 'Moving a PR to the front');
		// The front of its own priority: it does not become urgent (urgent PRs still go first).
		const order = db.getQueueItems(repo.id).map((i) => i.id);
		db.reorderQueue(repo.id, [it.id, ...order.filter((id) => id !== it.id)]);
		emitEvent(repo.id, n, 'priority', { jumpTo: 'front', by: caller.login });
	}
	return queueEntry(repo.id, n);
}

const CONFIG_KEYS: (keyof BatchConfig)[] = Object.keys(DEFAULT_BATCH_CONFIG) as (keyof BatchConfig)[];

export function getConfig(repo: Repo) {
	const s = store.getQueueSettings(repo.id);
	return { mode: s.mode, config: s.config, ci: s.ci, paused: s.pausedReason, publicView: s.publicView };
}

/**
 * Changes the queue's settings. Turning `publicView` on needs `visibility`, the repository's
 * visibility on GitHub as the caller looked it up: only a public repository's queue can be public.
 */
export function patchConfig(repo: Repo, caller: Caller, body: Record<string, unknown>, visibility: 'public' | 'private' | null = null) {
	requireRole(caller, 'admin', 'Changing queue settings');
	const publicView = body.publicView;
	if (publicView !== undefined && typeof publicView !== 'boolean') throw new ApiError(400, 'publicView must be a boolean');
	if (publicView === true && !store.getQueueSettings(repo.id).publicView && visibility !== 'public') {
		throw new ApiError(400, visibility === 'private' ? 'A private repository can not have a public queue page' : 'Could not check on GitHub that the repository is public; try again');
	}
	const config: Partial<BatchConfig> = {};
	for (const [k, v] of Object.entries((body.config ?? {}) as Record<string, unknown>)) {
		if (!CONFIG_KEYS.includes(k as keyof BatchConfig)) throw new ApiError(400, `Unknown setting ${k}`);
		const want = typeof DEFAULT_BATCH_CONFIG[k as keyof BatchConfig];
		if (typeof v !== want) throw new ApiError(400, `${k} must be a ${want}`);
		if (want === 'number' && (!Number.isFinite(v) || (v as number) < 0)) throw new ApiError(400, `${k} must be >= 0`);
		(config as Record<string, unknown>)[k] = v;
	}
	if (config.maxBatch !== undefined && config.maxBatch < 1) throw new ApiError(400, 'maxBatch must be >= 1');
	if (config.depth !== undefined && config.depth < 1) throw new ApiError(400, 'depth must be >= 1');
	if (config.comments !== undefined && !COMMENT_MODES.includes(config.comments as CommentMode)) throw new ApiError(400, `comments must be one of ${COMMENT_MODES.join(', ')}`);
	if (config.bisectRuns !== undefined && (config.bisectRuns < 1 || !Number.isInteger(config.bisectRuns))) throw new ApiError(400, 'bisectRuns must be a whole number >= 1');
	const mode = body.mode;
	if (mode !== undefined && mode !== 'serial' && mode !== 'batch') throw new ApiError(400, 'mode must be serial or batch');
	const ci = body.ci as Record<string, unknown> | undefined;
	if (ci) {
		const keys = ['workflow', 'requiredCheck', 'testedStatus', 'prStatus', 'prReport', 'dispatchRef'];
		for (const [k, v] of Object.entries(ci)) {
			if (k === 'prReport' && !(store.PR_REPORTS as readonly unknown[]).includes(v)) {
				throw new ApiError(400, `ci.prReport must be one of ${store.PR_REPORTS.join(', ')}`);
			}
			if (!keys.includes(k) || typeof v !== 'string' || (!v && k !== 'dispatchRef')) {
				throw new ApiError(400, `ci.${k} must be a non-empty string (${keys.join(', ')})`);
			}
		}
	}
	const before = store.getQueueSettings(repo.id);
	// GitHub just said it is public (checked above): the page shows at once, without waiting for the processor.
	if (publicView === true && visibility === 'public') noteVisibility(repo.id, 'public', () => {});
	store.updateQueueSettings(repo.id, {
		mode: mode as 'serial' | 'batch' | undefined,
		config,
		ci: ci as Partial<store.CISettings> | undefined,
		publicView: publicView as boolean | undefined
	});
	// Who changed what, from what: on the queue's event log, so a surprising setting can be traced.
	const changes: Record<string, { from: unknown; to: unknown }> = {};
	if (mode !== undefined && mode !== before.mode) changes.mode = { from: before.mode, to: mode };
	if (publicView !== undefined && publicView !== before.publicView) changes.publicView = { from: before.publicView, to: publicView };
	for (const [k, v] of Object.entries(config)) if (before.config[k as keyof BatchConfig] !== v) changes[k] = { from: before.config[k as keyof BatchConfig], to: v };
	for (const [k, v] of Object.entries(ci ?? {})) if (before.ci[k as keyof store.CISettings] !== v) changes[`ci.${k}`] = { from: before.ci[k as keyof store.CISettings], to: v };
	if (Object.keys(changes).length) emitEvent(repo.id, null, 'settings', { by: caller.login, changes });
	return getConfig(repo);
}

/** Checks who may cancel a batch; the cancel itself runs under the repo lock in the route. */
/** The repository's visibility on GitHub, for `patchConfig`; null when GitHub can't say. */
export async function repoVisibility(lookup: () => Promise<{ private?: boolean }>): Promise<'public' | 'private' | null> {
	try {
		const r = await lookup();
		return typeof r.private === 'boolean' ? (r.private ? 'private' : 'public') : null;
	} catch {
		return null;
	}
}

/** The batch `number` names, once the caller may cancel it. */
export function canCancelBatch(repo: Repo, caller: Caller, number: number): BatchRow {
	requireRole(caller, 'maintain', 'Cancelling a batch');
	return batchByNumber(repo, number);
}

export function pause(repo: Repo, caller: Caller, reason: unknown) {
	requireRole(caller, 'maintain', 'Pausing the queue');
	const why = typeof reason === 'string' && reason.trim() ? reason.trim() : `Paused by ${caller.login}`;
	store.updateQueueSettings(repo.id, { pausedReason: why });
	emitEvent(repo.id, null, 'paused', { reason: why, by: caller.login });
	return getConfig(repo);
}

export function resume(repo: Repo, caller: Caller) {
	requireRole(caller, 'maintain', 'Resuming the queue');
	const wasPaused = store.getQueueSettings(repo.id).pausedReason !== null;
	store.updateQueueSettings(repo.id, { pausedReason: null });
	// Resuming a queue that isn't paused vouches for a red default branch: it is trusted again
	// (say, it failed for a reason only its own run has), and failures on top of it are blamed on
	// PRs as usual. Resuming from a pause only lifts the pause.
	const h = store.getMasterHealth(repo.id);
	if (!wasPaused && h?.state === 'red') store.setMasterHealth(repo.id, { sha: h.sha, tree: h.tree, state: 'green', since: Date.now() });
	emitEvent(repo.id, null, 'resumed', { by: caller.login });
	return getConfig(repo);
}

/** A positive integer query parameter, or `fallback` when missing; 400 when malformed. */
export function intParam(v: string | null, name: string, fallback: number | null): number | null {
	if (v === null || v === '') return fallback;
	if (!/^\d+$/.test(v)) throw new ApiError(400, `${name} must be a non-negative integer`);
	return Number(v);
}

export function history(repo: Repo, limit: number) {
	return { history: db.getRepoHistory(repo.id, Math.min(Math.max(limit, 1), 200)) };
}

export async function events(
	repo: Repo,
	q: { after: number | null; pr: number | null; waitSec: number | null },
	signal?: AbortSignal
) {
	const r = await waitForEvents(repo.id, {
		after: q.after,
		pr: q.pr,
		waitMs: (q.waitSec ?? 0) * 1000,
		signal
	});
	return { events: r.events, cursor: r.cursor };
}

export function tryRunState(run: store.BatchRow) {
	return { id: run.id, branch: run.branch, status: run.status, ci: run.ci_result, headSha: run.heads[run.members[0]] };
}
