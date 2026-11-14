import { expect, test, vi } from 'vitest';
import { installationRepoCache } from './installation-repo-cache';

test('event bursts and concurrent viewers share one installation lookup until reconciliation expires', async () => {
	let now = 0;
	const list = [{ full_name: 'o/r', default_branch: 'main' }];
	const load = vi.fn(async () => list);
	const read = installationRepoCache(load, () => now);
	const first = read();
	for (let i = 0; i < 100; i++) expect(read()).toBe(first);
	expect(await first).toEqual(list);
	expect(load).toHaveBeenCalledOnce();
	now = 29_999; await read();
	expect(load).toHaveBeenCalledOnce();
	now = 30_000; await read();
	expect(load).toHaveBeenCalledTimes(2);
});

test('GitHub failures are retried on reconciliation instead of on every event', async () => {
	let now = 0;
	const load = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue([]);
	const read = installationRepoCache(load, () => now);
	await expect(read()).rejects.toThrow('Unavailable');
	await expect(read()).rejects.toThrow('Unavailable');
	expect(load).toHaveBeenCalledOnce();
	now = 30_000;
	await expect(read()).resolves.toEqual([]);
	expect(load).toHaveBeenCalledTimes(2);
});
