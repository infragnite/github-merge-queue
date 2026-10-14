// Wires stack detection to the real GitHub client and database.

import * as db from './db';
import * as github from './github';
import { loadStackInput } from './stack-source';
import { analyzeStacks, detectAutoClose, mergeBlocker, type StackAnalysis } from './stacks';

type RepoRef = { id: number; owner: string; name: string; default_branch: string };

export async function analyzeRepoStacks(repo: RepoRef): Promise<StackAnalysis> {
	const input = await loadStackInput(github.stackClient(repo.owner, repo.name), db.stackStore(repo.id), {
		defaultBranch: repo.default_branch,
		cacheKey: `${repo.owner}/${repo.name}`
	});
	return analyzeStacks(input);
}

/** Why the queue must not merge this PR yet, or null. */
export async function stackMergeBlocker(repo: RepoRef, prNumber: number): Promise<string | null> {
	const analysis = await analyzeRepoStacks(repo);
	for (const issue of analysis.issues) {
		if (issue.pr === prNumber) console.log(`[stacks] ${repo.owner}/${repo.name}: ${issue.message}`);
	}
	return mergeBlocker(analysis, prNumber);
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
		console.error(`[stacks] Could not explain closure of #${pr.number}:`, err instanceof Error ? err.message : err);
		return 'PR was closed';
	}
}
