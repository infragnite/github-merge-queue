// The batch merge queue's state machine: one `tickBatchQueue` call per
// processor cycle advances a repo's pipeline by whatever has changed.
//
//   restack -> plan -> build -> push mq/* branch -> CI ─ pass ──────────────> land
//                                                    └ fail -> re-run failed ─ pass -> land
//                                                                            └ fail -> bisect -> eject culprits,
//                                                                                      land the rest
//
// Batches are pipelined: batch k+1 is built on batch k's head. Landing
// squash-merges each PR through the API at its tested head (a stacked child is
// first restacked onto master exactly as it was built), and after every merge
// master's tree must equal the tree tested for that step, so nothing untested
// reaches master unnoticed. Batches are matched to master by tree, not by SHA.
//
// All GitHub, CI and git access goes through `QueueDeps`, so the machine is
// tested end to end against a real git sandbox and fakes.

import * as db from './db';
import * as store from './batch-store';
import type { BatchRow, BatchStep } from './batch-store';
import {
	admit,
	holdAdvice,
	planBisection,
	descendants,
	planRedBatch,
	type Hold,
	type HoldCode,
	type PRState,
	type Priority,
	type QueueEntry,
	type TestGroup
} from './batching';
import { planNextBatch } from './queue-model';
import type { BatchMember, BuildResult } from './batch-builder';
import type { ReplayResult } from './rebase';
import type { StackAnalysis } from './stacks';
import type { QueueItem } from '$lib/types';
import { RateLimitedError } from './rate-limit';
import { emitEvent, heldPRs, type QueueEventKind } from './events';

/** A PR as the queue sees it; `PRState`'s readiness fields come from `QueueGitHub.readiness`. */
export interface LivePR {
	pr: number;
	headSha: string;
	headRef: string;
	/** The head branch is in this repository (the queue can push to it). */
	sameRepo: boolean;
	draft: boolean;
	title: string;
	url: string;
	authorLogin: string;
	baseRef: string;
	state: 'open' | 'closed';
	merged: boolean;
}

export type Readiness = Pick<PRState, 'ciGreen' | 'approvedShas' | 'changesRequested'>;

export interface QueueGitHub {
	defaultBranchSha(): Promise<string>;
	pr(n: number): Promise<LivePR>;
	/**
	 * Every open PR, in one paginated list: a tick reads its PRs from it instead of one call per
	 * PR, which with a long queue would spend GitHub's hourly rate limit in minutes.
	 */
	openPRs?(): Promise<LivePR[]>;
	/** CI and reviews of a PR at `headSha` (the expensive part, fetched only when needed). */
	/** `needApprovals`: fetch reviews even when the config doesn't require approval (a fork PR). */
	readiness(n: number, headSha: string, author: string, opts?: { needApprovals?: boolean; fresh?: boolean }): Promise<Readiness>;
	/** Creates or force-moves a queue branch to `sha` (the commit must be in the mirror). */
	pushBranch(branch: string, sha: string): Promise<void>;
	/** Moves a PR's head branch to `sha`, only if it still points at `expected`. */
	pushHead(branch: string, sha: string, expected: string): Promise<void>;
	deleteBranch(branch: string): Promise<void>;
	retargetBase(n: number, base: string): Promise<void>;
	squashMerge(
		n: number,
		title: string,
		expectedHeadSha: string
	): Promise<{ merged: boolean; sha?: string | null; message?: string }>;
	/** The queue's "tested" status on master commits. */
	setStatus(sha: string, state: 'success' | 'failure' | 'pending', description: string): Promise<void>;
	/**
	 * The queue's status on a PR head (the configured `prStatus`, `merge-queue` by default, or that
	 * context plus `suffix`). The default branch should require it, sourced from this app.
	 */
	setPRStatus(
		sha: string,
		state: 'success' | 'failure' | 'pending',
		description: string,
		opts?: { suffix?: string; url?: string }
	): Promise<void>;
	label(n: number, name: string, on: boolean): Promise<void>;
	comment(n: number, body: string): Promise<void>;
}

export interface QueueCI {
	/**
	 * Called after `branch` was pushed with the batch commit `headSha` built on `baseSha`. The push
	 * itself triggers CI (`on: push: branches: ['mq/**']`), so this usually does nothing.
	 */
	start(branch: string, baseSha: string, headSha: string, prs: number[]): Promise<void>;
	/** Runs the workflow on the default branch, so caches are saved in its scope. */
	refreshCaches(): Promise<void>;
	/**
	 * The required check's result on `headSha`. With `notBefore` (epoch ms, when failed jobs were
	 * re-run), a check run that finished before it is stale: the result is pending until a newer one finishes.
	 * With `failFast`, a failed job the required check waits for makes it a failure at once.
	 */
	result(headSha: string, notBefore?: number | null, opts?: { failFast?: boolean }): Promise<'pending' | 'success' | 'failure'>;
	/** Cancels workflow runs still going on `headSha` (a superseded batch). */
	cancel(headSha: string): Promise<void>;
	/** Re-runs only the failed jobs; false when there is nothing to re-run. */
	rerunFailed(headSha: string): Promise<RerunResult>;
	/** A link to the required check's run on `headSha` (a failed job first), once it exists. */
	runUrl(headSha: string): Promise<string | null>;
}

export interface QueueGit {
	/** Makes sure the mirror has these commits. */
	fetch(shas: string[]): Promise<void>;
	tree(sha: string): Promise<string>;
	build(baseSha: string, members: BatchMember[]): Promise<BuildResult>;
	/** `git rebase --onto onto upstream head`, when it needs no conflict resolution. */
	restack(head: string, upstream: string, onto: string): Promise<ReplayResult>;
	/** A commit with `base`'s own tree on top of it, to test the default branch alone. */
	baseline(base: string): Promise<string>;
}

export interface QueueDeps {
	repo: { id: number; owner: string; name: string; default_branch: string };
	github: QueueGitHub;
	ci: QueueCI;
	git: QueueGit;
	analysis(): Promise<StackAnalysis>;
	now(): number;
	/** Waits; tests pass a no-op. */
	sleep?: (ms: number) => Promise<void>;
	log?: (msg: string) => void;
}

/** Why a PR deferred behind `ahead` waits. */
const deferredReason = (ahead: number[]) => `Conflicts with ${ahead.map((a) => `#${a}`).join(' ')} ahead of it; waits for them to land`;

const LIVE = ['queued', 'checking', 'updating', 'merging', 'conflict'];
export const CONFLICT_LABEL = 'needs-rebase';

/** `wait`: the failed check's workflow is still running other jobs; GitHub re-runs only finished runs. */
export type RerunResult = 'rerun' | 'none' | 'wait';
/** When each repo last had its caches refreshed (in memory: a restart costs one extra refresh). */
const lastCacheRefresh = new Map<number, number>();
/** A default-branch or baseline run that reports nothing in this long is given up on. */
const MASTER_CHECK_TIMEOUT_MS = 3 * 60 * 60 * 1000;
/** Batch failures without a culprit after which a PR leaves the queue (a flaky test, most likely). */
const MAX_BATCH_FAILURES = 3;

/** Commit status descriptions are cut at 140 characters. */
function short(text: string): string {
	return text.length > 138 ? `${text.slice(0, 135)}...` : text;
}

function sqliteMs(ts: string): number {
	return Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
}

class Tick {
	private readonly prs = new Map<number, LivePR>();
	/** This tick's list of open PRs, read once (null: not read yet, or stale after a landing). */
	private open: Map<number, LivePR> | null = null;
	private readonly ready = new Map<string, Readiness>();
	private analysisCache: StackAnalysis | null = null;

	constructor(private readonly d: QueueDeps) {}

	get repoId() {
		return this.d.repo.id;
	}

	log(msg: string) {
		(this.d.log ?? ((m) => console.log(`[batch-queue] ${this.d.repo.owner}/${this.d.repo.name}: ${m}`)))(msg);
	}

	/** Catch handler for a call whose failure must not stop the tick; the failure is still logged. */
	bestEffort(what: string) {
		return (err: unknown) => this.log(`${what} failed (ignored): ${err instanceof Error ? err.message : err}`);
	}

	event(pr: number | null, kind: QueueEventKind, data: Record<string, unknown> = {}) {
		try {
			emitEvent(this.repoId, pr, kind, data);
		} catch (e) {
			this.log(`could not record event ${kind}: ${e instanceof Error ? e.message : e}`);
		}
	}

	/** Forgets what this tick read about PRs (after a landing moved them). */
	forgetPRs() {
		this.prs.clear();
		this.open = null;
	}

	/**
	 * A PR as GitHub has it. Unless `fresh`, it comes from this tick's one list of open PRs; a PR
	 * not in it (closed or merged) is fetched alone. `fresh` fetches it alone, for a check right
	 * before acting on it.
	 */
	async pr(n: number, fresh = false): Promise<LivePR> {
		let p = fresh ? undefined : this.prs.get(n);
		if (!p && !fresh && this.d.github.openPRs) {
			this.open ??= new Map((await this.d.github.openPRs()).map((x) => [x.pr, x]));
			p = this.open.get(n);
			if (p) this.prs.set(n, p);
		}
		if (!p) {
			p = await this.d.github.pr(n);
			this.prs.set(n, p);
		}
		return p;
	}

	/** The PR with CI and approval state, for admission. */
	async state(n: number, fresh = false): Promise<PRState> {
		const p = await this.pr(n, fresh);
		const key = `${n}@${p.headSha}`;
		let r = fresh ? undefined : this.ready.get(key);
		if (!r) {
			r = await this.d.github.readiness(n, p.headSha, p.authorLogin, { needApprovals: !p.sameRepo, fresh });
			this.ready.set(key, r);
		}
		// A head the queue made by restacking keeps the approval and CI of the head it replaced.
		const from = store.rebasedFrom(this.repoId, n, p.headSha);
		let { ciGreen, approvedShas } = r;
		if (from.length) {
			if (from.some((f) => r.approvedShas.includes(f.sha))) approvedShas = [...approvedShas, p.headSha];
			if (ciGreen === null && from[0].ciGreen === true) ciGreen = true;
		}
		if (!this.settings().config.requirePRChecks) ciGreen = true;
		return {
			pr: n,
			headSha: p.headSha,
			draft: p.draft,
			ciGreen,
			approvedShas,
			changesRequested: r.changesRequested,
			targetsDefault: p.baseRef === this.d.repo.default_branch,
			fromFork: !p.sameRepo
		};
	}

	async analysis(): Promise<StackAnalysis> {
		this.analysisCache ??= await this.d.analysis();
		return this.analysisCache;
	}

	items(): QueueItem[] {
		return db.getQueueItems(this.repoId).filter((i) => LIVE.includes(i.status));
	}

	item(n: number): QueueItem | undefined {
		return this.items().find((i) => i.pr_number === n);
	}

	settings() {
		return planningSettings(store.getQueueSettings(this.repoId));
	}

	/** The Actions runs of a queue branch; a link that works before the run exists and after the branch is deleted. */
	branchRuns(branch: string): string {
		return `https://github.com/${this.d.repo.owner}/${this.d.repo.name}/actions?query=${encodeURIComponent(`branch:${branch}`)}`;
	}

	/** The run that tested `run`'s commit, falling back to its branch's runs. */
	async runLink(run: Pick<BatchRow, 'head_sha' | 'branch'>): Promise<string> {
		return (await this.d.ci.runUrl(run.head_sha).catch(() => null)) ?? this.branchRuns(run.branch);
	}

	pause(reason: string) {
		store.updateQueueSettings(this.repoId, { pausedReason: reason });
		this.event(null, 'paused', { reason });
		this.log(reason);
	}

	async parentOf(): Promise<(n: number) => number | null> {
		const a = await this.analysis();
		return (n) => {
			const p = a.prs.get(n)?.parent ?? null;
			return p !== null && a.prs.has(p) ? p : null;
		};
	}

	// --- outcomes ---

	async eject(n: number, reason: string, link?: string) {
		const it = this.item(n);
		if (!it) return;
		const head = (await this.pr(n).catch(() => null))?.headSha ?? it.head_sha;
		if (head) {
			await this.d.github
				.setPRStatus(head, 'failure', short(`Left the queue: ${reason}`), link ? { url: link } : undefined)
				.catch(this.bestEffort('github.setPRStatus'));
		}
		db.updateQueueItemStatus(it.id, 'failed', reason);
		db.addToHistory(this.repoId, n, it.pr_title, it.pr_url, it.author_login, null, 'failed', reason, it.created_at);
		db.removeFromQueue(it.id);
		await this.d.github
			.comment(n, `Removed from the merge queue: ${reason}${link ? `\n\nCI run: ${link}` : ''}`)
			.catch(this.bestEffort('github.comment'));
		this.event(n, 'ejected', { reason });
		this.log(`ejected #${n}: ${reason}`);
	}

	/** Ejects the culprits and the PRs stacked on them; returns every PR it ejected. */
	async ejectWithStack(culprits: { pr: number; reason: string; link?: string }[]): Promise<number[]> {
		const a = await this.analysis();
		const done = new Set<number>();
		for (const c of culprits) {
			await this.eject(c.pr, c.reason, c.link);
			done.add(c.pr);
		}
		for (const n of descendants(a, done)) {
			if (done.has(n) || !this.item(n)) continue;
			const p = a.prs.get(n)?.parent;
			await this.eject(n, `Stacked on #${p}, which failed in the queue`);
			done.add(n);
		}
		return [...done];
	}

	requeue(prs: number[]) {
		for (const n of prs) {
			const it = this.item(n);
			if (it && it.status === 'checking') db.updateQueueItemStatus(it.id, 'queued');
		}
	}

	/**
	 * A PR in a batch that failed without it being found the culprit goes back
	 * to the queue; after a few such failures it leaves, so an unexplained
	 * (flaky) failure can't loop forever.
	 */
	async requeueAfterFailure(prs: number[], batch: BatchRow) {
		for (const n of prs) {
			const it = this.item(n);
			if (!it) continue;
			if (store.bumpBatchFailures(it.id) >= MAX_BATCH_FAILURES) {
				await this.ejectWithStack([
					{ pr: n, reason: `failed in ${MAX_BATCH_FAILURES} batches without a clear culprit (flaky tests?), last batch ${batch.number}` }
				]);
			} else {
				db.updateQueueItemStatus(it.id, 'queued');
				this.event(n, 'requeued', { batch: batch.id, number: batch.number });
			}
		}
	}

	/** Every active batch from `from` on is rebuilt later; their PRs go back to the queue. */
	async supersede(batches: BatchRow[], why = 'a batch below it failed or master moved') {
		for (const b of batches) {
			store.setBatchStatus(b.id, 'superseded');
			this.requeue(b.members);
			await this.retire(b);
			for (const n of b.members) {
				if (this.item(n)?.status !== 'queued') continue;
				await this.d.github
					.setPRStatus(b.heads[n], 'pending', short(`Back in line: ${b.branch} was dropped (${why}); it is rebuilt`))
					.catch(this.bestEffort('github.setPRStatus'));
			}
		}
	}

	/** Stops a batch's CI (deleting a branch doesn't) and deletes its branch, and its bisection runs'. */
	async retire(b: BatchRow) {
		for (const r of [b, ...(b.kind === 'batch' ? store.getBisectRuns(b.id) : [])]) {
			// A cancelled run never started CI, so there is nothing of its own to stop.
			if (r.status !== 'cancelled' && (r.ci_result === 'pending' || r.status === 'retrying')) await this.d.ci.cancel(r.head_sha).catch(this.bestEffort('ci.cancel'));
			await this.d.github.deleteBranch(r.branch).catch(this.bestEffort('github.deleteBranch'));
		}
	}

	// --- conflicts ---

	/**
	 * A real conflict: the PR stays in the queue, marked `conflict` at its
	 * current head, and the author (an agent watching its checks, usually) is
	 * told on the PR. A push clears it and the PR is picked up again.
	 */
	async conflict(n: number, reason: string, files: string[], fix: string) {
		const it = this.item(n);
		const p = await this.pr(n);
		if (it) {
			db.updateQueueItemHeadSha(it.id, p.headSha);
			db.updateQueueItemStatus(it.id, 'conflict', reason);
		}
		await this.d.github.setPRStatus(p.headSha, 'failure', short(`Conflict: ${reason}`)).catch(this.bestEffort('github.setPRStatus'));
		await this.d.github.label(n, CONFLICT_LABEL, true).catch(this.bestEffort('github.label'));
		const list = files.length ? `\n\nConflicting files:\n${files.slice(0, 20).map((f) => `- \`${f}\``).join('\n')}` : '';
		await this.d.github
			.comment(
				n,
				`The merge queue can't apply this PR: ${reason}.${list}\n\nTo fix it:\n\n\`\`\`sh\n${fix}\n# resolve the conflicts, then\ngit push --force-with-lease\n\`\`\`\n\nThe PR stays queued and is picked up again after the push.`
			)
			.catch(this.bestEffort('github.comment'));
		this.event(n, 'conflict', { reason, files, fix, headSha: p.headSha });
		this.log(`#${n} has a conflict: ${reason}`);
	}

	async rebaseCommand(n: number): Promise<string> {
		const def = this.d.repo.default_branch;
		const parent = (await this.parentOf())(n);
		return parent !== null
			? `git fetch origin pull/${parent}/head && git rebase FETCH_HEAD`
			: `git fetch origin ${def} && git rebase origin/${def}`;
	}

	// --- building ---

	async members(prs: number[], below: number[]): Promise<BatchMember[]> {
		const parentOf = await this.parentOf();
		const present = new Set([...below, ...prs]);
		const out: BatchMember[] = [];
		for (const n of prs) {
			const p = await this.pr(n);
			const parent = parentOf(n);
			out.push({
				pr: n,
				headSha: p.headSha,
				title: p.title,
				parentHeadSha: parent !== null && present.has(parent) ? (await this.pr(parent)).headSha : null
			});
		}
		return out;
	}

	/**
	 * Builds `prs` on `baseSha`. A PR that conflicts only with other PRs ahead
	 * of it waits for them; one that conflicts with master gets a conflict
	 * notice. Either way it returns null so the caller replans without it.
	 */
	async build(baseSha: string, prs: number[], below: number[], masterSha: string) {
		const members = await this.members(prs, below);
		await this.d.git.fetch([baseSha, masterSha, ...members.map((m) => m.headSha)]);
		const r = await this.d.git.build(baseSha, members);
		if (r.ok) return { result: r, members };

		const bad = members.find((m) => m.pr === r.pr)!;
		const alone = await this.d.git.build(masterSha, [{ ...bad, parentHeadSha: null }]);
		const it = this.item(r.pr);
		if (alone.ok && it) {
			const ahead = [...below, ...prs.slice(0, prs.indexOf(r.pr))];
			store.setDeferredFor(it.id, ahead);
			db.updateQueueItemStatus(it.id, 'queued', deferredReason(ahead));
			this.event(r.pr, 'deferred', { behind: ahead, reason: r.reason });
			this.log(`#${r.pr} deferred: ${r.reason}`);
		} else {
			await this.conflict(r.pr, alone.ok ? r.reason : alone.reason.replace(/^#\d+ /, ''), alone.ok ? r.conflicts : alone.conflicts, await this.rebaseCommand(r.pr));
		}
		return null;
	}

	async startBatch(
		baseSha: string,
		prs: number[],
		below: number[],
		express: boolean,
		masterSha: string
	): Promise<'started' | 'conflict' | 'error'> {
		const built = await this.build(baseSha, prs, below, masterSha);
		if (!built) return 'conflict';
		const { result, members } = built;
		// A PR whose changes are all on the default branch already adds nothing: there is nothing to
		// test or squash (GitHub refuses an empty squash), and a batch of only such PRs would point
		// its branch at the default branch's own commit.
		let tip = baseSha;
		const empty: number[] = [];
		for (const c of result.commits) {
			if (c.sha === tip) empty.push(c.pr);
			tip = c.sha;
		}
		if (empty.length) {
			if (baseSha !== masterSha) {
				// Its changes may be those of a PR in a batch ahead, which can still fail: wait for it.
				for (const n of empty) {
					const it = this.item(n);
					if (it) store.setDeferredFor(it.id, below);
				}
				return 'conflict';
			}
			for (const n of empty) await this.eject(n, `#${n} has no changes left against ${this.d.repo.default_branch}`);
			return 'conflict';
		}
		const branch = `mq/batch-${this.d.now()}`;
		store.intendBranch(this.repoId, branch, result.headSha);
		try {
			await this.d.github.pushBranch(branch, result.headSha);
			await this.d.ci.start(branch, baseSha, result.headSha, prs);
		} catch (e) {
			// A rate limit passes by itself: the branch intent stays for the sweep, and the tick stops until the reset.
			if (e instanceof RateLimitedError) throw e;
			// A push or dispatch failure is a setup problem (permissions, workflow trigger): stop and say so.
			await this.d.github.deleteBranch(branch).catch(this.bestEffort('github.deleteBranch'));
			this.pause(`Could not start a batch of ${prs.map((n) => `#${n}`).join(' ')}: ${e instanceof Error ? e.message : e}`);
			return 'error';
		}
		const steps: Record<number, BatchStep> = {};
		const parentAt = await this.parentOf();
		for (const c of result.commits) steps[c.pr] = { sha: c.sha, tree: c.tree, fork: c.fork, parent: parentAt(c.pr) };
		const batch = store.insertBatch({
			repoId: this.repoId,
			kind: 'batch',
			branch,
			baseSha,
			headSha: result.headSha,
			treeSha: result.tree,
			baseTree: await this.d.git.tree(baseSha),
			members: prs,
			heads: Object.fromEntries(members.map((m) => [m.pr, m.headSha])),
			steps,
			express
		});
		store.branchPushed(this.repoId, branch);
		for (const n of prs) {
			const it = this.item(n);
			if (it) {
				db.updateQueueItemStatus(it.id, 'checking');
				this.event(n, 'batched', { batch: batch.id, branch, prs });
				await this.d.github
					.setPRStatus(batch.heads[n], 'pending', short(`Testing in ${branch} with ${prs.length - 1} other PR(s)`), { url: this.branchRuns(branch) })
					.catch(this.bestEffort('github.setPRStatus'));
			}
		}
		this.log(`batch ${batch.number} started: ${prs.map((n) => `#${n}`).join(' ')}${express ? ' (express)' : ''}`);
		return 'started';
	}

	// --- landing ---

	/**
	 * The PRs of `prs` that can no longer land as tested (pushed to, closed, left the queue, lost
	 * their approval), with the PRs stacked on them: those go back in line, the rest still land.
	 */
	async notLandable(batch: BatchRow, prs: number[], src: BatchRow): Promise<Set<number>> {
		const config = this.settings().config;
		const a = await this.analysis();
		const out = new Set<number>();
		for (const n of prs) {
			const it = this.item(n);
			if (!it || it.status !== 'checking') {
				this.log(`#${n} left the queue while batch ${batch.number} was testing; the rest lands without it`);
				this.skip(out, prs, n);
				continue;
			}
			const s = await this.state(n, true);
			const p = await this.pr(n);
			if (p.state !== 'open' || p.headSha !== batch.heads[n]) {
				// The author pushed or closed it after the batch was built: what we tested is stale.
				this.log(`#${n} changed after batch ${batch.number} was built; the rest lands without it`);
				this.skip(out, prs, n);
				continue;
			}
			// Reviews and drafts may have changed while the batch was testing; the batch's own CI stands in for the PR's.
			const adm = admit({ ...s, ciGreen: true }, a, config);
			if (!adm.ok) {
				db.updateQueueItemStatus(it.id, 'checking', adm.reason);
				this.log(`#${n} can no longer land: ${adm.reason}; the rest lands without it`);
				this.skip(out, prs, n);
			}
		}
		return out;
	}

	/** The parent of each PR of the landing under way, inside or outside the group. */
	parentAt: (n: number) => number | null = () => null;

	/** Adds `n` to `out`, with every PR of `prs` stacked on it (directly or not). */
	skip(out: Set<number>, prs: number[], n: number) {
		out.add(n);
		for (const m of prs) {
			for (let p = this.parentAt(m), seen = 0; p !== null && seen < prs.length; p = this.parentAt(p), seen++) {
				if (out.has(p)) {
					out.add(m);
					break;
				}
			}
		}
	}

	/**
	 * PRs of the landing under way that are left out of it (changed, or no longer apply without
	 * one that changed). Once any is, master holds a tree no run tested on its own: the rest still
	 * lands, but master is then checked alone rather than trusted.
	 */
	skipped = new Set<number>();

	/**
	 * Lands `prs` from `src` (the batch, or the bisection run that proved
	 * them). Before each merge master must hold the tree tested for the step
	 * before it, and after each merge the tree tested for that step.
	 */
	async land(batch: BatchRow, prs: number[], src: BatchRow): Promise<boolean> {
		// A PR that can no longer land as tested goes back in line, with what is stacked on it; the
		// rest of the group was tested as one tree with it, so no subset is safer than another: all
		// of the rest lands, and master is then checked alone.
		const known = await this.parentOf();
		// Older batches recorded no parents; their stacks come from what the queue knows now.
		this.parentAt = (m) => (src.steps[m] && src.steps[m].parent !== undefined ? src.steps[m].parent! : known(m));
		this.skipped = await this.notLandable(batch, prs, src);
		const part = prs.filter((n) => !this.skipped.has(n));
		if (!part.length) return false;
		// Recorded before the first merge: a crash before it is cleared is finished by `recoverLanding`.
		store.setLandingIntent(this.repoId, { batchId: batch.id, srcId: src.id, prs: part, group: prs });
		const merged: number[] = [];
		const ok = (await this.landNow(batch, part, src, merged)) && this.skipped.size === 0;
		// What landed is recorded together with clearing the intent, so a crash can't split them.
		// A landing of part of the group (one stopped, or left PRs out) puts on master a tree no run
		// tested on its own (only the whole group was), so it is not marked green; the next tick
		// checks it alone, and a bisection carries those PRs as landed.
		const record = () => {
			if (merged.length && batch.status === 'bisecting') {
				// Unless master is known to hold what landed, the batch keeps its base; the master move is handled next tick.
				const h = ok ? store.getMasterHealth(this.repoId)! : { sha: batch.base_sha, tree: batch.base_tree };
				store.recordBisectLanding(batch.id, merged, h.sha, h.tree);
				if (ok) store.setBatchStatus(src.id, 'landed');
			}
			store.setLandingIntent(this.repoId, null);
		};
		db.getDb().transaction(record)();
		return ok;
	}

	/**
	 * After a crash in the middle of a landing: records what was merged, and takes the green
	 * status back from what wasn't (it would let anyone merge it around the queue).
	 */
	/** Settles what a crash interrupted: branch pushes and landings. Cheap when there is nothing. */
	async recoverInterrupted() {
		await this.sweepBranchIntents();
		await this.recoverLanding();
	}

	async recoverLanding() {
		const intent = store.getLandingIntent(this.repoId);
		if (!intent) return;
		const batch = store.getBatch(intent.batchId);
		const src = store.getBatch(intent.srcId);
		const merged: number[] = [];
		for (const n of intent.prs) {
			// A GitHub error here is transient: the intent stays, and the next tick tries again.
			let p: LivePR;
			try {
				p = await this.pr(n, true);
			} catch (e) {
				// A deleted PR can't be settled; anything else is transient and the intent stays for the next tick.
				if ((e as { status?: number })?.status === 404) continue;
				throw e;
			}
			if (p.merged) {
				merged.push(n);
				const it = this.item(n);
				if (it) {
					db.addToHistory(this.repoId, n, it.pr_title, it.pr_url, it.author_login, null, 'merged', null, it.created_at);
					db.removeFromQueue(it.id);
					this.event(n, 'merged', { batch: intent.batchId });
				}
			} else if (p.state === 'open') {
				// A rate limit keeps the intent, so the green status is taken back after the reset.
				await this.d.github.setPRStatus(p.headSha, 'pending', short('Waiting for the merge queue (landing was interrupted)')).catch((e) => {
					if (e instanceof RateLimitedError) throw e;
					this.bestEffort('github.setPRStatus')(e);
				});
			}
		}
		if (merged.length && batch && src) {
			const master = await this.d.github.defaultBranchSha();
			await this.d.git.fetch([master]);
			const tree = await this.d.git.tree(master);
			const last = intent.prs.filter((n) => merged.includes(n)).at(-1)!;
			// The whole group, not just the PRs this landing set out to merge (some may have been left out).
			const all = intent.group.every((n) => merged.includes(n) || batch.landed.includes(n));
			if (src.steps[last]?.tree === tree) {
				// Master holds the queue's landing. Only all of it is a tree a run tested; part of it is
				// checked alone next tick (master's health is left as it was, for an older tree).
				if (all) store.setMasterHealth(this.repoId, { sha: master, tree, state: 'green', since: this.d.now() });
				if (batch.status === 'bisecting') {
					const h = all ? { sha: master, tree } : { sha: batch.base_sha, tree: batch.base_tree };
					store.recordBisectLanding(batch.id, merged.filter((n) => !batch.landed.includes(n)), h.sha, h.tree);
				} else if (all && batch.status === 'passed') {
					store.setBatchStatus(batch.id, 'landed');
					await this.retire(batch);
				}
			}
			this.log(`recovered an interrupted landing of batch ${batch.number}: merged ${merged.map((n) => `#${n}`).join(' ')}`);
		}
		store.setLandingIntent(this.repoId, null);
		this.forgetPRs();
	}

	/**
	 * `n` changed (pushed to or closed) while its batch was landing. No pause: it goes back in line
	 * with its new head, with what is stacked on it; the rest still lands, and master is then
	 * checked alone (it holds a tree no run tested).
	 */
	changedWhileLanding(batch: BatchRow, n: number, now: LivePR, prs: number[], src: BatchRow) {
		this.skip(this.skipped, prs, n);
		this.log(`#${n} ${now.state !== 'open' ? 'was closed' : 'was pushed to'} while batch ${batch.number} was landing; the rest lands without it`);
		this.event(n, 'changed', { batch: batch.id, from: batch.heads[n], to: now.headSha });
	}

	/** Lands `prs` in order; each PR it merges is appended to `merged`, whatever the result. */
	async landNow(batch: BatchRow, prs: number[], src: BatchRow, merged: number[] = []): Promise<boolean> {
		const def = this.d.repo.default_branch;

		let master = await this.d.github.defaultBranchSha();
		await this.d.git.fetch([master]);
		let expected = src.base_tree;
		for (const n of prs) {
			if (this.settings().pausedReason) return false;
			if (this.skipped.has(n)) continue;
			if (!this.item(n)) {
				// Dequeued while the PRs before it were landing: the rest lands without it.
				this.log(`#${n} left the queue while batch ${batch.number} was landing; the rest lands without it`);
				this.skip(this.skipped, prs, n);
				continue;
			}
			// Each merge lands exactly the tree tested for its step; once a PR is left out, only the
			// first merge still has one (the group's base): something merged around the queue is a pause.
			if ((!this.skipped.size || !merged.length) && (await this.d.git.tree(master)) !== expected) {
				this.pause(`Master changed while batch ${batch.number} was landing (before #${n}); was something merged outside the queue?`);
				return false;
			}
			const step = src.steps[n];
			// Read now, not from the start of the tick: the author may push while the PRs before it land.
			const p = await this.pr(n, true);
			let head = batch.heads[n];
			if (p.state !== 'open' || p.headSha !== head) {
				this.changedWhileLanding(batch, n, p, prs, src);
				continue;
			}
			if (step.fork) {
				// A stacked child: its parent just landed as a squash commit, so restack the child's own
				// commits onto master; GitHub's squash of the restacked head is then the tested tree.
				await this.d.git.fetch([head, step.fork]);
				const r = await this.d.git.restack(head, step.fork, master);
				if (this.skipped.size && !r.ok) {
					// It only applied on top of a PR left out: back in line with it.
					this.log(`#${n} does not apply without the PRs left out of batch ${batch.number}; back in line`);
					this.skip(this.skipped, prs, n);
					continue;
				}
				if (!r.ok || (!this.skipped.size && r.tree !== step.tree)) {
					this.pause(`Could not restack #${n} onto master to land it: ${r.ok ? 'the result differs from the tested tree' : r.reason}`);
					return false;
				}
				if (!p.sameRepo) {
					this.pause(`#${n} is stacked and comes from a fork; the queue can't restack it to land it`);
					return false;
				}
				try {
					await this.d.github.pushHead(p.headRef, r.head, head);
				} catch (e) {
					if (e instanceof RateLimitedError) throw e;
					this.pause(`Could not push the restacked #${n}: ${e instanceof Error ? e.message : e}`);
					return false;
				}
				store.recordRebasedHead(this.repoId, n, head, r.head, true);
				this.event(n, 'rebased', { from: head, to: r.head, onto: def, reason: 'landing after its parent' });
				head = r.head;
				// GitHub takes a moment to see the new head; merging before that is refused.
				if (!(await this.waitForHead(n, head))) {
					this.pause(`GitHub did not pick up the restacked head of #${n} in time`);
					return false;
				}
			}
			if (p.baseRef !== def) await this.d.github.retargetBase(n, def);
			// The default branch requires this status, so only the queue can merge, and only what it
			// tested. Any outcome but a merge takes it back, so nobody can merge around the queue.
			let m: { merged: boolean; sha?: string | null; message?: string };
			try {
				await this.d.github.setPRStatus(head, 'success', short(`Tested in ${src.branch}`), { url: await this.runLink(src) });
				m = await this.mergeWithRetry(n, p.title, head);
			} catch (e) {
				if (e instanceof RateLimitedError) {
					// The landing intent stays (the caller does not clear it on a throw): after the reset,
					// `recoverLanding` records what merged and takes the green status back from the rest.
					await this.d.github.setPRStatus(head, 'pending', short(`Waiting for the merge queue (GitHub rate limit)`)).catch(this.bestEffort('github.setPRStatus'));
					throw e;
				}
				m = { merged: false, message: e instanceof Error ? e.message : String(e) };
			}
			if (!m.merged) {
				// Pushed to between the check above and the merge: GitHub refuses a merge at a stale head.
				const now = await this.pr(n, true).catch((e) => {
					if (e instanceof RateLimitedError) throw e;
					return null;
				});
				if (now && (now.state !== 'open' || now.headSha !== head)) {
					await this.d.github.setPRStatus(head, 'pending', short(`Changed while batch ${batch.number} was landing; back in line`)).catch(this.bestEffort('github.setPRStatus'));
					this.changedWhileLanding(batch, n, now, prs, src);
					continue;
				}
				if (this.skipped.size) {
					// With a PR left out it may no longer apply (it was tested on top of that one): back in line.
					await this.d.github.setPRStatus(head, 'pending', short(`Did not merge without the PRs left out of batch ${batch.number}; back in line`)).catch(this.bestEffort('github.setPRStatus'));
					this.log(`#${n} did not merge without the PRs left out of batch ${batch.number} (${m.message ?? 'merge refused'}); back in line`);
					this.skip(this.skipped, prs, n);
					continue;
				}
				await this.d.github.setPRStatus(head, 'pending', short(`Waiting for the merge queue (landing stopped)`)).catch(this.bestEffort('github.setPRStatus'));
				this.pause(`Landing batch ${batch.number} stopped at #${n}: ${m.message ?? 'merge refused'}`);
				return false;
			}
			merged.push(n);
			master = m.sha ?? (await this.d.github.defaultBranchSha());
			await this.d.git.fetch([master]);
			const it = this.item(n);
			if (it) {
				db.addToHistory(this.repoId, n, it.pr_title, it.pr_url, it.author_login, master, 'merged', null, it.created_at);
				db.removeFromQueue(it.id);
			}
			this.event(n, 'merged', { batch: batch.id, sha: master });
			expected = step.tree;
		}
		if (this.skipped.size) {
			// Part of the group: this tree was never tested on its own. Master is left unknown, so the
			// next tick checks it alone; what was left out goes back in line.
			this.log(`batch ${batch.number} landed ${merged.map((n) => `#${n}`).join(' ') || 'nothing'}; back in line: ${[...this.skipped].map((n) => `#${n}`).join(' ')}`);
			this.analysisCache = null;
			this.forgetPRs();
			return merged.length > 0;
		}
		if ((await this.d.git.tree(master)) !== expected) {
			this.pause(`Master after batch ${batch.number} does not match the tested tree; was something merged outside the queue?`);
			return false;
		}
		await this.d.github.setStatus(master, 'success', `Tree tested in ${src.branch} (${src.head_sha.slice(0, 7)})`);
		this.log(`batch ${batch.number} landed: ${prs.map((n) => `#${n}`).join(' ')}`);
		// The tree on master passed CI. The default-branch run started now confirms it in that
		// branch's environment; until it does, failures on top of it wait rather than eject.
		// (Only a run on the default branch itself reports on this commit.)
		const baseline = store.getRunningBaseline(this.repoId);
		if (baseline) {
			// A check of an older default branch: this landing's tree is known now.
			await this.retire(baseline);
			store.setBatchStatus(baseline.id, 'superseded');
		}
		const ref = this.settings().ci.dispatchRef;
		const verifying = (await this.maybeRefreshCaches()) && (!ref || ref === this.d.repo.default_branch);
		store.setMasterHealth(this.repoId, { sha: master, tree: expected, state: verifying ? 'verifying' : 'green', since: this.d.now() });
		// What this tick read before the landing (stacks, PR bases and heads) is stale now.
		this.analysisCache = null;
		this.forgetPRs();
		return true;
	}

	/** Whether `b`'s run is cancelled at its first failed job: a run of several PRs, if the repo stops early. */
	failFast(b: BatchRow): boolean {
		return this.settings().config.stopOnFirstFailure && b.members.length > 1;
	}

	/**
	 * The required check's result on `b`. If the repo stops early, its first failed job decides it.
	 * A run of several PRs is then cancelled; a run of one PR goes on, only so its author gets every
	 * error, and holds nothing back: the queue has its verdict.
	 */
	async ciResult(b: BatchRow): Promise<'pending' | 'success' | 'failure'> {
		const r = await this.d.ci.result(b.head_sha, b.retried_at, { failFast: this.settings().config.stopOnFirstFailure });
		if (r === 'failure' && this.failFast(b))
			await this.d.ci.cancel(b.head_sha).catch((e) => {
				if (e instanceof RateLimitedError) throw e;
				this.bestEffort('ci.cancel')(e);
			});
		return r;
	}

	/** Re-runs a failed check's jobs once, unless the repo turned flake retries off. */
	async retry(headSha: string): Promise<RerunResult> {
		if (!this.settings().config.retryFailed) return 'none';
		return this.d.ci.rerunFailed(headSha);
	}

	async sleep(ms: number) {
		await (this.d.sleep ?? ((t) => new Promise<void>((r) => setTimeout(r, t))))(ms);
	}

	async waitForHead(n: number, sha: string): Promise<boolean> {
		for (let i = 0; i < 15; i++) {
			if ((await this.pr(n, true)).headSha === sha) return true;
			await this.sleep(1000 * Math.min(i + 1, 4));
		}
		return false;
	}

	/** GitHub refuses a merge for a while after a push or retarget (405/409); try a few times. */
	async mergeWithRetry(n: number, title: string, head: string) {
		let m: { merged: boolean; sha?: string | null; message?: string } = { merged: false };
		for (let i = 0; i < 4; i++) {
			m = await this.d.github.squashMerge(n, `${title} (#${n})`, head);
			if (m.merged || !/modified|not mergeable|try again|base branch was modified|405|409/i.test(m.message ?? '')) return m;
			await this.sleep(2000 * (i + 1));
		}
		return m;
	}

	/** Starts a default-branch CI run after a landing (`masterRun`), at most every `masterRunMinGapMs`. True if started. */
	async maybeRefreshCaches(): Promise<boolean> {
		const { masterRun, masterRunMinGapMs } = this.settings().config;
		if (!masterRun) return false;
		const last = lastCacheRefresh.get(this.repoId);
		if (last !== undefined && this.d.now() - last < masterRunMinGapMs) return false;
		lastCacheRefresh.set(this.repoId, this.d.now());
		try {
			await this.d.ci.refreshCaches();
			return true;
		} catch (e) {
			this.log(`default-branch run failed to start: ${e instanceof Error ? e.message : e}`);
			return false;
		}
	}

	// --- default-branch health ---

	/**
	 * Follows the default branch's own CI: the run after a landing ('verifying') and a baseline run
	 * of a commit that came from outside the queue ('checking'). Neither holds batches back; until
	 * they report, a failure on top of that commit blames nobody (`masterSettled`).
	 */
	async advanceMaster() {
		const h = store.getMasterHealth(this.repoId);
		if (!h || (h.state !== 'verifying' && h.state !== 'checking')) return;
		const run = h.state === 'checking' ? store.getRunningBaseline(this.repoId) : null;
		if (h.state === 'checking' && !run) {
			store.clearMasterHealth(this.repoId); // its run is gone (e.g. retired): check again
			return;
		}
		const sha = run ? run.head_sha : h.sha;
		// Results from before this state (an older run on the same commit) or before the re-run don't count.
		let r = await this.d.ci.result(sha, h.retriedAt ?? h.since);
		const timedOut = this.d.now() - (h.retriedAt ?? h.since) > MASTER_CHECK_TIMEOUT_MS;
		if (r === 'failure' && h.retriedAt === null) {
			const rerun = await this.retry(sha);
			if (rerun === 'wait' && !timedOut) return;
			if (rerun === 'rerun') {
				if (run) store.setBatchRetried(run.id, this.d.now());
				store.setMasterHealth(this.repoId, { ...h, retriedAt: this.d.now() });
				return;
			}
		}
		if (r === 'pending') {
			if (!timedOut) return;
			if (run) {
				// A baseline that never reports is a setup problem (does CI run on mq/base-*?), not a red branch.
				await this.retire(run);
				store.setBatchStatus(run.id, 'failed');
				store.clearMasterHealth(this.repoId);
				this.pause(`The check of ${this.d.repo.default_branch} alone (${run.branch}) got no CI result in time; is the workflow running on mq/* branches?`);
				return;
			}
			// Its tree passed in a batch; a default-branch run that never reports must not hold anything.
			this.log(`no result from the default-branch run on ${h.sha.slice(0, 7)}; taking its batch's result`);
			r = 'success';
		}
		if (run) {
			store.setBatchCI(run.id, r);
			store.setBatchStatus(run.id, r === 'success' ? 'landed' : 'failed');
			await this.d.github.deleteBranch(run.branch).catch(this.bestEffort('github.deleteBranch'));
		}
		if (r === 'success') {
			store.setMasterHealth(this.repoId, { sha: h.sha, tree: h.tree, state: 'green', since: this.d.now() });
			this.event(null, 'master-green', { sha: h.sha });
			this.log(`${this.d.repo.default_branch} ${h.sha.slice(0, 7)} is green`);
			return;
		}
		await this.markRed(h.sha, h.tree);
	}

	async markRed(sha: string, tree: string) {
		store.setMasterHealth(this.repoId, { sha, tree, state: 'red', since: this.d.now() });
		const why = `${this.d.repo.default_branch} ${sha.slice(0, 7)} fails CI on its own; the queue tries PRs on top of it until a batch passes`;
		this.event(null, 'master-broken', { sha, reason: why });
		this.log(why);
		await this.d.github.setStatus(sha, 'failure', short('Fails on its own; the queue looks for a PR that fixes it')).catch(this.bestEffort('github.setStatus'));
	}

	/**
	 * Before building on `masterSha`: a commit the queue doesn't know (it came from outside the
	 * queue) gets a baseline run of itself alone, alongside the batches built on it.
	 */
	async checkMaster(masterSha: string): Promise<void> {
		const tree = await this.d.git.tree(masterSha);
		const h = store.getMasterHealth(this.repoId);
		if (h && h.tree === tree) return;
		const prev = store.getRunningBaseline(this.repoId);
		if (prev) {
			await this.retire(prev);
			store.setBatchStatus(prev.id, 'superseded');
		}
		const head = await this.d.git.baseline(masterSha);
		const branch = `mq/base-${this.d.now()}`;
		store.intendBranch(this.repoId, branch, head);
		try {
			await this.d.github.pushBranch(branch, head);
			await this.d.ci.start(branch, masterSha, head, []);
		} catch (e) {
			if (e instanceof RateLimitedError) throw e;
			await this.d.github.deleteBranch(branch).catch(this.bestEffort('github.deleteBranch'));
			this.pause(`Could not start a check of ${this.d.repo.default_branch} alone: ${e instanceof Error ? e.message : e}`);
			return;
		}
		store.insertBatch({
			repoId: this.repoId,
			kind: 'baseline',
			branch,
			baseSha: masterSha,
			headSha: head,
			treeSha: tree,
			baseTree: tree,
			members: [],
			heads: {}
		});
		store.branchPushed(this.repoId, branch);
		store.setMasterHealth(this.repoId, { sha: masterSha, tree, state: 'checking', since: this.d.now() });
		this.log(`${this.d.repo.default_branch} moved outside the queue; checking ${masterSha.slice(0, 7)} alone in ${branch}`);
	}

	/** The default branch's state, if it is the commit `baseTree` is the tree of. */
	masterState(baseTree: string): store.MasterState | null {
		const h = store.getMasterHealth(this.repoId);
		return h && h.tree === baseTree ? h.state : null;
	}

	/**
	 * A failure on top of `baseTree` may be blamed on the PRs: their base is known green. On a base
	 * still being checked it waits; on a red base it is decided by `onRedBase`.
	 */
	masterSettled(baseTree: string): boolean {
		const st = this.masterState(baseTree);
		return st !== 'verifying' && st !== 'checking';
	}

	/**
	 * A batch failed on a red default branch: nobody is blamed. A lone PR's head is recorded as
	 * tried, so each PR gets one go at fixing the branch; a larger batch is retried one by one.
	 */
	async failedOnRed(batch: BatchRow) {
		const h = store.getMasterHealth(this.repoId)!;
		// `pr@head` once tried in a batch; `pr@head!` once tried alone, or again after every member
		// had been tried already. Every failure adds a mark, so the tries run out.
		const keys = batch.members.map((n) => `${n}@${batch.heads[n]}`);
		const seen = new Set(h.tried);
		// A batch that is one PR with only its queued ancestors is that PR's try alone too.
		const parentOf = await this.parentOf();
		const onlyAncestors = (n: number) =>
			batch.members.every((m) => {
				if (m === n) return true;
				for (let p = parentOf(n); p !== null; p = parentOf(p)) if (p === m) return true;
				return false;
			});
		const tip = batch.members.find(onlyAncestors);
		const again = batch.members.length === 1 || keys.every((k) => seen.has(k));
		const alone = again ? keys : tip !== undefined ? [`${tip}@${batch.heads[tip]}`] : [];
		const tried = [...new Set([...h.tried, ...keys, ...alone.map((k) => `${k}!`)])];
		store.setMasterHealth(this.repoId, { ...h, tried });
		store.setBatchStatus(batch.id, 'failed');
		await this.retire(batch);
		this.requeue(batch.members);
		for (const n of batch.members) {
			const it = this.item(n);
			if (it) db.updateQueueItemStatus(it.id, 'queued', `Waiting: ${this.d.repo.default_branch} is red, and this PR does not fix it`);
		}
	}

	/**
	 * Batches side by side on a red default branch (see `plan`): each is decided on its own. A
	 * pass lands (the others are then rebuilt on the fixed branch); a failure blames nobody.
	 * Returns false when the pipeline isn't in red mode.
	 */
	async advanceRed(active: BatchRow[]): Promise<boolean> {
		const tree = active[0].base_tree;
		if (this.masterState(tree) !== 'red' || active.some((b) => b.base_tree !== tree || b.status === 'bisecting')) return false;
		for (const b of active) {
			let r = await this.d.ci.result(b.head_sha, b.retried_at);
			if (r === 'pending') {
				if (!this.timedOut(b)) continue;
				await this.d.ci.cancel(b.head_sha).catch(this.bestEffort('ci.cancel'));
				r = 'failure';
			}
			if (r === 'failure' && b.status === 'testing') {
				// A flake must not use up a fix's try: re-run once, as on a green branch.
				const rerun = await this.retry(b.head_sha);
				if (rerun === 'wait' && !this.timedOut(b)) continue;
				if (rerun === 'rerun') {
					store.setBatchStatus(b.id, 'retrying');
					store.setBatchRetried(b.id, this.d.now());
					continue;
				}
			}
			store.setBatchCI(b.id, r);
			if (r === 'failure') {
				await this.failedOnRed(b);
				continue;
			}
			store.setBatchStatus(b.id, 'passed');
			const passed = { ...b, status: 'passed' as const };
			if (await this.land(passed, b.members, passed)) {
				store.setBatchStatus(b.id, 'landed');
				await this.retire(b);
				this.log(`batch ${b.number} fixed ${this.d.repo.default_branch}`);
			} else if (!this.settings().pausedReason) {
				await this.supersede([b]);
			}
			// Master moved (or landing stopped): the siblings are rebuilt next tick.
			await this.supersede(store.getActiveBatches(this.repoId).filter((x) => x.id !== b.id));
			return true;
		}
		return true;
	}

	// --- the pipeline head ---

	timedOut(b: BatchRow): boolean {
		return this.d.now() - store.batchCreatedMs(b) > this.settings().config.ciTimeoutMs;
	}

	async advanceHead(head: BatchRow, rest: BatchRow[], interleave = false) {
		if (head.status === 'testing' || head.status === 'retrying') {
			const r = await this.ciResult(head);
			if (r === 'pending') {
				if (this.timedOut(head)) {
					await this.supersede([head, ...rest]);
					this.pause(`Batch ${head.number} (${head.branch}) got no CI result in time; is the workflow running on mq/* branches?`);
				}
				return;
			}
			let rerun = r === 'failure' && head.status === 'testing' ? await this.retry(head.head_sha) : 'none';
			if (rerun === 'wait') {
				if (!this.timedOut(head)) return;
				rerun = 'none';
			}
			if (r === 'failure' && rerun === 'none') {
				// A failure on a default branch that may be broken itself blames nobody yet; on a red
				// one, nobody at all. A branch being verified after a landing already passed as that
				// batch's tree, so bisection starts at once; only its verdict waits for the branch.
				if (this.masterState(head.base_tree) === 'checking') return;
				if (this.masterState(head.base_tree) === 'red') {
					await this.supersede(rest);
					await this.failedOnRed(head);
					return;
				}
			}
			store.setBatchCI(head.id, r);
			if (r === 'success') {
				store.setBatchStatus(head.id, 'passed');
				head = { ...head, status: 'passed' };
			} else if (rerun === 'rerun') {
				store.setBatchStatus(head.id, 'retrying');
				store.setBatchRetried(head.id, this.d.now());
				this.log(`batch ${head.number} failed; re-running failed jobs`);
				return;
			} else {
				// Everything built on top of a failed batch has to be rebuilt.
				await this.supersede(rest);
				if (head.members.length === 1) {
					store.setBatchStatus(head.id, 'failed');
					await this.retire(head);
					await this.ejectWithStack([{ pr: head.members[0], reason: `CI failed in ${head.branch}`, link: await this.runLink(head) }]);
					return;
				}
				store.setBatchStatus(head.id, 'bisecting');
				head = { ...head, status: 'bisecting' };
				const link = await this.runLink(head);
				for (const n of head.members) {
					await this.d.github
						.setPRStatus(head.heads[n], 'pending', short(`${head.branch} failed; bisecting to find which PR breaks it`), { url: link })
						.catch(this.bestEffort('github.setPRStatus'));
				}
			}
		}
		if (head.status === 'passed') {
			if (await this.land(head, head.members, head)) {
				store.setBatchStatus(head.id, 'landed');
				await this.retire(head);
			} else if (!this.settings().pausedReason) {
				await this.supersede([head, ...rest]);
			}
			return;
		}
		if (head.status === 'bisecting') await this.bisect(head, interleave);
	}

	/**
	 * Narrows down a failed batch (see `planBisection`): a run that passes on the current default
	 * branch lands at once, failing groups are split and run again on top of it. Everything is
	 * planned from the recorded runs, so a restart picks it up where it was.
	 */
	async bisect(batch: BatchRow, interleave = false) {
		const runs = store.getBisectRuns(batch.id);
		for (const run of runs) {
			if (run.ci_result !== 'pending') continue;
			let res = await this.ciResult(run);
			const rerun = res === 'failure' && run.status !== 'retrying' ? await this.retry(run.head_sha) : 'none';
			if (rerun === 'wait') res = 'pending';
			else if (rerun === 'rerun') {
				// A bisection step is retried once too, so a flake doesn't eject an innocent PR.
				store.setBatchStatus(run.id, 'retrying');
				store.setBatchRetried(run.id, this.d.now());
				res = 'pending';
			} else if (res !== 'pending') {
				store.setBatchCI(run.id, res);
				store.setBatchStatus(run.id, res === 'success' ? 'passed' : 'failed');
				run.ci_result = res;
			}
			if (res === 'pending' && this.timedOut(run)) {
				await this.retire(batch);
				store.setBatchStatus(batch.id, 'failed');
				this.requeue(batch.members);
				this.pause(`Bisection run ${run.branch} got no CI result in time`);
				return;
			}
		}

		const masterSha = await this.d.github.defaultBranchSha();
		await this.d.git.fetch([masterSha]);
		const masterTree = await this.d.git.tree(masterSha);
		const landed = new Set(batch.landed);
		// Still to land or eject: in the batch and in the queue (a PR removed meanwhile is just gone).
		const left = new Set(batch.left_prs);
		const remaining = batch.members.filter((n) => !landed.has(n) && !left.has(n) && this.item(n)?.status === 'checking');
		// A PR that left the queue (or the batch) meanwhile is just gone from it.
		const gone = batch.members.filter((n) => !landed.has(n) && !left.has(n) && this.item(n)?.status !== 'checking');
		// A PR its author pushed to (or closed, or deleted) since the batch was built: what bisection
		// would test is stale, and evidence against it is not evidence against the new head. It goes back in line.
		const changed: number[] = [];
		for (const n of remaining) {
			// From this tick's list of open PRs: one call for all of them, not one per PR.
			const p = await this.pr(n).catch((e) => {
				if ((e as { status?: number })?.status === 404) return null;
				throw e;
			});
			if (!p || p.state !== 'open' || p.headSha !== batch.heads[n]) changed.push(n);
		}
		if (gone.length || changed.length) {
			if (changed.length) this.log(`batch ${batch.number}: ${changed.map((n) => `#${n}`).join(' ')} changed since it was batched; back in line`);
			const out = await this.leaveBisection(batch, [...gone, ...changed]);
			remaining.splice(0, remaining.length, ...remaining.filter((n) => !out.includes(n)));
		}
		// A run that never started (its push failed, or its PRs did not build on the new branch) shows nothing.
		const all = [batch, ...runs.filter((r) => r.status !== 'cancelled')];
		const plan = planBisection({
			runs: all.map((r) => ({
				context: r.context.filter((n) => !landed.has(n)),
				members: r.members,
				baseTree: r.base_tree,
				result: r === batch ? 'failure' : r.ci_result
			})),
			remaining,
			masterTree,
			parentOf: await this.parentOf(),
			// Known green: the base the batch failed on (its failure was only acted on once that was
			// settled), every tree this bisection landed, and the current branch (ejecting waits for it to settle).
			trusted: (t) => t === masterTree || t === (runs[0]?.base_tree ?? batch.base_tree) || runs.some((r) => r.status === 'landed' && r.tree_sha === t),
			// The rest wait their turn: runs side by side share the runners, and of two that pass only one can land as tested.
			slots: Math.max(1, this.settings().config.bisectRuns)
		});

		if (plan.kind === 'land') {
			const proof = all[plan.run];
			if (await this.land(batch, plan.prs, proof)) {
				this.log(`batch ${batch.number}: landed ${plan.prs.map((n) => `#${n}`).join(' ')} from ${proof.branch} while bisecting`);
				if (remaining.every((n) => plan.prs.includes(n))) await this.finishBisection(batch, runs, true);
			} else if (!this.settings().pausedReason) {
				// It can no longer land as tested (a PR was pushed to, closed, or lost its approval):
				// those PRs leave the bisection and go back in line to be tested as they are now.
				await this.leaveBisection(batch, plan.prs.filter((n) => !store.getBatch(batch.id)!.landed.includes(n)));
			}
			return;
		}

		// The default branch may be what fails: blame nobody until it is known. That holds only the
		// ejection: the other groups' runs don't depend on it.
		const ejectWaits = plan.eject.length > 0 && !this.masterSettled(masterTree);
		if (plan.eject.length && !ejectWaits) {
			if (this.masterState(masterTree) === 'red') {
				for (const r of runs) await this.retire(r);
				await this.failedOnRed({ ...batch, members: remaining });
				return;
			}
			const culprits = [];
			for (const e of plan.eject) {
				const landed = batch.landed.length ? `, which landed ${batch.landed.map((n) => `#${n}`).join(', ')}` : '';
				culprits.push({ pr: e.pr, reason: `${e.reason} (batch ${batch.number}${landed})`, link: await this.runLink(all[e.run]) });
			}
			store.leaveBatch(batch.id, plan.eject.map((e) => e.pr), { ejected: true });
			const out = await this.ejectWithStack(culprits);
			// Children in the batch went with their parent: ejected too, not back in line.
			store.leaveBatch(batch.id, out.filter((n) => batch.members.includes(n)), { ejected: true });
		}
		if (plan.requeue.length) {
			store.leaveBatch(batch.id, plan.requeue);
			await this.requeueAfterFailure(plan.requeue, batch);
			await this.leaveBisection(batch, plan.requeue);
		}
		if (plan.done) {
			if (!ejectWaits) await this.finishBisection(batch, runs, batch.landed.length > 0);
			return;
		}
		// Between two steps, urgent PRs go first: each step is planned again on whatever master is
		// then, so the bisection picks up where it was once they land.
		if (interleave && plan.start.length && (await this.plan([batch], masterSha, { urgentOnly: true })) === 'started') {
			this.log(`batch ${batch.number}: bisection waits for an urgent batch`);
			return;
		}
		for (const g of plan.start) await this.startBisectRun(batch, { context: [], members: g }, runs.length, masterSha, masterTree);
	}

	/**
	 * `prs` leave a bisection without being ejected, and go back in line (those still in the
	 * queue). The PRs stacked on them leave too: tested without their parent, a child would land
	 * the parent's commits as they were when batched, around the parent's own review.
	 */
	async leaveBisection(batch: BatchRow, prs: number[]): Promise<number[]> {
		const now = store.getBatch(batch.id)!;
		const parentOf = await this.parentOf();
		const parent = (n: number) => {
			const recorded = now.steps[n]?.parent;
			return recorded !== undefined ? recorded : parentOf(n);
		};
		const open = now.members.filter((n) => !now.landed.includes(n) && !now.left_prs.includes(n));
		const out = new Set(prs);
		for (let grew = true; grew; ) {
			grew = false;
			for (const n of open) {
				const p = parent(n);
				if (!out.has(n) && p !== null && out.has(p)) {
					out.add(n);
					grew = true;
				}
			}
		}
		const all = [...out];
		store.leaveBatch(batch.id, all);
		this.requeue(all);
		return all;
	}

	async finishBisection(batch: BatchRow, runs: BatchRow[], landedAny: boolean) {
		// Cleaned up before it is marked done, so an interrupted finish runs again.
		for (const r of runs) await this.retire(r);
		await this.d.github.deleteBranch(batch.branch).catch(this.bestEffort('github.deleteBranch'));
		store.setBatchStatus(batch.id, landedAny ? 'landed' : 'failed');
	}

	/** Starts a bisection run of `g` on the default branch as it is now (`baseSha`). */
	async startBisectRun(batch: BatchRow, g: TestGroup, seq: number, baseSha: string, baseTree: string) {
		const prs = [...g.context, ...g.members];
		const members = await this.members(prs, []);
		// Bisection tests the PRs exactly as they were in the failed batch, parents included.
		const parentOf = await this.parentOf();
		for (const m of members) {
			m.headSha = batch.heads[m.pr] ?? m.headSha;
			const parent = parentOf(m.pr);
			if (m.parentHeadSha && parent !== null && batch.heads[parent]) m.parentHeadSha = batch.heads[parent];
		}
		const r = await this.d.git.build(baseSha, members);
		if (!r.ok) {
			// They don't apply on the default branch as it is now (something landed meanwhile): not a
			// CI failure, and no run; they go back in line, where a conflict is handled the usual way.
			await this.leaveBisection(batch, g.members);
			this.log(`batch ${batch.number}: ${g.members.map((n) => `#${n}`).join(' ')} no longer build on the default branch; back in line`);
			return;
		}
		const branch = `${batch.branch}-bisect-${seq + 1}-${this.d.now()}`;
		const steps: Record<number, BatchStep> = {};
		for (const c of r.commits) steps[c.pr] = { sha: c.sha, tree: c.tree, fork: c.fork, parent: batch.steps[c.pr]?.parent ?? parentOf(c.pr) };
		const run = store.insertBatch({
			repoId: this.repoId,
			kind: 'bisect',
			parentBatchId: batch.id,
			branch,
			baseSha,
			headSha: r.headSha,
			treeSha: r.tree,
			baseTree,
			members: g.members,
			context: g.context,
			heads: batch.heads,
			steps
		});
		store.intendBranch(this.repoId, branch, r.headSha);
		try {
			await this.d.github.pushBranch(branch, r.headSha);
			await this.d.ci.start(branch, baseSha, r.headSha, prs);
			store.branchPushed(this.repoId, branch);
		} catch (e) {
			// Never ran: not evidence against its PRs. The run is planned again after a resume.
			store.setBatchStatus(run.id, 'cancelled');
			// After a rate limit the branch intent stays, so the sweep deletes the branch after the reset.
			if (e instanceof RateLimitedError) throw e;
			await this.d.github.deleteBranch(branch).catch(this.bestEffort('github.deleteBranch'));
			store.branchPushed(this.repoId, branch);
			this.pause(`Could not start bisection run ${branch}: ${e instanceof Error ? e.message : e}`);
			return;
		}
		const link = this.branchRuns(branch);
		for (const n of g.members) {
			await this.d.github
				.setPRStatus(batch.heads[n], 'pending', short(`Batch ${batch.number} failed; testing ${g.members.length === 1 ? `#${n} alone` : `${g.members.length} of its PRs`} in ${branch}`), { url: link })
				.catch(this.bestEffort('github.setPRStatus'));
		}
	}

	// --- try runs ---

	/** Tests one PR on top of master, outside the pipeline, so its author gets CI on demand. */
	async startTry(n: number): Promise<BatchRow> {
		const p = await this.pr(n, true);
		if (p.state !== 'open') throw new Error(`#${n} is not open`);
		if (!p.sameRepo) {
			// A try run executes the PR's code (its workflow too) in this repo's CI.
			const s = await this.state(n, true);
			if (!s.approvedShas.includes(p.headSha)) throw new Error(`#${n} comes from a fork; a writer must approve its head first`);
		}
		const masterSha = await this.d.github.defaultBranchSha();
		const member: BatchMember = { pr: n, headSha: p.headSha, title: p.title, parentHeadSha: null };
		await this.d.git.fetch([masterSha, p.headSha]);
		const r = await this.d.git.build(masterSha, [member]);
		if (!r.ok) throw new Error(`#${n} does not apply on ${this.d.repo.default_branch}: ${r.reason.replace(/^#\d+ /, '')}`);
		const branch = `mq/try-${n}-${this.d.now()}`;
		store.intendBranch(this.repoId, branch, r.headSha);
		await this.d.github.pushBranch(branch, r.headSha);
		try {
			await this.d.ci.start(branch, masterSha, r.headSha, [n]);
		} catch (e) {
			await this.d.github.deleteBranch(branch).catch(this.bestEffort('github.deleteBranch'));
			throw e;
		}
		const run = store.insertBatch({
			repoId: this.repoId,
			kind: 'try',
			branch,
			baseSha: masterSha,
			headSha: r.headSha,
			treeSha: r.tree,
			baseTree: await this.d.git.tree(masterSha),
			members: [n],
			heads: { [n]: p.headSha }
		});
		store.branchPushed(this.repoId, branch);
		await this.d.github
			.setPRStatus(p.headSha, 'pending', short(`Trying on ${this.d.repo.default_branch} in ${branch}`), { suffix: '/try', url: this.branchRuns(branch) })
			.catch(this.bestEffort('github.setPRStatus'));
		this.event(n, 'tried', { status: 'started', branch, run: run.id });
		return run;
	}

	async advanceTries() {
		for (const t of store.getRunningTries(this.repoId)) {
			let r = await this.d.ci.result(t.head_sha);
			if (r === 'pending' && !this.timedOut(t)) continue;
			if (r === 'pending') {
				await this.d.ci.cancel(t.head_sha).catch(this.bestEffort('ci.cancel'));
				r = 'failure';
			}
			store.setBatchCI(t.id, r);
			store.setBatchStatus(t.id, r === 'success' ? 'landed' : 'failed');
			const n = t.members[0];
			const desc = r === 'success' ? `Passed on ${this.d.repo.default_branch} in ${t.branch}` : `Failed on ${this.d.repo.default_branch} in ${t.branch}`;
			await this.d.github.setPRStatus(t.heads[n], r, short(desc), { suffix: '/try', url: await this.runLink(t) }).catch(this.bestEffort('github.setPRStatus'));
			await this.d.github.deleteBranch(t.branch).catch(this.bestEffort('github.deleteBranch'));
			this.event(n, 'tried', { status: r, branch: t.branch, run: t.id, headSha: t.heads[n] });
		}
	}

	// --- reconcile, restack and plan ---

	/**
	 * Finishes or undoes queue-branch pushes a crash interrupted: a branch no batch row owns is
	 * deleted (its CI cancelled); a branch of a run still going is pushed again, and its CI started
	 * if it never was.
	 */
	async sweepBranchIntents() {
		for (const { branch, sha } of store.branchIntents(this.repoId)) {
			const row = store.getBatchByBranch(this.repoId, branch);
			const live = row && row.ci_result === 'pending' && (row.status === 'testing' || row.status === 'retrying');
			try {
				if (row && live) {
					await this.d.github.pushBranch(branch, row.head_sha);
					if ((await this.d.ci.runUrl(row.head_sha)) === null) await this.d.ci.start(branch, row.base_sha, row.head_sha, [...row.context, ...row.members]);
				} else {
					this.log(`removing ${branch}: left behind by an interrupted start`);
					await this.d.ci.cancel(sha).catch(this.bestEffort('ci.cancel'));
					await this.d.github.deleteBranch(branch).catch(this.bestEffort('github.deleteBranch'));
				}
				store.branchPushed(this.repoId, branch);
			} catch (e) {
				// Tried again next tick; it must not stop the rest of the tick.
				this.log(`could not settle ${branch} after an interrupted start: ${e instanceof Error ? e.message : e}`);
			}
		}
	}

	async reconcile() {
		// A batch carries its PRs: one interrupted right after it was recorded may not have marked them.
		for (const b of store.getActiveBatches(this.repoId)) {
			for (const n of b.members) {
				const it = this.item(n);
				if (it?.status === 'queued' && !b.landed.includes(n) && !b.left_prs.includes(n)) db.updateQueueItemStatus(it.id, 'checking');
			}
		}
		// A PR is `checking` only while a batch carries it; any other (a mode switch, a crash
		// between steps) goes back in line rather than waiting forever.
		const carried = new Set(store.getActiveBatches(this.repoId).flatMap((b) => b.members));
		for (const it of this.items()) {
			if ((it.status === 'checking' || it.status === 'updating' || it.status === 'merging') && !carried.has(it.pr_number)) {
				db.updateQueueItemStatus(it.id, 'queued');
				it.status = 'queued';
			}
			const p = await this.pr(it.pr_number);
			if (p.state !== 'open') {
				if (it.status === 'checking') continue; // its batch notices when landing
				if (p.merged) {
					db.addToHistory(this.repoId, it.pr_number, it.pr_title, it.pr_url, it.author_login, null, 'merged', null, it.created_at);
					db.removeFromQueue(it.id);
				} else {
					db.updateQueueItemStatus(it.id, 'cancelled', 'PR was closed');
				}
				continue;
			}
			if (it.status === 'conflict' && it.head_sha !== p.headSha) {
				// The author pushed a fix: try again.
				db.updateQueueItemStatus(it.id, 'queued', null as unknown as string);
				await this.d.github.label(it.pr_number, CONFLICT_LABEL, false).catch(this.bestEffort('github.label'));
				this.event(it.pr_number, 'requeued', { reason: 'pushed after a conflict', headSha: p.headSha });
			}
		}
	}

	/**
	 * Restacks queued PRs whose parent was rebased or merged under them, when
	 * that needs no conflict resolution. Returns true when it pushed anything
	 * (the stack analysis is then stale until the next tick).
	 */
	async restack(): Promise<boolean> {
		const def = this.d.repo.default_branch;
		if (!this.items().some((i) => i.status === 'queued')) return false;
		const a = await this.analysis();
		let pushed = false;
		for (const it of this.items()) {
			if (it.status !== 'queued') continue;
			const n = it.pr_number;
			const info = a.prs.get(n);
			if (!info || info.parent === null) continue;
			const rebased = info.issues.find((i) => i.kind === 'parent-rebased');
			const merged = info.issues.find((i) => i.kind === 'parent-merged');
			const issue = rebased ?? merged;
			const stale = issue?.staleCommits ?? [];
			if (!issue || stale.length === 0) continue;
			const p = await this.pr(n);
			if (p.state !== 'open') continue;
			let onto: string;
			if (rebased) {
				if (!a.prs.has(info.parent)) continue;
				onto = (await this.pr(info.parent)).headSha;
			} else {
				onto = await this.d.github.defaultBranchSha();
			}
			const upstream = stale[stale.length - 1];
			const ontoName = rebased ? `#${info.parent}` : def;
			if (!p.sameRepo) {
				await this.conflict(n, `its parent #${info.parent} was ${rebased ? 'rewritten' : 'merged'} and the queue can't push to a fork`, [], `git fetch origin ${rebased ? `pull/${info.parent}/head` : def} && git rebase --onto FETCH_HEAD ${upstream}`);
				continue;
			}
			await this.d.git.fetch([p.headSha, upstream, onto]);
			const r = await this.d.git.restack(p.headSha, upstream, onto);
			if (!r.ok) {
				await this.conflict(
					n,
					`restacking onto ${ontoName} needs conflict resolution: ${r.reason}`,
					r.conflicts,
					`git fetch origin ${rebased ? `pull/${info.parent}/head` : def} && git rebase --onto FETCH_HEAD ${upstream}`
				);
				continue;
			}
			const before = await this.state(n);
			try {
				await this.d.github.pushHead(p.headRef, r.head, p.headSha);
			} catch (e) {
				this.log(`could not push restacked #${n}: ${e instanceof Error ? e.message : e}`);
				continue;
			}
			store.recordRebasedHead(this.repoId, n, p.headSha, r.head, before.ciGreen);
			db.updateQueueItemHeadSha(it.id, r.head);
			if (merged && p.baseRef !== def) await this.d.github.retargetBase(n, def).catch(this.bestEffort('github.retargetBase'));
			await this.d.github
				.comment(
					n,
					`The merge queue restacked this PR onto ${ontoName} (${issue.message}). Its ${r.replayed} commit(s) applied without conflicts; approvals carry over.\n\nBefore pushing again, move any local commits onto it:\n\n\`\`\`sh\ngit fetch origin ${p.headRef} && git rebase --onto FETCH_HEAD ${p.headSha.slice(0, 12)}\n\`\`\``
				)
				.catch(this.bestEffort('github.comment'));
			this.event(n, 'rebased', { from: p.headSha, to: r.head, onto: ontoName, reason: issue.message });
			this.log(`restacked #${n} onto ${ontoName}`);
			pushed = true;
		}
		return pushed;
	}

	/**
	 * Plans and starts the next batch on top of `active`. With `urgentOnly` it starts an express
	 * batch of urgent PRs on `masterSha` itself, beside a bisection (see `bisect`), or nothing.
	 */
	/**
	 * Records why each held PR can't go and tells its agent on GitHub, once per reason: a failing
	 * merge-queue status on its head and a `held` event. A PR held before and free now, or taken out
	 * of the queue, is released. What couldn't be posted is recorded only once it is, so the next
	 * tick tries again.
	 */
	/** A comment on PR `n`, best effort; a rate limit stops the tick. */
	async say(n: number, body: string) {
		await this.d.github.comment(n, body).catch((e) => {
			if (e instanceof RateLimitedError) throw e;
			this.bestEffort('github.comment')(e);
		});
	}

	async recordHolds(held: { pr: number; admission: Hold }[]) {
		const now = new Map(held.map((h) => [h.pr, h.admission]));
		/** Posts the status; false if it couldn't, else the head it was posted on (none: the PR is gone). */
		const tell = async (n: number, state: 'failure' | 'pending', description: string): Promise<false | { head?: string }> => {
			const p = await this.pr(n).catch((e) => {
				if (e instanceof RateLimitedError) throw e;
				return null;
			});
			if (!p) return {}; // closed or gone: there is no head to tell
			try {
				await this.d.github.setPRStatus(p.headSha, state, short(description));
				return { head: p.headSha };
			} catch (e) {
				if (e instanceof RateLimitedError) throw e;
				this.bestEffort('github.setPRStatus')(e);
				return false;
			}
		};
		for (const it of this.items()) {
			// A PR in conflict keeps its status and message: it is held for that, and was told.
			if (it.status !== 'queued') continue;
			const was = store.currentHold(it);
			// What it was last told, even if its message changed since (fewer PRs ahead of a deferral).
			const stored = store.storedHold(it as QueueItem & { hold?: string | null });
			const h = now.get(it.pr_number);
			if (!h) {
				// Free again. Its message may be gone already (plan() clears a lifted deferral's), so
				// what it was told comes from the stored hold.
				const told = was ?? (stored?.told && !stored.released ? stored : null);
				if (!told) continue;
				if (!(await tell(it.pr_number, 'pending', 'In line in the merge queue'))) continue;
				// A lifted deferral is the planner trying again, not news for the author.
				if (told.told && told.code !== 'deferred') await this.say(it.pr_number, 'Back in line in the merge queue.');
				store.setHold(it.id, told.told ? { ...told, released: true } : null);
				db.updateQueueItemStatus(it.id, 'queued', null as unknown as string);
				this.event(it.pr_number, 'released', { code: told.code });
				continue;
			}
			const { code, reason } = h;
			// Told on this head already. A status belongs to a commit: a push needs it again.
			const head = (await this.pr(it.pr_number).catch((e) => {
				if (e instanceof RateLimitedError) throw e;
				return null;
			}))?.headSha;
			if (was?.told && was.code === code && was.reason === reason && (!head || !was.head || was.head === head)) continue;
			const posted = await tell(it.pr_number, 'failure', `Needs attention: ${reason}`);
			if (!posted) continue;
			// One comment per kind of hold: it notifies the author, a status doesn't. A new reason of
			// the same kind (fewer PRs ahead) only updates the status.
			const advice = holdAdvice(code as HoldCode);
			// Told this kind on this head already; a deferral that comes back is told again only after a push.
			const toldThis = !!stored?.told && stored.code === code && (!stored.released || (code === 'deferred' && stored.head === posted.head));
			if (advice && !toldThis)
				await this.say(it.pr_number, `Needs attention in the merge queue: ${reason}\n\nWhat to do: ${advice}`);
			db.updateQueueItemStatus(it.id, 'queued', reason);
			store.setHold(it.id, { code, reason, told: true, head: posted.head });
			this.event(it.pr_number, 'held', { code, reason });
		}
		// Told it needs attention, then taken out of the queue (dequeued, closed, merged elsewhere).
		const live = new Set(this.items().map((i) => i.pr_number));
		for (const n of heldPRs(this.repoId)) {
			if (live.has(n)) continue;
			if (await tell(n, 'pending', 'Not in the merge queue')) this.event(n, 'released', { reason: 'left the queue' });
		}
	}

	/**
	 * Plans the next batch and starts it, and records what holds the PRs that can't go. With
	 * `holdsOnly`, nothing starts: the queue can't take new work now (a bisection, a full pipeline),
	 * but its agents still hear what their PRs need.
	 */
	async plan(active: BatchRow[], masterSha: string, opts: { urgentOnly?: boolean; holdsOnly?: boolean } = {}): Promise<'started' | 'conflict' | 'error' | 'idle'> {
		const settings = this.settings();
		// A deferred PR waits while a PR it conflicts with is in a batch or about to be. One that is
		// held back (unapproved, deferred itself, in conflict: it then has a reason or another
		// status) must not hold it forever, so it is planned again.
		const carried = new Set(active.flatMap((b) => b.members));
		const blocking = new Set(
			this.items()
				.filter((i) => carried.has(i.pr_number) || (i.status === 'queued' && !i.error_message))
				.map((i) => i.pr_number)
		);
		// Deferred PRs stay in the queue model (held), so what is stacked on them waits for them.
		const deferred = new Map<number, Hold>();
		const waiting = this.items().filter((i) => {
			if (i.status !== 'queued') return false;
			const behind = store.deferredFor(i as QueueItem & { deferred_for?: string | null });
			const still = behind.filter((b) => blocking.has(b));
			if (still.length) {
				// Say what it still waits for: PRs it was deferred behind that have landed since don't count.
				if (still.length < behind.length) {
					store.setDeferredFor(i.id, still);
					db.updateQueueItemStatus(i.id, 'queued', deferredReason(still));
				}
				deferred.set(i.pr_number, { ok: false, code: 'deferred', reason: deferredReason(still) });
				return false;
			}
			if (behind.length) {
				store.setDeferredFor(i.id, null);
				if (i.error_message === deferredReason(behind) || i.error_message?.startsWith('Conflicts with #')) db.updateQueueItemStatus(i.id, 'queued');
			}
			return true;
		});
		if (waiting.length === 0 && !opts.holdsOnly) {
			await this.recordHolds([...deferred].map(([pr, admission]) => ({ pr, admission })));
			return 'idle';
		}
		// PRs in conflict stay in the queue model too (held, with the conflict), so what is stacked
		// on them says the parent conflicts rather than that it isn't queued.
		const conflicted = new Map(this.items().filter((i) => i.status === 'conflict').map((i) => [i.pr_number, i.error_message ?? 'Merge conflict']));
		const queue: QueueEntry[] = [...waiting, ...this.items().filter((i) => deferred.has(i.pr_number) || conflicted.has(i.pr_number))].map((i) => ({
			pr: i.pr_number,
			enqueuedAt: sqliteMs(i.created_at),
			position: i.position,
			priority: ((i as QueueItem & { priority?: Priority }).priority ?? 'normal') as Priority
		}));
		const states = new Map<number, PRState>();
		for (const e of queue) if (!deferred.has(e.pr) && !conflicted.has(e.pr)) states.set(e.pr, await this.state(e.pr));
		// On a red default branch, batches of PRs not yet tried there run side by side on it (not
		// stacked) until one passes: that batch carries a fix and lands. When no untried PR can be
		// batched, each PR gets one more go alone, in case another PR in its batch broke it too.
		const red = this.masterState(await this.d.git.tree(masterSha)) === 'red';
		if (red && opts.urgentOnly) return 'idle';
		const analysis = await this.analysis();
		let plan: Pick<ReturnType<typeof planNextBatch>, 'batch' | 'express' | 'held'>;
		if (red) {
			// Siblings go only beside siblings: a stacked pipeline still in flight (built before the
			// branch turned red) is decided first.
			// (With `holdsOnly` nothing starts anyway; the plan still says what holds the PRs.)
			if (!opts.holdsOnly && (active.length >= settings.config.depth || active.some((b) => b.base_sha !== masterSha))) return 'idle';
			const tried = new Set(store.getMasterHealth(this.repoId)!.tried);
			plan = planRedBatch({
				queue: queue.filter((e) => !deferred.has(e.pr) && !conflicted.has(e.pr)),
				states,
				analysis,
				config: settings.config,
				tried: (n, alone) => tried.has(`${n}@${states.get(n)!.headSha}${alone ? '!' : ''}`),
				live: new Set(this.items().map((i) => i.pr_number))
			});
		} else {
			if (opts.urgentOnly && settings.mode === 'serial') return 'idle';
			plan = planNextBatch({ now: this.d.now(), queue, states, analysis, inflight: opts.urgentOnly ? [] : active.map((b) => b.members), config: settings.config, strategy: settings.mode, held: deferred, conflicts: conflicted });
			// Nothing urgent is ready: the bisection goes on. What holds PRs back is said when the
			// queue plans them all (a PR stacked on one being bisected isn't "unqueued" meanwhile).
			if (opts.urgentOnly && !plan.express) return 'idle';
		}
		// On a red branch the deferred PRs were left out of the plan; they are still held.
		if (!opts.urgentOnly) await this.recordHolds(red ? [...plan.held, ...[...deferred].map(([pr, admission]) => ({ pr, admission }))] : plan.held);
		if (!plan.batch || opts.holdsOnly) return 'idle';
		const below = red || opts.urgentOnly ? [] : active.flatMap((b) => b.members);
		const base = red || opts.urgentOnly || !active.length ? masterSha : active[active.length - 1].head_sha;
		return this.startBatch(base, plan.batch, below, plan.express, masterSha);
	}
}

/**
 * The settings the runtime plans with. One by one is the batch runtime with one run in flight,
 * started as soon as the head stack can go.
 */
function planningSettings(s: ReturnType<typeof store.getQueueSettings>): ReturnType<typeof store.getQueueSettings> {
	return s.mode === 'serial' ? { ...s, config: { ...s.config, depth: 1, collectWindowMs: 0 } } : s;
}

export async function tickBatchQueue(deps: QueueDeps): Promise<void> {
	const t = new Tick(deps);
	const settings = store.getQueueSettings(deps.repo.id);
	await t.recoverInterrupted();
	if (settings.pausedReason) return;
	await t.reconcile();
	await t.advanceTries();
	await t.advanceMaster();

	let active = store.getActiveBatches(deps.repo.id);
	let masterSha = await deps.github.defaultBranchSha();
	if (active.length) {
		await deps.git.fetch([masterSha]);
		const tree = await deps.git.tree(masterSha);
		if (active[0].base_tree !== tree && active[0].status === 'bisecting') {
			// A bisection follows the default branch: its failures still point at the same PRs, and
			// what passes is run again on top of the new commit. Batches built on it are rebuilt; an
			// urgent batch that ran between its steps and is bisecting itself follows it too.
			for (const b of active.filter((b) => b.status === 'bisecting' && b.base_tree !== tree)) {
				t.log(`master moved; batch ${b.number} bisects on top of it`);
				store.rebaseBatch(b.id, masterSha, tree);
			}
			await t.supersede(active.slice(1).filter((b) => b.status !== 'bisecting'));
			active = store.getActiveBatches(deps.repo.id);
			await t.checkMaster(masterSha);
		} else if (active[0].base_tree !== tree) {
			t.log('master moved outside the queue; rebuilding the pipeline');
			await t.supersede(active);
			active = [];
		}
	}
	if (active.length && (await t.advanceRed(active))) {
		active = store.getActiveBatches(deps.repo.id);
	} else if (active.length) {
		// Batches side by side on a branch that is no longer red (it was vouched for) aren't a
		// pipeline: keep the head, rebuild the rest on top of it.
		// An urgent batch run between two steps of a bisection is built on master beside it, not on
		// top of it: it goes first, and the bisection waits for it.
		const between = active[0].status === 'bisecting' ? active.find((b, i) => i > 0 && b.express && b.base_sha !== active[0].head_sha) : undefined;
		const loose = active.findIndex((b, i) => i > 0 && b !== between && b.base_sha !== active[i - 1].head_sha);
		if (loose > 0) {
			await t.supersede(active.slice(loose));
			active = active.slice(0, loose);
		}
		if (between && active.includes(between)) await t.advanceHead(between, []);
		else await t.advanceHead(active[0], active.slice(1), true);
		if (store.getQueueSettings(deps.repo.id).pausedReason) return;
		active = store.getActiveBatches(deps.repo.id);
	}
	// Don't plan new work on top of a bisection: its base is about to change. Holds are still said.
	if (active.some((b) => b.status === 'bisecting')) {
		await t.plan(active, masterSha, { holdsOnly: true });
		return;
	}
	const config = planningSettings(store.getQueueSettings(deps.repo.id)).config;
	if (config.autoRebase && (await t.restack())) return;
	if (!t.items().some((i) => i.status === 'queued')) {
		await t.recordHolds([]);
		return;
	}
	if (!active.length) {
		// Landing earlier in this tick moved master: read it again before building on it.
		masterSha = await deps.github.defaultBranchSha();
		await deps.git.fetch([masterSha]);
		await t.checkMaster(masterSha);
		if (store.getQueueSettings(deps.repo.id).pausedReason) return;
	}
	let planned = false;
	for (let i = 0; i < 8 && active.length < config.depth; i++) {
		// A conflict sets a PR aside at build time; plan again with the rest, on the same master.
		const r = await t.plan(active, masterSha);
		planned = true;
		if (r === 'idle' || r === 'error') break;
		active = store.getActiveBatches(deps.repo.id);
	}
	// A full pipeline takes nothing new; what holds the rest is still said.
	if (!planned) await t.plan(active, masterSha, { holdsOnly: true });
}

/** Leaving batch mode: stops every batch in flight and puts its PRs back in line. */
/** Settles what a crash interrupted, whatever the repo's mode (see `recoverInterrupted`). */
export async function recoverInterrupted(deps: QueueDeps): Promise<void> {
	if (!store.getLandingIntent(deps.repo.id) && !store.branchIntents(deps.repo.id).length) return;
	await new Tick(deps).recoverInterrupted();
}

export async function retireBatches(deps: QueueDeps): Promise<void> {
	const t = new Tick(deps);
	await t.recoverInterrupted();
	await t.supersede(store.getActiveBatches(deps.repo.id));
	const base = store.getRunningBaseline(deps.repo.id);
	if (base) {
		await t.retire(base);
		store.setBatchStatus(base.id, 'superseded');
		store.clearMasterHealth(deps.repo.id);
	}
}

/**
 * Cancels a batch in the pipeline, or one being bisected: its CI and its bisection runs' CI stop,
 * and its PRs that are still in the queue go back in line at their places, blamed for nothing.
 * The batches built on top of it are rebuilt too. Call it under the repo lock.
 */
export async function cancelBatch(deps: QueueDeps, id: number, by: string): Promise<{ requeued: number[]; rebuilt: number[] }> {
	const t = new Tick(deps);
	// First, so a landing a crash interrupted is settled before the batch is judged.
	await t.recoverInterrupted();
	const b = store.getBatch(id);
	if (!b || b.repo_id !== deps.repo.id || b.kind !== 'batch') throw new Error(`Batch ${id} not found`);
	const active = store.getActiveBatches(deps.repo.id);
	if (!active.some((x) => x.id === id)) throw new Error(`Batch ${b.number} is ${b.status}; only a batch being tested or bisected can be cancelled`);
	const waiting = (x: BatchRow) => x.members.filter((n) => t.item(n)?.status === 'checking');
	const requeued = waiting(b);
	const above = active.filter((x) => x.id > id);
	await t.supersede([b], `batch ${b.number} was cancelled by ${by}`);
	store.setBatchStatus(id, 'cancelled');
	for (const r of store.getBisectRuns(id)) if (r.status === 'testing' || r.status === 'retrying') store.setBatchStatus(r.id, 'cancelled');
	await t.supersede(above, `batch ${b.number} below it was cancelled`);
	t.event(null, 'cancelled', { batch: id, number: b.number, by, requeued, rebuilt: above.map((x) => x.id) });
	t.log(`batch ${b.number} cancelled by ${by}: ${requeued.map((n) => `#${n}`).join(' ') || 'no PRs'} back in line`);
	return { requeued, rebuilt: above.map((x) => x.id) };
}

/** Starts a one-off CI run of a PR on top of the default branch (the `try` API). */
export async function startTry(deps: QueueDeps, n: number): Promise<BatchRow> {
	return new Tick(deps).startTry(n);
}
