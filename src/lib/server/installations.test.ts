import { describe, expect, test, vi } from 'vitest';
import { Installations, ownerOfPath, type InstallationApi } from './installations';

function api(list: Array<{ id: number; login: string }>) {
	const fake = {
		list,
		listInstallations: vi.fn(async () => fake.list.map((i) => ({ id: i.id, account: { login: i.login } }))),
		createToken: vi.fn(async (id: number) => ({ token: `tok-${id}-${fake.createToken.mock.calls.length}`, expires_at: '2100-01-01T00:00:00Z' }))
	};
	return fake as typeof fake & InstallationApi;
}

describe('ownerOfPath', () => {
	test('reads the account of repo and org paths', () => {
		expect(ownerOfPath('/repos/qnox/krusty/pulls/1')).toBe('qnox');
		expect(ownerOfPath('/orgs/infragnite/members/anton')).toBe('infragnite');
	});

	test('a path that names no account has none', () => {
		expect(ownerOfPath('/graphql')).toBeNull();
		expect(ownerOfPath('/installation/repositories?per_page=100')).toBeNull();
	});
});

describe('Installations', () => {
	test("each account's repositories use its own installation's token", async () => {
		const gh = api([
			{ id: 1, login: 'infragnite' },
			{ id: 2, login: 'qnox' }
		]);
		const inst = new Installations(gh);

		expect(await inst.idFor('qnox')).toBe(2);
		expect(await inst.idFor('Infragnite')).toBe(1);
		expect(await inst.token(2)).toBe('tok-2-1');
		expect(await inst.token(1)).toBe('tok-1-2');
		expect(await inst.token(2)).toBe('tok-2-1');
		expect(gh.listInstallations).toHaveBeenCalledTimes(1);
		expect(gh.createToken).toHaveBeenCalledTimes(2);
	});

	test('a forgotten token is minted again', async () => {
		const gh = api([{ id: 7, login: 'qnox' }]);
		const inst = new Installations(gh);

		expect(await inst.token(7)).toBe('tok-7-1');
		inst.forget(7);
		expect(await inst.token(7)).toBe('tok-7-2');
	});

	test('an account the App is not on is an error, and is looked up again only after a minute', async () => {
		let now = 0;
		const gh = api([{ id: 1, login: 'infragnite' }]);
		const inst = new Installations(gh, () => now);

		await expect(inst.idFor('qnox')).rejects.toThrow('The merge queue GitHub App is not installed on qnox');
		now = 30_000;
		await expect(inst.idFor('qnox')).rejects.toThrow('The merge queue GitHub App is not installed on qnox');
		expect(gh.listInstallations).toHaveBeenCalledTimes(1);

		gh.list.push({ id: 2, login: 'qnox' });
		now = 61_000;
		expect(await inst.idFor('qnox')).toBe(2);
		expect(gh.listInstallations).toHaveBeenCalledTimes(2);
	});

	test('ids lists every installation afresh', async () => {
		const gh = api([{ id: 1, login: 'infragnite' }]);
		const inst = new Installations(gh);
		expect(await inst.ids()).toEqual([1]);
		gh.list.push({ id: 2, login: 'qnox' });
		expect(await inst.ids()).toEqual([1, 2]);
	});
});
