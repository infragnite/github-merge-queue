import { afterEach, beforeEach, describe, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');
const store = await import('./batch-store');
const { tickBatchQueue, startTry, retireBatches } = await import('./batch-queue');
const { baselineCommit, buildBatch, GitRunner } = await import('./batch-builder');
const { replay } = await import('./rebase');
const { analyzeStacks } = await import('./stacks');
import { GitSandbox } from './testing/git-sandbox';
import { writeFileSync } from 'node:fs';
import type { LivePR, QueueDeps } from './batch-queue';

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
	prStatuses: { sha: string; state: string; description: string; context: string }[] = [];
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
	/** PRs opened from a fork. */
	forks = new Set<number>();

	files(sha: string) {
		return new Set(git.git('ls-tree', '-r', '--name-only', sha).split('\n'));
	}

	everythingFails = false;

	ciFails(sha: string) {
		if (this.everythingFails) return true;
		const f = this.files(sha);
		if ([...this.breakingFiles].some((b) => f.has(b))) return true;
		return this.conflictPairs.some((pair) => pair.every((p) => f.has(p)));
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
					if (this.ciPendingOnce.delete(head)) return 'pending';
					const flakeNow = this.flaky.has(head) && !this.reruns.has(head);
					return flakeNow || this.ciFails(head) ? 'failure' : 'success';
				},
				cancel: async (head) => {
					this.cancelled.push(head);
				},
				refreshCaches: async () => {
					this.cacheRefreshes++;
				},
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
					this.prStatuses.push({ sha, state, description, context: `merge-queue${opts?.suffix ?? ''}` });
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
					if (this.refuseMerge.has(n)) return { merged: false, message: 'Repository rule violations found' };
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
		expect(world.started.at(-1)!.prs).toEqual([1, 2, 4]);
		// the survivors land on the bisection's own proof run, not a fresh batch
		expect(store.getRecentBatches(repo.id).filter((b) => b.kind === 'batch')).toHaveLength(1);
		expect(store.getRecentBatches(repo.id).find((b) => b.kind === 'batch')?.status).toBe('landed');
	});

	test('finds two PRs that only break together and ejects the later one', async () => {
		pr(1, { file: 'x-adds-field.txt' });
		pr(2);
		pr(3, { file: 'x-uses-old-initializer.txt' });
		world.conflictPairs.push(['x-adds-field.txt', 'x-uses-old-initializer.txt']);
		await run(60);
		expect(world.merged).toEqual([1, 2]);
		expect(world.comments[0]).toMatchObject({ pr: 3, body: expect.stringMatching(/combined with/) });
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

	test('a PR pushed to after its batch was built is rebuilt, not landed stale', async () => {
		pr(1);
		pr(2);
		await tickBatchQueue(world.deps());
		git.commit('pr2', 'late change');
		await run();
		expect(world.started).toHaveLength(2);
		expect(world.merged).toEqual([1, 2]);
		expect(world.files('main').has('late-change.txt')).toBe(true);
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
