import { afterEach, beforeEach, describe, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');
const store = await import('./batch-store');
const { tickBatchQueue, startTry, retireBatches, recoverInterrupted, cancelBatch } = await import('./batch-queue');
const { baselineCommit, buildBatch, GitRunner } = await import('./batch-builder');
const { replay } = await import('./rebase');
const { analyzeStacks } = await import('./stacks');
import { GitSandbox } from './testing/git-sandbox';
import { writeFileSync } from 'node:fs';
import type { LivePR, QueueDeps } from './batch-queue';
import { RateLimitedError } from './rate-limit';

let git: GitSandbox;
let repo: { id: number; owner: string; name: string; default_branch: string };
let repoSeq = 0;

/** Test double for GitHub + CI on top of the sandbox repo. */
class World {
	approved = new Set<number>();
	ciRed = new Set<number>();
	/** CI fails when the tested tree has this file (a PR that breaks master). */
	breakingFiles = new Set<string>();
	/** CI fails when the tree has all of these files (a semantic conflict between PRs). */
	conflictPairs: string[][] = [];
	/** Head SHAs whose first CI run fails and whose re-run passes. */
	flaky = new Set<string>();
	started: { branch: string; head: string; prs: number[] }[] = [];
	reruns = new Map<string, number>();
	statuses: { sha: string; state: string }[] = [];
	comments: { pr: number; body: string }[] = [];
	merged: number[] = [];
	ciPendingOnce = new Set<string>();
	prStatuses: { sha: string; state: string; description: string; context: string; url?: string }[] = [];
	labels = new Map<number, Set<string>>();
	pushedHeads: { branch: string; sha: string }[] = [];
	changesRequested = new Set<number>();
	/** Approval given on one specific head SHA only. */
	approvedOn = new Map<number, string>();
	cacheRefreshes = 0;
	cancelled: string[] = [];
	/** Re-run requests answered "the workflow is still running" before one is accepted. */
	rerunWaits = 0;
	/** PRs whose merge GitHub refuses (e.g. a ruleset the queue doesn't satisfy). */
	refuseMerge = new Set<number>();
	/** GitHub answers merges with a rate-limit refusal. */
	rateLimited = false;
	openListCalls = 0;
	prCalls = 0;
	/** PRs GitHub answers 404 for. */
	deleted = new Set<number>();
	/** PRs opened from a fork. */
	forks = new Set<number>();

	files(sha: string) {
		return new Set(git.git('ls-tree', '-r', '--name-only', sha).split('\n'));
	}

	everythingFails = false;
	/** Commits whose CI keeps running (reports pending) until removed. */
	stillRunning = new Set<string>();
	/** The default branch's own runs keep running while set. */
	holdMasterRuns = false;
	/** Runs of these PRs keep running while it says so. */
	hold: (prs: number[]) => boolean = () => false;
	/** Called as each PR is about to be merged (before GitHub checks its head). */
	beforeMerge: (n: number) => void = () => {};

	ciFails(sha: string) {
		if (this.everythingFails) return true;
		const f = this.files(sha);
		if ([...this.breakingFiles].some((b) => f.has(b))) return true;
		return this.conflictPairs.some((pair) => pair.every((p) => f.has(p)));
	}

	live(n: number): LivePR {
		if (this.deleted.has(n)) throw Object.assign(new Error('Not Found'), { status: 404 });
		const p = git.pr(n);
		const head = p.frozenHead ?? git.sha(p.headRef);
		return {
			pr: n,
			headSha: head,
			headRef: p.headRef,
			sameRepo: !this.forks.has(n),
			draft: false,
			title: `PR ${n}`,
			url: `https://example.test/pull/${n}`,
			authorLogin: 'dev',
			baseRef: p.baseRef,
			state: p.state,
			merged: p.merged
		};
	}

	deps(): QueueDeps {
		const runner = new GitRunner(git.dir);
		return {
			repo,
			now: () => Date.now() + this.started.length,
			sleep: async () => {},
			log: () => {},
			analysis: async () => analyzeStacks(git.input()),
			git: {
				fetch: async () => {},
				tree: async (sha) => git.git('rev-parse', `${sha}^{tree}`),
				build: async (base, members) => buildBatch(runner, base, members),
				restack: async (head, upstream, onto) => replay(runner, { head, upstream, onto }),
				baseline: async (base) => baselineCommit(runner, base)
			},
			ci: {
				start: async (branch, _base, head, prs) => {
					this.started.push({ branch, head, prs });
					this.ciPendingOnce.add(head);
				},
				result: async (head) => {
					if (this.ciPendingOnce.delete(head) || this.stillRunning.has(head)) return 'pending';
					if (this.holdMasterRuns && head === git.sha('main')) return 'pending';
					const started = this.started.find((x) => x.head === head);
					if (started && this.hold(started.prs)) return 'pending';
					const flakeNow = this.flaky.has(head) && !this.reruns.has(head);
					return flakeNow || this.ciFails(head) ? 'failure' : 'success';
				},
				cancel: async (head) => {
					this.cancelled.push(head);
				},
				refreshCaches: async () => {
					this.cacheRefreshes++;
				},
				runUrl: async (head) => `https://ci.example/${head}`,
				rerunFailed: async (head) => {
					if (this.rerunWaits > 0) {
						this.rerunWaits--;
						return 'wait';
					}
					this.reruns.set(head, (this.reruns.get(head) ?? 0) + 1);
					this.ciPendingOnce.add(head);
					return 'rerun';
				}
			},
			github: {
				defaultBranchSha: async () => git.sha('main'),
				pr: async (n): Promise<LivePR> => {
					this.prCalls++;
					return this.live(n);
				},
				openPRs: async () => {
					this.openListCalls++;
					return git.prNumbers().flatMap((n) => {
						if (this.deleted.has(n)) return [];
						const p = this.live(n);
						return p.state === 'open' ? [p] : [];
					});
				},
				readiness: async (n, head) => ({
					ciGreen: !this.ciRed.has(n),
					approvedShas: this.approved.has(n) ? [head] : this.approvedOn.has(n) ? [this.approvedOn.get(n)!] : [],
					changesRequested: this.changesRequested.has(n)
				}),
				pushBranch: async (branch, sha) => {
					git.git('branch', '-f', branch, sha);
				},
				pushHead: async (branch, sha, expected) => {
					if (git.sha(branch) !== expected) throw new Error('stale info');
					git.git('branch', '-f', branch, sha);
					this.pushedHeads.push({ branch, sha });
				},
				setPRStatus: async (sha, state, description, opts) => {
					this.prStatuses.push({ sha, state, description, context: `merge-queue${opts?.suffix ?? ''}`, ...(opts?.url ? { url: opts.url } : {}) });
				},
				label: async (n, name, on) => {
					const set = this.labels.get(n) ?? new Set();
					if (on) set.add(name);
					else set.delete(name);
					this.labels.set(n, set);
				},
				deleteBranch: async (branch) => {
					git.git('branch', '-D', branch);
				},
				retargetBase: async (n, base) => git.retarget(n, base),
				squashMerge: async (n, _title, expected) => {
					this.beforeMerge(n);
					if (this.refuseMerge.has(n)) return { merged: false, message: 'Repository rule violations found' };
					if (this.rateLimited) throw new RateLimitedError(Date.now() + 60_000, 'API rate limit exceeded');
					if (git.sha(git.pr(n).headRef) !== expected) return { merged: false, message: 'Head branch was modified' };
					try {
						git.merge(n, 'squash');
					} catch (e) {
						git.git('merge', '--abort');
						return { merged: false, message: 'Merge conflict' };
					}
					this.merged.push(n);
					return { merged: true, sha: git.sha('main') };
				},
				setStatus: async (sha, state) => {
					this.statuses.push({ sha, state });
				},
				comment: async (pr, body) => {
					this.comments.push({ pr, body });
				}
			}
		};
	}
}

let world: World;

beforeEach(() => {
	git = new GitSandbox();
	world = new World();
	const user = db.upsertUser(1, 'dev', null, null);
	const name = `repo${++repoSeq}`;
	db.addRepo('acme', name, 'main', user);
	repo = { ...db.getRepoByOwnerName('acme', name)!, default_branch: 'main' };
	store.updateQueueSettings(repo.id, { mode: 'batch', config: { collectWindowMs: 0, depth: 1 } });
	// The queue starts from a default branch it knows is green (tests of a broken one set their own).
	store.setMasterHealth(repo.id, { sha: git.sha('main'), tree: git.git('rev-parse', 'main^{tree}'), state: 'green', since: 0 });
});

afterEach(() => git?.cleanup());

/** A PR with one commit adding `file` (default: pr<n>.txt), approved and queued. */
function pr(n: number, opts: { file?: string; from?: string; base?: string; approve?: boolean } = {}) {
	const branch = `pr${n}`;
	git.branch(branch, opts.from ?? 'main');
	git.commit(branch, `pr${n}`, opts.file ?? `pr${n}.txt`);
	git.openPR(n, branch, opts.base ?? 'main');
	if (opts.approve !== false) world.approved.add(n);
	db.addToQueue(repo.id, n, `PR ${n}`, `https://example.test/pull/${n}`, 'dev', '', 'dev');
}

async function run(ticks = 30) {
	for (let i = 0; i < ticks; i++) await tickBatchQueue(world.deps());
}

const queued = () => db.getQueueItems(repo.id).map((i) => ({ pr: i.pr_number, status: i.status }));
const mainFiles = () => [...world.files('main')].filter((f) => f.startsWith('pr') || f.startsWith('x-')).sort();

describe('batch queue runtime', () => {
	test('tests approved PRs together once and lands them', async () => {
		pr(1);
		pr(2);
		pr(3);
		await run();
		expect(world.started).toHaveLength(1);
		expect(world.started[0].prs).toEqual([1, 2, 3]);
		expect(world.merged).toEqual([1, 2, 3]);
		expect(queued()).toEqual([]);
		expect(mainFiles()).toEqual(['pr1.txt', 'pr2.txt', 'pr3.txt']);
		// master's tree is the tested tree, and says so
		expect(world.statuses).toEqual([{ sha: git.sha('main'), state: 'success' }]);
		expect(git.git('rev-parse', 'main^{tree}')).toBe(git.git('rev-parse', `${world.started[0].head}^{tree}`));
	});

	test('holds unapproved PRs and PRs with red checks', async () => {
		store.updateQueueSettings(repo.id, { config: { requirePRChecks: true } });
		pr(1, { approve: false });
		pr(2);
		pr(3);
		world.ciRed.add(3);
		await run();
		expect(world.merged).toEqual([2]);
		expect(queued().map((q) => q.pr).sort()).toEqual([1, 3]);
	});

	test('a flake is re-run, not bisected', async () => {
		pr(1);
		pr(2);
		await tickBatchQueue(world.deps());
		world.flaky.add(world.started[0].head);
		await run();
		expect(world.reruns.get(world.started[0].head)).toBe(1);
		expect(world.started).toHaveLength(1);
		expect(world.merged).toEqual([1, 2]);
	});

	test('bisects a real break, ejects the breaker with a comment, lands the rest', async () => {
		pr(1);
		pr(2);
		pr(3, { file: 'x-breaks-master.txt' });
		pr(4);
		world.breakingFiles.add('x-breaks-master.txt');
		await run(60);
		expect(world.merged).toEqual([1, 2, 4]);
		expect(world.comments).toEqual([
			{ pr: 3, body: expect.stringMatching(/Removed from the merge queue: #3 fails on its own/) }
		]);
		expect(queued()).toEqual([]);
		expect(mainFiles()).toEqual(['pr1.txt', 'pr2.txt', 'pr4.txt']);
		expect(db.getRepoHistory(repo.id).find((h) => h.pr_number === 3)?.status).toBe('failed');
		// the batch, the failed-job re-run, then bisection runs and the survivors together
		// (bisection runs that fail are re-run once too, so a flake can't eject an innocent PR)
		expect(world.reruns.size).toBeGreaterThanOrEqual(1);
		expect(world.started.length).toBeGreaterThanOrEqual(4);
		// each passing group lands on its own bisection run as soon as it passes, not on a fresh batch
		expect(store.getRecentBatches(repo.id).filter((b) => b.kind === 'batch')).toHaveLength(1);
		expect(store.getRecentBatches(repo.id).find((b) => b.kind === 'batch')?.landed).toEqual([1, 2, 4]);
		expect(store.getRecentBatches(repo.id).find((b) => b.kind === 'batch')?.status).toBe('landed');
	});

	test('one bisection run at a time: a half that passes lands, and the next run is built on it', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2);
		pr(3);
		pr(4, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		await run(60);
		expect(world.merged).toEqual([1, 2, 3]);
		expect(world.comments).toEqual([{ pr: 4, body: expect.stringMatching(/#4 fails on its own on top of the default branch/) }]);
		// Never two at once, and nothing tested twice.
		const bisect = world.started.filter((x) => x.branch.includes('-bisect-')).map((x) => x.prs);
		expect(bisect).toEqual([[1, 2], [3], [4]]);
		expect(store.getRecentBatches(repo.id).find((b) => b.kind === 'batch')).toMatchObject({ landed: [1, 2, 3], ejected: [4] });
	});

	test('an urgent PR runs between two bisection steps, and the bisection then goes on from where it was', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2);
		pr(3);
		pr(4, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		for (let i = 0; i < 30 && !world.started.some((x) => x.branch.includes('-bisect-')); i++) await tickBatchQueue(world.deps());
		pr(5);
		store.setQueuePriority(repo.id, 5, 'urgent');
		await run(60);
		// #5 lands after the step that was running, before the next one; nothing is tested twice.
		expect(world.merged).toEqual([1, 2, 5, 3]);
		expect(world.started.map((x) => (x.branch.includes('-bisect-') ? 'step ' : 'batch ') + x.prs.join())).toEqual([
			'batch 1,2,3,4',
			'step 1,2',
			'batch 5',
			'step 3',
			'step 4'
		]);
		const batches = store.getRecentBatches(repo.id).filter((b) => b.kind === 'batch');
		expect(batches.find((b) => b.members.join() === '5')).toMatchObject({ status: 'landed', express: true });
		expect(batches.find((b) => b.members.length === 4)).toMatchObject({ status: 'landed', landed: [1, 2, 3], ejected: [4] });
	});

	test('an urgent batch that fails between two bisection steps is bisected first, and the first bisection then goes on', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2);
		pr(3);
		pr(4, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		for (let i = 0; i < 30 && !world.started.some((x) => x.branch.includes('-bisect-')); i++) await tickBatchQueue(world.deps());
		pr(5);
		pr(6, { file: 'y-breaks-master.txt' });
		world.breakingFiles.add('y-breaks-master.txt');
		store.setQueuePriority(repo.id, 5, 'urgent');
		store.setQueuePriority(repo.id, 6, 'urgent');
		await run(80);
		expect(world.merged).toEqual([1, 2, 5, 3]);
		expect(world.started.map((x) => (x.branch.includes('-bisect-') ? 'step ' : 'batch ') + x.prs.join())).toEqual([
			'batch 1,2,3,4',
			'step 1,2',
			'batch 5,6',
			'step 5',
			'step 6',
			'step 3',
			'step 4'
		]);
		expect(world.comments.map((c) => c.pr).sort()).toEqual([4, 6]);
	});

	test('a bisection lands the half that passes at once, while the other half is still running', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false, bisectRuns: 2 } });
		pr(1);
		pr(2);
		pr(3);
		pr(4, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		// The right half's runs take long.
		world.hold = (prs) => prs.includes(3) && !prs.includes(1);
		await run(30);
		expect(world.merged).toEqual([1, 2]);
		expect(store.getRecentBatches(repo.id).find((b) => b.kind === 'batch')).toMatchObject({ status: 'bisecting', landed: [1, 2] });
		world.hold = () => false;
		await run(30);
		expect(world.merged).toEqual([1, 2, 3]);
		expect(world.comments).toEqual([{ pr: 4, body: expect.stringMatching(/#4 fails on its own on top of the default branch \(batch \d+, which landed #1, #2, #3\)/) }]);
		// The right half failed on the old branch, so it was split on the new one straight away.
		const bisect = world.started.filter((x) => x.branch.includes('-bisect-')).map((x) => x.prs);
		expect(bisect).toEqual([[1, 2], [3, 4], [3], [4]]);
		expect(store.getRecentBatches(repo.id).find((b) => b.kind === 'batch')?.status).toBe('landed');
	});

	test('a PR pushed to while its half is tested leaves the bisection and is tested again as it is now', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2);
		pr(3);
		pr(4, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		world.hold = (prs) => prs.includes(1);
		for (let i = 0; i < 30 && !world.started.some((x) => x.prs.join() === '1,2'); i++) await tickBatchQueue(world.deps());
		git.commit('pr1', 'late change', 'pr1-late.txt');
		world.hold = () => false;
		await run(60);
		// #1 changed since it was batched: it goes back in line at once, the bisection goes on without
		// it (it doesn't take it back), and it lands later from a batch of its own; #2 lands from the bisection.
		expect([...world.merged].sort()).toEqual([1, 2, 3]);
		expect(world.files('main').has('pr1-late.txt')).toBe(true);
		expect(world.comments.map((c) => c.pr)).toEqual([4]);
		expect(queued()).toEqual([]);
		const first = store.getRecentBatches(repo.id).filter((b) => b.kind === 'batch').at(-1)!;
		expect(first).toMatchObject({ status: 'landed', landed: [2, 3], left_prs: [1, 4] });
	});

	test('a PR stacked on one that leaves the bisection leaves with it, and never lands its parent as batched', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' }); // stacked on #1
		pr(3);
		pr(4, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		world.hold = (prs) => prs.includes(1);
		for (let i = 0; i < 30 && !world.started.some((x) => x.prs.join() === '1,2'); i++) await tickBatchQueue(world.deps());
		git.commit('pr1', 'late change', 'pr1-late.txt');
		world.hold = () => false;
		await run(60);
		const first = store.getRecentBatches(repo.id).filter((b) => b.kind === 'batch').at(-1)!;
		expect(first).toMatchObject({ landed: [3], left_prs: expect.arrayContaining([1, 2, 4]) });
		// #1 landed with its late change before #2, which came after it from a batch of their own
		expect(world.merged.indexOf(1)).toBeLessThan(world.merged.indexOf(2));
		expect(world.files('main').has('pr1-late.txt')).toBe(true);
	});

	test('a batch that failed by flake ejects nobody: its halves pass and land', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false, bisectRuns: 2 } });
		pr(1);
		pr(2);
		pr(3);
		pr(4);
		await tickBatchQueue(world.deps());
		world.flaky.add(world.started[0].head);
		await run(40);
		expect(world.merged).toEqual([1, 2, 3, 4]);
		expect(world.comments).toEqual([]);
		// The halves passed side by side; the second ran again on top of the first to land.
		expect(world.started.map((x) => x.prs)).toEqual([[1, 2, 3, 4], [1, 2], [3, 4], [3, 4]]);
	});

	test('a batch that failed by flake, one run at a time: each run passes and lands, none is repeated', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2);
		pr(3);
		pr(4);
		await tickBatchQueue(world.deps());
		world.flaky.add(world.started[0].head);
		await run(40);
		expect(world.merged).toEqual([1, 2, 3, 4]);
		expect(world.comments).toEqual([]);
		expect(world.started.map((x) => x.prs)).toEqual([[1, 2, 3, 4], [1, 2], [3], [4]]);
	});

	test('a bisection follows the default branch when it moves outside the queue', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		world.hold = (prs) => prs.length === 1;
		for (let i = 0; i < 30 && !world.started.some((x) => x.branch.includes('-bisect-')); i++) await tickBatchQueue(world.deps());
		git.commit('main', 'hotfix pushed by hand', 'hotfix.txt');
		world.hold = () => false;
		await run(40);
		// Not rebuilt from scratch: the halves that ran on the old branch still count, #1 runs again on the new one.
		expect(store.getRecentBatches(repo.id).filter((b) => b.kind === 'batch')).toHaveLength(1);
		expect(world.merged).toEqual([1]);
		expect(world.comments).toEqual([{ pr: 2, body: expect.stringMatching(/#2 fails on its own/) }]);
		expect(world.files('main').has('hotfix.txt')).toBe(true);
	});

	test('a bisection group that no longer applies on the moved default branch goes back in line and stops no CI', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		world.hold = (prs) => prs.length === 1;
		for (let i = 0; i < 30 && !world.started.some((x) => x.branch.includes('-bisect-')); i++) await tickBatchQueue(world.deps());
		// someone lands a change to #1's file by hand: #1 no longer applies on the default branch
		git.commit('main', 'clashes with pr1', 'pr1.txt');
		const moved = git.sha('main');
		world.hold = () => false;
		await run(40);
		expect(world.cancelled).not.toContain(moved);
		expect(world.merged).toEqual([]);
		expect(queued()).toEqual([{ pr: 1, status: 'conflict' }]);
		// No run stands for the group that didn't build: one carrying the default branch's head would
		// read that branch's CI as its own result, and stopping it would stop the default branch's CI.
		const batch = store.getRecentBatches(repo.id).find((b) => b.kind === 'batch')!;
		expect(store.getBisectRuns(batch.id).map((r) => r.head_sha)).not.toContain(moved);
	});

	test('each status on a PR links to the run behind it, and says when its batch is bisected', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		await run(60);
		const of = (ref: string) => world.prStatuses.filter((x) => x.sha === git.sha(ref) && x.context === 'merge-queue');
		const branch = world.started[0].branch;
		expect(of('pr2').map((x) => [x.state, x.description.split(';')[0].split(':')[0], x.url])).toEqual([
			['pending', `Testing in ${branch} with 1 other PR(s)`, `https://github.com/${repo.owner}/${repo.name}/actions?query=${encodeURIComponent(`branch:${branch}`)}`],
			['pending', `${branch} failed`, `https://ci.example/${world.started[0].head}`],
			['pending', `Batch ${store.getRecentBatches(repo.id).find((b) => b.kind === 'batch')!.number} failed`, `https://github.com/${repo.owner}/${repo.name}/actions?query=${encodeURIComponent(`branch:${world.started[2].branch}`)}`],
			['failure', 'Left the queue', `https://ci.example/${world.started[2].head}`]
		]);
		expect(of('pr1').at(-1)).toMatchObject({ state: 'success', url: expect.stringMatching(/^https:\/\/ci\.example\//) });
		expect(world.comments).toEqual([{ pr: 2, body: expect.stringMatching(/\n\nCI run: https:\/\/ci\.example\//) }]);
	});

	test('finds two PRs that only break together and ejects the later one', async () => {
		pr(1, { file: 'x-adds-field.txt' });
		pr(2);
		pr(3, { file: 'x-uses-old-initializer.txt' });
		world.conflictPairs.push(['x-adds-field.txt', 'x-uses-old-initializer.txt']);
		await run(60);
		expect(world.merged).toEqual([1, 2]);
		expect(world.comments[0]).toMatchObject({ pr: 3, body: expect.stringMatching(/#3 fails on its own on top of the default branch \(batch \d+, which landed #1, #2\)/) });
	});

	test('a PR that conflicts with one ahead of it waits for it, then gets a conflict notice', async () => {
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		pr(3);
		await run();
		// no CI was spent on #2: it was set aside at build time
		expect(world.started.map((s) => s.prs)).toEqual([[1, 3]]);
		expect(world.merged).toEqual([1, 3]);
		// once #1 is on master, #2 conflicts with master itself: its author is told, and it stays queued
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		expect(world.comments).toEqual([{ pr: 2, body: expect.stringMatching(/can't apply this PR[\s\S]*same.txt[\s\S]*git rebase origin\/main/) }]);
		expect(world.labels.get(2)).toEqual(new Set(['needs-rebase']));
		expect(world.prStatuses.filter((x) => x.sha === git.sha('pr2')).at(-1)).toMatchObject({ state: 'failure', description: expect.stringMatching(/^Conflict/) });

		// the author rebases and resolves: the PR is picked up again and lands
		git.git('checkout', '-q', 'pr2');
		git.git('reset', '-q', '--hard', 'main');
		git.commit('pr2', 'pr2 resolved', 'pr2.txt');
		await run();
		expect(world.merged).toEqual([1, 3, 2]);
		expect(world.labels.get(2)).toEqual(new Set());
	});

	test('lands a stack parent-first and retargets the child', async () => {
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' }); // stacked on #1
		pr(5);
		await run();
		expect(world.started[0].prs).toEqual([1, 2, 5]);
		expect(world.merged).toEqual([1, 2, 5]);
		expect(git.pr(2).baseRef).toBe('main');
		expect(mainFiles()).toEqual(['pr1.txt', 'pr2.txt', 'pr5.txt']);
	});

	test('a stacked child that edits its parent\'s lines is restacked onto master to land as tested', async () => {
		pr(1, { file: 'shared.txt' });
		git.branch('pr2', 'pr1');
		git.git('checkout', '-q', 'pr2');
		writeFileSync(`${git.dir}/shared.txt`, 'child rewrote it\n');
		git.git('commit', '-qam', 'pr2');
		git.openPR(2, 'pr2', 'pr1');
		world.approved.add(2);
		db.addToQueue(repo.id, 2, 'PR 2', 'u', 'dev', '', 'dev');
		await run();
		expect(world.merged).toEqual([1, 2]);
		expect(store.getQueueSettings(repo.id).pausedReason).toBeNull();
		expect(git.git('show', 'main:shared.txt')).toBe('child rewrote it');
		expect(git.git('rev-parse', 'main^{tree}')).toBe(git.git('rev-parse', `${world.started[0].head}^{tree}`));
		expect(world.pushedHeads.map((h) => h.branch)).toEqual(['pr2']);
	});

	test('a stacked child whose parent moved on is tested with the parent\'s new commits', async () => {
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' });
		git.commit('pr1', 'p2', 'pr1-more.txt'); // the parent gets a commit the child doesn't have
		await run();
		expect(world.files(world.started[0].head).has('pr1-more.txt')).toBe(true);
		expect(world.merged).toEqual([1, 2]);
		expect(mainFiles()).toEqual(['pr1-more.txt', 'pr1.txt', 'pr2.txt']);
		expect(store.getQueueSettings(repo.id).pausedReason).toBeNull();
	});

	test('a PR into another branch is never batched or retargeted', async () => {
		git.branch('release', 'main');
		git.commit('release', 'rel-only', 'release-only.txt');
		pr(1, { from: 'release', base: 'release' });
		await run();
		expect(world.started).toEqual([]);
		expect(git.pr(1).baseRef).toBe('release');
		expect(db.getQueueItems(repo.id)[0].error_message).toMatch(/does not target the default branch/);
	});

	test('a PR dequeued while its batch is being built does not land', async () => {
		pr(1);
		const d = world.deps();
		const build = d.git.build;
		d.git.build = async (b, m) => {
			const it = db.getQueueItems(repo.id).find((i) => i.pr_number === 1);
			if (it) db.removeFromQueue(it.id);
			return build(b, m);
		};
		await tickBatchQueue(d);
		await run();
		expect(world.merged).toEqual([]);
	});

	test('changes requested while the batch tests keep the PR from landing', async () => {
		pr(1);
		pr(2);
		await tickBatchQueue(world.deps());
		world.changesRequested.add(2);
		await run();
		expect(world.merged).toEqual([1]);
		expect(db.getQueueItems(repo.id).map((i) => [i.pr_number, i.error_message])).toEqual([[2, '#2 has changes requested']]);
		// The dashboard shows it as needing someone, not as waiting for its turn.
		expect(store.currentHold(db.getQueueItems(repo.id)[0])).toEqual({ code: 'changes-requested', wait: false, reason: '#2 has changes requested' });
	});

	test('marks the PR head as tested right before merging it', async () => {
		pr(1);
		const head = git.sha('pr1');
		await run();
		expect(world.prStatuses.filter((x) => x.sha === head).map((x) => x.state)).toEqual(['pending', 'success']);
	});

	test('without PR checks required, a PR with red own checks is still batched', async () => {
		store.updateQueueSettings(repo.id, { config: { requirePRChecks: false } });
		pr(1);
		world.ciRed.add(1);
		await run();
		expect(world.merged).toEqual([1]);
	});

	test('restacks a queued child whose parent was rebased, and carries its approval over', async () => {
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' });
		git.commit('main', 'm1', 'x-main.txt');
		git.rebase('pr1', 'main'); // the parent is rebased: the child still has its old commits
		world.approved.delete(2); // approval on the old head only...
		const oldHead = git.sha('pr2');
		world.approvedOn.set(2, oldHead);
		await run();
		expect(world.pushedHeads[0]).toMatchObject({ branch: 'pr2' });
		expect(world.comments.find((c) => c.pr === 2)?.body).toMatch(/restacked this PR onto #1/);
		// the restacked head sits on the parent's rebased head (throws if not)
		git.git('merge-base', '--is-ancestor', 'pr1', world.pushedHeads[0].sha);
		expect(world.merged).toEqual([1, 2]);
		expect(mainFiles()).toEqual(['pr1.txt', 'pr2.txt', 'x-main.txt']);
	});

	test('a failing stack parent takes its child out of the queue too', async () => {
		pr(1, { file: 'x-breaks-master.txt' });
		pr(2, { from: 'pr1', base: 'pr1' });
		pr(3);
		world.breakingFiles.add('x-breaks-master.txt');
		await run(60);
		expect(world.merged).toEqual([3]);
		expect(world.comments.map((c) => c.pr).sort()).toEqual([1, 2]);
		expect(world.comments.find((c) => c.pr === 2)?.body).toMatch(/Stacked on #1, which failed/);
		// The batch records both as ejected, the child too, not as back in line.
		expect(store.getRecentBatches(repo.id).find((b) => b.kind === 'batch')).toMatchObject({ ejected: expect.arrayContaining([1, 2]) });
	});

	test('pipelines a second batch on top of the first', async () => {
		store.updateQueueSettings(repo.id, { config: { depth: 2, maxBatch: 2 } });
		pr(1);
		pr(2);
		pr(3);
		pr(4);
		await tickBatchQueue(world.deps());
		expect(world.started.map((s) => s.prs)).toEqual([
			[1, 2],
			[3, 4]
		]);
		// the second batch's commit contains the first batch
		expect(git.git('merge-base', '--is-ancestor', world.started[0].head, world.started[1].head)).toBe('');
		await run();
		expect(world.merged).toEqual([1, 2, 3, 4]);
		expect(world.started).toHaveLength(2);
	});

	test('a failed head batch makes the batch behind it rebuild without the culprit', async () => {
		store.updateQueueSettings(repo.id, { config: { depth: 2, maxBatch: 2 } });
		pr(1, { file: 'x-breaks-master.txt' });
		pr(2);
		pr(3);
		pr(4);
		world.breakingFiles.add('x-breaks-master.txt');
		await run(80);
		expect(world.merged.sort()).toEqual([2, 3, 4]);
		const second = store.getRecentBatches(repo.id).find((b) => b.members.join() === '3,4' && b.status === 'superseded');
		expect(second).toBeDefined();
		expect(mainFiles()).toEqual(['pr2.txt', 'pr3.txt', 'pr4.txt']);
	});

	test('urgent PRs jump the queue in an express batch', async () => {
		store.updateQueueSettings(repo.id, { config: { collectWindowMs: 60 * 60 * 1000 } });
		pr(1);
		pr(2);
		pr(3);
		store.setQueuePriority(repo.id, 3, 'urgent');
		await tickBatchQueue(world.deps());
		expect(world.started.map((s) => s.prs)).toEqual([[3]]);
		expect(store.getActiveBatches(repo.id)[0].express).toBe(true);
	});

	test('master moving outside the queue rebuilds the pipeline on the new master', async () => {
		pr(1);
		pr(2);
		await tickBatchQueue(world.deps());
		git.commit('main', 'hotfix pushed by hand');
		await run();
		// the batch, a check of the new master alone (it came from outside the queue), the rebuilt batch
		expect(world.started.map((x) => x.prs)).toEqual([[1, 2], [], [1, 2]]);
		expect(store.getRecentBatches(repo.id).filter((b) => b.kind === 'batch').map((b) => b.status).sort()).toEqual(['landed', 'superseded']);
		expect(world.merged).toEqual([1, 2]);
	});

	test('a PR pushed to after its batch was built is rebuilt, not landed stale; the rest of the batch lands', async () => {
		pr(1);
		pr(2);
		await tickBatchQueue(world.deps());
		git.commit('pr2', 'late change');
		await run();
		// #1 lands from the batch; master (#1 alone, never tested so) is checked; #2 is tested as it is now.
		expect(world.started.map((x) => (x.branch.includes('/base-') ? 'master' : x.prs.join()))).toEqual(['1,2', 'master', '2']);
		expect(world.merged).toEqual([1, 2]);
		expect(world.files('main').has('late-change.txt')).toBe(true);
	});

	test('a PR pushed to while its batch lands: the rest still lands, it is rebuilt, master is checked, no pause', async () => {
		pr(1);
		pr(2);
		pr(3);
		await tickBatchQueue(world.deps());
		// #3 is pushed to just as #1 merges: #2 still lands, #3 is retested as it is now.
		world.beforeMerge = (n) => {
			if (n === 1) git.commit('pr3', 'late change');
			world.beforeMerge = () => {};
		};
		await run();
		expect(store.getQueueSettings(repo.id).pausedReason).toBeNull();
		expect(world.merged).toEqual([1, 2, 3]);
		expect(world.files('main').has('late-change.txt')).toBe(true);
		// The batch, a check of master alone (it holds #1 #2 without #3, never tested), and #3 again.
		expect(world.started.map((x) => (x.branch.includes('/base-') ? 'master' : x.prs.join()))).toEqual(['1,2,3', 'master', '3']);
	});

	test('a batch has no order: a change to its first PR still lands all the others', async () => {
		pr(1);
		pr(2);
		pr(3);
		await tickBatchQueue(world.deps());
		git.commit('pr1', 'late change');
		await run();
		expect(store.getQueueSettings(repo.id).pausedReason).toBeNull();
		expect(world.merged).toEqual([2, 3, 1]);
		// The batch, master alone (#2 #3 without #1, never tested so), then #1 as it is now.
		expect(world.started.map((x) => (x.branch.includes('/base-') ? 'master' : x.prs.join()))).toEqual(['1,2,3', 'master', '1']);
	});

	test('a PR stacked on one that changed goes back in line with it; the rest lands', async () => {
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' });
		pr(3);
		await tickBatchQueue(world.deps());
		git.commit('pr1', 'late change');
		await run();
		expect(store.getQueueSettings(repo.id).pausedReason).toBeNull();
		expect(world.merged.slice(0, 1)).toEqual([3]);
		expect(world.merged.slice(1).sort()).toEqual([1, 2]);
		expect(world.started.map((x) => (x.branch.includes('/base-') ? 'master' : x.prs.join()))[1]).toBe('master');
	});

	test('a PR pushed to between the check and its merge is not a pause either', async () => {
		pr(1);
		pr(2);
		await tickBatchQueue(world.deps());
		// Pushed after the queue read #2's head, before GitHub merges it: the merge is refused.
		world.beforeMerge = (n) => {
			if (n === 2) {
				git.commit('pr2', 'late change');
				world.beforeMerge = () => {};
			}
		};
		await run();
		expect(store.getQueueSettings(repo.id).pausedReason).toBeNull();
		expect(world.merged).toEqual([1, 2]);
		expect(world.files('main').has('late-change.txt')).toBe(true);
	});

	test('batches are numbered per repository, apart from bisection steps and master checks', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		await run();
		pr(3);
		await run();
		const batches = store.getRecentBatches(repo.id).filter((b) => b.kind === 'batch').sort((a, b) => a.id - b.id);
		// The first one bisected, and its steps took ids of their own, but not numbers.
		expect(store.getBisectRuns(batches[0].id).length).toBeGreaterThan(0);
		expect(batches.map((b) => b.number)).toEqual(batches.map((_, i) => i + 1));
		expect(batches.at(-1)!.id).toBeGreaterThan(batches.length);
	});

	test('a paused queue does nothing', async () => {
		store.updateQueueSettings(repo.id, { pausedReason: 'release freeze' });
		pr(1);
		await run(3);
		expect(world.started).toEqual([]);
	});

	test('starts a master CI run after each landed batch', async () => {
		store.updateQueueSettings(repo.id, { config: { maxBatch: 1 } });
		pr(1);
		pr(2);
		await run();
		expect(world.merged).toEqual([1, 2]);
		expect(world.cacheRefreshes).toBe(2);
	});

	test('no master runs when masterRun is off', async () => {
		store.updateQueueSettings(repo.id, { config: { masterRun: false } });
		pr(1);
		await run();
		expect(world.merged).toEqual([1]);
		expect(world.cacheRefreshes).toBe(0);
	});

	test('a deferred PR is not held forever by a PR ahead that is itself held back', async () => {
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		await tickBatchQueue(world.deps());
		expect(world.started.map((x) => x.prs)).toEqual([[1]]);
		// #1's batch is dropped (master moved) and #1 loses its approval: #2 must go on without it
		git.commit('main', 'hotfix pushed by hand');
		world.approved.delete(1);
		await run();
		expect(world.merged).toEqual([2]);
	});

	test('a deferred PR says only what it still waits for, not PRs that landed since', async () => {
		pr(1, { file: 'same.txt' });
		pr(2);
		pr(3, { file: 'same.txt' });
		const item = (n: number) => db.getQueueItems(repo.id).find((i) => i.pr_number === n)!;
		// As if #3 had been deferred behind #1 and #2 when they were in a batch ahead of it.
		store.setDeferredFor(item(3).id, [1, 2]);
		db.updateQueueItemStatus(item(3).id, 'queued', 'Conflicts with #1 #2 ahead of it; waits for them to land');
		db.removeFromQueue(item(2).id); // #2 has landed since
		await tickBatchQueue(world.deps());
		expect(item(3).error_message).toBe('Conflicts with #1 ahead of it; waits for them to land');
	});

	test('a PR whose changes are already on the default branch leaves the queue instead of an empty batch', async () => {
		git.branch('pr1', 'main');
		git.commit('pr1', 'pr1', 'pr1.txt');
		git.openPR(1, 'pr1', 'main');
		world.approved.add(1);
		git.git('checkout', '-q', 'main');
		git.git('cherry-pick', 'pr1');
		store.setMasterHealth(repo.id, { sha: git.sha('main'), tree: git.git('rev-parse', 'main^{tree}'), state: 'green', since: 0 });
		db.addToQueue(repo.id, 1, 'PR 1', 'u', 'dev', '', 'dev');
		await run(3);
		expect(world.started).toEqual([]);
		expect(db.getQueueItems(repo.id)).toEqual([]);
		expect(world.comments).toEqual([{ pr: 1, body: expect.stringMatching(/no changes left against main/) }]);
	});

	test('a fork PR stacked on another PR is not admitted', async () => {
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' });
		world.forks.add(2);
		await run();
		expect(world.merged).toEqual([1]);
		expect(db.getQueueItems(repo.id).find((i) => i.pr_number === 2)?.error_message).toMatch(/stacked on another PR from a fork/);
	});

	test('a PR left updating by serial mode goes back in line in batch mode', async () => {
		pr(1);
		db.updateQueueItemStatus(db.getQueueItems(repo.id)[0].id, 'merging');
		await run();
		expect(world.merged).toEqual([1]);
	});

	test('with retryFailed off a failure is never re-run: a lone PR leaves at once', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		await run();
		expect(world.reruns.size).toBe(0);
		expect(world.comments).toEqual([{ pr: 1, body: expect.stringMatching(/Removed from the merge queue/) }]);
	});

	test('a failed check whose workflow still runs other jobs is re-run once it finishes, not bisected', async () => {
		pr(1);
		pr(2);
		await tickBatchQueue(world.deps());
		world.flaky.add(world.started[0].head);
		world.rerunWaits = 2;
		await run();
		expect(world.reruns.get(world.started[0].head)).toBe(1);
		expect(world.started).toHaveLength(1);
		expect(world.merged).toEqual([1, 2]);
	});

	test('a broken default branch holds the queue and ejects nobody, then resumes once fixed', async () => {
		pr(1);
		pr(2);
		// someone pushes a broken commit to main outside the queue
		git.commit('main', 'broken by hand', 'x-breaks-master.txt');
		world.breakingFiles.add('x-breaks-master.txt');
		await run();
		// a check of main alone, beside the batch built on it; then, main being red, each PR once
		// more alone (none fixes it), and nothing else
		expect(world.started.map((x) => x.prs)).toEqual([[], [1, 2], [1], [2]]);
		expect(store.getMasterHealth(repo.id)?.state).toBe('red');
		expect(world.comments).toEqual([]);
		expect(queued()).toEqual([
			{ pr: 1, status: 'queued' },
			{ pr: 2, status: 'queued' }
		]);
		// fixed on main: a new check passes and the PRs land
		git.git('checkout', '-q', 'main');
		git.git('rm', '-q', 'x-breaks-master.txt');
		git.git('commit', '-qm', 'fix main');
		await run();
		expect(world.started.map((x) => x.prs).slice(4)).toEqual([[], [1, 2]]);
		expect(world.merged).toEqual([1, 2]);
	});

	/** A PR that deletes main's breaking file (main must already have it). */
	function fixPR(n: number) {
		git.branch(`pr${n}`, 'main');
		git.git('checkout', '-q', `pr${n}`);
		git.git('rm', '-q', 'x-breaks-master.txt');
		git.git('commit', '-qm', `fix ${n}`);
		git.openPR(n, `pr${n}`, 'main');
		world.approved.add(n);
		db.addToQueue(repo.id, n, `PR ${n}`, `https://example.test/pull/${n}`, 'dev', '', 'dev');
	}

	test('a batch with the fix in it passes together on a broken default branch and lands whole', async () => {
		git.commit('main', 'broken by hand', 'x-breaks-master.txt');
		world.breakingFiles.add('x-breaks-master.txt');
		pr(1);
		fixPR(2);
		pr(3);
		await run();
		expect(world.merged).toEqual([1, 2, 3]);
		expect(world.comments).toEqual([]);
		expect(store.getMasterHealth(repo.id)?.state).not.toBe('red');
	});

	test('on a known-red default branch, batches run side by side until the one with the fix lands', async () => {
		store.updateQueueSettings(repo.id, { config: { maxBatch: 2, depth: 2 } });
		git.commit('main', 'broken by hand', 'x-breaks-master.txt');
		world.breakingFiles.add('x-breaks-master.txt');
		store.setMasterHealth(repo.id, { sha: git.sha('main'), tree: git.git('rev-parse', 'main^{tree}'), state: 'red', since: 0 });
		pr(1);
		pr(2);
		fixPR(3);
		pr(4);
		await run();
		// both on red main at once; [3, 4] carries the fix and lands, then [1, 2] on the fixed main
		expect(world.started.map((x) => x.prs)).toEqual([[1, 2], [3, 4], [1, 2]]);
		expect(world.merged).toEqual([3, 4, 1, 2]);
		expect(world.comments).toEqual([]);
	});

	/** main broken by hand, and known red. */
	function redMain() {
		git.commit('main', 'broken by hand', 'x-breaks-master.txt');
		world.breakingFiles.add('x-breaks-master.txt');
		store.setMasterHealth(repo.id, { sha: git.sha('main'), tree: git.git('rev-parse', 'main^{tree}'), state: 'red', since: 0 });
	}

	test('on a red default branch every PR is tried a bounded number of times, urgent ones too', async () => {
		redMain();
		pr(1);
		pr(2);
		store.setQueuePriority(repo.id, 1, 'urgent');
		store.setQueuePriority(repo.id, 2, 'urgent');
		await run(40);
		// urgent ones go alone: one try each
		expect(world.started.map((x) => x.prs)).toEqual([[1], [2]]);
		expect(world.comments).toEqual([]);
	});

	test('a PR held back on a red default branch does not stop the others from being tried alone', async () => {
		redMain();
		pr(1);
		pr(2);
		pr(3, { approve: false });
		await run(40);
		expect(world.started.map((x) => x.prs)).toEqual([[1, 2], [1], [2]]);
	});

	test('on a red default branch a stacked child is tried with its parent, never without it', async () => {
		store.updateQueueSettings(repo.id, { config: { maxBatch: 2 } });
		redMain();
		pr(1);
		pr(2);
		pr(3, { from: 'pr2', base: 'pr2' });
		await run(40);
		// in batches, then each stack on its own: #3 only ever with #2 under it ([2, 3] was its go alone)
		expect(world.started.map((x) => x.prs)).toEqual([[1, 2], [2, 3], [1], [2]]);
	});

	/** A PR stacked on `from` that deletes main's breaking file. */
	function stackedFix(n: number, from: string) {
		git.branch(`pr${n}`, from);
		git.git('checkout', '-q', `pr${n}`);
		git.git('rm', '-q', 'x-breaks-master.txt');
		git.git('commit', '-qm', `fix ${n}`);
		git.openPR(n, `pr${n}`, from);
		world.approved.add(n);
		db.addToQueue(repo.id, n, `PR ${n}`, `https://example.test/pull/${n}`, 'dev', '', 'dev');
	}

	test('on a red default branch a fix stacked on an urgent, already tried parent still lands', async () => {
		redMain();
		pr(1);
		store.setQueuePriority(repo.id, 1, 'urgent');
		await run(5);
		expect(world.started.map((x) => x.prs)).toEqual([[1]]);
		stackedFix(2, 'pr1');
		await run();
		expect(world.merged).toEqual([1, 2]);
	});

	test('on a red default branch a fixing parent is tried without its breaking child', async () => {
		redMain();
		fixPR(1);
		pr(2, { from: 'pr1', base: 'pr1', file: 'y-breaks.txt' });
		world.breakingFiles.add('y-breaks.txt');
		store.setQueuePriority(repo.id, 2, 'urgent');
		await run();
		expect(world.merged[0]).toBe(1);
		expect(store.getMasterHealth(repo.id)?.state).not.toBe('red');
	});

	test('on a red default branch a fix deep in a stack is reached', async () => {
		store.updateQueueSettings(repo.id, { config: { maxBatch: 2 } });
		redMain();
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' });
		await run(10);
		stackedFix(3, 'pr2');
		await run();
		expect(world.merged).toEqual([1, 2, 3]);
	});

	test('an urgent fix is tried first, alone, on a red default branch', async () => {
		store.updateQueueSettings(repo.id, { config: { maxBatch: 8, depth: 1 } });
		git.commit('main', 'broken by hand', 'x-breaks-master.txt');
		world.breakingFiles.add('x-breaks-master.txt');
		store.setMasterHealth(repo.id, { sha: git.sha('main'), tree: git.git('rev-parse', 'main^{tree}'), state: 'red', since: 0 });
		pr(1);
		pr(2);
		fixPR(3);
		store.setQueuePriority(repo.id, 3, 'urgent');
		await run();
		expect(world.started[0].prs).toEqual([3]);
		expect(world.merged).toEqual([3, 1, 2]);
	});

	test('a default-branch run failing after a landing stops the batch on top of it without blaming it', async () => {
		store.updateQueueSettings(repo.id, { config: { maxBatch: 1, depth: 2 } });
		pr(1);
		pr(2);
		await tickBatchQueue(world.deps()); // batches #1 and #2 (on top of #1)
		for (let i = 0; i < 5 && world.merged.length === 0; i++) await tickBatchQueue(world.deps());
		// #1 landed; the default-branch run started
		expect(world.merged).toEqual([1]);
		expect(store.getMasterHealth(repo.id)?.state).toBe('verifying');
		// the environment broke: everything fails from now on, main included
		world.everythingFails = true;
		await run(10);
		expect(store.getMasterHealth(repo.id)?.state).toBe('red');
		expect(world.comments).toEqual([]);
		expect(queued()).toEqual([{ pr: 2, status: 'queued' }]);
		expect(world.cancelled).toContain(world.started[1].head);
	});

	test('a batch failing on a default branch still being verified bisects at once, and blames only once it is green', async () => {
		store.updateQueueSettings(repo.id, { config: { maxBatch: 1, retryFailed: false } });
		pr(1);
		for (let i = 0; i < 10 && world.merged.length === 0; i++) await tickBatchQueue(world.deps());
		const master = store.getMasterHealth(repo.id)!;
		expect(master.state).toBe('verifying');
		world.holdMasterRuns = true; // the default-branch runs after landings take a while
		store.updateQueueSettings(repo.id, { config: { maxBatch: 8, retryFailed: false } });
		pr(2);
		pr(3, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		await run(30);
		// bisection ran while the default branch was being verified: #2 passed and landed, but nobody was blamed yet
		expect(store.getRecentBatches(repo.id).find((b) => b.members.join() === '2,3')?.status).toBe('bisecting');
		expect(world.started.some((s) => s.branch.includes('-bisect-'))).toBe(true);
		expect(world.merged).toEqual([1, 2]);
		expect(world.comments).toEqual([]);
		world.holdMasterRuns = false;
		await run(30);
		expect(world.merged).toEqual([1, 2]);
		expect(world.comments).toEqual([{ pr: 3, body: expect.stringMatching(/Removed from the merge queue: #3 fails on its own/) }]);
	});

	test('a refused merge takes the tested status back, so nobody can merge around the queue', async () => {
		pr(1);
		world.refuseMerge.add(1);
		await run();
		const head = git.sha('pr1');
		const last = world.prStatuses.filter((s) => s.sha === head).at(-1);
		expect(last?.state).toBe('pending');
		expect(store.getQueueSettings(repo.id).pausedReason).toMatch(/stopped at #1: Repository rule violations found/);
		expect(world.merged).toEqual([]);
	});

	test('a landing that stops part way does not trust what it merged: master is checked alone before anyone is blamed on it', async () => {
		pr(1);
		pr(2);
		world.refuseMerge.add(2);
		await run();
		expect(world.merged).toEqual([1]);
		expect(store.getQueueSettings(repo.id).pausedReason).toMatch(/stopped at #2/);
		// Master holds #1 without #2: no run tested that tree, so it is not marked green.
		const h = store.getMasterHealth(repo.id);
		expect(h?.sha === git.sha('main') && h.state === 'green').toBe(false);
		world.refuseMerge.delete(2);
		store.updateQueueSettings(repo.id, { pausedReason: null });
		const before = world.started.length;
		await run();
		expect(world.merged).toEqual([1, 2]);
		// a check of the default branch alone, and #2 on top of it
		expect(world.started.slice(before).map((x) => (x.branch.includes('/base-') ? 'master' : x.prs.join()))).toEqual(['master', '2']);
	});

	test('an interrupted landing that merged only part of its PRs does not mark master green', async () => {
		pr(1);
		pr(2);
		world.refuseMerge.add(2);
		await run();
		const b = store.getRecentBatches(repo.id).find((x) => x.kind === 'batch')!;
		expect(world.merged).toEqual([1]);
		// As if the app stopped after merging #1 of [1, 2], before it recorded anything.
		store.setMasterHealth(repo.id, { sha: 'old', tree: 'old-tree', state: 'green', since: 0 });
		store.setLandingIntent(repo.id, { batchId: b.id, srcId: b.id, prs: [1, 2], group: [1, 2] });
		await recoverInterrupted(world.deps());
		expect(store.getLandingIntent(repo.id)).toBeNull();
		expect(store.getMasterHealth(repo.id)).toMatchObject({ sha: 'old', tree: 'old-tree' });
	});

	test('an interrupted landing that left PRs out does not mark master green, even when all it set out to merge merged', async () => {
		pr(1);
		pr(2);
		pr(3);
		await tickBatchQueue(world.deps());
		git.commit('pr3', 'late change');
		// #3 is left out; later its own merge is refused, so only #1 #2 ever land.
		world.refuseMerge.add(3);
		const b = store.getRecentBatches(repo.id).find((x) => x.kind === 'batch')!;
		await run();
		expect(world.merged).toEqual([1, 2]);
		// As if the app stopped right after merging #1 #2 of the group [1, 2, 3], before recording it.
		store.setMasterHealth(repo.id, { sha: 'old', tree: 'old-tree', state: 'green', since: 0 });
		store.setLandingIntent(repo.id, { batchId: b.id, srcId: b.id, prs: [1, 2], group: [1, 2, 3] });
		await recoverInterrupted(world.deps());
		expect(store.getMasterHealth(repo.id)).toMatchObject({ sha: 'old', tree: 'old-tree' });
	});

	test('with a PR left out, a PR that GitHub then refuses goes back in line too, no pause', async () => {
		pr(1);
		pr(2);
		pr(3);
		await tickBatchQueue(world.deps());
		git.commit('pr1', 'late change');
		world.refuseMerge.add(3);
		await run(2);
		expect(store.getQueueSettings(repo.id).pausedReason).toBeNull();
		expect(world.merged).toEqual([2]);
		world.refuseMerge.delete(3);
		await run();
		expect(world.merged.slice(1).sort()).toEqual([1, 3]);
	});

	test('an interrupted landing of a PR that was deleted meanwhile is settled, not retried forever', async () => {
		pr(1);
		await tickBatchQueue(world.deps());
		const b = store.getRecentBatches(repo.id).find((x) => x.kind === 'batch')!;
		store.setLandingIntent(repo.id, { batchId: b.id, srcId: b.id, prs: [1], group: [1] });
		world.deleted.add(1);
		await recoverInterrupted(world.deps());
		expect(store.getLandingIntent(repo.id)).toBeNull();
	});

	test('cancelling a bisecting batch stops its runs and puts its PRs back in line, blaming nobody', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		world.hold = (prs) => prs.length === 1;
		for (let i = 0; i < 30 && !world.started.some((x) => x.branch.includes('-bisect-')); i++) await tickBatchQueue(world.deps());
		const b = store.getRecentBatches(repo.id).find((x) => x.kind === 'batch')!;
		expect(b.status).toBe('bisecting');
		const runs = world.started.filter((x) => x.branch.includes('-bisect-'));
		const r = await cancelBatch(world.deps(), b.id, 'anton');
		expect(r).toEqual({ requeued: [1, 2], rebuilt: [] });
		expect(store.getBatch(b.id)!.status).toBe('cancelled');
		expect(store.getBisectRuns(b.id).map((x) => x.status)).toEqual(runs.map(() => 'cancelled'));
		for (const x of runs) expect(world.cancelled).toContain(x.head);
		expect(queued()).toEqual([
			{ pr: 1, status: 'queued' },
			{ pr: 2, status: 'queued' }
		]);
		expect(world.comments).toEqual([]);
		await expect(cancelBatch(world.deps(), b.id, 'anton')).rejects.toThrow(/only a batch being tested or bisected/);
	});

	test('cancelling a batch in the pipeline rebuilds the one built on it', async () => {
		store.updateQueueSettings(repo.id, { config: { maxBatch: 1, depth: 2, collectWindowMs: 0 } });
		pr(1);
		pr(2);
		world.hold = () => true;
		await run(3);
		const [first, second] = store.getActiveBatches(repo.id);
		expect([first.members, second.members]).toEqual([[1], [2]]);
		const r = await cancelBatch(world.deps(), first.id, 'anton');
		expect(r).toEqual({ requeued: [1], rebuilt: [second.id] });
		expect(store.getBatch(second.id)!.status).toBe('superseded');
		expect(store.getActiveBatches(repo.id)).toEqual([]);
		world.hold = () => false;
		await run();
		expect(world.merged).toEqual([1, 2]);
	});

	test('a tick reads its PRs from one list of open PRs, not one call per PR', async () => {
		for (let n = 1; n <= 12; n++) pr(n);
		world.hold = () => true;
		await tickBatchQueue(world.deps());
		expect(store.getActiveBatches(repo.id)).toHaveLength(1);
		const [lists, calls] = [world.openListCalls, world.prCalls];
		// a tick with a batch in flight and PRs waiting: the list, and no PR fetched alone
		await tickBatchQueue(world.deps());
		expect(world.openListCalls - lists).toBe(1);
		expect(world.prCalls - calls).toBe(0);
	});

	test('a rate limit during a landing pauses nothing: the landing is finished after the reset', async () => {
		pr(1);
		pr(2);
		world.rateLimited = true;
		for (let i = 0; i < 20 && !store.getLandingIntent(repo.id); i++) await tickBatchQueue(world.deps()).catch((e) => expect(e).toBeInstanceOf(RateLimitedError));
		expect(store.getLandingIntent(repo.id)).not.toBeNull();
		expect(store.getQueueSettings(repo.id).pausedReason).toBeNull();
		expect(world.merged).toEqual([]);
		// the tested status was taken back, so nobody merges it around the queue meanwhile
		expect(world.prStatuses.filter((x) => x.sha === git.sha('pr1')).at(-1)?.state).toBe('pending');
		world.rateLimited = false;
		await run();
		expect(world.merged).toEqual([1, 2]);
		expect(store.getLandingIntent(repo.id)).toBeNull();
	});

	test('a superseded batch has its CI cancelled', async () => {
		pr(1);
		await tickBatchQueue(world.deps());
		const first = world.started[0].head;
		git.commit('main', 'hotfix pushed by hand');
		await run();
		expect(world.cancelled).toContain(first);
		expect(world.merged).toEqual([1]);
	});

	test('a fork PR is not queued, or tried, without approval of its head', async () => {
		store.updateQueueSettings(repo.id, { config: { requireApproval: false } });
		pr(1, { approve: false });
		world.forks.add(1);
		await run(3);
		expect(world.started).toEqual([]);
		expect(db.getQueueItems(repo.id)[0].error_message).toMatch(/comes from a fork/);
		await expect(startTry(world.deps(), 1)).rejects.toThrow(/comes from a fork/);
		world.approved.add(1);
		await run();
		expect(world.merged).toEqual([1]);
	});

	test('a PR left checking with no batch carrying it goes back in line', async () => {
		pr(1);
		const it = db.getQueueItems(repo.id)[0];
		db.updateQueueItemStatus(it.id, 'checking');
		await run();
		expect(world.merged).toEqual([1]);
	});

	test('leaving batch mode stops the batches in flight and requeues their PRs', async () => {
		pr(1);
		await tickBatchQueue(world.deps());
		await retireBatches(world.deps());
		expect(world.cancelled).toEqual([world.started[0].head]);
		expect(store.getActiveBatches(repo.id)).toEqual([]);
		expect(db.getQueueItems(repo.id)[0].status).toBe('queued');
	});
});

describe('surviving a crash at any step', () => {
	const MUTATING = {
		github: ['pushBranch', 'pushHead', 'deleteBranch', 'retargetBase', 'squashMerge', 'setStatus', 'setPRStatus', 'label', 'comment'],
		ci: ['start', 'refreshCaches', 'cancel', 'rerunFailed']
	} as const;

	/**
	 * Runs ticks where the k-th call that changes something outside (GitHub, CI) never returns: the
	 * process died there, before (`before`) or after (`after`) the change took effect. Later ticks
	 * run normally, from what is in the database and on GitHub. Returns the number of such calls seen.
	 */
	const trace: string[] = [];
	async function runCrashingAt(k: number, mode: 'before' | 'after', ticks: number): Promise<number> {
		let calls = 0;
		let crash: (() => void) | null = null;
		const crashed = new Promise<void>((r) => (crash = r));
		let dead = false;
		for (let i = 0; i < ticks; i++) {
			const d = world.deps();
			if (!dead) {
				for (const [part, names] of Object.entries(MUTATING) as [keyof typeof MUTATING, readonly string[]][]) {
					const o = d[part] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
					for (const name of names) {
						const real = o[name];
						o[name] = async (...a: unknown[]) => {
							if (dead) return new Promise(() => {});
							if (process.env.CRASH_TRACE) trace.push(`${calls + 1} ${part}.${name}(${a.map((x) => String(x).slice(0, 40)).join(', ')})`);
							if (++calls === k) {
								dead = true;
								if (mode === 'after') await real(...a);
								crash!();
								return new Promise(() => {});
							}
							return real(...a);
						};
					}
				}
			}
			await Promise.race([tickBatchQueue(d), crashed]);
			if (dead && i < ticks) {
				// The process restarts: the remaining ticks run with nothing carried over in memory.
				for (let j = i + 1; j < ticks; j++) await tickBatchQueue(world.deps());
				break;
			}
		}
		return calls;
	}

	function scenario() {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2);
		pr(3, { file: 'x-breaks-master.txt' });
		pr(4);
		world.breakingFiles.add('x-breaks-master.txt');
	}

	/** What must hold once the queue has settled, however often it was killed on the way. */
	function settled() {
		expect([...world.merged].sort()).toEqual([1, 2, 4]);
		expect(mainFiles()).toEqual(['pr1.txt', 'pr2.txt', 'pr4.txt']);
		expect(queued()).toEqual([]);
		expect(db.getRepoHistory(repo.id).filter((h) => h.status === 'failed').map((h) => h.pr_number)).toEqual([3]);
		// Each PR is recorded once, however often the queue was restarted on the way.
		expect(db.getRepoHistory(repo.id).map((h) => h.pr_number).sort()).toEqual([1, 2, 3, 4]);
		expect(store.getActiveBatches(repo.id)).toEqual([]);
		expect(store.getQueueSettings(repo.id).pausedReason).toBeNull();
		// No queue branch is left behind, and no unmerged PR carries the queue's green status.
		expect(git.git('branch', '--list', 'mq/*').trim()).toBe('');
		const last = new Map<string, string>();
		for (const s of world.prStatuses.filter((x) => x.context === 'merge-queue')) last.set(s.sha, s.state);
		expect(last.get(git.sha('pr3'))).toBe('failure');
		for (const n of [1, 2, 3, 4]) if (!git.pr(n).merged) expect(last.get(git.sha(`pr${n}`))).not.toBe('success');
	}

	test('without a crash (the reference)', async () => {
		scenario();
		const calls = await runCrashingAt(0, 'before', 80);
		if (process.env.CRASH_TRACE) console.log(trace.join('\n'));
		settled();
		expect(calls).toBeGreaterThan(10);
	});

	for (const mode of ['before', 'after'] as const) {
		test(`killed ${mode} any call that changes GitHub or CI, it still settles`, { timeout: 600_000 }, async () => {
			// Count the calls of an uninterrupted run first.
			scenario();
			const total = await runCrashingAt(0, mode, 80);
			const failures: string[] = [];
			for (let k = 1; k <= total; k++) {
				git.cleanup();
				git = new GitSandbox();
				world = new World();
				const user = db.upsertUser(1, 'dev', null, null);
				const name = `repo${++repoSeq}`;
				db.addRepo('acme', name, 'main', user);
				repo = { ...db.getRepoByOwnerName('acme', name)!, default_branch: 'main' };
				store.updateQueueSettings(repo.id, { mode: 'batch', config: { collectWindowMs: 0, depth: 1 } });
				store.setMasterHealth(repo.id, { sha: git.sha('main'), tree: git.git('rev-parse', 'main^{tree}'), state: 'green', since: 0 });
				scenario();
				await runCrashingAt(k, mode, 80);
				try {
					settled();
				} catch (e) {
					failures.push(`call ${k}: ${(e as Error).message.split('\n')[0]}; paused: ${store.getQueueSettings(repo.id).pausedReason}; batches: ${store.getRecentBatches(repo.id).map((b) => `${b.id}:${b.kind}:${b.status}:${b.members}`).join(' ')}`);
				}
			}
			expect(failures).toEqual([]);
		});
	}
});
