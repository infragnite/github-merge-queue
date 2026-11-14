import { afterEach, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { GitRunner, mergeTrees } from './batch-builder';
import { GitSandbox } from './testing/git-sandbox';

let git: GitSandbox | null = null;
afterEach(() => git?.cleanup());

/** Pids of running processes whose command line contains `marker`. */
function running(marker: string): number[] {
	const out: number[] = [];
	for (const d of readdirSync('/proc')) {
		if (!/^\d+$/.test(d)) continue;
		try {
			if (readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ').includes(marker)) out.push(Number(d));
		} catch {
			// gone
		}
	}
	return out;
}

test('a git command runs off the event loop: timers fire while it runs', async () => {
	git = new GitSandbox();
	const runner = new GitRunner(git.dir);
	let ticks = 0;
	const timer = setInterval(() => ticks++, 50);
	await runner.run(['-c', 'alias.slow=!sleep 1', 'slow']);
	clearInterval(timer);
	expect(ticks).toBeGreaterThanOrEqual(5);
});

test('input goes to the command on stdin', async () => {
	git = new GitSandbox();
	const runner = new GitRunner(git.dir);
	const sha = (await runner.run(['hash-object', '--stdin'], { input: 'hello\n' })).out;
	expect(sha).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
});

test('a timeout kills the whole process group, so a child git started does not outlive it', async () => {
	git = new GitSandbox();
	const runner = new GitRunner(git.dir);
	const started = Date.now();
	await expect(runner.run(['-c', 'alias.hang=!sh -c "sleep 31.25 & sleep 31.5"', 'hang'], { timeoutMs: 500 })).rejects.toThrow(/killed after 500 ms/);
	expect(Date.now() - started).toBeLessThan(5_000);
	await new Promise((r) => setTimeout(r, 200));
	expect(running('sleep 31.25')).toEqual([]);
	expect(running('sleep 31.5')).toEqual([]);
});

test('a failing command with allowFail gives its code and output', async () => {
	git = new GitSandbox();
	const r = await new GitRunner(git.dir).run(['rev-parse', '--verify', '-q', 'nope'], { allowFail: true });
	expect(r.code).toBe(1);
	expect(r.out).toBe('');
});

test('merging trees returns a promise', () => {
	git = new GitSandbox();
	const head = git.sha('main');
	const r = mergeTrees(new GitRunner(git.dir), head, head, head);
	expect(r).toBeInstanceOf(Promise);
	return r;
});
