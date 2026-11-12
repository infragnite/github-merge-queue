import { describe, expect, test } from 'vitest';
import { approvalsFrom, checkResult, checkRunRequest, earlyFailure, gateFeeds, postPRReport, prReportCalls, queuePage, stalledRun, statusFromCheck } from './batch-live';
import { RateLimitedError } from './rate-limit';
import type { GhReview } from './github';

const review = (login: string, state: string, sha: string, at: string, assoc = 'COLLABORATOR'): GhReview => ({
	user: { login },
	state,
	commit_id: sha,
	author_association: assoc,
	submitted_at: `2026-11-09T${at}:00Z`
});

describe('approvals from reviews', () => {
	test('the latest decisive review per reviewer counts', () => {
		const r = approvalsFrom(
			[
				review('ann', 'CHANGES_REQUESTED', 'a1', '10:00'),
				review('ann', 'COMMENTED', 'a1', '10:30'),
				review('ann', 'APPROVED', 'a2', '11:00')
			],
			'author'
		);
		expect(r).toEqual({ approvedShas: ['a2'], changesRequested: false });
	});

	test('changes requested by anyone blocks, even next to an approval', () => {
		const r = approvalsFrom([review('ann', 'APPROVED', 'a1', '10:00'), review('bob', 'CHANGES_REQUESTED', 'a1', '10:05')], 'x');
		expect(r.changesRequested).toBe(true);
	});

	test('a dismissed approval no longer counts', () => {
		const r = approvalsFrom([review('ann', 'APPROVED', 'a1', '10:00'), review('ann', 'DISMISSED', 'a1', '10:05')], 'x');
		expect(r.approvedShas).toEqual([]);
	});

	test('reviews from the author or from people without write access are ignored', () => {
		const r = approvalsFrom(
			[review('author', 'APPROVED', 'a1', '10:00', 'OWNER'), review('drive-by', 'APPROVED', 'a1', '10:00', 'CONTRIBUTOR')],
			'author'
		);
		expect(r.approvedShas).toEqual([]);
	});
});

describe('required check result', () => {
	test('pending until every run of the check completed', () => {
		expect(checkResult([])).toBe('pending');
		expect(checkResult([{ status: 'in_progress', conclusion: null }])).toBe('pending');
	});

	test('success only when every run succeeded; a skipped or neutral required job proves nothing', () => {
		expect(checkResult([{ status: 'completed', conclusion: 'success' }])).toBe('success');
		expect(checkResult([{ status: 'completed', conclusion: 'skipped' }])).toBe('failure');
		expect(checkResult([{ status: 'completed', conclusion: 'neutral' }])).toBe('failure');
		expect(checkResult([{ status: 'completed', conclusion: 'failure' }])).toBe('failure');
		expect(checkResult([{ status: 'completed', conclusion: 'cancelled' }])).toBe('failure');
	});

	test('after a re-run, the failed attempt that finished before it does not count', () => {
		const old = { status: 'completed', conclusion: 'failure', completed_at: '2026-11-09T10:00:00Z' };
		const rerun = Date.parse('2026-11-09T10:05:00Z');
		expect(checkResult([old], rerun)).toBe('pending');
		expect(checkResult([old, { status: 'completed', conclusion: 'success', completed_at: '2026-11-09T10:20:00Z' }], rerun)).toBe('success');
	});
});

describe('stopping at the first failed job', () => {
	const job = (name: string, status: string, conclusion: string | null, suite: number, completed_at: string | null = '2026-11-10T10:00:00Z') => ({
		name,
		status,
		conclusion,
		completed_at,
		check_suite: { id: suite }
	});
	const required = [job('ci-and-conformance', 'queued', null, 7)];

	test('a failed job in the required check\'s workflow run fails it before the run ends', () => {
		expect(earlyFailure(required, [job('build', 'completed', 'success', 7), job('tests', 'completed', 'failure', 7), job('lint', 'in_progress', null, 7)])).toBe(true);
		expect(earlyFailure(required, [job('tests', 'completed', 'timed_out', 7)])).toBe(true);
	});

	test('nothing failed yet, or a job was skipped or cancelled: not a failure', () => {
		expect(earlyFailure(required, [job('build', 'completed', 'success', 7), job('tests', 'in_progress', null, 7)])).toBe(false);
		expect(earlyFailure(required, [job('docs', 'completed', 'skipped', 7), job('old', 'completed', 'cancelled', 7)])).toBe(false);
	});

	test('a failure in another workflow run does not count', () => {
		expect(earlyFailure(required, [job('nightly', 'completed', 'failure', 9)])).toBe(false);
	});

	test('without the required check yet and without its workflow, nothing is known to feed it', () => {
		expect(earlyFailure([], [job('tests', 'completed', 'failure', 7)])).toBe(false);
	});

	test('a job that failed before its re-run is stale', () => {
		const notBefore = Date.parse('2026-11-10T11:00:00Z');
		expect(earlyFailure(required, [job('tests', 'completed', 'failure', 7, '2026-11-10T10:00:00Z')], notBefore)).toBe(false);
		expect(earlyFailure(required, [job('tests', 'completed', 'failure', 7, '2026-11-10T11:05:00Z')], notBefore)).toBe(true);
	});
});

describe('a stalled CI run', () => {
	const MIN = 60_000;
	const now = Date.parse('2026-11-12T08:00:00Z');
	const at = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
	const job = (status: string, conclusion: string | null, o: { started?: number; completed?: number; suite?: number } = {}) => ({
		status,
		conclusion,
		started_at: o.started === undefined ? null : at(o.started),
		completed_at: o.completed === undefined ? null : at(o.completed),
		check_suite: { id: o.suite ?? 7 }
	});
	const opts = { now, hangMs: 60 * MIN, notBefore: null, suites: new Set([7]) };

	test('a job running longer than the limit is hung', () => {
		expect(stalledRun([job('completed', 'success', { started: 120, completed: 110 }), job('in_progress', null, { started: 61 })], opts)).toBe('hung');
	});

	test('a job running within the limit, or one waiting for a runner however long, is not hung', () => {
		expect(stalledRun([job('in_progress', null, { started: 59 })], opts)).toBeNull();
		expect(stalledRun([job('queued', null)], opts)).toBeNull();
		expect(stalledRun([job('queued', null, { started: 300 })], opts)).toBeNull();
	});

	test('a hung job of another workflow does not count', () => {
		expect(stalledRun([job('in_progress', null, { started: 200, suite: 9 })], opts)).toBeNull();
	});

	test('a finished run whose jobs were cancelled or timed out, with none failed, was interrupted', () => {
		expect(stalledRun([job('completed', 'success', { started: 50, completed: 40 }), job('completed', 'cancelled', { started: 50, completed: 1 })], opts)).toBe('interrupted');
		expect(stalledRun([job('completed', 'timed_out', { started: 400, completed: 40 }), job('completed', 'skipped', { completed: 40 })], opts)).toBe('interrupted');
	});

	test('a run with a failed job failed, even if other jobs were cancelled', () => {
		expect(stalledRun([job('completed', 'failure', { started: 50, completed: 40 }), job('completed', 'cancelled', { started: 50, completed: 39 })], opts)).toBeNull();
	});

	test('a run that passed, or still runs, was not interrupted', () => {
		expect(stalledRun([job('completed', 'success', { started: 50, completed: 40 })], opts)).toBeNull();
		expect(stalledRun([job('completed', 'cancelled', { started: 50, completed: 40 }), job('in_progress', null, { started: 10 })], opts)).toBeNull();
	});

	test('jobs of an attempt before the re-run do not count', () => {
		const notBefore = now - 30 * MIN;
		expect(stalledRun([job('completed', 'cancelled', { started: 200, completed: 40 })], { ...opts, notBefore })).toBeNull();
		expect(stalledRun([job('completed', 'cancelled', { started: 25, completed: 5 })], { ...opts, notBefore })).toBe('interrupted');
	});

	test('without the workflow known, every job on the commit counts', () => {
		expect(stalledRun([job('in_progress', null, { started: 61, suite: 9 })], { ...opts, suites: undefined })).toBe('hung');
	});
});

describe("the gate's jobs, by krusty's real names", () => {
	// From krusty's ci.yml: matrix jobs named with expressions inside parentheses.
	const workflow = `
jobs:
  build-tool-bins:
    name: build-tools (\${{ matrix.kotlin }})
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  build-conformance-bin:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  conformance:
    name: conformance (\${{ matrix.version }}, \${{ matrix.target }})
    needs: [build-conformance-bin, build-tool-bins]
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  conformance-nightly:
    name: conformance-nightly (\${{ matrix.version }})
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  ci-and-conformance:
    if: always()
    needs: [conformance]
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;

	test('a job named only by an expression matches no check run, rather than every one', () => {
		const feeds = gateFeeds(
			`
jobs:
  route:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  matrixed:
    name: \${{ matrix.name }}
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  gate:
    needs: [matrixed]
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`,
			'gate'
		)!;
		expect(['route', 'release', 'gate'].map((n) => [n, feeds(n)])).toEqual([
			['route', false],
			['release', false],
			['gate', true]
		]);
	});

	test('a matrix job named with expressions in parentheses feeds the gate by its check run names', () => {
		const feeds = gateFeeds(workflow, 'ci-and-conformance')!;
		const names = [
			'conformance (2.4.10, wasm-js)',
			'conformance (2.4.0, wasm-wasi)',
			'build-tools (2.4.21)',
			'build-conformance-bin',
			'ci-and-conformance',
			'conformance (2.4.10)',
			'conformance-nightly (2.4.10)',
			'conformance'
		];
		expect(names.map((n) => [n, feeds(n)])).toEqual([
			['conformance (2.4.10, wasm-js)', true],
			['conformance (2.4.0, wasm-wasi)', true],
			['build-tools (2.4.21)', true],
			['build-conformance-bin', true],
			['ci-and-conformance', true],
			['conformance (2.4.10)', false],
			['conformance-nightly (2.4.10)', false],
			['conformance', false]
		]);
	});
});

describe('the jobs the required check waits for', () => {
	// Like krusty's: a routing job no gate needs, a matrix, a reusable workflow, and a gate that
	// runs always and checks what it needs.
	const workflow = `
name: ci
on:
  push:
    branches: ['mq/**']
jobs:
  route:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  build:
    name: Build
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  test:
    name: "Test \${{ matrix.os }}"
    needs: build
    strategy:
      matrix:
        os: [linux, mac]
    runs-on: \${{ matrix.os }}
    steps: [{ run: echo }]
  conformance:
    needs: [build]
    uses: ./.github/workflows/conformance.yml
  lint:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  ci-and-conformance:
    if: always()
    needs:
      - test
      - conformance
      - lint
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;

	test('every job the gate needs, directly or not, by its check run name', () => {
		const feeds = gateFeeds(workflow, 'ci-and-conformance')!;
		for (const name of ['Build', 'Test linux', 'Test mac', 'conformance / suite', 'lint', 'ci-and-conformance']) expect(feeds(name), name).toBe(true);
		expect(feeds('route')).toBe(false);
	});

	test('a gate named by its name, not its id', () => {
		const feeds = gateFeeds(workflow, 'Build')!;
		expect(feeds('Build')).toBe(true);
		expect(feeds('lint')).toBe(false);
	});

	test('a job allowed to fail (continue-on-error, or an expression that may allow it) decides nothing early, nor what only it needs', () => {
		const tolerant = `
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  setup:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  experimental:
    needs: [build, setup]
    continue-on-error: true
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  nightly:
    name: Nightly \${{ matrix.toolchain }}
    continue-on-error: \${{ matrix.toolchain == 'nightly' }}
    strategy: { matrix: { toolchain: [stable, nightly] } }
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  strict:
    needs: setup
    continue-on-error: false
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  gate:
    needs: [experimental, nightly, strict]
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;
		const feeds = gateFeeds(tolerant, 'gate')!;
		// `build` failing skips `experimental`, which the gate tolerates; `setup` also feeds `strict`.
		for (const name of ['setup', 'strict', 'gate']) expect(feeds(name), name).toBe(true);
		for (const name of ['build', 'experimental', 'Nightly stable', 'Nightly nightly']) expect(feeds(name), name).toBe(false);
	});

	test('no such gate, or a workflow it cannot read: unknown, so nothing fails early', () => {
		expect(gateFeeds(workflow, 'nope')).toBeNull();
		expect(gateFeeds('not: [valid', 'ci-and-conformance')).toBeNull();
		expect(gateFeeds('', 'ci-and-conformance')).toBeNull();
	});

	test('a failure in a job the gate does not wait for never fails it early', () => {
		const feeds = gateFeeds(workflow, 'ci-and-conformance')!;
		const job = (name: string, conclusion: string) => ({ name, status: 'completed', conclusion, completed_at: null, check_suite: { id: 7 } });
		const required = [{ check_suite: { id: 7 } }];
		expect(earlyFailure(required, [job('route', 'failure')], null, feeds)).toBe(false);
		expect(earlyFailure(required, [job('Test mac', 'failure')], null, feeds)).toBe(true);
	});

	test('before the gate has a check run (GitHub makes it once its needs end), a failed job it needs fails it early', () => {
		// krusty's batch 8: eight conformance jobs red for 15 minutes, the gate not created yet.
		const feeds = gateFeeds(workflow, 'ci-and-conformance')!;
		const job = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion, completed_at: null, check_suite: { id: 7 } });
		const ciRuns = new Set([7]);
		expect(earlyFailure([], [job('Build', 'completed', 'success'), job('conformance / suite', 'completed', 'failure'), job('Test mac', 'in_progress', null)], null, feeds, ciRuns)).toBe(true);
		expect(earlyFailure([], [job('route', 'completed', 'failure'), job('Test mac', 'in_progress', null)], null, feeds, ciRuns)).toBe(false);
		expect(earlyFailure([], [job('Build', 'completed', 'success')], null, feeds, ciRuns)).toBe(false);
	});

	test("before the gate exists, a failed job of the same name in another workflow doesn't fail it", () => {
		const feeds = gateFeeds(workflow, 'ci-and-conformance')!;
		// `Build` failed in another workflow (suite 9) on the same commit; the CI workflow's run is suite 7.
		const jobs = [
			{ name: 'Build', status: 'completed', conclusion: 'failure', completed_at: null, check_suite: { id: 9 } },
			{ name: 'Build', status: 'in_progress', conclusion: null, completed_at: null, check_suite: { id: 7 } }
		];
		expect(earlyFailure([], jobs, null, feeds, new Set([7]))).toBe(false);
		// The CI workflow's runs not found: nothing is known to feed the gate.
		expect(earlyFailure([], jobs, null, feeds, new Set())).toBe(false);
	});
});

describe("the queue's check run on a PR", () => {
	const at = { name: 'merge-queue', detailsUrl: 'https://mq.example/repos/o/r' };

	test('in line and testing are open runs; the rest are completed with their conclusion', () => {
		expect(checkRunRequest('s1', { state: 'queued', title: 'In line in the merge queue' }, at)).toEqual({
			name: 'merge-queue',
			head_sha: 's1',
			details_url: 'https://mq.example/repos/o/r',
			status: 'queued',
			output: { title: 'In line in the merge queue', summary: 'In line in the merge queue' }
		});
		expect(checkRunRequest('s1', { state: 'in_progress', title: 'Testing in mq/1' }, at)).toMatchObject({ status: 'in_progress' });
		expect(checkRunRequest('s1', { state: 'in_progress', title: 't' }, at)).not.toHaveProperty('conclusion');
		for (const state of ['action_required', 'failure', 'success', 'neutral'] as const) {
			const r = checkRunRequest('s1', { state, title: 't' }, at);
			expect(r, state).toMatchObject({ status: 'completed', conclusion: state });
		}
	});

	test('a hold says "action required" and carries the fix in its summary', () => {
		const r = checkRunRequest('s1', { state: 'action_required', title: 'Draft', summary: '**Merge queue:** Draft. Mark it ready for review.' }, at);
		expect(r).toMatchObject({ conclusion: 'action_required', output: { title: 'Draft', summary: '**Merge queue:** Draft. Mark it ready for review.' } });
	});

	test('Details opens the queue page; a CI run link goes in the summary', () => {
		const r = checkRunRequest('s1', { state: 'failure', title: 'Left the queue: failed', url: 'https://ci/run/9' }, at);
		expect(r.details_url).toBe('https://mq.example/repos/o/r');
		expect(r.output.summary).toBe('Left the queue: failed\n\nCI run: https://ci/run/9');
	});

	test('a suffix names a second run beside it (a trial)', () => {
		expect(checkRunRequest('s1', { state: 'in_progress', title: 't', suffix: '/try' }, at).name).toBe('merge-queue/try');
	});

	test("a summary over GitHub's 65535 characters is cut, keeping its hidden block", () => {
		const block = '<!-- merge-queue {"v":1} -->';
		const r = checkRunRequest('s1', { state: 'action_required', title: 't', summary: `${'x'.repeat(70000)}\n\n${block}` }, at);
		expect(r.output.summary.length).toBeLessThanOrEqual(65535);
		expect(r.output.summary.endsWith(block)).toBe(true);
	});

	test('the queue page, or the commit on GitHub when the app has no address', () => {
		expect(queuePage('https://mq.example/', 'o', 'r', 's1')).toBe('https://mq.example/repos/o/r');
		expect(queuePage('', 'o', 'r', 's1')).toBe('https://github.com/o/r/commit/s1');
	});
});

describe('the same state as a commit status, for a ruleset that still requires one', () => {
	test('only success passes; a hold and an ejection fail; the rest are pending', () => {
		const state = (s: Parameters<typeof statusFromCheck>[0]['state']) => statusFromCheck({ state: s, title: 't' }, 'merge-queue', 'u').state;
		expect(state('success')).toBe('success');
		expect(state('action_required')).toBe('failure');
		expect(state('failure')).toBe('failure');
		expect(state('queued')).toBe('pending');
		expect(state('in_progress')).toBe('pending');
		// A status has no neutral, and a pending one keeps a PR out of the queue unmergeable.
		expect(state('neutral')).toBe('pending');
	});

	test('the title is the description, cut at 140 characters; the link is the CI run, else the queue page', () => {
		const s = statusFromCheck({ state: 'queued', title: 'y'.repeat(200), suffix: '/try' }, 'merge-queue', 'https://mq.example/repos/o/r');
		expect(s.description.length).toBeLessThanOrEqual(140);
		expect(s.context).toBe('merge-queue/try');
		expect(s.target_url).toBe('https://mq.example/repos/o/r');
		expect(statusFromCheck({ state: 'failure', title: 't', url: 'https://ci/1' }, 'merge-queue', 'q').target_url).toBe('https://ci/1');
	});
});

describe('what the PR report setting posts', () => {
	test('a check run, a status, or both while a ruleset still requires the status', () => {
		expect(prReportCalls('check-run')).toEqual(['check-run']);
		expect(prReportCalls('status')).toEqual(['status']);
		expect(prReportCalls('both')).toEqual(['check-run', 'status']);
		// A setting from before it existed, or a typo: the status the ruleset requires keeps being posted.
		expect(prReportCalls(undefined)).toEqual(['check-run', 'status']);
		expect(prReportCalls('checks' as never)).toEqual(['check-run', 'status']);
	});
});

describe('posting both, while a ruleset still requires the status', () => {
	const calls: string[] = [];
	const ok = (kind: string) => async () => void calls.push(kind);
	const fail = (kind: string, e: Error = new Error(`${kind} refused`)) => async () => {
		calls.push(kind);
		throw e;
	};

	test('a refused check run (no Checks permission yet) does not fail the post: the status went out, and retrying every tick would only post it again', async () => {
		calls.length = 0;
		const warned: unknown[] = [];
		await postPRReport('both', fail('check-run'), ok('status'), (e) => warned.push(e));
		expect(calls).toEqual(['check-run', 'status']);
		expect(warned).toHaveLength(1);
	});

	test('a refused status fails it, whatever the check run did', async () => {
		calls.length = 0;
		await expect(postPRReport('both', ok('check-run'), fail('status'), () => {})).rejects.toThrow('status refused');
		expect(calls).toEqual(['check-run', 'status']);
	});

	test('a rate limit stops it at once', async () => {
		calls.length = 0;
		const limited = new RateLimitedError(Date.now() + 1000, 'rate limited');
		await expect(postPRReport('both', fail('check-run', limited), ok('status'), () => {})).rejects.toBe(limited);
		expect(calls).toEqual(['check-run']);
	});

	test('posting only the check run, its refusal fails the post, so it is tried again', async () => {
		calls.length = 0;
		await expect(postPRReport('check-run', fail('check-run'), ok('status'), () => {})).rejects.toThrow('check-run refused');
		expect(calls).toEqual(['check-run']);
	});
});
