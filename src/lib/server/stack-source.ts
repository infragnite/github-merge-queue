// Gathers the input for stack detection (./stacks.ts) from GitHub and the
// database. Kept free of $env/db/github imports so it can be tested with
// fakes; the real client and store are built in ./github.ts and ./db.ts.

import type { PRSnapshot, StackCommit, StackInput } from './stacks';

export interface GhPull {
	number: number;
	state: string;
	merged_at: string | null;
	closed_at: string | null;
	head: { ref: string; sha: string };
	base: { ref: string };
}

export interface GhCompare {
	total_commits: number;
	commits: Array<{
		sha: string;
		commit: { message: string; author: { email: string; date: string } | null };
	}>;
}

export interface StackGitHub {
	listOpenPRs(): Promise<GhPull[]>;
	listRecentlyClosedPRs(): Promise<GhPull[]>;
	/** null when the branch doesn't exist. */
	getBranchSha(branch: string): Promise<string | null>;
	/** `base...head`; null when either commit is unknown to GitHub. */
	compare(base: string, head: string, page: number, perPage: number): Promise<GhCompare | null>;
}

export interface StackStore {
	recordHeads(heads: Array<{ pr: number; sha: string }>): void;
	knownHeads(): Map<number, string[]>;
	/** ref -> ISO time the branch delete webhook arrived. */
	deletedBranches(): Map<string, string>;
}

export const COMPARE_PAGE_SIZE = 100;
export const COMPARE_MAX_PAGES = 5;
const CACHE_LIMIT = 2000;

// `default...head` for a fixed pair of SHAs never changes, so cache it across
// processor cycles. Keyed by both SHAs; a moved default branch misses.
const compareCache = new Map<string, { commits: StackCommit[]; truncated: boolean } | null>();

export function clearCompareCache() {
	compareCache.clear();
}

async function commitsSince(
	gh: StackGitHub,
	cacheKey: string,
	baseSha: string,
	headSha: string
): Promise<{ commits: StackCommit[]; truncated: boolean } | null> {
	const key = `${cacheKey}:${baseSha}...${headSha}`;
	if (compareCache.has(key)) return compareCache.get(key)!;

	const commits: StackCommit[] = [];
	let total = 0;
	let result: { commits: StackCommit[]; truncated: boolean } | null = null;
	for (let page = 1; page <= COMPARE_MAX_PAGES; page++) {
		const res = await gh.compare(baseSha, headSha, page, COMPARE_PAGE_SIZE);
		if (!res) break;
		total = res.total_commits;
		for (const c of res.commits) {
			commits.push({
				sha: c.sha,
				message: c.commit.message,
				authorEmail: c.commit.author?.email ?? '',
				authoredAt: c.commit.author?.date ?? ''
			});
		}
		if (res.commits.length < COMPARE_PAGE_SIZE || commits.length >= total) {
			result = { commits, truncated: false };
			break;
		}
	}
	if (!result && commits.length) result = { commits, truncated: commits.length < total };

	if (compareCache.size >= CACHE_LIMIT) {
		compareCache.delete(compareCache.keys().next().value!);
	}
	compareCache.set(key, result);
	return result;
}

function toSnapshot(pr: GhPull): PRSnapshot {
	return {
		number: pr.number,
		state: pr.state === 'open' ? 'open' : 'closed',
		merged: !!pr.merged_at,
		headRef: pr.head.ref,
		headSha: pr.head.sha,
		baseRef: pr.base.ref,
		commits: null,
		closedAt: pr.closed_at
	};
}

export async function loadStackInput(
	gh: StackGitHub,
	store: StackStore,
	opts: { defaultBranch: string; cacheKey: string; concurrency?: number }
): Promise<StackInput> {
	const defaultSha = await gh.getBranchSha(opts.defaultBranch);
	if (!defaultSha) throw new Error(`Default branch '${opts.defaultBranch}' not found`);

	const [open, closed] = await Promise.all([gh.listOpenPRs(), gh.listRecentlyClosedPRs()]);
	store.recordHeads(open.map((p) => ({ pr: p.number, sha: p.head.sha })));

	const snapshots = new Map<number, PRSnapshot>();
	for (const pr of closed) snapshots.set(pr.number, toSnapshot(pr));
	for (const pr of open) snapshots.set(pr.number, toSnapshot(pr));

	const openSnaps = [...snapshots.values()].filter((s) => s.state === 'open');
	const limit = Math.max(1, opts.concurrency ?? 4);
	for (let i = 0; i < openSnaps.length; i += limit) {
		await Promise.all(
			openSnaps.slice(i, i + limit).map(async (s) => {
				const res = await commitsSince(gh, opts.cacheKey, defaultSha, s.headSha);
				s.commits = res?.commits ?? null;
				s.commitsTruncated = res?.truncated ?? false;
			})
		);
	}

	// Only branches the analysis looks up: open PRs' bases and the bases of
	// PRs closed without merging (candidates for GitHub's auto-close).
	const refs = new Set<string>();
	for (const s of snapshots.values()) {
		if (s.baseRef === opts.defaultBranch) continue;
		if (s.state === 'open' || !s.merged) refs.add(s.baseRef);
	}
	const existingBranches = new Set([opts.defaultBranch]);
	await Promise.all(
		[...refs].map(async (ref) => {
			if (await gh.getBranchSha(ref)) existingBranches.add(ref);
		})
	);

	return {
		defaultBranch: opts.defaultBranch,
		prs: [...snapshots.values()],
		knownHeads: store.knownHeads(),
		existingBranches,
		deletedBranches: store.deletedBranches()
	};
}
