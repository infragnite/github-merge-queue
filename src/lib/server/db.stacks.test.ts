import { beforeAll, describe, expect, test } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
const db = await import('./db');

let repoId: number;

beforeAll(() => {
	const user = db.upsertUser(1, 'dev', null, null);
	db.addRepo('acme', 'repo', 'main', user);
	repoId = db.getRepoByOwnerName('acme', 'repo')!.id;
});

describe('stack detection storage', () => {
	test('head history is per PR and de-duplicated', () => {
		const store = db.stackStore(repoId);
		store.recordHeads([
			{ pr: 1, sha: 'aaa' },
			{ pr: 2, sha: 'bbb' }
		]);
		store.recordHeads([
			{ pr: 1, sha: 'aaa' },
			{ pr: 1, sha: 'aab' }
		]);
		const heads = store.knownHeads();
		expect(heads.get(1)?.sort()).toEqual(['aaa', 'aab']);
		expect(heads.get(2)).toEqual(['bbb']);
	});

	test('deleted branches come back as ISO timestamps, latest deletion wins', () => {
		db.recordBranchDeleted(repoId, 'feature/a');
		db.recordBranchDeleted(repoId, 'feature/a');
		const deleted = db.getDeletedBranches(repoId);
		expect([...deleted.keys()]).toEqual(['feature/a']);
		const at = deleted.get('feature/a')!;
		expect(at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
		expect(Math.abs(Date.parse(at) - Date.now())).toBeLessThan(60_000);
	});

	test('history is dropped with the repository', () => {
		db.removeRepo(repoId);
		expect(db.getKnownPRHeads(repoId).size).toBe(0);
		expect(db.getDeletedBranches(repoId).size).toBe(0);
	});
});
