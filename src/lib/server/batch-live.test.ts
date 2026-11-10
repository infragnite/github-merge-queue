import { describe, expect, test } from 'vitest';
import { approvalsFrom, checkResult, earlyFailure, gateFeeds } from './batch-live';
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
		expect(earlyFailure([], [job('Build', 'completed', 'success'), job('conformance / suite', 'completed', 'failure'), job('Test mac', 'in_progress', null)], null, feeds)).toBe(true);
		expect(earlyFailure([], [job('route', 'completed', 'failure'), job('Test mac', 'in_progress', null)], null, feeds)).toBe(false);
		expect(earlyFailure([], [job('Build', 'completed', 'success')], null, feeds)).toBe(false);
	});
});
