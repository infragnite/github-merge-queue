// Stacked PR detection.
//
// GitHub's `base.ref` is not a reliable signal for stacking: a PR stacked on
// another can target the default branch directly, GitHub retargets children
// when a parent's branch is deleted after merge, and a declared stack stops
// being real the moment the lower PR is rebased or force-pushed. So stacks
// are inferred from git ancestry instead: PR B sits on PR A when B's commits
// (everything reachable from B's head but not from the default branch)
// contain A's head. `base.ref` is only compared against what ancestry says.
//
// Everything in this file is pure; `stack-source.ts` gathers the input from
// GitHub and the database.

export interface StackCommit {
	sha: string;
	message: string;
	authorEmail: string;
	authoredAt: string;
}

export interface PRSnapshot {
	number: number;
	state: 'open' | 'closed';
	merged: boolean;
	headRef: string;
	headSha: string;
	baseRef: string;
	/** Commits in `default..head`, oldest first. null when unknown. */
	commits: StackCommit[] | null;
	/** True when `commits` was cut short (compare API page limit). */
	commitsTruncated?: boolean;
	closedAt?: string | null;
}

export interface StackInput {
	defaultBranch: string;
	prs: PRSnapshot[];
	/** Every head SHA ever observed per PR (webhooks + polling), any order. */
	knownHeads?: Map<number, Iterable<string>>;
	/** Branches known to exist right now; null/undefined when unknown. */
	existingBranches?: Set<string> | null;
	/** Branch deletions seen via webhook: ref name -> ISO time. */
	deletedBranches?: Map<string, string>;
}

/**
 * How a PR relates to the PR directly beneath it.
 * - healthy:       contains the parent's current head
 * - behind:        contains an older head of the parent that is still in the
 *                  parent's history (parent got new commits; a merge/rebase
 *                  of the parent into the child fixes it)
 * - rebased:       contains pre-rewrite copies of the parent's commits
 *                  (parent was rebased, amended or force-pushed)
 * - parent-merged: parent was merged but its original commits are still in
 *                  this PR (squash/rebase merge); needs restacking onto the
 *                  default branch
 * - parent-closed: parent was closed without merging but its commits are
 *                  still in this PR
 */
export type LinkStatus = 'healthy' | 'behind' | 'rebased' | 'parent-merged' | 'parent-closed';

export type IssueKind =
	| 'parent-behind'
	| 'parent-rebased'
	| 'parent-merged'
	| 'parent-closed'
	| 'base-mismatch'
	| 'base-branch-missing'
	| 'auto-closed'
	| 'commits-truncated';

export interface StackIssue {
	kind: IssueKind;
	pr: number;
	parent?: number;
	/** blocking: merging now would land the wrong commits or the wrong place. */
	severity: 'blocking' | 'warning';
	message: string;
	/** Commits in `pr` that are stale copies of the parent's work. */
	staleCommits?: string[];
	evidence?: 'head' | 'known-head' | 'fingerprint' | 'webhook' | 'branch-missing' | 'timing';
}

export interface PRStackInfo {
	number: number;
	/** Direct parent PR by ancestry, or null if the PR sits on the default branch. */
	parent: number | null;
	link: LinkStatus | null;
	/** Open PRs whose direct parent is this one. */
	children: number[];
	/** 0 for a PR sitting directly on the default branch. */
	depth: number;
	/** The base.ref this PR should have given what ancestry says. */
	expectedBase: string;
	issues: StackIssue[];
	/** True when this PR or anything below it has a blocking issue. */
	broken: boolean;
}

export interface StackAnalysis {
	prs: Map<number, PRStackInfo>;
	/** Each stack bottom-up (parents before children), open PRs only; singletons excluded. */
	stacks: number[][];
	issues: StackIssue[];
}

interface Relation {
	parent: PRSnapshot;
	status: LinkStatus;
	/** Highest index in the child's commit list matched by this relation. */
	anchor: number;
	stale: string[];
	evidence: StackIssue['evidence'];
}

export function fingerprint(c: StackCommit): string {
	// Survives rebase, cherry-pick and `commit --amend --no-edit`: git keeps
	// the author and author date and the message is unchanged.
	return `${c.authorEmail}\u0000${c.authoredAt}\u0000${c.message.trim()}`;
}

/** Commit -> the PR it belongs to: the lowest open PR (fewest commits) containing it. */
function commitOwners(open: PRSnapshot[]): Map<string, PRSnapshot> {
	const owners = new Map<string, PRSnapshot>();
	for (const pr of open) {
		if (!pr.commits) continue;
		for (const c of pr.commits) {
			const cur = owners.get(c.sha);
			if (
				!cur ||
				pr.commits.length < cur.commits!.length ||
				(pr.commits.length === cur.commits!.length && pr.number < cur.number)
			) {
				owners.set(c.sha, pr);
			}
		}
	}
	return owners;
}

function findRelations(
	child: PRSnapshot,
	all: PRSnapshot[],
	open: PRSnapshot[],
	knownHeads: Map<number, Set<string>>,
	owners: Map<string, PRSnapshot>
): Relation[] {
	const commits = child.commits!;
	const index = new Map<string, number>();
	commits.forEach((c, i) => index.set(c.sha, i));

	const rel = new Map<number, Relation>();
	const consider = (r: Relation) => {
		const cur = rel.get(r.parent.number);
		if (!cur || rank(r.status) < rank(cur.status) || (r.status === cur.status && r.anchor > cur.anchor)) {
			rel.set(r.parent.number, r);
		}
	};

	for (const other of all) {
		if (other.number === child.number || other.headSha === child.headSha) continue;
		// A closed PR from the same branch is an earlier incarnation of this
		// one (closed and reopened as a new PR), not a parent.
		if (other.state !== 'open' && other.headRef === child.headRef) continue;

		// 1. The other PR's current head is in this PR.
		const headAt = index.get(other.headSha);
		if (headAt !== undefined) {
			const status: LinkStatus =
				other.state === 'open' ? 'healthy' : other.merged ? 'parent-merged' : 'parent-closed';
			consider({ parent: other, status, anchor: headAt, stale: [], evidence: 'head' });
			continue;
		}
		if (other.state !== 'open') continue;

		// 2. An older head of the other PR is in this PR.
		const otherShas = new Set(other.commits?.map((c) => c.sha) ?? []);
		let behindAt = -1;
		let rebasedAt = -1;
		const staleHeads: string[] = [];
		for (const sha of knownHeads.get(other.number) ?? []) {
			const at = index.get(sha);
			if (at === undefined) continue;
			if (other.commits && otherShas.has(sha)) {
				behindAt = Math.max(behindAt, at);
			} else if (other.commits) {
				rebasedAt = Math.max(rebasedAt, at);
				staleHeads.push(sha);
			}
		}
		if (rebasedAt >= 0) {
			consider({
				parent: other,
				status: 'rebased',
				anchor: rebasedAt,
				stale: staleCopies(commits, rebasedAt, otherShas, staleHeads),
				evidence: 'known-head'
			});
		} else if (behindAt >= 0) {
			consider({ parent: other, status: 'behind', anchor: behindAt, stale: [], evidence: 'known-head' });
		}
	}

	// 3. Rewritten copies of another open PR's commits (no history needed).
	const byPrint = new Map<string, { sha: string; owner: PRSnapshot }[]>();
	for (const pr of open) {
		if (pr.number === child.number || !pr.commits) continue;
		for (const c of pr.commits) {
			const owner = owners.get(c.sha);
			if (owner !== pr) continue; // attribute each commit to its lowest PR only
			const list = byPrint.get(fingerprint(c)) ?? [];
			list.push({ sha: c.sha, owner: pr });
			byPrint.set(fingerprint(c), list);
		}
	}
	const printHits = new Map<number, { anchor: number; stale: string[]; parent: PRSnapshot }>();
	commits.forEach((c, i) => {
		for (const hit of byPrint.get(fingerprint(c)) ?? []) {
			if (hit.sha === c.sha || index.has(hit.sha)) continue;
			const cur = printHits.get(hit.owner.number) ?? { anchor: -1, stale: [], parent: hit.owner };
			cur.anchor = Math.max(cur.anchor, i);
			cur.stale.push(c.sha);
			printHits.set(hit.owner.number, cur);
		}
	});
	for (const hit of printHits.values()) {
		// Fingerprints match in both directions; the parent is the side whose
		// head commit has a stale copy in the child. Without that, `child` is
		// the one below (its old copies sit in `hit.parent`).
		const parentHead = hit.parent.commits!.at(-1)!;
		const headPrint = fingerprint(parentHead);
		if (!commits.some((c) => c.sha !== parentHead.sha && fingerprint(c) === headPrint)) continue;
		const existing = rel.get(hit.parent.number);
		if (existing?.status === 'healthy') continue; // has the new copies too; old ones are harmless noise
		consider({
			parent: hit.parent,
			status: 'rebased',
			anchor: hit.anchor,
			stale: existing?.status === 'rebased' ? union(existing.stale, hit.stale) : hit.stale,
			evidence: existing?.status === 'rebased' ? existing.evidence : 'fingerprint'
		});
	}

	return [...rel.values()];
}

// Lower is preferred when one PR relates to the same parent several ways.
function rank(s: LinkStatus): number {
	return { healthy: 0, 'parent-merged': 1, 'parent-closed': 2, rebased: 3, behind: 4 }[s];
}

function union(a: string[], b: string[]): string[] {
	return [...new Set([...a, ...b])];
}

/** Child commits up to `upTo` that the parent no longer has. */
function staleCopies(
	commits: StackCommit[],
	upTo: number,
	parentShas: Set<string>,
	staleHeads: string[]
): string[] {
	const out: string[] = [];
	for (let i = 0; i <= upTo; i++) {
		if (!parentShas.has(commits[i].sha)) out.push(commits[i].sha);
	}
	return out.length ? out : staleHeads;
}

/** Picks the nearest parent: the relation anchored highest in the child's history. */
function nearest(relations: Relation[]): Relation | null {
	let best: Relation | null = null;
	for (const r of relations) {
		if (
			!best ||
			r.anchor > best.anchor ||
			(r.anchor === best.anchor && (r.parent.commits?.length ?? 0) > (best.parent.commits?.length ?? 0)) ||
			(r.anchor === best.anchor &&
				(r.parent.commits?.length ?? 0) === (best.parent.commits?.length ?? 0) &&
				rank(r.status) < rank(best.status))
		) {
			best = r;
		}
	}
	return best;
}

function linkIssue(pr: PRSnapshot, r: Relation): StackIssue | null {
	const p = r.parent.number;
	switch (r.status) {
		case 'healthy':
			return null;
		case 'behind':
			return {
				kind: 'parent-behind',
				pr: pr.number,
				parent: p,
				severity: 'warning',
				evidence: r.evidence,
				message: `#${p} has new commits that #${pr.number} doesn't include yet`
			};
		case 'rebased':
			return {
				kind: 'parent-rebased',
				pr: pr.number,
				parent: p,
				severity: 'blocking',
				evidence: r.evidence,
				staleCommits: r.stale,
				message: `#${p} was rebased or force-pushed; #${pr.number} still carries ${r.stale.length} old commit(s) from it and must be restacked onto #${p}`
			};
		case 'parent-merged':
			return {
				kind: 'parent-merged',
				pr: pr.number,
				parent: p,
				severity: 'warning',
				evidence: r.evidence,
				message: `#${p} was merged but #${pr.number} still carries its original commits; rebase #${pr.number} onto the default branch`
			};
		case 'parent-closed':
			return {
				kind: 'parent-closed',
				pr: pr.number,
				parent: p,
				severity: 'blocking',
				evidence: r.evidence,
				message: `#${p} was closed without merging but #${pr.number} still contains its commits`
			};
	}
}

/**
 * Explains why a closed, unmerged PR was closed when the cause is GitHub
 * closing it after its base branch was deleted. Returns null when the
 * evidence doesn't point that way.
 */
export function detectAutoClose(
	pr: PRSnapshot,
	input: Pick<StackInput, 'defaultBranch' | 'prs' | 'existingBranches' | 'deletedBranches'>
): StackIssue | null {
	if (pr.state !== 'closed' || pr.merged || pr.baseRef === input.defaultBranch) return null;

	const deletedAt = input.deletedBranches?.get(pr.baseRef);
	const branchGone = input.existingBranches ? !input.existingBranches.has(pr.baseRef) : undefined;
	if (branchGone === false) return null; // base still exists: closed on purpose

	const parent = input.prs.find(
		(p) => p.number !== pr.number && p.headRef === pr.baseRef && p.state === 'closed'
	);
	const closedMs = pr.closedAt ? Date.parse(pr.closedAt) : NaN;

	let evidence: StackIssue['evidence'] | null = null;
	if (deletedAt && !Number.isNaN(closedMs)) {
		// GitHub closes dependents as part of the deletion; allow for clock skew
		// and webhook delivery lag but not for a manual close much later.
		const delta = closedMs - Date.parse(deletedAt);
		if (delta >= -AUTO_CLOSE_WINDOW_MS && delta <= AUTO_CLOSE_WINDOW_MS) evidence = 'webhook';
	}
	if (!evidence && branchGone && parent?.closedAt && !Number.isNaN(closedMs)) {
		// No webhook record: the base is gone and this PR closed no earlier
		// than the PR that owned the base branch.
		if (closedMs >= Date.parse(parent.closedAt) - AUTO_CLOSE_WINDOW_MS) evidence = 'timing';
	}
	if (!evidence && branchGone && !parent) evidence = 'branch-missing';
	if (!evidence) return null;

	const via = parent ? ` (it was stacked on #${parent.number})` : '';
	const likely = evidence === 'webhook' ? '' : 'most likely ';
	return {
		kind: 'auto-closed',
		pr: pr.number,
		parent: parent?.number,
		severity: 'blocking',
		evidence,
		message: `GitHub ${likely}closed #${pr.number} because its base branch '${pr.baseRef}' was deleted${via}; reopen it against ${input.defaultBranch} to queue it again`
	};
}

export const AUTO_CLOSE_WINDOW_MS = 10 * 60 * 1000;

export function analyzeStacks(input: StackInput): StackAnalysis {
	const all = input.prs;
	const open = all.filter((p) => p.state === 'open');
	const byNumber = new Map(all.map((p) => [p.number, p]));
	const knownHeads = new Map<number, Set<string>>();
	for (const [n, shas] of input.knownHeads ?? []) knownHeads.set(n, new Set(shas));
	const owners = commitOwners(open);
	const headRefs = new Map(open.map((p) => [p.headRef, p]));

	const infos = new Map<number, PRStackInfo>();
	const issues: StackIssue[] = [];

	for (const pr of open) {
		const info: PRStackInfo = {
			number: pr.number,
			parent: null,
			link: null,
			children: [],
			depth: 0,
			expectedBase: input.defaultBranch,
			issues: [],
			broken: false
		};
		infos.set(pr.number, info);

		if (pr.commitsTruncated) {
			info.issues.push({
				kind: 'commits-truncated',
				pr: pr.number,
				severity: 'warning',
				message: `#${pr.number} has more commits than could be fetched; stack detection may be incomplete`
			});
		}

		const r = pr.commits ? nearest(findRelations(pr, all, open, knownHeads, owners)) : null;
		if (r) {
			info.parent = r.parent.number;
			info.link = r.status;
			if (r.parent.state === 'open') info.expectedBase = r.parent.headRef;
			const issue = linkIssue(pr, r);
			if (issue) info.issues.push(issue);
		}

		if (pr.baseRef !== info.expectedBase) {
			const declared = headRefs.get(pr.baseRef);
			// Targeting some non-PR branch (e.g. a release branch) with no stack
			// underneath is a legitimate setup, not a mismatch.
			if (info.parent !== null || declared) {
				const why =
					info.parent !== null && byNumber.get(info.parent)!.state === 'open'
						? `its commits sit on #${info.parent}`
						: declared
							? `it doesn't contain #${declared.number}'s commits`
							: `#${info.parent} is no longer open`;
				info.issues.push({
					kind: 'base-mismatch',
					pr: pr.number,
					parent: info.parent ?? declared?.number,
					// Merging would either drag the parent's commits into the base
					// or land this PR on the parent's branch instead of the base.
					severity: info.link === 'parent-merged' ? 'warning' : 'blocking',
					message: `#${pr.number} targets '${pr.baseRef}' but should target '${info.expectedBase}': ${why}`
				});
			}
		}

		if (input.existingBranches && !input.existingBranches.has(pr.baseRef)) {
			info.issues.push({
				kind: 'base-branch-missing',
				pr: pr.number,
				severity: 'blocking',
				evidence: 'branch-missing',
				message: `#${pr.number}'s base branch '${pr.baseRef}' no longer exists`
			});
		}
	}

	for (const pr of all) {
		const issue = detectAutoClose(pr, input);
		if (issue) issues.push(issue);
	}

	// Children, depth and broken propagation (parents first).
	for (const info of infos.values()) {
		if (info.parent !== null) infos.get(info.parent)?.children.push(info.number);
	}
	const resolve = (info: PRStackInfo, seen: Set<number>): void => {
		if (seen.has(info.number)) return;
		seen.add(info.number);
		const parent = info.parent !== null ? infos.get(info.parent) : undefined;
		if (parent && !seen.has(parent.number)) resolve(parent, seen);
		info.depth = parent ? parent.depth + 1 : info.parent !== null ? 1 : 0;
		info.broken = info.issues.some((i) => i.severity === 'blocking') || !!parent?.broken;
	};
	const done = new Set<number>();
	for (const info of infos.values()) resolve(info, done);

	for (const info of infos.values()) issues.push(...info.issues);

	const stacks: number[][] = [];
	for (const info of infos.values()) {
		if (info.parent !== null && infos.has(info.parent)) continue; // not a root
		if (info.children.length === 0) continue;
		const members: number[] = [];
		const queue = [info.number];
		const seen = new Set<number>();
		while (queue.length) {
			const n = queue.shift()!;
			if (seen.has(n)) continue;
			seen.add(n);
			members.push(n);
			queue.push(...[...infos.get(n)!.children].sort((a, b) => a - b));
		}
		stacks.push(members);
	}

	return { prs: infos, stacks, issues };
}

/**
 * Whether the queue may merge `prNumber` into the default branch now, and
 * why not. Stacked PRs whose parent is still open are held: merging them
 * would either land the parent's commits or merge into the parent's branch.
 */
export function mergeBlocker(analysis: StackAnalysis, prNumber: number): string | null {
	const info = analysis.prs.get(prNumber);
	if (!info) return null;
	const blocking = info.issues.find((i) => i.severity === 'blocking' && i.kind !== 'base-mismatch');
	if (blocking) return blocking.message;
	if (info.parent !== null && analysis.prs.has(info.parent)) {
		return `Stacked on #${info.parent}, which isn't merged yet; merge #${info.parent} first, then restack this PR onto the default branch`;
	}
	const mismatch = info.issues.find((i) => i.kind === 'base-mismatch' && i.severity === 'blocking');
	if (mismatch) return mismatch.message;
	if (info.broken) {
		return `The stack under this PR is broken (see #${info.parent})`;
	}
	return null;
}
