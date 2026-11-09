import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitRunner } from './batch-builder';
import { replay } from './rebase';
import { GitSandbox } from './testing/git-sandbox';

let git: GitSandbox;
let runner: GitRunner;

beforeEach(() => {
	git = new GitSandbox();
	runner = new GitRunner(git.dir);
});

afterEach(() => git?.cleanup());

const write = (branch: string, file: string, text: string, msg: string) => {
	git.git('checkout', '-q', branch);
	writeFileSync(join(git.dir, file), text);
	git.git('add', '-A');
	git.git('commit', '-q', '-m', msg);
};

describe('replaying a PR onto a new base', () => {
	test('restacks a child onto its rebased parent, keeping author and message', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1', 'lib.txt');
		git.branch('b', 'a');
		const oldParent = git.sha('a');
		git.commit('b', 'b1');
		git.commit('b', 'b2');
		git.commit('main', 'm1');
		git.rebase('a', 'main');
		const r = replay(runner, { head: git.sha('b'), upstream: oldParent, onto: git.sha('a'), date: 1 });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.replayed).toBe(2);
		expect(git.git('log', '--format=%s|%ae', `a..${r.head}`).split('\n')).toEqual(['b2|dev@example.com', 'b1|dev@example.com']);
		git.git('merge-base', '--is-ancestor', 'a', r.head);
		expect(git.git('ls-tree', '-r', '--name-only', r.head).split('\n').sort()).toEqual(['b1.txt', 'b2.txt', 'lib.txt', 'm1.txt']);
	});

	test('skips commits already on the new base (merged in from main)', () => {
		git.branch('a', 'main');
		git.commit('a', 'a1');
		git.commit('main', 'm1');
		git.mergeInto('a', 'main');
		git.commit('a', 'a2');
		const r = replay(runner, { head: git.sha('a'), upstream: git.sha('main~1'), onto: git.sha('main') });
		expect(r.ok && r.replayed).toBe(2);
	});

	test('a conflict is not a trivial rebase', () => {
		write('main', 'f.txt', 'base\n', 'base');
		git.branch('a', 'main');
		write('a', 'f.txt', 'from a\n', 'a1');
		write('main', 'f.txt', 'from main\n', 'm1');
		const r = replay(runner, { head: git.sha('a'), upstream: git.sha('main~1'), onto: git.sha('main') });
		expect(r).toMatchObject({ ok: false, conflicts: ['f.txt'] });
	});

	test('a change that applies as a whole but not commit by commit is not trivial either', () => {
		write('main', 'f.txt', 'base\n', 'base');
		git.branch('a', 'main');
		write('a', 'f.txt', 'from a\n', 'a1'); // conflicts with main...
		write('a', 'f.txt', 'from main\n', 'a2'); // ...but the PR ends up where main is
		write('main', 'f.txt', 'from main\n', 'm1');
		const r = replay(runner, { head: git.sha('a'), upstream: git.sha('main~1'), onto: git.sha('main') });
		expect(r.ok).toBe(false);
	});
});
