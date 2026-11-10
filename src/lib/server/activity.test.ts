import { afterEach, describe, expect, test } from 'vitest';
import { activityOf, clearActivity, trackActivity, withActivity } from './activity';
import { RateLimitedError } from './rate-limit';
import type { LivePR, QueueDeps } from './batch-queue';
import type { BuildResult } from './batch-builder';

const REPO = { id: 7, owner: 'o', name: 'r', default_branch: 'main' };

const live = (n: number, extra: Partial<LivePR> = {}): LivePR => ({
	pr: n,
	headSha: `head${n}`,
	headRef: `feature-${n}`,
	sameRepo: true,
	draft: false,
	title: `PR ${n}`,
	url: '',
	authorLogin: 'a',
	baseRef: 'main',
	state: 'open',
	merged: false,
	...extra
});

/** A promise the test settles by hand, to look at the activity while a call runs. */
function gate<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const ok: BuildResult = { ok: true, headSha: 'batch', tree: 't', commits: [] };

/** Deps whose calls answer at once, with `over` replacing some of them; `clock.t` is the time. */
function fakeDeps(over: { git?: Partial<QueueDeps['git']>; github?: Partial<QueueDeps['github']>; ci?: Partial<QueueDeps['ci']>; analysis?: QueueDeps['analysis'] } = {}) {
	const clock = { t: 1_000_000 };
	const deps = {
		repo: REPO,
		now: () => clock.t,
		analysis: over.analysis ?? (async () => ({ prs: new Map(), stacks: [], issues: [] })),
		git: { fetch: async () => {}, tree: async () => 't', build: async () => ok, restack: async () => ({ ok: true, head: 'new', tree: 't', replayed: 1 }), baseline: async () => 'b', ...over.git },
		github: {
			defaultBranchSha: async () => 'master',
			pr: async (n: number) => live(n),
			openPRs: async () => [live(1), live(2), live(3)],
			readiness: async () => ({ ciGreen: true, approvedShas: [], changesRequested: false }),
			pushBranch: async () => {},
			pushHead: async () => {},
			deleteBranch: async () => {},
			retargetBase: async () => {},
			squashMerge: async () => ({ merged: true, sha: 'm' }),
			setStatus: async () => {},
			setPRCheck: async () => {},
			label: async () => {},
			comment: async () => {},
			...over.github
		},
		ci: { start: async () => {}, refreshCaches: async () => {}, result: async () => 'pending' as const, cancel: async () => {}, rerunFailed: async () => 'none' as const, runUrl: async () => null, ...over.ci }
	} satisfies QueueDeps;
	return { deps: deps as QueueDeps, clock };
}

const member = (n: number) => ({ pr: n, headSha: `head${n}`, title: `PR ${n}` });

afterEach(() => clearActivity(REPO.id));

describe('activity of a queue step', () => {
	test('forming a batch: while its branch is pushed, the page sees the batch, its PRs, the branch, the step and since when', async () => {
		const push = gate();
		const { deps, clock } = fakeDeps({ github: { pushBranch: () => push.promise } });
		const d = trackActivity(deps);
		await d.github.pr(1);
		await d.github.pr(2);
		await d.git.fetch(['master', 'head1', 'head2']);
		const started = clock.t;
		await d.git.build('master', [member(1), member(2)]);
		clock.t += 42_000;
		const pushing = d.github.pushBranch('mq/batch-5', 'batch');
		clock.t += 3_000;
		expect(activityOf(REPO.id)).toMatchObject({
			phase: { kind: 'forming', label: 'Forming a batch', prs: [1, 2], branch: 'mq/batch-5', since: started },
			step: { label: 'pushing mq/batch-5', prs: [1, 2], since: started + 42_000 },
			failure: null
		});
		push.resolve();
		await pushing;
		expect(activityOf(REPO.id).step).toBeNull();
		expect(activityOf(REPO.id).phase?.kind).toBe('forming');
	});

	test('a fetch names the PRs whose heads it fetches, known from the PRs read before it', async () => {
		const fetch = gate();
		const { deps } = fakeDeps({ git: { fetch: () => fetch.promise } });
		const d = trackActivity(deps);
		await d.github.openPRs!();
		const p = d.git.fetch(['master', 'head3', 'head1']);
		expect(activityOf(REPO.id).step).toMatchObject({ label: 'fetching #3 #1 from GitHub', prs: [3, 1] });
		fetch.resolve();
		await p;
	});

	test('a batch is formed from when the fetch of its PRs began', async () => {
		const { deps, clock } = fakeDeps();
		const d = trackActivity(deps);
		await d.github.pr(1);
		const fetched = clock.t;
		await d.git.fetch(['master', 'head1']);
		clock.t += 60_000;
		await d.git.build('master', [member(1)]);
		expect(activityOf(REPO.id).phase).toMatchObject({ kind: 'forming', since: fetched });
	});

	test('after a batch fails to build, building one of its PRs alone on the default branch is the conflict check of that PR', async () => {
		const probe = gate<BuildResult>();
		let builds = 0;
		const { deps } = fakeDeps({
			git: {
				build: async (base, members) => {
					builds++;
					if (builds === 1) return { ok: false, pr: 2, reason: 'conflict', conflicts: ['a'], commits: [] };
					return probe.promise;
				}
			}
		});
		const d = trackActivity(deps);
		await d.git.build('master', [member(1), member(2), member(3)]);
		const p = d.git.build('master', [{ ...member(2), parentHeadSha: null }]);
		expect(activityOf(REPO.id)).toMatchObject({
			phase: { kind: 'forming', label: 'Forming a batch', prs: [1, 2, 3] },
			step: { label: 'checking #2 against main', prs: [2] }
		});
		probe.resolve(ok);
		await p;
	});

	test('while a batch is bisecting, a build is a bisection step, and so is a pushed bisection branch', async () => {
		const push = gate();
		const { deps } = fakeDeps({ github: { pushBranch: () => push.promise } });
		const d = trackActivity(deps, { buildKind: () => 'bisect' });
		await d.git.build('base', [member(1), member(2)]);
		expect(activityOf(REPO.id).phase).toMatchObject({ kind: 'bisect', label: 'Preparing a bisection step', prs: [1, 2] });
		const p = d.github.pushBranch('mq/batch-5-bisect-2-99', 'x');
		expect(activityOf(REPO.id).phase).toMatchObject({ kind: 'bisect', branch: 'mq/batch-5-bisect-2-99' });
		push.resolve();
		await p;
	});

	test('a pushed branch says what was built: a batch, a bisection step, a try run or a check of the default branch', async () => {
		const { deps } = fakeDeps();
		const labels: string[] = [];
		for (const branch of ['mq/batch-1', 'mq/batch-1-bisect-1-5', 'mq/try-4-5', 'mq/base-5']) {
			const d = trackActivity(deps);
			await d.git.build('master', [member(4)]);
			await d.github.pushBranch(branch, 'x');
			labels.push(activityOf(REPO.id).phase!.label);
			clearActivity(REPO.id);
		}
		expect(labels).toEqual(['Forming a batch', 'Preparing a bisection step', 'Starting a try run', 'Checking main']);
	});

	test('a try run is one from its build on', async () => {
		const { deps } = fakeDeps();
		await withActivity(
			deps,
			async (d) => {
				await d.git.build('master', [member(4)]);
				expect(activityOf(REPO.id).phase).toMatchObject({ kind: 'try', label: 'Starting a try run', prs: [4] });
			},
			{ buildKind: () => 'try' }
		);
	});

	test('the check of the default branch: its baseline commit and push', async () => {
		const { deps } = fakeDeps();
		const d = trackActivity(deps);
		await d.git.baseline('master');
		expect(activityOf(REPO.id).phase).toMatchObject({ kind: 'master', label: 'Checking main', prs: [] });
	});

	test('restacking a PR on its parent: the rebase and the push of its new head name it', async () => {
		const rebase = gate<{ ok: true; head: string; tree: string; replayed: number }>();
		const push = gate();
		const { deps } = fakeDeps({ git: { restack: () => rebase.promise }, github: { pushHead: () => push.promise } });
		const d = trackActivity(deps);
		await d.github.pr(4);
		const r = d.git.restack('head4', 'stale', 'parent');
		expect(activityOf(REPO.id)).toMatchObject({ phase: { kind: 'restack', label: 'Restacking #4', prs: [4] }, step: { label: 'rebasing #4', prs: [4] } });
		rebase.resolve({ ok: true, head: 'new4', tree: 't', replayed: 1 });
		await r;
		const p = d.github.pushHead('feature-4', 'new4', 'head4');
		expect(activityOf(REPO.id).step).toMatchObject({ label: 'pushing the restacked #4', prs: [4] });
		push.resolve();
		await p;
	});

	test('landing a batch: each merge adds its PR, and restacking a child to land it is part of the landing', async () => {
		const merge = gate<{ merged: boolean; sha: string }>();
		let merges = 0;
		const { deps } = fakeDeps({ github: { squashMerge: async () => (++merges === 2 ? merge.promise : { merged: true, sha: 'm1' }) } });
		const d = trackActivity(deps);
		await d.github.pr(1);
		await d.github.pr(2);
		await d.github.squashMerge(1, 'PR 1 (#1)', 'head1');
		await d.git.restack('head2', 'fork', 'm1');
		expect(activityOf(REPO.id).phase).toMatchObject({ kind: 'landing', label: 'Landing', prs: [1, 2] });
		const p = d.github.squashMerge(2, 'PR 2 (#2)', 'new2');
		expect(activityOf(REPO.id)).toMatchObject({ phase: { kind: 'landing', prs: [1, 2] }, step: { label: 'merging #2 into main', prs: [2] } });
		merge.resolve({ merged: true, sha: 'm2' });
		await p;
	});

	test('a failed step is kept with its batch, PRs and error after the tick, until the same step next succeeds', async () => {
		let fail = true;
		const { deps, clock } = fakeDeps({
			github: {
				pushBranch: async () => {
					if (fail) throw new Error('refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml`');
				}
			}
		});
		await withActivity(deps, async (d) => {
			await d.git.build('master', [member(1), member(2)]);
			await d.github.pushBranch('mq/batch-5', 'x').catch(() => {});
		});
		expect(activityOf(REPO.id)).toEqual({
			since: null,
			phase: null,
			step: null,
			failure: {
				phase: 'Forming a batch',
				step: 'pushing mq/batch-5',
				prs: [1, 2],
				message: 'refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml`',
				at: clock.t
			}
		});
		// Other steps succeeding don't clear it; the same step does.
		await withActivity(deps, async (d) => {
			await d.git.build('master', [member(3)]);
		});
		expect(activityOf(REPO.id).failure).not.toBeNull();
		fail = false;
		await withActivity(deps, async (d) => {
			await d.git.build('master', [member(3)]);
			await d.github.pushBranch('mq/batch-6', 'x');
		});
		expect(activityOf(REPO.id).failure).toBeNull();
	});

	test('the error still reaches the caller', async () => {
		const { deps } = fakeDeps({ git: { fetch: async () => Promise.reject(new Error('timeout')) } });
		const d = trackActivity(deps);
		await expect(d.git.fetch(['x'])).rejects.toThrow('timeout');
		expect(activityOf(REPO.id).failure).toMatchObject({ phase: null, step: 'fetching commits from GitHub', message: 'timeout' });
		expect(activityOf(REPO.id).step).toBeNull();
	});

	test("a rate limit is not a failed step: the page has its own notice for it", async () => {
		const { deps } = fakeDeps({ github: { pushBranch: async () => Promise.reject(new RateLimitedError(5, 'rate limited')) } });
		const d = trackActivity(deps);
		await d.github.pushBranch('mq/batch-1', 'x').catch(() => {});
		expect(activityOf(REPO.id).failure).toBeNull();
	});

	test('a failed cleanup the queue ignores (deleting a branch, cancelling CI, a label, a comment, a check) is not shown', async () => {
		const boom = async () => Promise.reject(new Error('boom'));
		const { deps } = fakeDeps({ github: { deleteBranch: boom, label: boom, comment: boom, setPRCheck: boom }, ci: { cancel: boom } });
		const d = trackActivity(deps);
		await d.github.deleteBranch('mq/x').catch(() => {});
		await d.ci.cancel('x').catch(() => {});
		await d.github.label(1, 'needs-rebase', true).catch(() => {});
		await d.github.comment(1, 'hi').catch(() => {});
		await d.github.setPRCheck('x', { state: 'queued', title: 't' }).catch(() => {});
		expect(activityOf(REPO.id).failure).toBeNull();
	});

	test('a tick is running from when it starts until it ends, even when it throws; its batch and step go with it', async () => {
		const { deps, clock } = fakeDeps();
		const start = clock.t;
		let seen: ReturnType<typeof activityOf> | null = null;
		await expect(
			withActivity(deps, async (d) => {
				await d.git.build('master', [member(1)]);
				clock.t += 5_000;
				seen = activityOf(REPO.id);
				throw new Error('later step failed');
			})
		).rejects.toThrow('later step failed');
		expect(seen).toMatchObject({ since: start, phase: { kind: 'forming' } });
		expect(activityOf(REPO.id)).toMatchObject({ since: null, phase: null, step: null });
	});

	test('routine reads are steps too, with the PR they read', async () => {
		const read = gate<{ ciGreen: boolean; approvedShas: string[]; changesRequested: boolean }>();
		const { deps } = fakeDeps({ github: { readiness: () => read.promise } });
		const d = trackActivity(deps);
		const p = d.github.readiness(9, 'head9', 'a');
		expect(activityOf(REPO.id)).toMatchObject({ phase: null, step: { label: 'reading the reviews and checks of #9', prs: [9] } });
		read.resolve({ ciGreen: true, approvedShas: [], changesRequested: false });
		await p;
	});

	test("one repository's activity is not another's", async () => {
		const { deps } = fakeDeps();
		await trackActivity(deps).git.build('master', [member(1)]);
		expect(activityOf(REPO.id + 1)).toEqual({ since: null, phase: null, step: null, failure: null });
	});
});
