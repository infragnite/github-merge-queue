import { describe, expect, test, vi } from 'vitest';
import { GitHubError, withTokenRefreshOn401 } from './github-retry';

describe('withTokenRefreshOn401', () => {
	test('returns result without retry when call succeeds', async () => {
		const getToken = vi.fn().mockResolvedValue('tok-1');
		const invalidate = vi.fn();
		const call = vi.fn().mockResolvedValue('ok');

		const result = await withTokenRefreshOn401(getToken, invalidate, call);

		expect(result).toBe('ok');
		expect(getToken).toHaveBeenCalledTimes(1);
		expect(call).toHaveBeenCalledTimes(1);
		expect(call).toHaveBeenCalledWith('tok-1');
		expect(invalidate).not.toHaveBeenCalled();
	});

	test('on 401, invalidates cache, mints fresh token, retries once, returns success', async () => {
		const getToken = vi.fn().mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
		const invalidate = vi.fn();
		const call = vi
			.fn()
			.mockRejectedValueOnce(new GitHubError(401, 'Bad credentials', { message: 'Bad credentials' }))
			.mockResolvedValueOnce('ok');

		const result = await withTokenRefreshOn401(getToken, invalidate, call);

		expect(result).toBe('ok');
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(getToken).toHaveBeenCalledTimes(2);
		expect(call).toHaveBeenCalledTimes(2);
		expect(call.mock.calls[0][0]).toBe('stale');
		expect(call.mock.calls[1][0]).toBe('fresh');
	});

	test('retries on "Bad credentials" body message even when status is not 401', async () => {
		const getToken = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
		const invalidate = vi.fn();
		const call = vi
			.fn()
			.mockRejectedValueOnce(new GitHubError(403, 'Bad credentials', { message: 'Bad credentials' }))
			.mockResolvedValueOnce('ok');

		const result = await withTokenRefreshOn401(getToken, invalidate, call);

		expect(result).toBe('ok');
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	test('does NOT retry on non-401 errors', async () => {
		const getToken = vi.fn().mockResolvedValue('tok');
		const invalidate = vi.fn();
		const err = new GitHubError(404, 'Not Found', { message: 'Not Found' });
		const call = vi.fn().mockRejectedValue(err);

		await expect(withTokenRefreshOn401(getToken, invalidate, call)).rejects.toBe(err);
		expect(call).toHaveBeenCalledTimes(1);
		expect(invalidate).not.toHaveBeenCalled();
	});

	test('does NOT retry on non-GitHubError exceptions', async () => {
		const getToken = vi.fn().mockResolvedValue('tok');
		const invalidate = vi.fn();
		const err = new Error('network down');
		const call = vi.fn().mockRejectedValue(err);

		await expect(withTokenRefreshOn401(getToken, invalidate, call)).rejects.toBe(err);
		expect(call).toHaveBeenCalledTimes(1);
		expect(invalidate).not.toHaveBeenCalled();
	});

	test('retries exactly once — second 401 propagates', async () => {
		const getToken = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
		const invalidate = vi.fn();
		const err2 = new GitHubError(401, 'Bad credentials', { message: 'Bad credentials' });
		const call = vi
			.fn()
			.mockRejectedValueOnce(new GitHubError(401, 'Bad credentials', { message: 'Bad credentials' }))
			.mockRejectedValueOnce(err2);

		await expect(withTokenRefreshOn401(getToken, invalidate, call)).rejects.toBe(err2);
		expect(call).toHaveBeenCalledTimes(2);
		expect(invalidate).toHaveBeenCalledTimes(1);
	});
});
