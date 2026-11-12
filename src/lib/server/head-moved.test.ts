import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRunner } from './batch-builder';
import { GitSandbox } from './testing/git-sandbox';
import { HeadMovedError, leaseLost } from './head-moved';

let git: GitSandbox;
let remoteDir: string;
afterEach(() => {
	git?.cleanup();
	rmSync(remoteDir, { recursive: true, force: true });
});

/** The error a real `git push --force-with-lease` gives, pushing `sha` to `branch` of a bare remote expected at `expected`. */
async function pushError(branch: string, sha: string, expected: string): Promise<string> {
	const runner = new GitRunner(git.dir);
	try {
		await runner.runAsync(['push', '-q', `--force-with-lease=refs/heads/${branch}:${expected}`, remoteDir, `${sha}:refs/heads/${branch}`]);
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	return '';
}

describe('a push that lost its lease', () => {
	function setup() {
		git = new GitSandbox();
		remoteDir = mkdtempSync(join(tmpdir(), 'lease-remote-'));
		git.git('init', '-q', '--bare', remoteDir);
		git.branch('feature', 'main');
		git.commit('feature', 'one', 'a.txt');
		git.git('push', '-q', remoteDir, 'feature');
	}

	test("is told apart from other push errors by git's own words", async () => {
		setup();
		const read = git.sha('feature');
		// The author pushes after the queue read the branch...
		git.commit('feature', 'two', 'b.txt');
		git.git('push', '-q', remoteDir, 'feature');
		// ...and the queue's push, leased on what it read, is refused.
		git.branch('restacked', 'main');
		git.commit('restacked', 'mine', 'c.txt');
		const msg = await pushError('feature', git.sha('restacked'), read);
		expect(msg).not.toBe('');
		expect(leaseLost(msg)).toBe(true);
	});

	test('a branch deleted since it was read lost its lease too', async () => {
		setup();
		const read = git.sha('feature');
		git.git('push', '-q', remoteDir, '--delete', 'feature');
		const msg = await pushError('feature', git.sha('main'), read);
		expect(leaseLost(msg)).toBe(true);
	});

	test('other failures are not a lost lease', () => {
		expect(leaseLost("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com")).toBe(false);
		expect(leaseLost('remote: Permission to o/r.git denied to app[bot].\nfatal: unable to access: The requested URL returned error: 403')).toBe(false);
		expect(leaseLost('! [remote rejected] abc -> feature (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)')).toBe(false);
	});

	test('the error names the branch and the head the queue expected', () => {
		const e = new HeadMovedError('feature', 'd17cb2fb08e67619912e7b4b44da9cee694a6a05');
		expect(e).toBeInstanceOf(Error);
		expect(e.branch).toBe('feature');
		expect(e.expected).toBe('d17cb2fb08e67619912e7b4b44da9cee694a6a05');
		expect(e.message).toBe('feature is no longer at d17cb2fb: it was pushed to');
	});
});
