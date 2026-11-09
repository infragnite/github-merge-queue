import { afterEach, beforeEach, describe, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');
const store = await import('./batch-store');
const { tickBatchQueue } = await import('./batch-queue');
const { buildBatch, GitRunner } = await import('./batch-builder');
const { analyzeStacks } = await import('./stacks');
import { GitSandbox } from './testing/git-sandbox';
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

	files(sha: string) {
		return new Set(git.git('ls-tree', '-r', '--name-only', sha).split('\n'));
	}

	ciFails(sha: string) {
		const f = this.files(sha);
		if ([...this.breakingFiles].some((b) => f.has(b))) return true;
		return this.conflictPairs.some((pair) => pair.every((p) => f.has(p)));
	}

	deps(): QueueDeps {
		const runner = new GitRunner(git.dir);
		return {
			repo,
			now: () => Date.now() + this.started.length,
			log: () => {},
			analysis: async () => analyzeStacks(git.input()),
			git: {
				fetch: async () => {},
				tree: async (sha) => git.git('rev-parse', `${sha}^{tree}`),
				build: async (base, members) => buildBatch(runner, base, members)
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
				rerunFailed: async (head) => {
					this.reruns.set(head, (this.reruns.get(head) ?? 0) + 1);
					this.ciPendingOnce.add(head);
					return true;
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
						draft: false,
						ciGreen: !this.ciRed.has(n),
						approvedShas: this.approved.has(n) ? [head] : [],
						changesRequested: false,
						title: `PR ${n}`,
						url: `https://example.test/pull/${n}`,
						authorLogin: 'dev',
						baseRef: p.baseRef,
						state: p.state,
						merged: p.merged
					};
				},
				pushBranch: async (branch, sha) => {
					git.git('branch', '-f', branch, sha);
				},
				deleteBranch: async (branch) => {
					git.git('branch', '-D', branch);
				},
				retargetBase: async (n, base) => git.retarget(n, base),
				squashMerge: async (n) => {
					git.merge(n, 'squash');
					this.merged.push(n);
					return { merged: true };
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
		expect(world.reruns.size).toBe(1);
		expect(world.started.length).toBeGreaterThanOrEqual(4);
		expect(world.started.at(-1)!.prs).toEqual([1, 2, 4]);
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

	test('a PR that conflicts textually is ejected at build time, without CI', async () => {
		pr(1, { file: 'same.txt' });
		pr(2, { file: 'same.txt' });
		pr(3);
		await run();
		expect(world.comments).toEqual([{ pr: 2, body: expect.stringMatching(/conflicts with the batch.*same.txt/) }]);
		expect(world.started.map((s) => s.prs)).toEqual([[1, 3]]);
		expect(world.merged).toEqual([1, 3]);
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
		expect(world.started).toHaveLength(2);
		expect(store.getRecentBatches(repo.id).map((b) => b.status).sort()).toEqual(['landed', 'superseded']);
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
});
