import { describe, expect, test } from 'vitest';
import { GitHubError } from './github-retry';
import { mergeInStack, needsAsyncMerge, type AsyncMergeApi } from './stacked-merge';

const HEAD = 'a'.repeat(40);
const MERGED = 'b'.repeat(40);

/** A fake of GitHub's async merge endpoints: each PUT and GET answers from the given scripts in turn. */
function api(puts: Array<unknown | GitHubError>, gets: Array<unknown | GitHubError> = []) {
	const calls: string[] = [];
	const bodies: unknown[] = [];
	const slept: number[] = [];
	const fake: AsyncMergeApi = {
		put: async (path, body) => {
			calls.push(`PUT ${path}`);
			bodies.push(body);
			const r = puts.shift();
			if (r instanceof GitHubError) throw r;
			return r;
		},
		get: async (path) => {
			calls.push(`GET ${path}`);
			const r = gets.shift();
			if (r instanceof GitHubError) throw r;
			return r;
		},
		sleep: async (ms) => {
			slept.push(ms);
		}
	};
	return { fake, calls, bodies, slept };
}

const pending = (uuid = 'u-1') => ({ status: 'pending', details: { message: 'Merge request accepted', uuid, merge_method: 'squash', merge_action: 'direct_merge', expected_head_sha: HEAD } });
const BOTTOM = { stack: { position: 1, size: 2 } };

describe("merging a PR in one of GitHub's stacks", () => {
	test('squash-merges it directly, at the tested head, with the queue title, and waits for the merge commit', async () => {
		const { fake, calls, bodies } = api([pending()], [pending(), { status: 'merged', details: { message: 'Merged', sha: MERGED } }]);
		const r = await mergeInStack(fake, { pulls: '/repos/o/r/pulls', n: 3255, title: 'Represent Wasm value classes (#3255)', sha: HEAD, pr: BOTTOM });
		expect(r).toEqual({ merged: true, sha: MERGED, message: undefined });
		expect(bodies).toEqual([{ merge_method: 'squash', merge_action: 'direct_merge', sha: HEAD, commit_title: 'Represent Wasm value classes (#3255)', commit_message: '' }]);
		expect(calls).toEqual(['PUT /repos/o/r/pulls/3255/merge-async', 'GET /repos/o/r/pulls/3255/merge-async/u-1', 'GET /repos/o/r/pulls/3255/merge-async/u-1']);
	});

	test('a merge GitHub reports done at once needs no wait', async () => {
		const { fake, calls } = api([{ status: 'merged', details: { message: 'Merged', sha: MERGED } }]);
		expect(await mergeInStack(fake, { pulls: '/repos/o/r/pulls', n: 1, title: 't', sha: HEAD, pr: BOTTOM })).toEqual({ merged: true, sha: MERGED, message: undefined });
		expect(calls).toHaveLength(1);
	});

	test('a merge GitHub fails says why', async () => {
		const { fake } = api([pending()], [{ status: 'failed', details: { message: 'Head branch was modified. Review and try the merge again.' } }]);
		expect(await mergeInStack(fake, { pulls: '/repos/o/r/pulls', n: 1, title: 't', sha: HEAD, pr: BOTTOM })).toEqual({
			merged: false,
			sha: null,
			message: 'Head branch was modified. Review and try the merge again.'
		});
	});

	test('a merge request already pending (409) is waited for, not sent again', async () => {
		const conflict = new GitHubError(409, 'A merge request is already pending', { message: 'A merge request is already pending', status: 'pending', details: { uuid: 'u-9' } });
		const { fake, calls } = api([conflict], [{ status: 'merged', details: { message: 'Merged', sha: MERGED } }]);
		expect(await mergeInStack(fake, { pulls: '/repos/o/r/pulls', n: 1, title: 't', sha: HEAD, pr: BOTTOM })).toEqual({ merged: true, sha: MERGED, message: undefined });
		expect(calls).toEqual(['PUT /repos/o/r/pulls/1/merge-async', 'GET /repos/o/r/pulls/1/merge-async/u-9']);
	});

	test('a refusal (400, a closed PR) is a merge refused with its message', async () => {
		const { fake } = api([new GitHubError(400, 'Pull request is closed', { message: 'Pull request is closed' })]);
		expect(await mergeInStack(fake, { pulls: '/repos/o/r/pulls', n: 1, title: 't', sha: HEAD, pr: BOTTOM })).toEqual({ merged: false, sha: null, message: 'Pull request is closed' });
	});

	test('a merge still pending after the wait is not merged, and says GitHub is still merging it', async () => {
		const gets = Array.from({ length: 100 }, () => pending());
		const { fake, slept } = api([pending()], gets);
		const r = await mergeInStack(fake, { pulls: '/repos/o/r/pulls', n: 1, title: 't', sha: HEAD, pr: BOTTOM });
		expect(r).toEqual({ merged: false, sha: null, message: 'GitHub is still merging #1 in the background; resume the queue once it has merged' });
		expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120_000);
	});

	test('a PR above unmerged PRs in its stack is not merged: GitHub would merge those too, untested', async () => {
		const { fake, calls } = api([]);
		expect(await mergeInStack(fake, { pulls: '/repos/o/r/pulls', n: 3294, title: 't', sha: HEAD, pr: { stack: { position: 2, size: 2 } } })).toEqual({
			merged: false,
			sha: null,
			message: "#3294 sits above 1 open PR in its GitHub stack, and GitHub's merge would merge them with it; merge or unstack the PRs below it first"
		});
		expect(calls).toEqual([]);
	});

	test('a rate limit is not a refusal: it is thrown for the queue to wait', async () => {
		const limited = Object.assign(new GitHubError(403, 'API rate limit exceeded'), { until: Date.now() + 1000 });
		const { fake } = api([limited]);
		await expect(mergeInStack(fake, { pulls: '/repos/o/r/pulls', n: 1, title: 't', sha: HEAD, pr: BOTTOM })).rejects.toBe(limited);
	});
});

describe('which PRs need the async merge', () => {
	test('a PR in a GitHub stack does', () => {
		expect(needsAsyncMerge({ stack: { position: 1, size: 2 } }, null)).toBe(true);
	});

	test('a PR not in one does not', () => {
		expect(needsAsyncMerge({}, null)).toBe(false);
		expect(needsAsyncMerge({ stack: null }, null)).toBe(false);
	});

	test("GitHub's refusal of the plain merge for a stacked PR does, whatever the PR said", () => {
		expect(
			needsAsyncMerge(
				{},
				'This pull request is part of a stack and must be merged using the asynchronous merge REST API. For more information, see https://docs.github.com/rest/pulls/pulls#merge-a-pull-request-asynchronously'
			)
		).toBe(true);
		expect(needsAsyncMerge({}, 'Pull Request is not mergeable')).toBe(false);
	});
});
