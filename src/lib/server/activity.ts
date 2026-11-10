// What the queue is doing right now, per repository, for the queue page: forming a batch (fetching
// its PRs, merging them, pushing its branch), checking a PR for conflicts, restacking, landing.
// These steps take from seconds to minutes and change nothing the page shows until they end, so
// without this the page looks stuck. Kept in memory: after a restart there is nothing running.
//
// It wraps the queue's deps rather than reporting from inside the queue: every slow step is one of
// their calls, and what the call is for follows from the calls before it (a build after a failed
// build is the conflict check of one PR) and the branch it pushes (mq/batch-*, *-bisect-*, mq/try-*).

import { RateLimitedError } from './rate-limit';
import type { QueueDeps } from './batch-queue';

export type PhaseKind = 'forming' | 'bisect' | 'try' | 'master' | 'restack' | 'landing';

/** A piece of work made of several steps, such as forming a batch. */
export interface ActivityPhase {
	kind: PhaseKind;
	label: string;
	prs: number[];
	/** The branch it pushed, once pushed. */
	branch: string | null;
	since: number;
}

/** The call running now. Its label starts in lower case: it reads after the phase. */
export interface ActivityStep {
	label: string;
	prs: number[];
	since: number;
}

export interface ActivityFailure {
	/** The phase it failed in, if any. */
	phase: string | null;
	step: string;
	prs: number[];
	/** Null where the viewer may not see it (the public page). */
	message: string | null;
	at: number;
}

export interface ActivityView {
	/** When the running tick (or action) started; null when none runs. */
	since: number | null;
	phase: ActivityPhase | null;
	step: ActivityStep | null;
	/** The last step that failed, until the same step next succeeds. */
	failure: ActivityFailure | null;
}

interface RepoActivity extends ActivityView {
	/** The kind of call that failed, so the same call succeeding clears it. */
	failedCall: string | null;
}

const repos = new Map<number, RepoActivity>();

function of(repoId: number): RepoActivity {
	let a = repos.get(repoId);
	if (!a) repos.set(repoId, (a = { since: null, phase: null, step: null, failure: null, failedCall: null }));
	return a;
}

export function activityOf(repoId: number): ActivityView {
	const a = repos.get(repoId);
	if (!a) return { since: null, phase: null, step: null, failure: null };
	return {
		since: a.since,
		phase: a.phase && { ...a.phase, prs: [...a.phase.prs] },
		step: a.step && { ...a.step, prs: [...a.step.prs] },
		failure: a.failure && { ...a.failure, prs: [...a.failure.prs] }
	};
}

/** Forgets a repository's activity (tests). */
export function clearActivity(repoId: number) {
	repos.delete(repoId);
}

const prList = (prs: number[]) => prs.map((n) => `#${n}`).join(' ');

/** What a pushed branch was built for, by its name. */
function branchKind(branch: string): PhaseKind | null {
	if (/-bisect-\d+-\d+$/.test(branch)) return 'bisect';
	if (/^mq\/try-/.test(branch)) return 'try';
	if (/^mq\/base-/.test(branch)) return 'master';
	if (/^mq\/batch-/.test(branch)) return 'forming';
	return null;
}

function phaseLabel(kind: PhaseKind, prs: number[], def: string): string {
	switch (kind) {
		case 'forming':
			return 'Forming a batch';
		case 'bisect':
			return 'Preparing a bisection step';
		case 'try':
			return 'Starting a try run';
		case 'master':
			return `Checking ${def}`;
		case 'restack':
			return `Restacking ${prList(prs)}`;
		case 'landing':
			return 'Landing';
	}
}

/** Calls whose failure the queue shrugs off (cleanup, notices): a failure of theirs isn't shown. */
const IGNORED = new Set(['deleteBranch', 'cancel', 'label', 'comment', 'setPRCheck', 'setStatus']);

export interface TrackOptions {
	/** What a build is for, when the calls can't tell: a bisection step while a batch bisects, a try run. A batch by default. */
	buildKind?: () => 'forming' | 'bisect' | 'try';
}

/** `deps`, with each call recorded as the repository's running step while it runs. */
export function trackActivity(deps: QueueDeps, opts: TrackOptions = {}): QueueDeps {
	const a = of(deps.repo.id);
	const def = deps.repo.default_branch;
	const now = () => deps.now();
	// What the calls so far said, to name what later calls are for.
	const bySha = new Map<string, number>();
	const byRef = new Map<string, number>();
	let lastFetch: { since: number; shas: Set<string> } | null = null;
	let buildFailed = false;

	const learn = (p: { pr: number; headSha: string; headRef: string }) => {
		bySha.set(p.headSha, p.pr);
		byRef.set(p.headRef, p.pr);
	};
	const prsOf = (shas: string[]) => [...new Set(shas.flatMap((s) => (bySha.has(s) ? [bySha.get(s)!] : [])))];

	const setPhase = (kind: PhaseKind, prs: number[], since = now()) => {
		a.phase = { kind, label: phaseLabel(kind, prs, def), prs, branch: null, since };
	};

	async function step<T>(call: string, label: string, prs: number[], fn: () => Promise<T>): Promise<T> {
		const outer = a.step;
		a.step = { label, prs, since: now() };
		try {
			const r = await fn();
			if (a.failedCall === call) {
				a.failure = null;
				a.failedCall = null;
			}
			return r;
		} catch (e) {
			if (!(e instanceof RateLimitedError) && !IGNORED.has(call)) {
				a.failure = { phase: a.phase?.label ?? null, step: label, prs, message: e instanceof Error ? e.message : String(e), at: now() };
				a.failedCall = call;
			}
			throw e;
		} finally {
			a.step = outer;
		}
	}

	const { git, github, ci } = deps;
	return {
		...deps,
		analysis: () => step('analysis', 'reading the stacks', [], () => deps.analysis()),
		git: {
			...git,
			fetch: (shas) => {
				const prs = prsOf(shas);
				lastFetch = { since: now(), shas: new Set(shas) };
				return step('fetch', `fetching ${prs.length ? prList(prs) : 'commits'} from GitHub`, prs, () => git.fetch(shas));
			},
			build: async (base, members) => {
				for (const m of members) bySha.set(m.headSha, m.pr);
				const prs = members.map((m) => m.pr);
				const probe = buildFailed && members.length === 1 && !!a.phase;
				buildFailed = false;
				if (!probe) {
					// A batch is formed from when the fetch of its commits began.
					const since = lastFetch && members.some((m) => lastFetch!.shas.has(m.headSha)) ? lastFetch.since : now();
					setPhase(opts.buildKind?.() ?? 'forming', prs, since);
				}
				const r = await step('build', probe ? `checking ${prList(prs)} against ${def}` : `merging ${prList(prs)}`, prs, () => git.build(base, members));
				buildFailed = !probe && !r.ok;
				return r;
			},
			restack: (head, upstream, onto) => {
				const prs = prsOf([head]);
				if (a.phase?.kind !== 'landing') setPhase('restack', prs);
				else for (const n of prs) if (!a.phase.prs.includes(n)) a.phase.prs.push(n);
				return step('restack', `rebasing ${prs.length ? prList(prs) : 'a PR'}`, prs, () => git.restack(head, upstream, onto));
			},
			baseline: (base) => {
				setPhase('master', []);
				return step('baseline', `making a commit to test ${def}`, [], () => git.baseline(base));
			}
		},
		github: {
			...github,
			pr: async (n) => {
				const p = await step('pr', `reading #${n}`, [n], () => github.pr(n));
				learn(p);
				return p;
			},
			...(github.openPRs
				? {
						openPRs: async () => {
							const all = await step('openPRs', 'reading the open PRs', [], () => github.openPRs!());
							for (const p of all) learn(p);
							return all;
						}
					}
				: {}),
			defaultBranchSha: () => step('defaultBranchSha', `reading ${def}`, [], () => github.defaultBranchSha()),
			readiness: (n, sha, author, o) => step('readiness', `reading the reviews and checks of #${n}`, [n], () => github.readiness(n, sha, author, o)),
			pushBranch: (branch, sha) => {
				const kind = branchKind(branch);
				if (kind && (!a.phase || a.phase.kind !== kind)) setPhase(kind, a.phase?.prs ?? [], a.phase?.since);
				if (a.phase) a.phase.branch = branch;
				return step('pushBranch', `pushing ${branch}`, a.phase?.prs ?? [], () => github.pushBranch(branch, sha));
			},
			pushHead: (branch, sha, expected) => {
				const n = byRef.get(branch) ?? bySha.get(expected);
				const prs = n === undefined ? [] : [n];
				return step('pushHead', `pushing the restacked ${n === undefined ? branch : `#${n}`}`, prs, () => github.pushHead(branch, sha, expected));
			},
			retargetBase: (n, base) => step('retargetBase', `pointing #${n} at ${base}`, [n], () => github.retargetBase(n, base)),
			squashMerge: (n, title, sha) => {
				if (a.phase?.kind !== 'landing') setPhase('landing', []);
				if (!a.phase!.prs.includes(n)) a.phase!.prs.push(n);
				return step('squashMerge', `merging #${n} into ${def}`, [n], () => github.squashMerge(n, title, sha));
			},
			deleteBranch: (branch) => step('deleteBranch', `deleting ${branch}`, [], () => github.deleteBranch(branch)),
			setStatus: (sha, state, d) => step('setStatus', `setting the status of ${def}`, [], () => github.setStatus(sha, state, d)),
			setPRCheck: (sha, check) => {
				const n = bySha.get(sha);
				return step('setPRCheck', `updating the check of ${n === undefined ? 'a PR' : `#${n}`}`, n === undefined ? [] : [n], () => github.setPRCheck(sha, check));
			},
			label: (n, name, on) => step('label', `labelling #${n}`, [n], () => github.label(n, name, on)),
			comment: (n, body) => step('comment', `commenting on #${n}`, [n], () => github.comment(n, body))
		},
		ci: {
			...ci,
			start: (branch, base, head, prs) => step('ciStart', `starting CI on ${branch}`, prs, () => ci.start(branch, base, head, prs)),
			refreshCaches: () => step('refreshCaches', `starting CI on ${def} to refresh caches`, [], () => ci.refreshCaches()),
			result: (sha, notBefore, o) => step('result', 'reading CI results', [], () => ci.result(sha, notBefore, o)),
			cancel: (sha) => step('cancel', 'cancelling CI of a run no longer needed', [], () => ci.cancel(sha)),
			rerunFailed: (sha) => step('rerunFailed', 're-running failed jobs', [], () => ci.rerunFailed(sha)),
			runUrl: (sha) => step('runUrl', 'reading CI results', [], () => ci.runUrl(sha))
		}
	};
}

/**
 * Runs `fn` (a tick, or an action such as a try run) with tracked deps. While it runs the
 * repository has a running activity; when it ends, the phase and step end with it, and only a
 * failure stays.
 */
export async function withActivity<T>(deps: QueueDeps, fn: (d: QueueDeps) => Promise<T>, opts: TrackOptions = {}): Promise<T> {
	const a = of(deps.repo.id);
	a.since = deps.now();
	try {
		return await fn(trackActivity(deps, opts));
	} finally {
		a.since = null;
		a.phase = null;
		a.step = null;
	}
}
