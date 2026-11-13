import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childProcesses, currentDoing, doing, formatStall, startStallWatch, stopStallWatch, withDoing } from './stall-watch';

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), 'stall-'));
	dirs.push(d);
	return d;
};
afterEach(async () => {
	await stopStallWatch();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('what a stall report says', () => {
	test('how long, what the queue was doing, the main thread stack, and the processes it started', () => {
		expect(
			formatStall({
				blockedMs: 21_500,
				doing: 'qnox/krusty: merging #1 #2 · git merge-tree --write-tree a b',
				stack: ['spin (src/lib/server/x.ts:4)', 'build (src/lib/server/batch-builder.ts:197)'],
				children: [
					{ pid: 101, depth: 1, args: 'git merge-tree --write-tree a b' },
					{ pid: 102, depth: 2, args: 'node /data/merge-drivers/sorted-set.cjs x y z' }
				]
			})
		).toBe(
			[
				'[stall] main thread blocked for 21 s',
				'[stall] doing: qnox/krusty: merging #1 #2 · git merge-tree --write-tree a b',
				'[stall] at spin (src/lib/server/x.ts:4)',
				'[stall]    build (src/lib/server/batch-builder.ts:197)',
				'[stall] child 101: git merge-tree --write-tree a b',
				'[stall]   child 102: node /data/merge-drivers/sorted-set.cjs x y z'
			].join('\n')
		);
	});

	test('a stack it could not read and no children say so', () => {
		expect(formatStall({ blockedMs: 20_000, doing: null, stack: null, children: [] })).toBe(
			[
				'[stall] main thread blocked for 20 s',
				'[stall] doing: nothing recorded',
				'[stall] at: stack not captured (the main thread is inside a native call, such as a synchronous child process)',
				'[stall] no child processes'
			].join('\n')
		);
	});
});

describe('the processes the server started', () => {
	test('read from /proc, children before grandchildren, with credentials redacted', () => {
		const proc = tmp();
		const put = (pid: number, cmdline: string[], children: number[]) => {
			mkdirSync(join(proc, String(pid), 'task', String(pid)), { recursive: true });
			writeFileSync(join(proc, String(pid), 'cmdline'), cmdline.join('\0') + '\0');
			writeFileSync(join(proc, String(pid), 'task', String(pid), 'children'), children.map((c) => `${c} `).join(''));
		};
		put(100, ['node', 'build'], [101]);
		put(101, ['git', 'fetch', 'https://x-access-token:ghs_secret@github.com/a/b'], [102]);
		put(102, ['git-remote-https', 'origin'], []);
		expect(childProcesses(100, proc)).toEqual([
			{ pid: 101, depth: 1, args: 'git fetch https://x-access-token:***@github.com/a/b' },
			{ pid: 102, depth: 2, args: 'git-remote-https origin' }
		]);
	});

	test('a process that is gone, or no /proc at all, gives what is left', () => {
		const proc = tmp();
		mkdirSync(join(proc, '100', 'task', '100'), { recursive: true });
		writeFileSync(join(proc, '100', 'task', '100', 'children'), '101 ');
		expect(childProcesses(100, proc)).toEqual([]);
		expect(childProcesses(100, join(proc, 'missing'))).toEqual([]);
	});
});

describe('what the server is doing', () => {
	test('a step and the git command inside it read as one line, and each ends with its own scope', () => {
		doing(null);
		const seen: (string | null)[] = [];
		withDoing('qnox/krusty: merging #1', () => {
			seen.push(currentDoing());
			withDoing('git merge-tree a b', () => seen.push(currentDoing()));
			seen.push(currentDoing());
		});
		seen.push(currentDoing());
		expect(seen).toEqual(['qnox/krusty: merging #1', 'qnox/krusty: merging #1 · git merge-tree a b', 'qnox/krusty: merging #1', null]);
	});

	test('a scope that throws still ends', () => {
		expect(() => withDoing('a', () => { throw new Error('x'); })).toThrow('x');
		expect(currentDoing()).toBeNull();
	});
});

describe('the watchdog thread', () => {
	function spinForTheStallTest(ms: number) {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			/* the main thread is busy */
		}
	}

	test('while the main thread spins, it logs the stall with the spinning function and what the queue was doing', async () => {
		const file = join(tmp(), 'stall.log');
		startStallWatch({ stallMs: 400, checkMs: 100, repeatMs: 60_000, logFile: file });
		await new Promise((r) => setTimeout(r, 300));
		doing('qnox/krusty: reading the stacks');
		spinForTheStallTest(2_500);
		doing(null);
		await new Promise((r) => setTimeout(r, 500));
		const log = readFileSync(file, 'utf8');
		expect(log).toMatch(/^\[stall\] main thread blocked for \d+ s$/m);
		expect(log).toContain('[stall] doing: qnox/krusty: reading the stacks');
		expect(log).toMatch(/^\[stall\] at spinForTheStallTest \(.*stall-watch\.test\.ts:\d+\)$/m);
		expect(log).toContain('[stall] main thread free again after');
	});

	test('a free main thread logs nothing', async () => {
		const file = join(tmp(), 'stall.log');
		startStallWatch({ stallMs: 400, checkMs: 100, repeatMs: 60_000, logFile: file });
		await new Promise((r) => setTimeout(r, 1_200));
		expect(() => readFileSync(file, 'utf8')).toThrow();
	});
});
