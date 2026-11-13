import { afterEach, expect, test } from 'vitest';
import { GitRunner } from './batch-builder';
import { GitSandbox } from './testing/git-sandbox';
import { currentDoing } from './stall-watch';

let git: GitSandbox | null = null;
afterEach(() => git?.cleanup());

test('a git command slower than the threshold is logged with its arguments and time, credentials redacted', async () => {
	git = new GitSandbox();
	const logs: string[] = [];
	const runner = new GitRunner(git.dir, {}, { slowMs: 0, log: (m) => logs.push(m) });
	runner.run(['rev-parse', '--git-dir']);
	await runner.runAsync(['config', 'x.url', 'https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz@github.com/a'], { allowFail: true });
	expect(logs.map((l) => l.replace(/\d+ ms/, 'N ms'))).toEqual([
		'[git] slow: git rev-parse --git-dir took N ms',
		'[git] slow: git config x.url https://x-access-token:***@github.com/a took N ms'
	]);
});

test('a command under the threshold logs nothing, and the server is doing nothing once it ends', () => {
	git = new GitSandbox();
	const logs: string[] = [];
	const runner = new GitRunner(git.dir, {}, { slowMs: 60_000, log: (m) => logs.push(m) });
	runner.run(['rev-parse', '--git-dir']);
	expect(logs).toEqual([]);
	expect(currentDoing()).toBeNull();
});
