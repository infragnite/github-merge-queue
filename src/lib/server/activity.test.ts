import { afterEach, describe, expect, test } from 'vitest';
import { activityOf, clearActivity, trackActivity, withActivity } from './activity';
import { RateLimitedError } from './rate-limit';
import { HeadMovedError } from './head-moved';
import { GitHubError } from './github-retry';
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
		// `changed` is in QueueGit from #42 on; the cast below keeps this file checking before and after it.
		git: { fetch: async () => {}, changed: async () => [] as string[], tree: async () => 't', build: async () => ok, restack: async () => ({ ok: true, head: 'new', tree: 't', replayed: 1 }), baseline: async () => 'b', mergeTrees: async () => ({ queue: 't', line: 't' }), mergeCommit: async () => 'm', ...over.git },
		github: {
			defaultBranchSha: async () => 'master',
			pr: async (n: number) => live(n),
			openPRs: async () => [live(1), live(2), live(3)],
			readiness: async () => ({ ciGreen: true, approvedShas: [], changesRequested: false }),
			pushBranch: async () => {},
			pushHead: async () => {},
			pushKeepsApproval: async () => true,
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
	};
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
		await d.git.build('master', [member(1), member(2)], { attrs: 'master' });
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
		await d.git.build('master', [member(1)], { attrs: 'master' });
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
		await d.git.build('master', [member(1), member(2), member(3)], { attrs: 'master' });
		const p = d.git.build('master', [{ ...member(2), parentHeadSha: null }], { attrs: 'master' });
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
		await d.git.build('base', [member(1), member(2)], { attrs: 'master' });
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
			await d.git.build('master', [member(4)], { attrs: 'master' });
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
				await d.git.build('master', [member(4)], { attrs: 'master' });
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
		const r = d.git.restack('head4', 'stale', 'parent', 'master');
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
		await d.git.restack('head2', 'fork', 'm1', 'm1');
		expect(activityOf(REPO.id).phase).toMatchObject({ kind: 'landing', label: 'Landing', prs: [1, 2] });
		const p = d.github.squashMerge(2, 'PR 2 (#2)', 'new2');
		expect(activityOf(REPO.id)).toMatchObject({ phase: { kind: 'landing', prs: [1, 2] }, step: { label: 'merging #2 into main', prs: [2] } });
		merge.resolve({ merged: true, sha: 'm2' });
		await p;
	});

	const WORKFLOWS = "! [remote rejected] x -> mq/batch-5 (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)";
	const GRANT_WORKFLOWS = "Grant the GitHub App the Workflows (read and write) permission, then approve it on this account's installation";

	test('a failed step someone can fix is kept with its batch, PRs and what to do, until the same step next succeeds', async () => {
		let fail = true;
		const { deps, clock } = fakeDeps({
			github: {
				pushBranch: async () => {
					if (fail) throw new Error(WORKFLOWS);
				}
			}
		});
		await withActivity(deps, async (d) => {
			await d.git.build('master', [member(1), member(2)], { attrs: 'master' });
			await d.github.pushBranch('mq/batch-5', 'x').catch(() => {});
		});
		expect(activityOf(REPO.id)).toEqual({
			since: null,
			phase: null,
			step: null,
			failure: { phase: 'Forming a batch', step: 'pushing mq/batch-5', prs: [1, 2], action: GRANT_WORKFLOWS, at: clock.t }
		});
		// Other steps succeeding don't clear it; the same step does.
		await withActivity(deps, async (d) => {
			await d.git.build('master', [member(3)], { attrs: 'master' });
		});
		expect(activityOf(REPO.id).failure).not.toBeNull();
		fail = false;
		await withActivity(deps, async (d) => {
			await d.git.build('master', [member(3)], { attrs: 'master' });
			await d.github.pushBranch('mq/batch-6', 'x');
		});
		expect(activityOf(REPO.id).failure).toBeNull();
	});

	test('a missing App permission names the permission the call needs', async () => {
		const notAccessible = (path: string) => async () => Promise.reject(new GitHubError(403, `Resource not accessible by integration: ${path}`));
		const cases: [string, (d: QueueDeps) => Promise<unknown>, Partial<QueueDeps['github']> | Partial<QueueDeps['ci']>, 'github' | 'ci', string][] = [
			['retargetBase', (d) => d.github.retargetBase(4, 'main'), { retargetBase: notAccessible('PATCH /repos/o/r/pulls/4') }, 'github', 'Pull requests (read and write)'],
			['squashMerge', (d) => d.github.squashMerge(4, 't', 'h'), { squashMerge: notAccessible('PUT /repos/o/r/pulls/4/merge') }, 'github', 'Contents (read and write)'],
			['ci.start', (d) => d.ci.start('mq/batch-1', 'b', 'h', [1]), { start: notAccessible('POST /repos/o/r/actions/workflows/ci.yml/dispatches') }, 'ci', 'Actions (read and write)']
		];
		for (const [, call, over, where, permission] of cases) {
			clearActivity(REPO.id);
			const { deps } = fakeDeps({ [where]: over });
			await call(trackActivity(deps)).catch(() => {});
			expect(activityOf(REPO.id).failure?.action).toBe(`Grant the GitHub App the ${permission} permission, then approve it on this account's installation`);
		}
	});

	test("git refusing the App's push for lack of access names the Contents permission", async () => {
		const denied = 'git push failed: remote: Permission to o/r.git denied to merge-queue[bot].\nfatal: unable to access \'https://github.com/o/r.git/\': The requested URL returned error: 403';
		const { deps } = fakeDeps({ github: { pushHead: async () => Promise.reject(new Error(denied)) } });
		await trackActivity(deps).github.pushHead('feature-4', 'new4', 'head4').catch(() => {});
		expect(activityOf(REPO.id).failure?.action).toBe("Grant the GitHub App the Contents (read and write) permission, then approve it on this account's installation");
	});

	test('a failure nobody can act on (a timeout, a server error) goes to the log only; the error still reaches the caller', async () => {
		const { deps } = fakeDeps({ git: { fetch: async () => Promise.reject(new Error('timeout')) }, github: { pushBranch: async () => Promise.reject(new GitHubError(502, 'Server Error')) } });
		const d = trackActivity(deps);
		await expect(d.git.fetch(['x'])).rejects.toThrow('timeout');
		await expect(d.github.pushBranch('mq/batch-1', 'x')).rejects.toThrow('Server Error');
		expect(activityOf(REPO.id).failure).toBeNull();
		expect(activityOf(REPO.id).step).toBeNull();
	});

	test('a push that lost its lease is not a failure: the author pushed first, and the next tick reads the new head', async () => {
		const { deps } = fakeDeps({ github: { pushHead: async (branch, _sha, expected) => Promise.reject(new HeadMovedError(branch, expected)) } });
		const d = trackActivity(deps);
		await d.github.pr(4);
		await expect(d.github.pushHead('feature-4', 'new4', 'head4')).rejects.toBeInstanceOf(HeadMovedError);
		expect(activityOf(REPO.id).failure).toBeNull();
	});

	test('a tick that ends without the failure again clears it; an action (a try run) or a tick that throws does not', async () => {
		let fail = true;
		const { deps } = fakeDeps({ github: { pushBranch: async () => (fail ? Promise.reject(new Error(WORKFLOWS)) : undefined) } });
		const tick = { tick: true };
		await withActivity(deps, (d) => d.github.pushBranch('mq/batch-1', 'x').catch(() => {}), tick);
		expect(activityOf(REPO.id).failure).not.toBeNull();
		// The same failure again in the next tick keeps it.
		await withActivity(deps, (d) => d.github.pushBranch('mq/batch-2', 'x').catch(() => {}), tick);
		expect(activityOf(REPO.id).failure).not.toBeNull();
		fail = false;
		// An action that never pushes says nothing about it.
		await withActivity(deps, async () => {});
		expect(activityOf(REPO.id).failure).not.toBeNull();
		// Nor does a tick that stopped part way.
		await expect(withActivity(deps, async () => Promise.reject(new Error('later step failed')), tick)).rejects.toThrow();
		expect(activityOf(REPO.id).failure).not.toBeNull();
		// A whole tick without it: it is over, even though nothing pushed a batch.
		await withActivity(deps, async () => {}, tick);
		expect(activityOf(REPO.id).failure).toBeNull();
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
				await d.git.build('master', [member(1)], { attrs: 'master' });
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
		await trackActivity(deps).git.build('master', [member(1)], { attrs: 'master' });
		expect(activityOf(REPO.id + 1)).toEqual({ since: null, phase: null, step: null, failure: null });
	});
});
