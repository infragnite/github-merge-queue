import { describe, it, expect, beforeEach } from 'vitest';
import { clearTickError, describeTickError, noteTickError, tickErrorView } from './tick-errors';
import { GitHubError } from './github-retry';

const repo = 7;
const t0 = Date.parse('2026-11-13T07:30:40Z');
const server = () => new GitHubError(500, 'Server Error', { message: 'Server Error' }, undefined, 'GET /repos/qnox/krusty/pulls');

describe('tick errors on the queue page', () => {
	beforeEach(() => clearTickError(repo));

	it('shows nothing for one failed step that the next one recovers from', () => {
		noteTickError(repo, server(), t0);
		expect(tickErrorView(repo)).toBeNull();
		clearTickError(repo);
		expect(tickErrorView(repo)).toBeNull();
	});

	it('shows nothing for two failed steps in a row', () => {
		noteTickError(repo, server(), t0);
		noteTickError(repo, server(), t0 + 60_000);
		expect(tickErrorView(repo)).toBeNull();
	});

	it('says GitHub is failing and there is nothing to do once its errors persist', () => {
		noteTickError(repo, server(), t0);
		noteTickError(repo, server(), t0 + 60_000);
		noteTickError(repo, new GitHubError(502, 'Bad Gateway', {}, undefined, 'POST /graphql'), t0 + 120_000);
		expect(tickErrorView(repo)).toEqual({
			kind: 'github',
			since: t0,
			count: 3,
			detail: 'GitHub API 502 on POST /graphql: Bad Gateway'
		});
	});

	it('treats network failures as GitHub being unreachable', () => {
		for (let i = 0; i < 3; i++) noteTickError(repo, new TypeError('fetch failed'), t0 + i * 60_000);
		expect(tickErrorView(repo)?.kind).toBe('github');
	});

	it('shows a persisting error of the queue itself as stuck', () => {
		for (let i = 0; i < 3; i++) noteTickError(repo, new Error('git merge-tree failed: fatal: bad object abc'), t0 + i * 60_000);
		expect(tickErrorView(repo)).toEqual({ kind: 'stuck', since: t0, count: 3, detail: 'git merge-tree failed: fatal: bad object abc' });
	});

	it('counts consecutive failures even when the message changes', () => {
		noteTickError(repo, server(), t0);
		noteTickError(repo, new Error('git fetch timed out'), t0 + 60_000);
		noteTickError(repo, new Error('git fetch timed out'), t0 + 120_000);
		expect(tickErrorView(repo)).toMatchObject({ kind: 'stuck', since: t0, count: 3, detail: 'git fetch timed out' });
	});
});

describe('describeTickError', () => {
	it('names the GitHub call and status', () => {
		expect(describeTickError(server())).toBe('GitHub API 500 on GET /repos/qnox/krusty/pulls: Server Error');
	});
	it('keeps a GitHub error without a recorded call readable', () => {
		expect(describeTickError(new GitHubError(503, 'Service Unavailable'))).toBe('GitHub API 503: Service Unavailable');
	});
	it('passes other errors through', () => {
		expect(describeTickError(new Error('boom'))).toBe('boom');
		expect(describeTickError('plain')).toBe('plain');
	});
});
