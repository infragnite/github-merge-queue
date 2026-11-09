// The batch merge queue's state machine: one `tickBatchQueue` call per
// processor cycle advances a repo's pipeline by whatever has changed.
//
//   plan -> build -> push mq/* branch -> CI ─ pass ─────────────────────> land
//                                           └ fail -> re-run failed jobs ─ pass -> land
//                                                                         └ fail -> bisect -> eject culprits,
//                                                                                   land the rest
//
// Batches are pipelined: batch k+1 is built on batch k's head. Landing
// squash-merges each PR through the API, so master gets new commits with the
// tested tree; batches are therefore matched to master by tree, not by SHA.
//
// All GitHub, CI and git access goes through `QueueDeps`, so the machine is
// tested end to end against a real git sandbox and fakes.

import * as db from './db';
import * as store from './batch-store';
import type { BatchRow } from './batch-store';
import {
	Bisection,
	descendants,
	planNextBatch,
	type PRState,
	type Priority,
	type QueueEntry,
	type TestGroup
} from './batching';
import type { BatchMember, BuildResult } from './batch-builder';
import type { StackAnalysis } from './stacks';
import type { QueueItem } from '$lib/types';

export interface LivePR extends PRState {
	title: string;
	url: string;
	authorLogin: string;
	baseRef: string;
	state: 'open' | 'closed';
	merged: boolean;
}

export interface QueueGitHub {
	defaultBranchSha(): Promise<string>;
	pr(n: number): Promise<LivePR>;
	/** Creates or force-moves a branch to `sha` (the commit must already be pushed or local to the mirror). */
	pushBranch(branch: string, sha: string): Promise<void>;
	deleteBranch(branch: string): Promise<void>;
	retargetBase(n: number, base: string): Promise<void>;
	squashMerge(n: number, title: string, expectedHeadSha: string): Promise<{ merged: boolean; message?: string }>;
	setStatus(sha: string, state: 'success' | 'failure' | 'pending', description: string): Promise<void>;
	comment(n: number, body: string): Promise<void>;
}

export interface QueueCI {
	/** Starts the required workflow on `branch` for the batch commit `headSha` built on `baseSha`. */
	start(branch: string, baseSha: string, headSha: string, prs: number[]): Promise<void>;
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

function sqliteMs(ts: string): number {
	return Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
}

class Tick {
	private readonly prs = new Map<number, LivePR>();
	private analysisCache: StackAnalysis | null = null;

	constructor(private readonly d: QueueDeps) {}

	log(msg: string) {
		(this.d.log ?? ((m) => console.log(`[batch-queue] ${this.d.repo.owner}/${this.d.repo.name}: ${m}`)))(msg);
	}

	async pr(n: number): Promise<LivePR> {
		let p = this.prs.get(n);
		if (!p) {
			p = await this.d.github.pr(n);
			this.prs.set(n, p);
		}
		return p;
	}

	async analysis(): Promise<StackAnalysis> {
		this.analysisCache ??= await this.d.analysis();
		return this.analysisCache;
	}

	items(): QueueItem[] {
		return db.getQueueItems(this.d.repo.id).filter((i) => LIVE.includes(i.status));
	}

	item(n: number): QueueItem | undefined {
		return this.items().find((i) => i.pr_number === n);
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
		db.updateQueueItemStatus(it.id, 'failed', reason);
		db.addToHistory(this.d.repo.id, n, it.pr_title, it.pr_url, it.author_login, null, 'failed', reason, it.created_at);
		db.removeFromQueue(it.id);
		await this.d.github
			.comment(n, `Removed from the merge queue: ${reason}${link ? `\n\nBatch: ${link}` : ''}`)
			.catch(() => {});
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
			if (it) db.updateQueueItemStatus(it.id, 'queued');
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

	/** Builds `prs` on `baseSha`; ejects PRs that conflict and returns null so the caller replans. */
	async build(baseSha: string, prs: number[], below: number[]) {
		const members = await this.members(prs, below);
		await this.d.git.fetch([baseSha, ...members.map((m) => m.headSha)]);
		const r = await this.d.git.build(baseSha, members);
		if (!r.ok) {
			await this.ejectWithStack([{ pr: r.pr, reason: r.reason }]);
			return null;
		}
		return { result: r, heads: Object.fromEntries(members.map((m) => [m.pr, m.headSha])) };
	}

	async startBatch(baseSha: string, prs: number[], below: number[], express: boolean): Promise<'started' | 'conflict'> {
		const built = await this.build(baseSha, prs, below);
		if (!built) return 'conflict';
		const branch = `mq/batch-${this.d.now()}`;
		await this.d.github.pushBranch(branch, built.result.headSha);
		const batch = store.insertBatch({
			repoId: this.d.repo.id,
			kind: 'batch',
			branch,
			baseSha,
			headSha: built.result.headSha,
			treeSha: built.result.tree,
			baseTree: await this.d.git.tree(baseSha),
			members: prs,
			heads: built.heads,
			express
		});
		for (const n of prs) {
			const it = this.item(n);
			if (it) db.updateQueueItemStatus(it.id, 'checking');
		}
		await this.d.ci.start(branch, baseSha, built.result.headSha, prs);
		this.log(`batch ${batch.id} started: ${prs.map((n) => `#${n}`).join(' ')}${express ? ' (express)' : ''}`);
		return 'started';
	}

	// --- landing ---

	async land(batch: BatchRow, prs: number[], tree: string): Promise<boolean> {
		const def = this.d.repo.default_branch;
		for (const n of prs) {
			const p = await this.pr(n);
			if (p.state !== 'open' || p.headSha !== batch.heads[n]) {
				// The author pushed or closed it after the batch was built: what we tested is stale.
				this.log(`#${n} changed after batch ${batch.id} was built; rebuilding`);
				return false;
			}
		}
		for (const n of prs) {
			const p = await this.pr(n);
			if (p.baseRef !== def) await this.d.github.retargetBase(n, def);
			const r = await this.d.github.squashMerge(n, `${p.title} (#${n})`, batch.heads[n]);
			if (!r.merged) {
				const reason = `Landing batch ${batch.id} stopped at #${n}: ${r.message ?? 'merge refused'}`;
				store.updateQueueSettings(this.d.repo.id, { pausedReason: reason });
				this.log(reason);
				return false;
			}
			const it = this.item(n);
			if (it) {
				db.addToHistory(this.d.repo.id, n, it.pr_title, it.pr_url, it.author_login, null, 'merged', null, it.created_at);
				db.removeFromQueue(it.id);
			}
		}
		const master = await this.d.github.defaultBranchSha();
		await this.d.git.fetch([master]);
		if ((await this.d.git.tree(master)) === tree) {
			await this.d.github.setStatus(master, 'success', `Tree tested in ${batch.branch} (${batch.head_sha.slice(0, 7)})`);
		} else {
			const reason = `Master after batch ${batch.id} does not match the tested tree; was something merged outside the queue?`;
			store.updateQueueSettings(this.d.repo.id, { pausedReason: reason });
			this.log(reason);
		}
		this.log(`batch ${batch.id} landed: ${prs.map((n) => `#${n}`).join(' ')}`);
		return true;
	}

	// --- the pipeline head ---

	async advanceHead(head: BatchRow, rest: BatchRow[]) {
		if (head.status === 'testing' || head.status === 'retrying') {
			const r = await this.d.ci.result(head.head_sha);
			if (r === 'pending') return;
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
			if (await this.land(head, head.members, head.tree_sha)) {
				store.setBatchStatus(head.id, 'landed');
				await this.d.github.deleteBranch(head.branch).catch(() => {});
			} else if (!store.getQueueSettings(this.d.repo.id).pausedReason) {
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
				if (res !== 'pending') store.setBatchCI(run.id, res);
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
		this.requeue(step.requeue);
		let landed = false;
		if (step.land.length) {
			const proof = runs.find((r) => r.context.length === 0 && r.members.join(',') === step.land.join(','));
			if (proof && (await this.land(batch, step.land, proof.tree_sha))) landed = true;
			else this.requeue(step.land);
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
		const run = store.insertBatch({
			repoId: this.d.repo.id,
			kind: 'bisect',
			parentBatchId: batch.id,
			branch,
			baseSha: batch.base_sha,
			headSha: r.ok ? r.headSha : batch.base_sha,
			treeSha: r.ok ? r.tree : '',
			baseTree: batch.base_tree,
			members: g.members,
			context: g.context,
			heads: batch.heads
		});
		if (!r.ok) {
			// Built fine as part of the whole batch, so this can't normally happen; count it as a failure.
			store.setBatchCI(run.id, 'failure');
			return;
		}
		await this.d.github.pushBranch(branch, r.headSha);
		await this.d.ci.start(branch, batch.base_sha, r.headSha, prs);
	}

	// --- reconcile and plan ---

	async reconcile() {
		for (const it of this.items()) {
			const p = await this.pr(it.pr_number);
			if (p.state === 'open') continue;
			if (it.status === 'checking') continue; // its batch notices when landing
			if (p.merged) {
				db.addToHistory(this.d.repo.id, it.pr_number, it.pr_title, it.pr_url, it.author_login, null, 'merged', null, it.created_at);
				db.removeFromQueue(it.id);
			} else {
				db.updateQueueItemStatus(it.id, 'cancelled', 'PR was closed');
			}
		}
	}

	async plan(active: BatchRow[], masterSha: string): Promise<'started' | 'conflict' | 'idle'> {
		const settings = store.getQueueSettings(this.d.repo.id);
		const waiting = this.items().filter((i) => i.status !== 'checking');
		if (waiting.length === 0) return 'idle';
		const queue: QueueEntry[] = waiting.map((i) => ({
			pr: i.pr_number,
			enqueuedAt: sqliteMs(i.created_at),
			priority: ((i as QueueItem & { priority?: Priority }).priority ?? 'normal') as Priority
		}));
		const states = new Map<number, PRState>();
		for (const e of queue) states.set(e.pr, await this.pr(e.pr));
		const plan = planNextBatch({
			now: this.d.now(),
			queue,
			states,
			analysis: await this.analysis(),
			inflight: active.map((b) => b.members),
			config: settings.config
		});
		for (const h of plan.held) {
			if (!h.admission.wait && (h.admission.code === 'stack-broken' || h.admission.code === 'ci-failed')) {
				const it = this.item(h.pr);
				if (it && it.error_message !== h.admission.reason) {
					db.updateQueueItemStatus(it.id, 'queued', h.admission.reason);
				}
			}
		}
		if (!plan.batch) return 'idle';
		const base = active.length ? active[active.length - 1].head_sha : masterSha;
		const below = active.flatMap((b) => b.members);
		return this.startBatch(base, plan.batch, below, plan.express);
	}
}

export async function tickBatchQueue(deps: QueueDeps): Promise<void> {
	const t = new Tick(deps);
	if (store.getQueueSettings(deps.repo.id).pausedReason) return;
	await t.reconcile();

	let active = store.getActiveBatches(deps.repo.id);
	const masterSha = await deps.github.defaultBranchSha();
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
	const depth = store.getQueueSettings(deps.repo.id).config.depth;
	for (let i = 0; i < 8 && active.length < depth; i++) {
		// A conflict ejects a PR at build time; plan again with the rest.
		// Landing earlier in this tick moved master: read it again before building on it.
		const base = active.length ? masterSha : await deps.github.defaultBranchSha();
		const r = await t.plan(active, base);
		if (r === 'idle') break;
		active = store.getActiveBatches(deps.repo.id);
	}
}
