import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitRunner } from './batch-builder';
import { mergeDriverEnv } from './merge-drivers';
import { GitSandbox } from './testing/git-sandbox';

let git: GitSandbox;
let runner: GitRunner;

beforeEach(() => {
	git = new GitSandbox();
	runner = new GitRunner(git.dir, mergeDriverEnv(join(git.dir, '.git')));
});

afterEach(() => git?.cleanup());

const LIST = 'lists/lane.txt';
const HEADER = ['# Files expected to fail.', '# The list only shrinks.'];

/** Commits `lines` as the list on `branch` (and `.gitattributes` when given). */
function write(branch: string, lines: string[], attributes?: string) {
	git.git('checkout', '-q', branch);
	if (attributes !== undefined) writeFileSync(join(git.dir, '.gitattributes'), attributes);
	mkdirSync(join(git.dir, 'lists'), { recursive: true });
	writeFileSync(join(git.dir, LIST), lines.map((l) => `${l}\n`).join(''));
	git.git('add', '-A');
	git.git('commit', '-q', '-m', `${branch}: ${lines.length} lines`);
}

const SET = 'lists/** merge=sorted-set\n';

/** Branches `ours` and `theirs` off `main`, writes their lists, and merges them as the queue does. */
function merge(ours: string[], theirs: string[], opts: { attrsOn?: 'main' | 'theirs'; runner?: GitRunner } = {}) {
	git.branch('ours', 'main');
	git.branch('theirs', 'main');
	write('ours', ours);
	write('theirs', theirs, opts.attrsOn === 'theirs' ? SET : undefined);
	const r = (opts.runner ?? runner).run(
		[`--attr-source=${git.sha('main')}`, 'merge-tree', '--write-tree', '--name-only', '--no-messages', git.sha('ours'), git.sha('theirs')],
		{ allowFail: true }
	);
	const lines = r.out.split('\n').filter(Boolean);
	return { clean: r.code === 0, conflicts: r.code === 1 ? lines.slice(1) : [], text: r.code === 0 ? git.git('show', `${lines[0]}:${LIST}`) : null };
}

const BASE = [...HEADER, 'a.kt', 'b.kt', 'c.kt', 'd.kt', 'e.kt'];
const list = (...entries: string[]) => [...HEADER, ...entries].join('\n');

describe('the sorted-set merge driver', () => {
	beforeEach(() => write('main', BASE, SET));

	test('neighbouring removals on two branches merge without a conflict and stay removed', () => {
		const r = merge([...HEADER, 'a.kt', 'c.kt', 'd.kt', 'e.kt'], [...HEADER, 'a.kt', 'b.kt', 'd.kt', 'e.kt']);
		expect(r).toEqual({ clean: true, conflicts: [], text: list('a.kt', 'd.kt', 'e.kt') });
	});

	test('an entry removed on both sides, beside one removed on one side, stays removed', () => {
		const r = merge([...HEADER, 'a.kt', 'b.kt', 'e.kt'], [...HEADER, 'a.kt', 'b.kt', 'c.kt', 'e.kt']);
		expect(r).toEqual({ clean: true, conflicts: [], text: list('a.kt', 'b.kt', 'e.kt') });
	});

	test('an addition beside a removal keeps both changes, in byte order', () => {
		const r = merge([...HEADER, 'a.kt', 'b.kt', 'bb.kt', 'c.kt', 'd.kt', 'e.kt'], [...HEADER, 'a.kt', 'b.kt', 'd.kt', 'e.kt']);
		expect(r).toEqual({ clean: true, conflicts: [], text: list('a.kt', 'b.kt', 'bb.kt', 'd.kt', 'e.kt') });
	});

	test('a header changed on one side is kept', () => {
		const r = merge(['# Files expected to fail on this lane.', HEADER[1], 'a.kt', 'c.kt', 'd.kt', 'e.kt'], [...HEADER, 'a.kt', 'b.kt', 'd.kt', 'e.kt']);
		expect(r).toEqual({ clean: true, conflicts: [], text: ['# Files expected to fail on this lane.', HEADER[1], 'a.kt', 'd.kt', 'e.kt'].join('\n') });
	});

	test('headers changed differently on both sides fall back to the line merge, which conflicts', () => {
		const r = merge(['# One.', 'a.kt', 'c.kt', 'd.kt', 'e.kt'], ['# Two.', 'a.kt', 'b.kt', 'd.kt', 'e.kt']);
		expect(r).toEqual({ clean: false, conflicts: [LIST], text: null });
	});

	test('a comment between entries is not a set: the line merge decides', () => {
		const r = merge([...HEADER, 'a.kt', '# group', 'b.kt', 'c.kt', 'd.kt', 'e.kt'], [...HEADER, 'a.kt', 'b.kt', 'c.kt', 'd.kt']);
		expect(r).toEqual({ clean: true, conflicts: [], text: list('a.kt', '# group', 'b.kt', 'c.kt', 'd.kt') });
	});

	test('entries out of order are not a set: neighbouring edits conflict as in a line merge', () => {
		write('main', [...HEADER, 'b.kt', 'a.kt', 'c.kt']);
		const r = merge([...HEADER, 'b.kt', 'c.kt'], [...HEADER, 'b.kt', 'a.kt']);
		expect(r).toEqual({ clean: false, conflicts: [LIST], text: null });
	});

	test('without the driver environment the same merge conflicts', () => {
		const r = merge([...HEADER, 'a.kt', 'c.kt', 'd.kt', 'e.kt'], [...HEADER, 'a.kt', 'b.kt', 'd.kt', 'e.kt'], { runner: new GitRunner(git.dir) });
		expect(r).toEqual({ clean: false, conflicts: [LIST], text: null });
	});
});

describe('where the attributes come from', () => {
	test('a PR that adds the attributes does not get the driver: only the base decides', () => {
		write('main', BASE);
		const r = merge([...HEADER, 'a.kt', 'c.kt', 'd.kt', 'e.kt'], [...HEADER, 'a.kt', 'b.kt', 'd.kt', 'e.kt'], { attrsOn: 'theirs' });
		expect(r).toEqual({ clean: false, conflicts: [LIST], text: null });
	});
});
