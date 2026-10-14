import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	clearCompareCache,
	COMPARE_MAX_PAGES,
	COMPARE_PAGE_SIZE,
	loadStackInput,
	type GhCompare,
	type StackGitHub,
	type StackStore
} from './stack-source';
import { analyzeStacks, mergeBlocker } from './stacks';
import { GitSandbox } from './testing/git-sandbox';

let git: GitSandbox;

/** In-memory stand-in for the db-backed store. */
function memoryStore(seed?: GitSandbox): StackStore & { heads: Map<number, Set<string>> } {
	const heads = new Map<number, Set<string>>();
	for (const [n, shas] of seed?.knownHeads() ?? []) heads.set(n, new Set(shas));
	return {
		heads,
		recordHeads(list) {
			for (const { pr, sha } of list) {
				const s = heads.get(pr) ?? new Set();
				s.add(sha);
				heads.set(pr, s);
			}
		},
		knownHeads: () => new Map([...heads].map(([n, s]) => [n, [...s]])),
		deletedBranches: () => seed?.deletedBranches() ?? new Map()
	};
}

const opts = { defaultBranch: 'main', cacheKey: 'acme/repo' };

beforeEach(() => {
	clearCompareCache();
	git = new GitSandbox();
});

afterEach(() => {
	git?.cleanup();
});

function stack() {
	git.branch('a', 'main');
	git.commit('a', 'a1');
	git.branch('b', 'a');
	git.commit('b', 'b1');
	git.openPR(1, 'a', 'main');
	git.openPR(2, 'b', 'main'); // lies about its base
}

describe('loadStackInput', () => {
	test('builds the same input the analysis sees from git directly', async () => {
		stack();
		const input = await loadStackInput(git.client(), memoryStore(git), opts);
		const fromGit = git.input();

		const byNum = (prs: typeof input.prs) => [...prs].sort((x, y) => x.number - y.number);
		expect(byNum(input.prs).map((p) => [p.number, p.headSha, p.commits?.map((c) => c.sha)])).toEqual(
			byNum(fromGit.prs).map((p) => [p.number, p.headSha, p.commits?.map((c) => c.sha)])
		);
		const a = analyzeStacks(input);
		expect(a.prs.get(2)).toMatchObject({ parent: 1, link: 'healthy' });
		expect(mergeBlocker(a, 2)).toMatch(/Stacked on #1/);
	});

	test('records current heads so a later rebase is recognised', async () => {
		git.recordHistory = false;
		stack();
		const store = memoryStore();
		await loadStackInput(git.client(), store, opts);
		expect([...store.heads.get(1)!]).toEqual([git.sha('a')]);

		git.amend('a', 'a1 reworded'); // fingerprints can't see this one
		const a = analyzeStacks(await loadStackInput(git.client(), store, opts));
		expect(a.prs.get(2)).toMatchObject({ parent: 1, link: 'rebased' });
		expect(a.prs.get(2)!.issues[0].evidence).toBe('known-head');
	});

	test('caches compare results by SHA pair across calls', async () => {
		stack();
		const calls: string[] = [];
		await loadStackInput(git.client(calls), memoryStore(), opts);
		const first = calls.filter((c) => c.startsWith('compare')).length;
		expect(first).toBe(2);

		calls.length = 0;
		await loadStackInput(git.client(calls), memoryStore(), opts);
		expect(calls.filter((c) => c.startsWith('compare'))).toEqual([]);

		git.commit('b', 'b2'); // only #2's head moved
		calls.length = 0;
		await loadStackInput(git.client(calls), memoryStore(), opts);
		expect(calls.filter((c) => c.startsWith('compare'))).toHaveLength(1);

		git.commit('main', 'm2'); // default branch moved: everything misses
		calls.length = 0;
		await loadStackInput(git.client(calls), memoryStore(), opts);
		expect(calls.filter((c) => c.startsWith('compare'))).toHaveLength(2);
	});

	test('pages through long compares and flags truncation', async () => {
		const total = COMPARE_PAGE_SIZE * COMPARE_MAX_PAGES + 7;
		const commit = (i: number) => ({
			sha: `sha${i}`,
			commit: { message: `m${i}`, author: { email: 'e', date: 'd' } }
		});
		const gh: StackGitHub = {
			listOpenPRs: async () => [
				{
					number: 1,
					state: 'open',
					merged_at: null,
					closed_at: null,
					head: { ref: 'big', sha: 'sha-head' },
					base: { ref: 'main' }
				}
			],
			listRecentlyClosedPRs: async () => [],
			getBranchSha: async (b) => (b === 'main' ? 'main-sha' : null),
			compare: async (_b, _h, page, perPage): Promise<GhCompare> => ({
				total_commits: total,
				commits: Array.from({ length: perPage }, (_, i) => commit((page - 1) * perPage + i))
			})
		};
		const input = await loadStackInput(gh, memoryStore(), opts);
		expect(input.prs[0].commits).toHaveLength(COMPARE_PAGE_SIZE * COMPARE_MAX_PAGES);
		expect(input.prs[0].commitsTruncated).toBe(true);
	});

	test('a compare GitHub cannot answer leaves commits unknown', async () => {
		stack();
		const gh = { ...git.client(), compare: async () => null };
		const input = await loadStackInput(gh, memoryStore(), opts);
		expect(input.prs.every((p) => p.commits === null)).toBe(true);
		expect(analyzeStacks(input).stacks).toEqual([]);
	});

	test('fails loudly when the default branch is missing', async () => {
		await expect(loadStackInput(git.client(), memoryStore(), { ...opts, defaultBranch: 'nope' })).rejects.toThrow(
			/Default branch 'nope' not found/
		);
	});

	test('only looks up branches the analysis needs', async () => {
		stack();
		git.branch('c', 'b');
		git.commit('c', 'c1');
		git.openPR(3, 'c', 'b');
		const calls: string[] = [];
		await loadStackInput(git.client(calls), memoryStore(), opts);
		expect(calls.filter((c) => c.startsWith('branch:')).sort()).toEqual(['branch:b', 'branch:main']);
	});

	test('end to end: auto-closed PR after its base branch is deleted', async () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.branch('b', 'a');
		git.commit('b', 'b1');
		git.openPR(1, 'a', 'main');
		git.openPR(2, 'b', 'a');
		git.merge(1, 'squash');
		git.deleteBranch('a', { retarget: false });

		const a = analyzeStacks(await loadStackInput(git.client(), memoryStore(git), opts));
		expect(a.issues).toContainEqual(
			expect.objectContaining({ kind: 'auto-closed', pr: 2, parent: 1, evidence: 'webhook' })
		);
	});
});
