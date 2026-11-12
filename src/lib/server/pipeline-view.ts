// Loads the batch pipeline for the repository page: settings, default-branch health, batches
// in flight (with bisection and try runs) and recently finished ones, with live CI progress.

import * as github from './github';
import * as store from './batch-store';
import { dashboardStackAnalysis } from './stack-runtime';
import { tickError, type TickError } from './tick-errors';
import { activityOf, type ActivityView } from './activity';
import { batchCard, ciMayStillRun, summarizeJobs, type BatchCard, type CIProgress } from './batch-view';
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
	/** What the queue itself is doing now (forming a batch, restacking, landing), and its last failed step. */
	activity: ActivityView;
	/** The server's clock when this was read (epoch ms), so the page times steps by it, not its own. */
	serverTime: number;
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

/**
 * With `cachedOnly` (a read-only viewer), nothing is fetched from GitHub: CI progress and stacks
 * come from what signed-in viewers or the processor's warm-up last fetched.
 */
export async function pipelineView(repo: RepoRef, prs: Map<number, { title: string; url: string }>, opts: { cachedOnly?: boolean } = {}): Promise<PipelineView> {
	const settings = store.getQueueSettings(repo.id);
	const active = store.getActiveBatches(repo.id);
	const activeIds = new Set(active.map((b) => b.id));
	const recent = store.getRecentBatches(repo.id, RECENT + active.length).filter((b) => !activeIds.has(b.id)).slice(0, RECENT);
	// Tries and the baseline check of master run beside the batches; show them as cards too.
	const sideRuns = [...store.getRunningTries(repo.id), ...[store.getRunningBaseline(repo.id)].filter((b) => b !== null)];
	const bisection = new Map(active.map((b) => [b.id, store.getBisectRuns(b.id)]));

	const running = [...active, ...sideRuns, ...[...bisection.values()].flat()].filter((b) => ciMayStillRun(b, Date.now(), progressCache.get(`${repo.owner}/${repo.name}@${b.head_sha}`)?.value));
	const budget = await github.rateLimitOf(repo.owner).catch(() => null);
	const progress = new Map<string, CIProgress>();
	await Promise.all(
		running.map(async (b) => {
			const p = await progressFor(repo, b.head_sha, !!budget?.low || !!opts.cachedOnly);
			if (p) progress.set(b.head_sha, p);
		})
	);

	let analysis: StackAnalysis | null = null;
	try {
		analysis = await dashboardStackAnalysis(repo, opts);
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
		activity: activityOf(repo.id),
		serverTime: Date.now(),
		progressErrors: Object.fromEntries(
			running.flatMap((b) => {
				const why = progressErrors.get(`${repo.owner}/${repo.name}@${b.head_sha}`);
				return why ? [[b.head_sha, why]] : [];
			})
		)
	};
}

/**
 * What a read-only viewer gets of the pipeline: named fields only, so a field added to the view
 * later isn't published by default. No pause reason, step errors or CI lookup errors (they can
 * name GitHub or App internals).
 */
export function publicPipeline(p: PipelineView): PipelineView {
	return {
		mode: p.mode,
		paused: p.paused ? 'The queue is paused' : null,
		master: p.master ? { sha: p.master.sha, state: p.master.state, since: p.master.since } : null,
		active: p.active,
		recent: p.recent,
		error: p.error ? 'Batches could not be loaded' : null,
		rateLimitedUntil: p.rateLimitedUntil,
		tickError: null,
		progressErrors: {},
		activity: publicActivity(p.activity),
		serverTime: p.serverTime
	};
}

/** Which step runs and on which PRs is what the page already shows; why one failed is not (App internals). */
export function publicActivity(a: ActivityView): ActivityView {
	return { since: a.since, phase: a.phase, step: a.step, failure: a.failure ? { ...a.failure, action: null } : null };
}
