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
	Bisection,
	descendants,
	planNextBatch,
	type PRState,
	type Priority,
	type QueueEntry,
	type TestGroup
} from './batching';
import type { BatchMember, BuildResult } from './batch-builder';
import type { ReplayResult } from './rebase';
import type { StackAnalysis } from './stacks';
import type { QueueItem } from '$lib/types';
import { emitEvent, type QueueEventKind } from './events';

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
	/** CI and reviews of a PR at `headSha` (the expensive part, fetched only when needed). */
	readiness(n: number, headSha: string, author: string): Promise<Readiness>;
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
	/** The required check's result on `headSha`. */
	result(headSha: string): Promise<'pending' | 'success' | 'failure'>;
	/** Re-runs only the failed jobs; false when there is nothing to re-run. */
	rerunFailed(headSha: string): Promise<boolean>;
}

export interface QueueGit {
	/** Makes sure the mirror has these commits. */
	fetch(shas: string[]): Promise<void>;
	tree(sha: string): Promise<string>;
	build(baseSha: string, members: BatchMember[]): Promise<BuildResult>;
	/** `git rebase --onto onto upstream head`, when it needs no conflict resolution. */
	restack(head: string, upstream: string, onto: string): Promise<ReplayResult>;
}

export interface QueueDeps {
	repo: { id: number; owner: string; name: string; default_branch: string };
	github: QueueGitHub;
	ci: QueueCI;
	git: QueueGit;
	analysis(): Promise<StackAnalysis>;
	now(): number;
	log?: (msg: string) => void;
}

const LIVE = ['queued', 'checking', 'updating', 'merging', 'conflict'];
export const CONFLICT_LABEL = 'needs-rebase';
/** When each repo last had its caches refreshed (in memory: a restart costs one extra refresh). */
const lastCacheRefresh = new Map<number, number>();
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
	private readonly ready = new Map<string, Readiness>();
	private analysisCache: StackAnalysis | null = null;

	constructor(private readonly d: QueueDeps) {}

	get repoId() {
		return this.d.repo.id;
	}

	log(msg: string) {
		(this.d.log ?? ((m) => console.log(`[batch-queue] ${this.d.repo.owner}/${this.d.repo.name}: ${m}`)))(msg);
	}

	event(pr: number | null, kind: QueueEventKind, data: Record<string, unknown> = {}) {
		try {
			emitEvent(this.repoId, pr, kind, data);
		} catch (e) {
			this.log(`could not record event ${kind}: ${e instanceof Error ? e.message : e}`);
		}
	}

	async pr(n: number, fresh = false): Promise<LivePR> {
		let p = fresh ? undefined : this.prs.get(n);
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
			r = await this.d.github.readiness(n, p.headSha, p.authorLogin);
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
			targetsDefault: p.baseRef === this.d.repo.default_branch
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
		return store.getQueueSettings(this.repoId);
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
		if (head) await this.d.github.setPRStatus(head, 'failure', short(`Left the queue: ${reason}`)).catch(() => {});
		db.updateQueueItemStatus(it.id, 'failed', reason);
		db.addToHistory(this.repoId, n, it.pr_title, it.pr_url, it.author_login, null, 'failed', reason, it.created_at);
		db.removeFromQueue(it.id);
		await this.d.github
			.comment(n, `Removed from the merge queue: ${reason}${link ? `\n\nBatch: ${link}` : ''}`)
			.catch(() => {});
		this.event(n, 'ejected', { reason });
		this.log(`ejected #${n}: ${reason}`);
	}

	async ejectWithStack(culprits: { pr: number; reason: string }[]) {
		const a = await this.analysis();
		const done = new Set<number>();
		for (const c of culprits) {
			await this.eject(c.pr, c.reason);
			done.add(c.pr);
		}
		for (const n of descendants(a, done)) {
			if (done.has(n) || !this.item(n)) continue;
			const p = a.prs.get(n)?.parent;
			await this.eject(n, `Stacked on #${p}, which failed in the queue`);
		}
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
	async requeueAfterFailure(prs: number[], batchId: number) {
		for (const n of prs) {
			const it = this.item(n);
			if (!it) continue;
			if (store.bumpBatchFailures(it.id) >= MAX_BATCH_FAILURES) {
				await this.ejectWithStack([
					{ pr: n, reason: `failed in ${MAX_BATCH_FAILURES} batches without a clear culprit (flaky tests?), last batch ${batchId}` }
				]);
			} else {
				db.updateQueueItemStatus(it.id, 'queued');
				this.event(n, 'requeued', { batch: batchId });
			}
		}
	}

	/** Every active batch from `from` on is rebuilt later; their PRs go back to the queue. */
	async supersede(batches: BatchRow[]) {
		for (const b of batches) {
			store.setBatchStatus(b.id, 'superseded');
			this.requeue(b.members);
			await this.d.github.deleteBranch(b.branch).catch(() => {});
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
		await this.d.github.setPRStatus(p.headSha, 'failure', short(`Conflict: ${reason}`)).catch(() => {});
		await this.d.github.label(n, CONFLICT_LABEL, true).catch(() => {});
		const list = files.length ? `\n\nConflicting files:\n${files.slice(0, 20).map((f) => `- \`${f}\``).join('\n')}` : '';
		await this.d.github
			.comment(
				n,
				`The merge queue can't apply this PR: ${reason}.${list}\n\nTo fix it:\n\n\`\`\`sh\n${fix}\n# resolve the conflicts, then\ngit push --force-with-lease\n\`\`\`\n\nThe PR stays queued and is picked up again after the push.`
			)
			.catch(() => {});
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
			db.updateQueueItemStatus(it.id, 'queued', `Conflicts with ${ahead.map((a) => `#${a}`).join(' ')} ahead of it; waits for them to land`);
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
		const branch = `mq/batch-${this.d.now()}`;
		try {
			await this.d.github.pushBranch(branch, result.headSha);
			await this.d.ci.start(branch, baseSha, result.headSha, prs);
		} catch (e) {
			// A push or dispatch failure is a setup problem (permissions, workflow trigger): stop and say so.
			await this.d.github.deleteBranch(branch).catch(() => {});
			this.pause(`Could not start a batch of ${prs.map((n) => `#${n}`).join(' ')}: ${e instanceof Error ? e.message : e}`);
			return 'error';
		}
		const steps: Record<number, BatchStep> = {};
		for (const c of result.commits) steps[c.pr] = { sha: c.sha, tree: c.tree, fork: c.fork };
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
		for (const n of prs) {
			const it = this.item(n);
			if (it) {
				db.updateQueueItemStatus(it.id, 'checking');
				this.event(n, 'batched', { batch: batch.id, branch, prs });
				await this.d.github.setPRStatus(batch.heads[n], 'pending', short(`Testing in ${branch} with ${prs.length - 1} other PR(s)`)).catch(() => {});
			}
		}
		this.log(`batch ${batch.id} started: ${prs.map((n) => `#${n}`).join(' ')}${express ? ' (express)' : ''}`);
		return 'started';
	}

	// --- landing ---

	/** Whether every PR may still land exactly as tested; false sends the batch back to be rebuilt. */
	async stillLandable(batch: BatchRow, prs: number[]): Promise<boolean> {
		const config = this.settings().config;
		const a = await this.analysis();
		for (const n of prs) {
			const it = this.item(n);
			if (!it || it.status !== 'checking') {
				this.log(`#${n} left the queue while batch ${batch.id} was testing; rebuilding`);
				return false;
			}
			const s = await this.state(n, true);
			const p = await this.pr(n);
			if (p.state !== 'open' || p.headSha !== batch.heads[n]) {
				// The author pushed or closed it after the batch was built: what we tested is stale.
				this.log(`#${n} changed after batch ${batch.id} was built; rebuilding`);
				return false;
			}
			// Reviews and drafts may have changed while the batch was testing; the batch's own CI stands in for the PR's.
			const adm = admit({ ...s, ciGreen: true }, a, config);
			if (!adm.ok) {
				db.updateQueueItemStatus(it.id, 'checking', adm.reason);
				this.log(`#${n} can no longer land: ${adm.reason}; rebuilding`);
				return false;
			}
		}
		return true;
	}

	/**
	 * Lands `prs` from `src` (the batch, or the bisection run that proved
	 * them). Before each merge master must hold the tree tested for the step
	 * before it, and after each merge the tree tested for that step.
	 */
	async land(batch: BatchRow, prs: number[], src: BatchRow): Promise<boolean> {
		const def = this.d.repo.default_branch;
		if (!(await this.stillLandable(batch, prs))) return false;

		let master = await this.d.github.defaultBranchSha();
		await this.d.git.fetch([master]);
		let expected = src.base_tree;
		for (const n of prs) {
			if (this.settings().pausedReason) return false;
			if ((await this.d.git.tree(master)) !== expected) {
				this.pause(`Master changed while batch ${batch.id} was landing (before #${n}); was something merged outside the queue?`);
				return false;
			}
			const step = src.steps[n];
			const p = await this.pr(n);
			let head = batch.heads[n];
			if (step.fork) {
				// A stacked child: its parent just landed as a squash commit, so restack the child's own
				// commits onto master; GitHub's squash of the restacked head is then the tested tree.
				await this.d.git.fetch([head, step.fork]);
				const r = await this.d.git.restack(head, step.fork, master);
				if (!r.ok || r.tree !== step.tree) {
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
					this.pause(`Could not push the restacked #${n}: ${e instanceof Error ? e.message : e}`);
					return false;
				}
				store.recordRebasedHead(this.repoId, n, head, r.head, true);
				this.event(n, 'rebased', { from: head, to: r.head, onto: def, reason: 'landing after its parent' });
				head = r.head;
			}
			if (p.baseRef !== def) await this.d.github.retargetBase(n, def);
			// The default branch requires this status, so only the queue can merge, and only what it tested.
			await this.d.github.setPRStatus(head, 'success', short(`Tested in ${batch.branch}`));
			const m = await this.d.github.squashMerge(n, `${p.title} (#${n})`, head);
			if (!m.merged) {
				this.pause(`Landing batch ${batch.id} stopped at #${n}: ${m.message ?? 'merge refused'}`);
				return false;
			}
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
		if ((await this.d.git.tree(master)) !== expected) {
			this.pause(`Master after batch ${batch.id} does not match the tested tree; was something merged outside the queue?`);
			return false;
		}
		await this.d.github.setStatus(master, 'success', `Tree tested in ${batch.branch} (${batch.head_sha.slice(0, 7)})`);
		this.log(`batch ${batch.id} landed: ${prs.map((n) => `#${n}`).join(' ')}`);
		await this.maybeRefreshCaches();
		return true;
	}

	async maybeRefreshCaches() {
		const every = this.settings().config.cacheRefreshMs;
		if (!every) return;
		const last = lastCacheRefresh.get(this.repoId) ?? 0;
		if (this.d.now() - last < every) return;
		lastCacheRefresh.set(this.repoId, this.d.now());
		await this.d.ci.refreshCaches().catch((e) => this.log(`cache refresh failed: ${e instanceof Error ? e.message : e}`));
	}

	// --- the pipeline head ---

	timedOut(b: BatchRow): boolean {
		return this.d.now() - store.batchCreatedMs(b) > this.settings().config.ciTimeoutMs;
	}

	async advanceHead(head: BatchRow, rest: BatchRow[]) {
		if (head.status === 'testing' || head.status === 'retrying') {
			const r = await this.d.ci.result(head.head_sha);
			if (r === 'pending') {
				if (this.timedOut(head)) {
					await this.supersede([head, ...rest]);
					this.pause(`Batch ${head.id} (${head.branch}) got no CI result in time; is the workflow running on mq/* branches?`);
				}
				return;
			}
			store.setBatchCI(head.id, r);
			if (r === 'success') {
				store.setBatchStatus(head.id, 'passed');
				head = { ...head, status: 'passed' };
			} else if (head.status === 'testing' && (await this.d.ci.rerunFailed(head.head_sha))) {
				store.setBatchStatus(head.id, 'retrying');
				store.setBatchCI(head.id, 'pending');
				this.log(`batch ${head.id} failed; re-running failed jobs`);
				return;
			} else {
				// Everything built on top of a failed batch has to be rebuilt.
				await this.supersede(rest);
				if (head.members.length === 1) {
					store.setBatchStatus(head.id, 'failed');
					await this.d.github.deleteBranch(head.branch).catch(() => {});
					await this.ejectWithStack([{ pr: head.members[0], reason: `CI failed in ${head.branch}` }]);
					return;
				}
				store.setBatchStatus(head.id, 'bisecting');
				head = { ...head, status: 'bisecting' };
			}
		}
		if (head.status === 'passed') {
			if (await this.land(head, head.members, head)) {
				store.setBatchStatus(head.id, 'landed');
				await this.d.github.deleteBranch(head.branch).catch(() => {});
			} else if (!this.settings().pausedReason) {
				await this.supersede([head, ...rest]);
			}
			return;
		}
		if (head.status === 'bisecting') await this.bisect(head);
	}

	async bisect(batch: BatchRow) {
		const parentOf = await this.parentOf();
		const bis = new Bisection(batch.members, parentOf);
		const runs = store.getBisectRuns(batch.id);
		let waiting = false;
		for (const run of runs) {
			let res = run.ci_result;
			if (res === 'pending') {
				res = await this.d.ci.result(run.head_sha);
				if (res === 'failure' && run.status !== 'retrying' && (await this.d.ci.rerunFailed(run.head_sha))) {
					// A bisection step is retried once too, so a flake doesn't eject an innocent PR.
					store.setBatchStatus(run.id, 'retrying');
					res = 'pending';
				} else if (res !== 'pending') store.setBatchCI(run.id, res);
				if (res === 'pending' && this.timedOut(run)) {
					await this.d.github.deleteBranch(run.branch).catch(() => {});
					store.setBatchStatus(batch.id, 'failed');
					this.requeue(batch.members);
					this.pause(`Bisection run ${run.branch} got no CI result in time`);
					return;
				}
			}
			if (res === 'pending') waiting = true;
			else bis.record({ context: run.context, members: run.members }, res === 'success');
		}
		if (waiting) return;

		const step = bis.next();
		if (step.kind === 'test') {
			const have = new Set(runs.map((r) => `${r.context.join(',')}|${r.members.join(',')}`));
			for (const g of step.groups) {
				if (have.has(`${g.context.join(',')}|${g.members.join(',')}`)) continue;
				await this.startBisectRun(batch, g, runs.length);
			}
			return;
		}

		for (const r of runs) await this.d.github.deleteBranch(r.branch).catch(() => {});
		await this.ejectWithStack(step.eject.map((e) => ({ pr: e.pr, reason: `${e.reason} (batch ${batch.id})` })));
		await this.requeueAfterFailure(step.requeue, batch.id);
		let landed = false;
		if (step.land.length) {
			const proof = runs.find(
				(r) => r.context.length === 0 && r.members.join(',') === step.land.join(',') && r.ci_result === 'success'
			);
			if (proof && (await this.land(batch, step.land, proof))) landed = true;
			else if (!this.settings().pausedReason) this.requeue(step.land);
		}
		store.setBatchStatus(batch.id, landed ? 'landed' : 'failed');
		await this.d.github.deleteBranch(batch.branch).catch(() => {});
	}

	async startBisectRun(batch: BatchRow, g: TestGroup, seq: number) {
		const prs = [...g.context, ...g.members];
		const members = await this.members(prs, []);
		// Bisection tests the PRs exactly as they were in the failed batch.
		for (const m of members) m.headSha = batch.heads[m.pr] ?? m.headSha;
		const r = await this.d.git.build(batch.base_sha, members);
		const branch = `${batch.branch}-bisect-${seq + 1}-${this.d.now()}`;
		const steps: Record<number, BatchStep> = {};
		if (r.ok) for (const c of r.commits) steps[c.pr] = { sha: c.sha, tree: c.tree, fork: c.fork };
		const run = store.insertBatch({
			repoId: this.repoId,
			kind: 'bisect',
			parentBatchId: batch.id,
			branch,
			baseSha: batch.base_sha,
			headSha: r.ok ? r.headSha : batch.base_sha,
			treeSha: r.ok ? r.tree : '',
			baseTree: batch.base_tree,
			members: g.members,
			context: g.context,
			heads: batch.heads,
			steps
		});
		if (!r.ok) {
			// Built fine as part of the whole batch, so this can't normally happen; count it as a failure.
			store.setBatchCI(run.id, 'failure');
			return;
		}
		try {
			await this.d.github.pushBranch(branch, r.headSha);
			await this.d.ci.start(branch, batch.base_sha, r.headSha, prs);
		} catch (e) {
			store.setBatchCI(run.id, 'failure');
			this.pause(`Could not start bisection run ${branch}: ${e instanceof Error ? e.message : e}`);
		}
	}

	// --- try runs ---

	/** Tests one PR on top of master, outside the pipeline, so its author gets CI on demand. */
	async startTry(n: number): Promise<BatchRow> {
		const p = await this.pr(n, true);
		if (p.state !== 'open') throw new Error(`#${n} is not open`);
		const masterSha = await this.d.github.defaultBranchSha();
		const member: BatchMember = { pr: n, headSha: p.headSha, title: p.title, parentHeadSha: null };
		await this.d.git.fetch([masterSha, p.headSha]);
		const r = await this.d.git.build(masterSha, [member]);
		if (!r.ok) throw new Error(`#${n} does not apply on ${this.d.repo.default_branch}: ${r.reason.replace(/^#\d+ /, '')}`);
		const branch = `mq/try-${n}-${this.d.now()}`;
		await this.d.github.pushBranch(branch, r.headSha);
		try {
			await this.d.ci.start(branch, masterSha, r.headSha, [n]);
		} catch (e) {
			await this.d.github.deleteBranch(branch).catch(() => {});
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
		await this.d.github.setPRStatus(p.headSha, 'pending', short(`Trying on ${this.d.repo.default_branch} in ${branch}`), { suffix: '/try' }).catch(() => {});
		this.event(n, 'tried', { status: 'started', branch, run: run.id });
		return run;
	}

	async advanceTries() {
		for (const t of store.getRunningTries(this.repoId)) {
			let r = await this.d.ci.result(t.head_sha);
			if (r === 'pending' && !this.timedOut(t)) continue;
			if (r === 'pending') r = 'failure';
			store.setBatchCI(t.id, r);
			store.setBatchStatus(t.id, r === 'success' ? 'landed' : 'failed');
			const n = t.members[0];
			const desc = r === 'success' ? `Passed on ${this.d.repo.default_branch} in ${t.branch}` : `Failed on ${this.d.repo.default_branch} in ${t.branch}`;
			await this.d.github.setPRStatus(t.heads[n], r, short(desc), { suffix: '/try' }).catch(() => {});
			await this.d.github.deleteBranch(t.branch).catch(() => {});
			this.event(n, 'tried', { status: r, branch: t.branch, run: t.id, headSha: t.heads[n] });
		}
	}

	// --- reconcile, restack and plan ---

	async reconcile() {
		for (const it of this.items()) {
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
				await this.d.github.label(it.pr_number, CONFLICT_LABEL, false).catch(() => {});
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
			if (merged && p.baseRef !== def) await this.d.github.retargetBase(n, def).catch(() => {});
			await this.d.github
				.comment(
					n,
					`The merge queue restacked this PR onto ${ontoName} (${issue.message}). Its ${r.replayed} commit(s) applied without conflicts; approvals carry over.\n\nUpdate your local branch before pushing again:\n\n\`\`\`sh\ngit fetch origin ${p.headRef} && git reset --hard origin/${p.headRef}\n\`\`\``
				)
				.catch(() => {});
			this.event(n, 'rebased', { from: p.headSha, to: r.head, onto: ontoName, reason: issue.message });
			this.log(`restacked #${n} onto ${ontoName}`);
			pushed = true;
		}
		return pushed;
	}

	async plan(active: BatchRow[], masterSha: string): Promise<'started' | 'conflict' | 'error' | 'idle'> {
		const settings = this.settings();
		const live = new Set(this.items().map((i) => i.pr_number));
		const waiting = this.items().filter((i) => {
			if (i.status !== 'queued') return false;
			const behind = store.deferredFor(i as QueueItem & { deferred_for?: string | null });
			if (behind.some((b) => live.has(b))) return false;
			if (behind.length) store.setDeferredFor(i.id, null);
			return true;
		});
		if (waiting.length === 0) return 'idle';
		const queue: QueueEntry[] = waiting.map((i) => ({
			pr: i.pr_number,
			enqueuedAt: sqliteMs(i.created_at),
			priority: ((i as QueueItem & { priority?: Priority }).priority ?? 'normal') as Priority
		}));
		const states = new Map<number, PRState>();
		for (const e of queue) states.set(e.pr, await this.state(e.pr));
		const plan = planNextBatch({
			now: this.d.now(),
			queue,
			states,
			analysis: await this.analysis(),
			inflight: active.map((b) => b.members),
			config: settings.config
		});
		for (const h of plan.held) {
			const it = this.item(h.pr);
			if (it && it.error_message !== h.admission.reason) db.updateQueueItemStatus(it.id, 'queued', h.admission.reason);
		}
		if (!plan.batch) return 'idle';
		const base = active.length ? active[active.length - 1].head_sha : masterSha;
		const below = active.flatMap((b) => b.members);
		return this.startBatch(base, plan.batch, below, plan.express, masterSha);
	}
}

export async function tickBatchQueue(deps: QueueDeps): Promise<void> {
	const t = new Tick(deps);
	if (store.getQueueSettings(deps.repo.id).pausedReason) return;
	await t.reconcile();
	await t.advanceTries();

	let active = store.getActiveBatches(deps.repo.id);
	let masterSha = await deps.github.defaultBranchSha();
	if (active.length) {
		await deps.git.fetch([masterSha]);
		if (active[0].base_tree !== (await deps.git.tree(masterSha))) {
			t.log('master moved outside the queue; rebuilding the pipeline');
			await t.supersede(active);
			active = [];
		}
	}
	if (active.length) {
		await t.advanceHead(active[0], active.slice(1));
		if (store.getQueueSettings(deps.repo.id).pausedReason) return;
		active = store.getActiveBatches(deps.repo.id);
	}
	// Don't plan new work on top of a bisection: its base is about to change.
	if (active.some((b) => b.status === 'bisecting')) return;
	const config = store.getQueueSettings(deps.repo.id).config;
	if (config.autoRebase && (await t.restack())) return;
	for (let i = 0; i < 8 && active.length < config.depth; i++) {
		// A conflict sets a PR aside at build time; plan again with the rest.
		// Landing earlier in this tick moved master: read it again before building on it.
		if (!active.length) masterSha = await deps.github.defaultBranchSha();
		const r = await t.plan(active, masterSha);
		if (r === 'idle' || r === 'error') break;
		active = store.getActiveBatches(deps.repo.id);
	}
}

/** Starts a one-off CI run of a PR on top of the default branch (the `try` API). */
export async function startTry(deps: QueueDeps, n: number): Promise<BatchRow> {
	return new Tick(deps).startTry(n);
}
