import { expect, test, vi } from 'vitest';
const fake = vi.hoisted(() => ({ jobs: vi.fn() }));
vi.mock('./github', () => ({ actionsJobsForSha: fake.jobs }));
const { progressFor, invalidateProgress } = await import('./pipeline-view');

test('webhook invalidation preserves job links through an API failure or low rate-limit budget', async () => {
	const repo = { id: 1, owner: 'o', name: 'r', default_branch: 'main' };
	fake.jobs.mockResolvedValueOnce([{ name: 'test (jvm)', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/1/job/2' }]);
	const original = await progressFor(repo, 'head', false);
	invalidateProgress('o', 'r', 'head');
	fake.jobs.mockRejectedValueOnce(new Error('GitHub unavailable'));
	expect(await progressFor(repo, 'head', false)).toEqual(original);
	expect(fake.jobs).toHaveBeenCalledTimes(2);
	invalidateProgress('o', 'r', 'head');
	expect(await progressFor(repo, 'head', true)).toEqual(original);
	expect(fake.jobs).toHaveBeenCalledTimes(2);
	expect(original?.failedJobLinks?.[0].url).toContain('/job/2');
});
