import { afterEach, beforeEach, describe, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');
const store = await import('./batch-store');
const { tickBatchQueue, startTry, retireBatches, recoverInterrupted, cancelBatch } = await import('./batch-queue');
const { baselineCommit, buildBatch, GitRunner } = await import('./batch-builder');
const { replay } = await import('./rebase');
const { analyzeStacks } = await import('./stacks');
const { enqueue } = await import('./api-service');
const events = await import('./events');
import { GitSandbox } from './testing/git-sandbox';
import { writeFileSync } from 'node:fs';
import type { LivePR, PRCheckState, QueueDeps } from './batch-queue';
import { ejectedNotice, holdCheck, holdNotice, readNotice } from './hold-format';
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
	/** GitHub refuses a push that changes a workflow: the app has no Workflows permission. */
	workflowsDenied = false;
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
	/** The queue's check runs on PR heads, in the order posted (GitHub shows the latest of each name). */
	prChecks: { sha: string; name: string; state: PRCheckState; title: string; summary?: string; url?: string }[] = [];
	labels = new Map<number, Set<string>>();
	pushedHeads: { branch: string; sha: string }[] = [];
	changesRequested = new Set<number>();
	drafts = new Set<number>();
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
	commentsFail = false;
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
	/** Failing runs keep going a few reads after their first failed job, which a fail-fast read sees at once. */
	slowFailures = false;
	slowReads = new Map<string, number>();
	/** Each result read: the head and whether it asked to fail fast. */
	resultReads: { head: string; failFast: boolean }[] = [];
	/** Cancels and re-runs, in order, as `cancel <head>` and `rerun <head>`. */
	ciOps: string[] = [];
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
			draft: this.drafts.has(n),
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
				baseline: async (base) => baselineCommit(runner, base),
				changed: async (from, to) => git.git('diff', '--name-only', from, to).split('\n').filter(Boolean)
			},
			ci: {
				start: async (branch, _base, head, prs) => {
					this.started.push({ branch, head, prs });
					this.ciPendingOnce.add(head);
				},
				result: async (head, _notBefore, opts) => {
					this.resultReads.push({ head, failFast: !!opts?.failFast });
					if (this.ciPendingOnce.delete(head) || this.stillRunning.has(head)) return 'pending';
					if (this.slowFailures && this.ciFails(head) && !this.cancelled.includes(head) && !opts?.failFast) {
						// The rest of a failing run takes a few more reads to finish.
						const n = (this.slowReads.get(head) ?? 0) + 1;
						this.slowReads.set(head, n);
						if (n <= 3) return 'pending';
					}
					if (this.holdMasterRuns && head === git.sha('main')) return 'pending';
					const started = this.started.find((x) => x.head === head);
					if (started && this.hold(started.prs)) return 'pending';
					const flakeNow = this.flaky.has(head) && !this.reruns.has(head);
					return flakeNow || this.ciFails(head) ? 'failure' : 'success';
				},
				cancel: async (head) => {
					this.cancelled.push(head);
					this.ciOps.push(`cancel ${head}`);
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
					this.ciOps.push(`rerun ${head}`);
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
					if (this.workflowsDenied) {
						const changed = git.git('diff', '--name-only', git.sha('main'), sha, '--', '.github/workflows').trim();
						if (changed) {
							throw new Error(
								`git push failed: ! [remote rejected] ${sha} -> ${branch} (refusing to allow a GitHub App to create or update workflow \`${changed.split('\n')[0]}\` without \`workflows\` permission)`
							);
						}
					}
					git.git('branch', '-f', branch, sha);
				},
				pushHead: async (branch, sha, expected) => {
					if (git.sha(branch) !== expected) throw new Error('stale info');
					git.git('branch', '-f', branch, sha);
					this.pushedHeads.push({ branch, sha });
				},
				setPRCheck: async (sha, c) => {
					this.prChecks.push({
						sha,
						name: `merge-queue${c.suffix ?? ''}`,
						state: c.state,
						title: c.title,
						...(c.summary !== undefined ? { summary: c.summary } : {}),
						...(c.url ? { url: c.url } : {})
					});
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
					if (this.commentsFail) throw new Error('Server Error');
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
			{ pr: 3, body: expect.stringMatching(/^\*\*Merge queue:\*\* Removed from the queue: Fails on its own[\s\S]*\. Fix the failure, push, and queue it again\./) }
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
		expect(world.comments).toEqual([{ pr: 4, body: expect.stringMatching(/Fails on its own on top of the default branch/) }]);
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
		expect(world.comments).toEqual([{ pr: 4, body: expect.stringMatching(/Fails on its own on top of the default branch \(batch \d+, which landed #1, #2, #3\)/) }]);
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
		expect(world.comments).toEqual([{ pr: 2, body: expect.stringMatching(/Fails on its own/) }]);
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
		const of = (ref: string) => world.prChecks.filter((x) => x.sha === git.sha(ref) && x.name === 'merge-queue');
		const branch = world.started[0].branch;
		expect(of('pr2').map((x) => [x.state, x.title.split(';')[0].split(':')[0], x.url])).toEqual([
			['in_progress', `Testing in ${branch} with 1 other PR(s)`, `https://github.com/${repo.owner}/${repo.name}/actions?query=${encodeURIComponent(`branch:${branch}`)}`],
			['in_progress', `${branch} failed`, `https://ci.example/${world.started[0].head}`],
			['in_progress', `Batch ${store.getRecentBatches(repo.id).find((b) => b.kind === 'batch')!.number} failed`, `https://github.com/${repo.owner}/${repo.name}/actions?query=${encodeURIComponent(`branch:${world.started[2].branch}`)}`],
			['failure', 'Left the queue', `https://ci.example/${world.started[2].head}`]
		]);
		expect(of('pr1').at(-1)).toMatchObject({ state: 'success', url: expect.stringMatching(/^https:\/\/ci\.example\//) });
		expect(world.comments).toEqual([{ pr: 2, body: expect.stringMatching(/\n\nCI run: https:\/\/ci\.example\//) }]);
		expect(readNotice(world.comments[0].body)).toMatchObject({ kind: 'ejected', pr: 2, head: git.sha('pr2'), nextActions: ['fix-failure', 'requeue'] });
	});

	test('finds two PRs that only break together and ejects the later one', async () => {
		pr(1, { file: 'x-adds-field.txt' });
		pr(2);
		pr(3, { file: 'x-uses-old-initializer.txt' });
		world.conflictPairs.push(['x-adds-field.txt', 'x-uses-old-initializer.txt']);
		await run(60);
		expect(world.merged).toEqual([1, 2]);
		expect(world.comments[0]).toMatchObject({ pr: 3, body: expect.stringMatching(/Fails on its own on top of the default branch \(batch \d+, which landed #1, #2\)/) });
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
		// Git names the files when the author rebases: the reason is only what it conflicts with.
		expect(world.comments).toEqual([{ pr: 2, body: holdNotice({ pr: 2, head: git.sha('pr2'), code: 'conflict', reason: 'Conflicts with main', files: ['same.txt'], fix: 'git fetch origin main && git rebase origin/main' }) }]);
		expect(world.comments[0].body).toMatch(/^\*\*Merge queue:\*\* Conflicts with main\. /);
		expect(db.getQueueItems(repo.id).find((i) => i.pr_number === 2)!.error_message).toBe('Conflicts with main');
		// One format: the conflict reads back like any other hold, with its files.
		// Waiting for #1 had nothing for the author to do, so it said nothing.
		expect(readNotice(world.comments[0].body)).toMatchObject({ kind: 'hold', pr: 2, head: git.sha('pr2'), code: 'conflict', files: ['same.txt'], nextActions: ['resolve-conflict'] });
		expect(world.labels.get(2)).toEqual(new Set(['needs-rebase']));
		expect(world.prChecks.filter((x) => x.sha === git.sha('pr2')).at(-1)).toMatchObject({ state: 'action_required', title: 'Conflicts with main', summary: expect.stringContaining('"code":"conflict"') });

		// the author rebases and resolves: the PR is picked up again and lands
		git.git('checkout', '-q', 'pr2');
		git.git('reset', '-q', '--hard', 'main');
		git.commit('pr2', 'pr2 resolved', 'pr2.txt');
		await run();
		expect(world.merged).toEqual([1, 3, 2]);
		expect(world.labels.get(2)).toEqual(new Set());
	});

	test('a conflict with the default branch is checked again when the branch moves, without a push', async () => {
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		await run();
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		const head = git.sha('pr2');
		// Nothing changes on the default branch: it stays held, and is told only once.
		await run(3);
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		// The default branch drops the conflicting file: #2 now merges cleanly, and goes without a push.
		git.git('checkout', '-q', 'main');
		git.git('rm', '-q', 'same.txt');
		git.git('commit', '-qm', 'drop same.txt');
		await run();
		expect(git.sha('pr2')).toBe(head);
		expect(world.merged).toEqual([1, 2]);
		expect(world.labels.get(2)).toEqual(new Set());
		expect(world.comments.map((c) => c.pr)).toEqual([2]);
		expect(events.listEvents(repo.id, { pr: 2 }).filter((e) => e.kind === 'requeued').map((e) => e.data)).toEqual([
			{ reason: 'no longer conflicts with main', headSha: head }
		]);
	});

	test('a conflict recorded before the queue kept its base is checked again too', async () => {
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		await run();
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		store.setHold(db.getQueueItems(repo.id).find((i) => i.pr_number === 2)!.id, null);
		git.git('checkout', '-q', 'main');
		git.git('rm', '-q', 'same.txt');
		git.git('commit', '-qm', 'drop same.txt');
		await run();
		expect(world.merged).toEqual([1, 2]);
	});

	test('a restack that needs conflict resolution waits for a push: the default branch moving does not retry it', async () => {
		pr(1, { file: 'shared.txt' });
		pr(2, { from: 'pr1', base: 'pr1', file: 'shared.txt' });
		db.removeFromQueue(db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!.id);
		// #1 is rewritten under #2: replaying #2's own commit onto it conflicts.
		git.git('checkout', '-q', 'pr1');
		writeFileSync(`${git.dir}/shared.txt`, 'parent rewrote it\n');
		git.git('commit', '-q', '--amend', '-am', 'pr1 rewritten');
		await run(3);
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		git.commit('main', 'm1', 'x-main.txt');
		await run(3);
		git.commit('main', 'm2', 'x-main2.txt');
		await run(3);
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		expect(world.comments.filter((c) => c.pr === 2)).toHaveLength(1);
	});

	test('a restack that conflicted with its rebased parent is tried again once the parent moves, without a push to it', async () => {
		pr(1, { file: 'shared.txt' });
		pr(2, { from: 'pr1', base: 'pr1', file: 'shared.txt' });
		db.removeFromQueue(db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!.id);
		const old = git.sha('pr1');
		git.git('checkout', '-q', 'pr1');
		writeFileSync(`${git.dir}/shared.txt`, 'parent rewrote it\n');
		git.git('commit', '-q', '--amend', '-am', 'pr1 rewritten');
		await run(3);
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		const head = git.sha('pr2');
		// The parent's author puts its content back in a new commit: #2's commit replays cleanly again.
		git.git('checkout', '-q', 'pr1');
		git.git('checkout', '-q', old, '--', 'shared.txt');
		git.git('commit', '-qam', 'pr1 restores shared.txt');
		await run(3);
		expect(queued()).toEqual([{ pr: 2, status: 'queued' }]);
		expect(events.listEvents(repo.id, { pr: 2 }).filter((e) => e.kind === 'requeued').map((e) => e.data)).toEqual([{ reason: '#1 moved', headSha: head }]);
		expect(world.pushedHeads.map((h) => h.branch)).toEqual(['pr2']);
	});

	test('a restack conflict tried again after its parent moved, and still conflicting, is not told again', async () => {
		pr(1, { file: 'shared.txt' });
		pr(2, { from: 'pr1', base: 'pr1', file: 'shared.txt' });
		db.removeFromQueue(db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!.id);
		git.git('checkout', '-q', 'pr1');
		writeFileSync(`${git.dir}/shared.txt`, 'parent rewrote it\n');
		git.git('commit', '-q', '--amend', '-am', 'pr1 rewritten');
		await run(3);
		git.commit('pr1', 'pr1 more', 'pr1-more.txt'); // the parent moves; #2 still conflicts with it
		await run(3);
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		expect(world.comments.filter((c) => c.pr === 2)).toHaveLength(1);
	});

	test('a restack conflict whose parent then lands is tried again, not left waiting on a parent that will not move', async () => {
		pr(1, { file: 'shared.txt' });
		pr(2, { from: 'pr1', base: 'pr1', file: 'shared.txt' });
		db.removeFromQueue(db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!.id);
		git.git('checkout', '-q', 'pr1');
		writeFileSync(`${git.dir}/shared.txt`, 'parent rewrote it\n');
		git.git('commit', '-q', '--amend', '-am', 'pr1 rewritten');
		await run(3);
		const head = git.sha('pr2');
		git.merge(1, 'squash');
		git.pr(1).state = 'closed';
		git.pr(1).merged = true;
		await run(3);
		expect(events.listEvents(repo.id, { pr: 2 }).filter((e) => e.kind === 'requeued').map((e) => e.data)).toEqual([{ reason: '#1 is no longer open', headSha: head }]);
	});

	test('a restack conflict whose comment failed is told when it is tried again and still conflicts', async () => {
		pr(1, { file: 'shared.txt' });
		pr(2, { from: 'pr1', base: 'pr1', file: 'shared.txt' });
		db.removeFromQueue(db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!.id);
		git.git('checkout', '-q', 'pr1');
		writeFileSync(`${git.dir}/shared.txt`, 'parent rewrote it\n');
		git.git('commit', '-q', '--amend', '-am', 'pr1 rewritten');
		world.commentsFail = true;
		await run(3);
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		world.commentsFail = false;
		git.commit('pr1', 'pr1 more', 'pr1-more.txt'); // the parent moves; #2 still conflicts with it
		await run(3);
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		expect(world.comments.filter((c) => c.pr === 2)).toHaveLength(1);
	});

	test('a conflict with the default branch whose comment failed is told on a later tick, the branch unchanged', async () => {
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		world.commentsFail = true;
		await run();
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		world.commentsFail = false;
		await run(3);
		expect(world.comments).toEqual([{ pr: 2, body: holdNotice({ pr: 2, head: git.sha('pr2'), code: 'conflict', reason: 'Conflicts with main', files: ['same.txt'], fix: 'git fetch origin main && git rebase origin/main' }) }]);
	});

	test('a conflict whose comment failed and that has gone by the next tick is not told', async () => {
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		world.commentsFail = true;
		await run();
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		world.commentsFail = false;
		git.git('checkout', '-q', 'main');
		git.git('rm', '-q', 'same.txt');
		git.git('commit', '-qm', 'drop same.txt');
		await run();
		expect(world.merged).toEqual([1, 2]);
		expect(world.comments).toEqual([]);
	});

	test('a restack conflict waits while a bisection runs, so its author is told once', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1, { file: 'shared.txt' });
		pr(2, { from: 'pr1', base: 'pr1', file: 'shared.txt' });
		db.removeFromQueue(db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!.id);
		git.git('checkout', '-q', 'pr1');
		writeFileSync(`${git.dir}/shared.txt`, 'parent rewrote it\n');
		git.git('commit', '-q', '--amend', '-am', 'pr1 rewritten');
		await run(3);
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		pr(3);
		pr(4, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		world.hold = (prs) => prs.length === 1;
		for (let i = 0; i < 30 && !world.started.some((x) => x.branch.includes('-bisect-')); i++) await tickBatchQueue(world.deps());
		expect(world.started.some((x) => x.branch.includes('-bisect-'))).toBe(true);
		git.commit('pr1', 'pr1 more', 'pr1-more.txt'); // the parent moves mid-bisection; #2 still conflicts with it
		for (let i = 0; i < 3; i++) await tickBatchQueue(world.deps());
		world.hold = () => false;
		await run(40);
		expect(queued()).toEqual([{ pr: 2, status: 'conflict' }]);
		expect(world.comments.filter((c) => c.pr === 2)).toHaveLength(1);
	});

	test('a workflow change held before holds were saved is not checked again by itself', async () => {
		world.workflowsDenied = true;
		pr(1, { file: '.github/workflows/ci.yml' });
		await run();
		expect(queued()).toEqual([{ pr: 1, status: 'conflict' }]);
		store.setHold(db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!.id, null);
		git.commit('main', 'm1', 'x-main.txt');
		await run();
		expect(queued()).toEqual([{ pr: 1, status: 'conflict' }]);
		expect(world.comments.filter((c) => c.pr === 1)).toHaveLength(1);
	});

	test('a conflict saved over a hold of another kind keeps its own kind and base after a failed check', async () => {
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		await run();
		const item = () => db.getQueueItems(repo.id).find((i) => i.pr_number === 2)! as ReturnType<typeof db.getQueueItems>[number] & { hold?: string | null };
		// As saved before conflicts kept a base: the hold it had while queued.
		store.setHold(item().id, { code: 'deferred', reason: 'Conflicts with #1 ahead of it; waits for them to land', released: true });
		git.commit('main', 'm1', 'x-main.txt');
		await run(1);
		expect(store.storedHold(item())).toMatchObject({ code: 'conflict', base: git.sha('main') });
		expect(store.storedHold(item())?.released).toBeUndefined();
	});

	test('a workflow change the app may not push is not checked again by itself: only a push retries it', async () => {
		world.workflowsDenied = true;
		pr(1, { file: '.github/workflows/ci.yml' });
		await run();
		world.workflowsDenied = false;
		git.commit('main', 'm1', 'x-main.txt');
		await run();
		expect(world.merged).toEqual([]);
		expect(queued()).toEqual([{ pr: 1, status: 'conflict' }]);
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
		expect(db.getQueueItems(repo.id)[0].error_message).toBe('Does not target the default branch');
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
		expect(db.getQueueItems(repo.id).map((i) => [i.pr_number, i.error_message])).toEqual([[2, 'Changes requested']]);
		// The dashboard shows it as needing someone, not as waiting for its turn.
		expect(store.currentHold(db.getQueueItems(repo.id)[0])).toEqual({ code: 'changes-requested', reason: 'Changes requested', told: true, head: git.sha('pr2') });
	});

	test('marks the PR head as tested right before merging it', async () => {
		pr(1);
		const head = git.sha('pr1');
		await run();
		expect(world.prChecks.filter((x) => x.sha === head).map((x) => x.state)).toEqual(['in_progress', 'success']);
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

	test('a PR whose parent was rebased, with restacking off, is told the exact restack command', async () => {
		store.updateQueueSettings(repo.id, { config: { autoRebase: false } });
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' });
		const stale = git.sha('pr1');
		git.commit('main', 'm1', 'x-main.txt');
		git.rebase('pr1', 'main');
		await run(3);
		const reason = '#1 was rebased or force-pushed; this PR still carries 1 old commit from it';
		// The first thing it is told; #1 then lands, and the sandbox keeps #2's base where GitHub would retarget it.
		expect(world.comments.filter((c) => c.pr === 2)[0]).toEqual(
			{
				pr: 2,
				body: holdNotice({ pr: 2, head: git.sha('pr2'), code: 'stack-broken', reason, fix: `git fetch origin pull/1/head && git rebase --onto FETCH_HEAD ${stale}` })
			}
		);
		expect(world.comments.find((c) => c.pr === 2)?.body).toContain(`\`\`\`sh\ngit fetch origin pull/1/head && git rebase --onto FETCH_HEAD ${stale}\n`);
	});

	test("a PR on its parent's branch but not on its latest commit is told to rebase onto it, with the command", async () => {
		pr(1);
		pr(2, { base: 'pr1' }); // branched from main, not from #1's head
		await run(3);
		// The first thing it is told; #1 then lands, and the sandbox keeps #2's base where GitHub would retarget it.
		expect(world.comments.filter((c) => c.pr === 2)[0]).toEqual(
			{
				pr: 2,
				body: holdNotice({ pr: 2, head: git.sha('pr2'), code: 'stack-broken', reason: "Not on #1's latest commit", fix: 'git fetch origin pull/1/head && git rebase FETCH_HEAD' })
			}
		);
		expect(world.comments.find((c) => c.pr === 2)?.body).toContain('```sh\ngit fetch origin pull/1/head && git rebase FETCH_HEAD\n');
	});

	test('comments only when action is needed: a clean restack is not told', async () => {
		store.updateQueueSettings(repo.id, { config: { comments: 'attention' } });
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' });
		git.commit('main', 'm1', 'x-main.txt');
		git.rebase('pr1', 'main');
		await run();
		expect(world.pushedHeads[0]).toMatchObject({ branch: 'pr2' });
		expect(world.merged).toEqual([1, 2]);
		expect(world.comments).toEqual([]);
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

	test('a PR that changes a workflow the app may not push is held with what to do; the queue goes on', async () => {
		world.workflowsDenied = true;
		pr(1);
		pr(2, { file: '.github/workflows/ci.yml' });
		pr(3);
		await run();
		expect(store.getQueueSettings(repo.id).pausedReason).toBeNull();
		expect(world.merged).toEqual([1, 3]);
		const reason = 'Changes .github/workflows/ci.yml, which the merge queue app may not push';
		expect(db.getQueueItems(repo.id).map((i) => ({ pr: i.pr_number, status: i.status, message: i.error_message }))).toEqual([
			{ pr: 2, status: 'conflict', message: reason }
		]);
		const notice = holdNotice({ pr: 2, head: git.sha('pr2'), code: 'workflow-permission', reason, files: ['.github/workflows/ci.yml'] });
		expect(world.comments).toEqual([{ pr: 2, body: notice }]);
		expect(world.prChecks.filter((c) => c.sha === git.sha('pr2')).at(-1)).toMatchObject({ state: 'action_required', title: reason });
		// Not a conflict to rebase: no needs-rebase label.
		expect(world.labels.get(2)?.has('needs-rebase') ?? false).toBe(false);
	});

	test('a PR held for its workflow change stays queued, so queueing it again is refused; a push retries it', async () => {
		world.workflowsDenied = true;
		pr(1);
		pr(2, { file: '.github/workflows/ci.yml' });
		await run();
		expect(world.merged).toEqual([1]);
		const live = { number: 2, title: 'PR 2', html_url: 'https://example.test/pull/2', state: 'open', user: { login: 'dev', avatar_url: '' } };
		expect(() => enqueue(repo as Parameters<typeof enqueue>[0], { login: 'agent', role: 'write', app: false }, live, {})).toThrow('#2 is already queued');
		// An admin grants the permission; nothing retries until a push.
		world.workflowsDenied = false;
		await run(3);
		expect(world.merged).toEqual([1]);
		git.commit('pr2', 'pr2 again', 'pr2.txt');
		await run();
		expect(world.merged).toEqual([1, 2]);
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

	test('a PR stacked on a deferred PR waits for it, and says why', async () => {
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		pr(3, { from: 'pr2', base: 'pr2' });
		await tickBatchQueue(world.deps());
		expect(world.started.map((x) => x.prs)).toEqual([[1]]);
		const item = (n: number) => db.getQueueItems(repo.id).find((i) => i.pr_number === n)!;
		expect(item(2).error_message).toBe('Conflicts with #1 ahead of it; waits for them to land');
		// One more tick plans the rest: #2 is queued, only deferred; #3 waits for it.
		await tickBatchQueue(world.deps());
		expect(item(3).error_message).toBe('Waits for #2: conflicts with #1 ahead of it; waits for them to land');
	});

	test('a held PR is told on GitHub what it needs, once, and an event says so; then it is released', async () => {
		pr(1);
		pr(2);
		world.changesRequested.add(2);
		await run(3);
		expect(world.merged).toEqual([1]);
		const told = () => world.prChecks.filter((x) => x.sha === git.sha('pr2') && x.name === 'merge-queue').map((x) => [x.state, x.title]);
		// Told once, however many ticks hold it.
		expect(told()).toEqual([['action_required', 'Changes requested']]);
		const kinds = () => events.listEvents(repo.id, { pr: 2 }).map((e) => e.kind);
		expect(events.listEvents(repo.id, { pr: 2 }).filter((e) => e.kind === 'held').map((e) => e.data)).toEqual([{ code: 'changes-requested', reason: 'Changes requested' }]);
		world.changesRequested.delete(2);
		await run();
		expect(world.merged).toEqual([1, 2]);
		expect(kinds().filter((k) => k === 'held' || k === 'released' || k === 'batched')).toEqual(['held', 'released', 'batched']);
	});

	test("a held PR's check run says action required, with the reason in its title and the fix in its summary", async () => {
		pr(1);
		world.drafts.add(1);
		await run(2);
		const h = { pr: 1, head: git.sha('pr1'), code: 'draft' as const, reason: 'Draft' };
		const checks = world.prChecks.filter((x) => x.sha === git.sha('pr1'));
		expect(checks).toEqual([{ sha: git.sha('pr1'), name: 'merge-queue', state: 'action_required', ...holdCheck(h) }]);
		expect(checks[0].summary).toContain('```sh\ngh pr ready 1\n```');
		expect(readNotice(checks[0].summary!)).toMatchObject({ kind: 'hold', code: 'draft', nextActions: ['mark-ready'] });
		expect(world.comments).toEqual([{ pr: 1, body: holdNotice(h) }]);
	});

	test('a PR goes from in line to testing to tested, and only tested passes', async () => {
		pr(1);
		pr(2);
		world.changesRequested.add(2);
		await run(2);
		world.changesRequested.delete(2);
		await run();
		expect(world.merged).toEqual([1, 2]);
		const states = (ref: string) => world.prChecks.filter((x) => x.sha === git.sha(ref) && x.name === 'merge-queue').map((x) => x.state);
		expect(states('pr1')).toEqual(['in_progress', 'success']);
		expect(states('pr2')).toEqual(['action_required', 'queued', 'in_progress', 'success']);
		expect(world.prChecks.find((x) => x.sha === git.sha('pr2') && x.state === 'queued')?.title).toBe('In line in the merge queue');
	});

	test('a PR that leaves the queue is left with a check that does not pass, so it is not merged around the queue', async () => {
		pr(1);
		world.changesRequested.add(1);
		await run(2);
		db.removeFromQueue(db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!.id);
		await run(2);
		const last = world.prChecks.filter((x) => x.sha === git.sha('pr1')).at(-1)!;
		// A neutral conclusion would pass a required check.
		expect(['success', 'neutral', 'skipped']).not.toContain(last.state);
		expect(last).toMatchObject({ state: 'queued', title: 'Not in the merge queue' });
	});

	test('an ejected PR gets a failed check with its CI run, and a comment with the same block', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		await run(20);
		const last = world.prChecks.filter((x) => x.sha === git.sha('pr1') && x.name === 'merge-queue').at(-1)!;
		expect(last).toMatchObject({ state: 'failure', title: expect.stringMatching(/^Left the queue: CI failed in mq\//), url: expect.stringMatching(/^https:\/\/ci\.example\//) });
		const c = world.comments.find((x) => x.pr === 1)!;
		expect(c.body).toBe(ejectedNotice({ pr: 1, head: git.sha('pr1'), reason: readNotice(c.body)!.reason!, link: last.url }));
		expect(last.summary).toBe(c.body);
	});

	test('a conflict is told on the check run in the hold format: action required and the commands, its files only in the block', async () => {
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		await run();
		expect(world.merged).toEqual([1]);
		const last = world.prChecks.filter((x) => x.sha === git.sha('pr2') && x.name === 'merge-queue').at(-1)!;
		expect(last.state).toBe('action_required');
		expect(last.summary).toMatch(/```sh\n[\s\S]*git push --force-with-lease\n```/);
		expect(last.summary).not.toContain('Conflicting files');
		expect(readNotice(last.summary!)).toMatchObject({ kind: 'hold', code: 'conflict', head: git.sha('pr2'), files: ['same.txt'] });
	});

	test('a hold recorded before PRs were told about holds is told on the next tick', async () => {
		pr(1);
		world.changesRequested.add(1);
		const item = db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!;
		// What the previous version left: the hold and its message, and nothing posted.
		db.updateQueueItemStatus(item.id, 'queued', 'Changes requested');
		store.setHold(item.id, { code: 'changes-requested', reason: 'Changes requested' });
		await run(2);
		const told = world.prChecks.filter((x) => x.sha === git.sha('pr1') && x.name === 'merge-queue').map((x) => [x.state, x.title]);
		expect(told).toEqual([['action_required', 'Changes requested']]);
		expect(world.comments).toEqual([
			{ pr: 1, body: holdNotice({ pr: 1, head: git.sha('pr1'), code: 'changes-requested', reason: 'Changes requested' }) }
		]);
	});

	test('a held PR gets one comment saying what to do, and none when it is back in line', async () => {
		pr(1);
		pr(2);
		world.changesRequested.add(2);
		await run(3);
		expect(world.merged).toEqual([1]);
		expect(world.comments).toEqual([
			{ pr: 2, body: holdNotice({ pr: 2, head: git.sha('pr2'), code: 'changes-requested', reason: 'Changes requested' }) }
		]);
		world.changesRequested.delete(2);
		await run();
		expect(world.merged).toEqual([1, 2]);
		// Back in line gives no action: its check goes back to queued, and the event is kept.
		expect(world.comments.slice(1)).toEqual([]);
		expect(world.prChecks.filter((x) => x.sha === git.sha('pr2')).map((x) => x.state)).toContain('queued');
		expect(events.listEvents(repo.id, { pr: 2 }).map((e) => e.kind)).toContain('released');
	});

	test('comments only when action is needed: the hold is told, being back in line is not', async () => {
		store.updateQueueSettings(repo.id, { config: { comments: 'attention' } });
		pr(1);
		pr(2);
		world.changesRequested.add(2);
		await run(3);
		expect(world.comments).toEqual([
			{ pr: 2, body: holdNotice({ pr: 2, head: git.sha('pr2'), code: 'changes-requested', reason: 'Changes requested' }) }
		]);
		world.changesRequested.delete(2);
		await run();
		expect(world.merged).toEqual([1, 2]);
		expect(world.comments).toHaveLength(1);
		// The check still says it is back in line.
		expect(world.prChecks.filter((x) => x.sha === git.sha('pr2') && x.name === 'merge-queue').map((x) => x.state)).toContain('queued');
	});

	test('a hold not commented on under "none" is commented on once after switching to "attention"', async () => {
		store.updateQueueSettings(repo.id, { config: { comments: 'none' } });
		pr(1);
		world.changesRequested.add(1);
		await run(3);
		expect(world.comments).toEqual([]);
		const checks = () => world.prChecks.filter((x) => x.sha === git.sha('pr1') && x.name === 'merge-queue').length;
		// Not told by a comment, but the check is not posted again every tick either.
		const posted = checks();
		await run(3);
		expect(checks()).toBe(posted);
		store.updateQueueSettings(repo.id, { config: { comments: 'attention' } });
		await run(3);
		expect(world.comments).toEqual([
			{ pr: 1, body: holdNotice({ pr: 1, head: git.sha('pr1'), code: 'changes-requested', reason: 'Changes requested' }) }
		]);
	});

	test('with comments off, a hold, a conflict and an ejection post nothing; statuses and labels still tell', async () => {
		store.updateQueueSettings(repo.id, { config: { comments: 'none', retryFailed: false } });
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		pr(3, { file: 'x-breaks-master.txt' });
		pr(4);
		world.breakingFiles.add('x-breaks-master.txt');
		world.changesRequested.add(4);
		await run(60);
		expect(world.merged).toEqual([1]);
		expect(queued().sort((a, b) => a.pr - b.pr)).toEqual([
			{ pr: 2, status: 'conflict' },
			{ pr: 4, status: 'queued' }
		]);
		expect(world.comments).toEqual([]);
		expect(world.labels.get(2)).toEqual(new Set(['needs-rebase']));
		expect(world.prChecks.filter((x) => x.sha === git.sha('pr3')).at(-1)).toMatchObject({ state: 'failure', title: expect.stringMatching(/^Left the queue/) });
		expect(world.prChecks.filter((x) => x.sha === git.sha('pr4')).at(-1)).toMatchObject({ state: 'action_required', title: 'Changes requested' });
		expect(world.prChecks.filter((x) => x.sha === git.sha('pr2')).at(-1)).toMatchObject({ state: 'action_required' });
	});

	test('comments only when action is needed: an ejection and a conflict are told', async () => {
		store.updateQueueSettings(repo.id, { config: { comments: 'attention', retryFailed: false } });
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		pr(3, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		await run(60);
		expect(world.merged).toEqual([1]);
		expect(world.comments.filter((c) => c.pr === 3).map((c) => readNotice(c.body))).toEqual([expect.objectContaining({ kind: 'ejected', pr: 3 })]);
		expect(world.comments.filter((c) => c.pr === 2).map((c) => readNotice(c.body))).toContainEqual(expect.objectContaining({ kind: 'hold', code: 'conflict' }));
	});

	test('a PR whose parent is not queued is told to queue it', async () => {
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' });
		db.removeFromQueue(db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!.id);
		await run(2);
		expect(world.comments).toEqual([
			{ pr: 2, body: holdNotice({ pr: 2, head: git.sha('pr2'), code: 'parent-not-queued', reason: "Stacked on #1, which isn't queued; queue #1 first" }) }
		]);
	});

	test('a PR held while a batch bisects is told then, not once the bisection ends', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		pr(1);
		pr(2, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		// The bisection's runs (one PR each) take long.
		world.hold = (prs) => prs.length === 1;
		await run(5);
		expect(store.getRecentBatches(repo.id).find((b) => b.kind === 'batch')?.status).toBe('bisecting');
		pr(5);
		world.changesRequested.add(5);
		await run(2);
		const told = world.prChecks.filter((x) => x.sha === git.sha('pr5') && x.name === 'merge-queue').map((x) => [x.state, x.title]);
		expect(told).toEqual([['action_required', 'Changes requested']]);
	});

	test('a status that could not be posted is posted on the next tick', async () => {
		pr(1);
		world.changesRequested.add(1);
		const deps = world.deps();
		const post = deps.github.setPRCheck;
		let down = true;
		deps.github.setPRCheck = async (...a) => {
			if (down) {
				down = false;
				throw new Error('GitHub is down');
			}
			return post(...a);
		};
		await tickBatchQueue(deps);
		await tickBatchQueue(deps);
		await tickBatchQueue(deps);
		const told = world.prChecks.filter((x) => x.sha === git.sha('pr1') && x.name === 'merge-queue').map((x) => [x.state, x.title]);
		expect(told).toEqual([['action_required', 'Changes requested']]);
	});

	test('a held PR taken out of the queue is no longer told it needs attention', async () => {
		pr(1);
		world.changesRequested.add(1);
		await run(2);
		const item = db.getQueueItems(repo.id).find((i) => i.pr_number === 1)!;
		db.removeFromQueue(item.id);
		await run(2);
		const told = world.prChecks.filter((x) => x.sha === git.sha('pr1') && x.name === 'merge-queue').map((x) => [x.state, x.title]);
		expect(told).toEqual([
			['action_required', 'Changes requested'],
			['queued', 'Not in the merge queue']
		]);
		expect(events.listEvents(repo.id, { pr: 1 }).map((e) => e.kind).filter((k) => k === 'held' || k === 'released')).toEqual(['held', 'released']);
	});

	test('a PR stacked on a queued PR in conflict says that its parent conflicts, not that it is unqueued', async () => {
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' });
		const item = (n: number) => db.getQueueItems(repo.id).find((i) => i.pr_number === n)!;
		db.updateQueueItemHeadSha(item(1).id, git.sha('pr1'));
		db.updateQueueItemStatus(item(1).id, 'conflict', 'Conflicts with main in src/a.ts');
		// As the queue saves a conflict: with the default branch it conflicted with, so it isn't checked again yet.
		store.setHold(item(1).id, { code: 'conflict', reason: 'Conflicts with main in src/a.ts', told: true, base: git.sha('main') });
		await tickBatchQueue(world.deps());
		expect(world.started).toEqual([]);
		expect(item(2).error_message).toBe('Waits for #1: conflicts with main in src/a.ts');
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

	test('a deferred PR has nothing to do, so it is never told: no comment, no check, however its list changes', async () => {
		pr(1);
		pr(2);
		world.hold = () => true;
		pr(4);
		world.changesRequested.add(4);
		pr(3);
		const item = (n: number) => db.getQueueItems(repo.id).find((i) => i.pr_number === n)!;
		store.setDeferredFor(item(3).id, [1, 2, 4]);
		db.updateQueueItemStatus(item(3).id, 'queued', 'Conflicts with #1 #2 #4 ahead of it; waits for them to land');
		await tickBatchQueue(world.deps());
		// #4 is held now, so #3 no longer waits for it.
		await tickBatchQueue(world.deps());
		expect(item(3).error_message).toBe('Conflicts with #1 #2 ahead of it; waits for them to land');
		const told = () => world.prChecks.filter((x) => x.sha === git.sha('pr3') && x.name === 'merge-queue').map((x) => [x.state, x.title]);
		expect(told()).toEqual([]);
		expect(world.comments.filter((c) => c.pr === 3)).toEqual([]);
		// The deferral lifts (only #4, held, is left ahead), then comes back: no comment either time.
		store.setDeferredFor(item(3).id, [4]);
		db.updateQueueItemStatus(item(3).id, 'queued', 'Conflicts with #4 ahead of it; waits for them to land');
		await tickBatchQueue(world.deps());
		store.setDeferredFor(item(3).id, [1]);
		db.updateQueueItemStatus(item(3).id, 'queued', 'Conflicts with #1 ahead of it; waits for them to land');
		await tickBatchQueue(world.deps());
		expect(world.comments.filter((c) => c.pr === 3)).toEqual([]);
		expect(told()).toEqual([]);
		expect(events.listEvents(repo.id, { pr: 3 }).filter((e) => e.kind === 'held')).toEqual([]);
	});

	test('a deferral told as needing action by an earlier version is put back in line, without a comment', async () => {
		pr(1);
		world.hold = () => true;
		pr(3);
		const item = (n: number) => db.getQueueItems(repo.id).find((i) => i.pr_number === n)!;
		const reason = 'Conflicts with #1 ahead of it; waits for them to land';
		store.setDeferredFor(item(3).id, [1]);
		db.updateQueueItemStatus(item(3).id, 'queued', reason);
		store.setHold(item(3).id, { code: 'deferred', reason, told: true, head: git.sha('pr3') });
		await tickBatchQueue(world.deps());
		await tickBatchQueue(world.deps());
		expect(world.prChecks.filter((x) => x.sha === git.sha('pr3') && x.name === 'merge-queue').map((x) => [x.state, x.title])).toEqual([['queued', 'In line in the merge queue']]);
		expect(world.comments).toEqual([]);
		// It still waits for #1.
		expect(item(3).error_message).toBe(reason);
	});

	test('a PR stacked on a held PR is not told: its parent is', async () => {
		pr(1);
		world.changesRequested.add(1);
		pr(2, { from: 'pr1', base: 'pr1' });
		await run(3);
		expect(world.comments.map((c) => c.pr)).toEqual([1]);
		expect(world.prChecks.filter((x) => x.sha === git.sha('pr2') && x.name === 'merge-queue')).toEqual([]);
		expect(db.getQueueItems(repo.id).find((i) => i.pr_number === 2)!.error_message).toMatch(/^Waits for #1/);
	});

	test('a push while held for the same reason gets the status on the new head, and no new comment', async () => {
		pr(1);
		world.changesRequested.add(1);
		await run(2);
		const first = git.sha('pr1');
		git.commit('pr1', 'still working on it');
		await run(2);
		const on = (sha: string) => world.prChecks.filter((x) => x.sha === sha && x.name === 'merge-queue').map((x) => [x.state, x.title]);
		expect(on(first)).toEqual([['action_required', 'Changes requested']]);
		expect(on(git.sha('pr1'))).toEqual([['action_required', 'Changes requested']]);
		expect(world.comments.map((c) => c.pr)).toEqual([1]);
	});

	test('a deferral is not told, even when it comes back after the author pushed', async () => {
		pr(1);
		world.hold = () => true;
		pr(4);
		world.changesRequested.add(4);
		pr(3);
		const item = (n: number) => db.getQueueItems(repo.id).find((i) => i.pr_number === n)!;
		const defer = async (behind: number[]) => {
			store.setDeferredFor(item(3).id, behind);
			db.updateQueueItemStatus(item(3).id, 'queued', `Conflicts with ${behind.map((n) => `#${n}`).join(' ')} ahead of it; waits for them to land`);
			await tickBatchQueue(world.deps());
		};
		await defer([1]);
		await tickBatchQueue(world.deps()); // #4 is held now
		await defer([4]); // lifted: only #4, held, is ahead
		const first = git.sha('pr3');
		git.commit('pr3', 'a new attempt');
		await defer([1]);
		expect(world.comments.filter((c) => c.pr === 3)).toEqual([]);
		expect(world.prChecks.filter((x) => x.name === 'merge-queue' && (x.sha === first || x.sha === git.sha('pr3')))).toEqual([]);
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
		expect(db.getQueueItems(repo.id).find((i) => i.pr_number === 2)?.error_message).toBe('Stacked on another PR from a fork; retarget it to the default branch once its parent lands');
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
		expect(world.comments).toEqual([{ pr: 1, body: expect.stringMatching(/Removed from the queue/) }]);
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

	test('on a red default branch with the pipeline full, a PR held meanwhile is told', async () => {
		store.updateQueueSettings(repo.id, { config: { depth: 1 } });
		redMain();
		pr(1);
		world.hold = () => true;
		await run(2);
		expect(world.started.map((x) => x.prs)).toEqual([[1]]);
		pr(5);
		world.changesRequested.add(5);
		await run(2);
		const told = world.prChecks.filter((x) => x.sha === git.sha('pr5') && x.name === 'merge-queue').map((x) => [x.state, x.title]);
		expect(told).toEqual([['action_required', 'Changes requested']]);
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
		expect(world.comments).toEqual([{ pr: 3, body: expect.stringMatching(/^\*\*Merge queue:\*\* Removed from the queue: Fails on its own[\s\S]*\. Fix the failure, push, and queue it again\./) }]);
	});

	test('an ejection waiting for the default branch to be verified holds only itself: the other groups go on bisecting', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false, bisectRuns: 2 } });
		pr(1);
		pr(2, { file: 'x-breaks-2.txt' });
		pr(3);
		pr(4, { file: 'x-breaks-4.txt' });
		world.breakingFiles.add('x-breaks-2.txt');
		world.breakingFiles.add('x-breaks-4.txt');
		world.holdMasterRuns = true; // the default-branch run after a landing takes a while
		await run(40);
		// #1 passed alone and landed, so the default branch is being verified; #2 failed alone and
		// waits for that to be ejected. #3 and #4 were still tested meanwhile.
		expect(store.getMasterHealth(repo.id)?.state).toBe('verifying');
		const alone = (n: number) => world.started.some((x) => x.prs.length === 1 && x.prs[0] === n);
		expect([1, 2, 3, 4].filter(alone)).toEqual([1, 2, 3, 4]);
		expect(world.merged).toEqual([1, 3]);
		expect(world.comments).toEqual([]);
		world.holdMasterRuns = false;
		await run(30);
		expect(world.merged).toEqual([1, 3]);
		expect(world.comments.map((c) => c.pr).sort()).toEqual([2, 4]);
	});

	test('a refused merge takes the tested status back, so nobody can merge around the queue', async () => {
		pr(1);
		world.refuseMerge.add(1);
		await run();
		const head = git.sha('pr1');
		const last = world.prChecks.filter((s) => s.sha === head).at(-1);
		expect(last?.state).toBe('queued');
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
		expect(world.prChecks.filter((x) => x.sha === git.sha('pr1')).at(-1)?.state).toBe('queued');
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
		expect(db.getQueueItems(repo.id)[0].error_message).toBe('From a fork; a writer must approve its head first');
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
		github: ['pushBranch', 'pushHead', 'deleteBranch', 'retargetBase', 'squashMerge', 'setStatus', 'setPRCheck', 'label', 'comment'],
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
		for (const s of world.prChecks.filter((x) => x.name === 'merge-queue')) last.set(s.sha, s.state);
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

describe('stopping a red run at its first failed job', () => {
	const prsOf = (head: string) => world.started.find((x) => x.head === head)?.prs ?? [];

	test('a batch and a bisection step of several PRs fail fast and are cancelled; a PR alone is decided then, and its CI goes on for the log', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false } });
		world.slowFailures = true;
		for (let n = 1; n <= 8; n++) pr(n, n === 4 ? { file: 'x-breaks-master.txt' } : {});
		world.breakingFiles.add('x-breaks-master.txt');
		await run(80);
		expect(world.merged.sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6, 7, 8]);
		expect(world.comments).toEqual([{ pr: 4, body: expect.stringMatching(/Fails on its own/) }]);
		// Every run is read fail-fast: its first failed job decides it.
		for (const r of world.resultReads.filter((r) => prsOf(r.head).length > 0)) expect(r.failFast, `run of ${prsOf(r.head).join(' ')}`).toBe(true);
		// The failing batch and the failing step were cancelled when they failed; the lone run was not.
		const failing = world.started.filter((x) => x.prs.length > 1 && x.prs.includes(4)).map((x) => x.head);
		expect(failing.length).toBeGreaterThanOrEqual(2);
		for (const h of failing) expect(world.cancelled).toContain(h);
		// The lone run of #4 was decided at its first failure, without waiting for the rest of its
		// jobs, and never cancelled: they go on so its author gets every error.
		const lone = world.started.find((x) => x.prs.length === 1 && x.prs[0] === 4)!.head;
		expect(world.cancelled).not.toContain(lone);
		expect(world.slowReads.has(lone)).toBe(false);
		for (const h of failing) expect(world.slowReads.has(h)).toBe(false);
	});

	for (const mode of ['batch', 'serial'] as const)
		test(`${mode}: the run that ejects a stacked PR is decided at its first failure and not cancelled`, async () => {
			// 1 <- 2 <- 3 <- 4, with #3 the breaker, and #5 on its own.
			store.updateQueueSettings(repo.id, { mode, config: { retryFailed: false } });
			world.slowFailures = true;
			pr(1);
			pr(2, { from: 'pr1', base: 'pr1' });
			pr(3, { from: 'pr2', base: 'pr2', file: 'x-breaks-3.txt' });
			pr(4, { from: 'pr3', base: 'pr3' });
			pr(5);
			world.breakingFiles.add('x-breaks-3.txt');
			await run(80);
			expect(world.merged.sort((a, b) => a - b)).toEqual([1, 2, 5]);
			expect(world.comments.filter((c) => /Removed from the queue/.test(c.body)).map((c) => c.pr).sort()).toEqual([3, 4]);
			// The last run with #3 in it decided its eject at its first failure, whatever else is on its
			// branch, and was never cancelled: its jobs go on for the author's log.
			const decisive = world.started.filter((x) => x.prs.includes(3)).at(-1)!;
			expect(world.cancelled).not.toContain(decisive.head);
			expect(world.slowReads.has(decisive.head), `run of ${decisive.prs.join(' ')}`).toBe(false);
			// Earlier failing runs with #3 and other suspects stopped at their first failure.
			for (const x of world.started.filter((x) => x.prs.includes(3) && x !== decisive)) expect(world.cancelled, `run of ${x.prs.join(' ')}`).toContain(x.head);
		});

	test('off, a red run is read to its end', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false, stopOnFirstFailure: false } });
		pr(1);
		pr(2, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		await run(60);
		expect(world.merged).toEqual([1]);
		expect(world.resultReads.every((r) => !r.failFast)).toBe(true);
		expect(world.cancelled).toEqual([]);
	});

	test('a failed run of one PR that is still running blocks no bisection step: the next starts at once', async () => {
		store.updateQueueSettings(repo.id, { config: { retryFailed: false, bisectRuns: 1 } });
		world.slowFailures = true;
		pr(1, { file: 'x-breaks-master.txt' });
		pr(2);
		world.breakingFiles.add('x-breaks-master.txt');
		await run(40);
		expect(world.merged).toEqual([2]);
		const lone1 = world.started.find((x) => x.prs.length === 1 && x.prs[0] === 1)!.head;
		const lone2 = world.started.find((x) => x.prs.length === 1 && x.prs[0] === 2)!.head;
		// #2's run started while #1's lone run was still going, and nothing waited for #1's to end.
		expect(world.started.findIndex((x) => x.head === lone2)).toBeGreaterThan(world.started.findIndex((x) => x.head === lone1));
		expect(world.slowReads.has(lone1)).toBe(false);
		expect(world.cancelled).not.toContain(lone1);
		expect(world.comments).toEqual([{ pr: 1, body: expect.stringMatching(/Fails on its own[\s\S]*CI run: https:\/\/ci\.example\//) }]);
	});

	test('a failed run of one PR waits for its flake re-run while retries are on', async () => {
		world.slowFailures = true;
		world.rerunWaits = 2;
		pr(1, { file: 'x-breaks-master.txt' });
		world.breakingFiles.add('x-breaks-master.txt');
		await run(40);
		expect(world.merged).toEqual([]);
		const head = world.started[0].head;
		// It failed early, but a re-run of its failed jobs could still pass: it waited for it.
		expect(world.reruns.get(head)).toBe(1);
		expect(world.comments).toEqual([{ pr: 1, body: expect.stringMatching(/^\*\*Merge queue:\*\* Removed from the queue: CI failed[\s\S]*CI run: https:\/\/ci\.example\//) }]);
	});

	test('a fail-fast failure is still re-run once when flake retries are on', async () => {
		world.slowFailures = true;
		pr(1);
		pr(2, { file: 'x-breaks-master.txt' });
		pr(3);
		world.breakingFiles.add('x-breaks-master.txt');
		await run(60);
		expect(world.merged).toEqual([1, 3]);
		const head = world.started[0].head;
		expect(world.reruns.get(head)).toBe(1);
		// It stopped early (read with fail-fast, cancelled), and only then was re-run.
		expect(world.resultReads.some((r) => r.head === head && r.failFast)).toBe(true);
		expect(world.ciOps.filter((o) => o.endsWith(head)).slice(0, 2)).toEqual([`cancel ${head}`, `rerun ${head}`]);
	});
});

describe('batch queue runtime, randomised', () => {
	// Whole queue runs with random breakers, interacting pairs and stacks, two bisection runs at once. After
	// every tick: no PR shows a green merge-queue status on its head unless it merged, the default
	// branch never holds a breaker, and in the end every PR merged or was ejected with a comment.
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
		test(`seed ${seed}`, { timeout: 120_000 }, async () => {
			let s = seed * 7919;
			const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
			store.updateQueueSettings(repo.id, { config: { retryFailed: false, bisectRuns: 2 } });
			const n = 5 + Math.floor(rnd() * 5);
			const prs = Array.from({ length: n }, (_, i) => i + 1);
			const breakers = new Set(prs.filter(() => rnd() < 0.2));
			const pair = rnd() < 0.5 ? prs.filter((p) => !breakers.has(p)).sort(() => rnd() - 0.5).slice(0, 2) : [];
			// Some PRs are stacked on the one before them.
			const parents = new Map<number, number>();
			for (const p of prs) {
				const file = breakers.has(p) ? `x-breaks-${p}.txt` : pair.includes(p) ? `x-pair-${p}.txt` : undefined;
				if (p > 1 && rnd() < 0.25) parents.set(p, p - 1);
				pr(p, parents.has(p) ? { file, from: `pr${p - 1}`, base: `pr${p - 1}` } : { file });
				if (file && breakers.has(p)) world.breakingFiles.add(file);
			}
			if (pair.length === 2) world.conflictPairs.push(pair.map((p) => `x-pair-${p}.txt`));
			const head = (p: number) => git.sha(`pr${p}`);
			for (let tick = 0; tick < 120 && queued().length; tick++) {
				await tickBatchQueue(world.deps());
				for (const p of prs) {
					const last = world.prChecks.filter((x) => x.sha === head(p) && x.name === 'merge-queue').at(-1);
					if (last?.state === 'success') expect(world.merged, `#${p} green but not merged after tick ${tick}`).toContain(p);
				}
				expect(world.ciFails(git.sha('main')), `main broke after tick ${tick}`).toBe(false);
			}
			expect(queued()).toEqual([]);
			const ejected = new Set(world.comments.filter((c) => /Removed from the queue/.test(c.body)).map((c) => c.pr));
			expect([...world.merged, ...ejected].sort((a, b) => a - b)).toEqual(prs);
			for (const b of breakers) expect(ejected).toContain(b);
			// Of an interacting pair, at most one is ejected; every other PR merges, but for what is
			// stacked on an ejected PR, which leaves with it.
			const onEjected = (p: number) => {
				for (let q = parents.get(p); q !== undefined; q = parents.get(q)) if (ejected.has(q)) return true;
				return false;
			};
			expect([...ejected].filter((p) => !breakers.has(p) && !onEjected(p)).length).toBeLessThanOrEqual(pair.length ? 1 : 0);
		});
});

describe('one by one, on the batch runtime', () => {
	beforeEach(() => store.updateQueueSettings(repo.id, { mode: 'serial', config: { retryFailed: false, collectWindowMs: 60 * 60 * 1000, depth: 2 } }));

	/** Ticks until the queue is empty, checking that at most one run is ever in flight. */
	async function runSerial(ticks = 60) {
		for (let i = 0; i < ticks && queued().length; i++) {
			await tickBatchQueue(world.deps());
			expect(store.getActiveBatches(repo.id).length, `runs in flight after tick ${i}`).toBeLessThanOrEqual(1);
		}
	}
	const ejected = () => world.comments.filter((c) => /Removed from the queue/.test(c.body)).map((c) => c.pr);

	test('tests the head stack whole, one run at a time, without waiting to collect more', async () => {
		pr(1);
		pr(2);
		pr(3, { from: 'pr2', base: 'pr2' });
		pr(4);
		await runSerial();
		expect(world.started.map((s) => s.prs)).toEqual([[1], [2, 3], [4]]);
		expect(world.merged).toEqual([1, 2, 3, 4]);
		expect(mainFiles()).toEqual(['pr1.txt', 'pr2.txt', 'pr3.txt', 'pr4.txt']);
	});

	test('a lone PR that fails is ejected, and the next one goes', async () => {
		pr(1);
		pr(2, { file: 'x-breaks-master.txt' });
		pr(3);
		world.breakingFiles.add('x-breaks-master.txt');
		await runSerial();
		expect(world.started.map((s) => s.prs)).toEqual([[1], [2], [3]]);
		expect(world.merged).toEqual([1, 3]);
		expect(ejected()).toEqual([2]);
	});

	test('a red stack lands its good part and ejects the PR that breaks it, with what sits on it', async () => {
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1' });
		pr(3, { from: 'pr2', base: 'pr2', file: 'x-breaks-3.txt' });
		pr(4, { from: 'pr3', base: 'pr3' });
		pr(5);
		world.breakingFiles.add('x-breaks-3.txt');
		await runSerial();
		expect(world.started[0].prs).toEqual([1, 2, 3, 4]);
		expect(world.merged).toEqual([1, 2, 5]);
		expect(ejected().sort()).toEqual([3, 4]);
		// Every run tests a stack's prefix: never a child without its parent.
		for (const s of world.started.slice(1)) {
			if (s.prs.includes(5)) expect(s.prs).toEqual([5]);
			else expect(s.prs).toEqual([1, 2, 3, 4].slice(s.prs[0] - 1, s.prs[0] - 1 + s.prs.length));
		}
	});

	test('a stack that is partly held goes with its good part', async () => {
		pr(1);
		pr(2, { from: 'pr1', base: 'pr1', approve: false });
		pr(3);
		await runSerial(20);
		expect(world.started.map((s) => s.prs)).toEqual([[1], [3]]);
		expect(world.merged).toEqual([1, 3]);
	});
});

describe('both planners, the same queue', () => {
	// The same queue of PRs, with breakers and stacks but no PRs that interact, run one by one and
	// in batches: the same PRs land and the same PRs leave. Only the cost differs.
	async function outcome(seed: number, mode: 'serial' | 'batch') {
		let s = seed * 7919;
		const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
		store.updateQueueSettings(repo.id, { mode, config: { retryFailed: false, bisectRuns: 2, maxBatch: 4, collectWindowMs: 0, depth: 2 } });
		const n = 5 + Math.floor(rnd() * 6);
		const prs = Array.from({ length: n }, (_, i) => i + 1);
		const breakers = new Set(prs.filter(() => rnd() < 0.25));
		for (const p of prs) {
			const file = breakers.has(p) ? `x-breaks-${p}.txt` : undefined;
			pr(p, p > 1 && rnd() < 0.35 ? { file, from: `pr${p - 1}`, base: `pr${p - 1}` } : { file });
			if (file) world.breakingFiles.add(file);
		}
		for (let tick = 0; tick < 150 && queued().length; tick++) {
			await tickBatchQueue(world.deps());
			expect(world.ciFails(git.sha('main')), `${mode}: main broke after tick ${tick}`).toBe(false);
		}
		expect(queued(), mode).toEqual([]);
		const ejected = world.comments.filter((c) => /Removed from the queue/.test(c.body)).map((c) => c.pr);
		return { merged: [...world.merged].sort((a, b) => a - b), ejected: ejected.sort((a, b) => a - b), runs: world.started.length };
	}

	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
		test(`seed ${seed}`, { timeout: 120_000 }, async () => {
			const serial = await outcome(seed, 'serial');
			// A fresh repository for the second run of the same queue.
			git.cleanup();
			git = new GitSandbox();
			world = new World();
			const name = `repo${++repoSeq}`;
			db.addRepo('acme', name, 'main', db.upsertUser(1, 'dev', null, null));
			repo = { ...db.getRepoByOwnerName('acme', name)!, default_branch: 'main' };
			store.setMasterHealth(repo.id, { sha: git.sha('main'), tree: git.git('rev-parse', 'main^{tree}'), state: 'green', since: 0 });
			const batch = await outcome(seed, 'batch');
			expect({ merged: batch.merged, ejected: batch.ejected }).toEqual({ merged: serial.merged, ejected: serial.ejected });
		});
});
