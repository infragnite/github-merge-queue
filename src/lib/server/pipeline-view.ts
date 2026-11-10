// Loads the batch pipeline for the repository page: settings, default-branch health, batches
// in flight (with bisection and try runs) and recently finished ones, with live CI progress.

import * as github from './github';
import * as store from './batch-store';
import { getActiveQueueItem } from './db';
import { dashboardStackAnalysis } from './stack-runtime';
import { tickError, type TickError } from './tick-errors';
import { batchCard, isRunning, summarizeJobs, type BatchCard, type CIProgress } from './batch-view';
import type { StackAnalysis } from './stacks';

type RepoRef = { id: number; owner: string; name: string; default_branch: string };

export interface PipelineView {
	mode: string;
	paused: string | null;
	master: { sha: string; state: string; since: number } | null;
	active: BatchCard[];
	recent: BatchCard[];
	error: string | null;
	/** Set while GitHub's rate limit holds the queue: when calls resume (epoch ms). */
	rateLimitedUntil: number | null;
	/** The queue's last failed step, until a step succeeds. */
	tickError: TickError | null;
	/** Batch heads whose CI progress could not be read, with why (the last known progress is shown). */
	progressErrors: Record<string, string>;
	/** One by one: the PR the queue is on now, with its CI progress. */
	current: { pr: number; status: string; startedAt: string | null; progress: CIProgress | null } | null;
}

/**
 * Job counts change by the minute; dashboards refreshing every 10s share one lookup per minute.
 * While the rate-limit budget is low, or a lookup fails, the last counts are shown.
 */
const PROGRESS_TTL_MS = 60_000;
const progressCache = new Map<string, { at: number; value: CIProgress }>();
const progressErrors = new Map<string, string>();

async function progressFor(repo: RepoRef, sha: string, low: boolean): Promise<CIProgress | null> {
	const key = `${repo.owner}/${repo.name}@${sha}`;
	const hit = progressCache.get(key);
	if (hit && (low || Date.now() - hit.at < PROGRESS_TTL_MS)) return hit.value;
	if (low) return null;
	try {
		const value = summarizeJobs(await github.actionsJobsForSha(repo.owner, repo.name, sha));
		progressCache.set(key, { at: Date.now(), value });
		progressErrors.delete(key);
		for (const [k, v] of progressCache) if (Date.now() - v.at > 60 * PROGRESS_TTL_MS) progressCache.delete(k);
		return value;
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		console.warn(`[batches] ${repo.owner}/${repo.name}: CI progress for ${sha.slice(0, 8)} failed: ${why}`);
		progressErrors.set(key, why);
		return hit?.value ?? null;
	}
}

const RECENT = 10;

export async function pipelineView(repo: RepoRef, prs: Map<number, { title: string; url: string }>): Promise<PipelineView> {
	const settings = store.getQueueSettings(repo.id);
	const active = store.getActiveBatches(repo.id);
	const activeIds = new Set(active.map((b) => b.id));
	const recent = store.getRecentBatches(repo.id, RECENT + active.length).filter((b) => !activeIds.has(b.id)).slice(0, RECENT);
	// Tries and the baseline check of master run beside the batches; show them as cards too.
	const sideRuns = [...store.getRunningTries(repo.id), ...[store.getRunningBaseline(repo.id)].filter((b) => b !== null)];
	const bisection = new Map(active.map((b) => [b.id, store.getBisectRuns(b.id)]));

	const running = [...active, ...sideRuns, ...[...bisection.values()].flat()].filter(isRunning);
	const budget = await github.rateLimitOf(repo.owner).catch(() => null);
	const progress = new Map<string, CIProgress>();
	await Promise.all(
		running.map(async (b) => {
			const p = await progressFor(repo, b.head_sha, !!budget?.low);
			if (p) progress.set(b.head_sha, p);
		})
	);

	// One by one: the PR at the front, while the queue updates, checks or merges it.
	const front = settings.mode === 'serial' ? getActiveQueueItem(repo.id) : undefined;
	const current =
		front && ['updating', 'checking', 'merging'].includes(front.status)
			? {
					pr: front.pr_number,
					status: front.status,
					startedAt: front.started_at,
					progress: front.head_sha && front.status === 'checking' ? await progressFor(repo, front.head_sha, !!budget?.low) : null
				}
			: null;

	let analysis: StackAnalysis | null = null;
	try {
		analysis = await dashboardStackAnalysis(repo);
	} catch {
		// Logged by the stacks section; batches still show, just without stack nesting.
	}

	const card = (b: (typeof active)[number]) => batchCard(b, bisection.get(b.id) ?? [], analysis, prs, progress);
	const master = store.getMasterHealth(repo.id);
	return {
		mode: settings.mode,
		paused: settings.pausedReason,
		master: master ? { sha: master.sha, state: master.state, since: master.since } : null,
		active: [...sideRuns, ...active].map(card),
		recent: recent.map(card),
		error: null,
		rateLimitedUntil: budget?.blockedUntil ?? null,
		tickError: tickError(repo.id),
		current,
		progressErrors: Object.fromEntries(
			[...running.map((b) => b.head_sha), ...(current && front?.head_sha ? [front.head_sha] : [])].flatMap((sha) => {
				const why = progressErrors.get(`${repo.owner}/${repo.name}@${sha}`);
				return why ? [[sha, why]] : [];
			})
		)
	};
}
