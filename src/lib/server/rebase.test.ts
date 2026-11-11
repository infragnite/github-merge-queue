import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitRunner } from './batch-builder';
import { replay } from './rebase';
import { mergeDriverEnv } from './merge-drivers';
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

describe('merge drivers in a restack', () => {
	const LIST = 'lane.txt';
	let queue: GitRunner;
	beforeEach(() => {
		queue = new GitRunner(git.dir, mergeDriverEnv(join(git.dir, '.git')));
		write('main', LIST, 'a\nb\nc\nd\ne\n', 'list');
	});

	/**
	 * A parent that routes the list to the sorted-set driver itself, a child removing `c`, and the
	 * parent rebased onto a main that removed `b`: replaying the child is a neighbouring-line merge.
	 */
	const stack = (mainAttributes: boolean) => {
		if (mainAttributes) write('main', '.gitattributes', `${LIST} merge=sorted-set\n`, 'attributes on main');
		git.branch('a', 'main');
		if (!mainAttributes) write('a', '.gitattributes', `${LIST} merge=sorted-set\n`, 'parent opts the list in');
		write('a', 'lib.txt', 'lib\n', 'parent work');
		const oldParent = git.sha('a');
		git.branch('b', 'a');
		write('b', LIST, 'a\nb\nd\ne\n', 'child removes c');
		write('main', LIST, 'a\nc\nd\ne\n', 'main removes b');
		git.rebase('a', 'main');
		return { head: git.sha('b'), upstream: oldParent, onto: git.sha('a') };
	};

	test("a parent's own attributes do not pick the driver: the default branch's do", () => {
		const s = stack(false);
		const r = replay(queue, { ...s, attrs: git.sha('main'), date: 1 });
		expect(r).toMatchObject({ ok: false, conflicts: [LIST] });
	});

	test('the default branch routing the list to the driver restacks cleanly', () => {
		const s = stack(true);
		const r = replay(queue, { ...s, attrs: git.sha('main'), date: 1 });
		expect(r.ok).toBe(true);
		if (r.ok) expect(git.git('show', `${r.head}:${LIST}`)).toBe('a\nd\ne');
	});
});
