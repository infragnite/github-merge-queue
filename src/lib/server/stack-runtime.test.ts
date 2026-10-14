import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const github = vi.hoisted(() => ({
	getBranchSha: vi.fn(),
	getRecentlyClosedPRs: vi.fn(),
	stackClient: vi.fn()
}));
vi.mock('./github', () => github);

const db = await import('./db');
const { closedPRReason } = await import('./stack-runtime');

let repo: { id: number; owner: string; name: string; default_branch: string };

beforeAll(() => {
	const user = db.upsertUser(1, 'dev', null, null);
	db.addRepo('acme', 'repo', 'main', user);
	repo = db.getRepoByOwnerName('acme', 'repo')!;
});

beforeEach(() => {
	github.getBranchSha.mockReset();
	github.getRecentlyClosedPRs.mockReset();
});

const child = (closedAt: string) => ({
	number: 2,
	head: { ref: 'b', sha: 'bbb' },
	base: { ref: 'a' },
	closed_at: closedAt
});
const parent = {
	number: 1,
	head: { ref: 'a', sha: 'aaa' },
	base: { ref: 'main' },
	closed_at: '2026-01-01T11:00:00Z',
	merged_at: '2026-01-01T11:00:00Z'
};

describe('closedPRReason', () => {
	test('PRs on the default branch are plain closes and cost no API calls', async () => {
		const pr = { ...child('2026-01-01T12:00:00Z'), base: { ref: 'main' } };
		expect(await closedPRReason(repo, pr)).toBe('PR was closed');
		expect(github.getBranchSha).not.toHaveBeenCalled();
	});

	test('explains GitHub auto-closing a stacked PR after its base was deleted', async () => {
		github.getBranchSha.mockResolvedValue(null);
		github.getRecentlyClosedPRs.mockResolvedValue([parent]);
		const reason = await closedPRReason(repo, child('2026-01-01T12:00:00Z'));
		expect(reason).toMatch(/closed #2 because its base branch 'a' was deleted \(it was stacked on #1\)/);
	});

	test('a recorded delete webhook makes it certain', async () => {
		db.recordBranchDeleted(repo.id, 'a');
		github.getBranchSha.mockResolvedValue(null);
		github.getRecentlyClosedPRs.mockResolvedValue([parent]);
		const reason = await closedPRReason(repo, child(new Date().toISOString()));
		expect(reason).toMatch(/^GitHub closed #2/);
	});

	test('base still present: a manual close', async () => {
		github.getBranchSha.mockResolvedValue('still-here');
		github.getRecentlyClosedPRs.mockResolvedValue([parent]);
		expect(await closedPRReason(repo, child('2026-01-01T12:00:00Z'))).toBe('PR was closed');
	});

	test('API failures fall back to the plain reason', async () => {
		github.getBranchSha.mockRejectedValue(new Error('GitHub API 502'));
		github.getRecentlyClosedPRs.mockResolvedValue([]);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await closedPRReason(repo, child('2026-01-01T12:00:00Z'))).toBe('PR was closed');
	});
});
