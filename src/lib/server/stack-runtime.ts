// Wires stack detection to the real GitHub client and database.

import * as db from './db';
import * as github from './github';
import { loadStackInput } from './stack-source';
import { analyzeStacks, detectAutoClose, type StackAnalysis } from './stacks';
import { memoByGeneration } from './wake';
import { log } from './log';

type RepoRef = { id: number; owner: string; name: string; default_branch: string };

export async function analyzeRepoStacks(repo: RepoRef): Promise<StackAnalysis> {
	const input = await loadStackInput(github.stackClient(repo.owner, repo.name), db.stackStore(repo.id), {
		defaultBranch: repo.default_branch,
		cacheKey: `${repo.owner}/${repo.name}`
	});
	return analyzeStacks(input);
}

// Analysis costs a call per open PR; webhooks bump the repo's generation when PRs change,
// and the queue's own merges and pushes do too.
const analysisMemo = memoByGeneration<StackAnalysis>(5 * 60 * 1000);

/** The repo's stack analysis, reused until a PR changes or five minutes pass. */
export function currentStackAnalysis(repo: RepoRef): Promise<StackAnalysis> {
	return analysisMemo(repo.id, 'stacks', () => analyzeRepoStacks(repo));
}

const shown = new Map<number, { at: number; value: StackAnalysis }>();
/** A dashboard refresh reuses an analysis this young even after a PR changed. */
const DASHBOARD_MIN_AGE_MS = 60_000;

/**
 * The analysis for the dashboard: the queue's own, but at most one fresh one a minute, and none
 * while GitHub's rate-limit budget is low (the last one is shown instead).
 */
export async function dashboardStackAnalysis(repo: RepoRef & { owner: string }, opts: { cachedOnly?: boolean } = {}): Promise<StackAnalysis> {
	const last = shown.get(repo.id);
	// A read-only (public) viewer never makes the app call GitHub: the last analysis, or none yet.
	if (opts.cachedOnly) {
		if (last) return last.value;
		throw new Error('not analysed yet');
	}
	if (last && (Date.now() - last.at < DASHBOARD_MIN_AGE_MS || (await github.rateLimitOf(repo.owner).catch(() => null))?.low)) return last.value;
	const value = await currentStackAnalysis(repo);
	shown.set(repo.id, { at: Date.now(), value });
	return value;
}

/**
 * Explains a PR that was closed without merging. Returns GitHub's
 * auto-close-after-base-deletion reason when that's what happened.
 */
export async function closedPRReason(
	repo: RepoRef,
	pr: { number: number; head: { ref: string; sha: string }; base: { ref: string }; closed_at: string | null }
): Promise<string> {
	try {
		if (pr.base.ref === repo.default_branch) return 'PR was closed';
		const [baseSha, closed] = await Promise.all([
			github.getBranchSha(repo.owner, repo.name, pr.base.ref),
			github.getRecentlyClosedPRs(repo.owner, repo.name)
		]);
		const snap = (p: typeof pr & { state?: string; merged_at?: string | null }) => ({
			number: p.number,
			state: 'closed' as const,
			merged: !!p.merged_at,
			headRef: p.head.ref,
			headSha: p.head.sha,
			baseRef: p.base.ref,
			commits: null,
			closedAt: p.closed_at
		});
		const issue = detectAutoClose(snap(pr), {
			defaultBranch: repo.default_branch,
			prs: (closed as Array<typeof pr & { merged_at: string | null }>).map(snap),
			existingBranches: baseSha ? new Set([repo.default_branch, pr.base.ref]) : new Set([repo.default_branch]),
			deletedBranches: db.getDeletedBranches(repo.id)
		});
		return issue ? issue.message : 'PR was closed';
	} catch (err) {
		log.error('could not explain why a PR was closed', { pr: pr.number, err });
		return 'PR was closed';
	}
}
