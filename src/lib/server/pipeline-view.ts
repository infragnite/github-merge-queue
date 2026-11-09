// Loads the batch pipeline for the repository page: settings, default-branch health, batches
// in flight (with bisection and try runs) and recently finished ones, with live CI progress.

import * as github from './github';
import * as store from './batch-store';
import { currentStackAnalysis } from './stack-runtime';
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
}

/** Job counts change by the minute; a dashboard refreshing every 10s reuses them briefly. */
const PROGRESS_TTL_MS = 20_000;
const progressCache = new Map<string, { at: number; value: CIProgress }>();

async function progressFor(repo: RepoRef, sha: string): Promise<CIProgress | null> {
	const key = `${repo.owner}/${repo.name}@${sha}`;
	const hit = progressCache.get(key);
	if (hit && Date.now() - hit.at < PROGRESS_TTL_MS) return hit.value;
	try {
		const value = summarizeJobs(await github.actionsJobsForSha(repo.owner, repo.name, sha));
		progressCache.set(key, { at: Date.now(), value });
		for (const [k, v] of progressCache) if (Date.now() - v.at > 10 * PROGRESS_TTL_MS) progressCache.delete(k);
		return value;
	} catch (e) {
		console.warn(`[batches] ${repo.owner}/${repo.name}: CI progress for ${sha.slice(0, 8)} failed: ${e instanceof Error ? e.message : e}`);
		return null;
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
	const progress = new Map<string, CIProgress>();
	await Promise.all(
		running.map(async (b) => {
			const p = await progressFor(repo, b.head_sha);
			if (p) progress.set(b.head_sha, p);
		})
	);

	let analysis: StackAnalysis | null = null;
	try {
		analysis = await currentStackAnalysis(repo);
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
		error: null
	};
}
