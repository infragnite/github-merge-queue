import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitRunner, mergeTrees } from './batch-builder';
import { COUNT_BASELINE_SOURCE, gitConfigEnv, gitVersionProblem, mergeDriverEnv, MIN_GIT_VERSION, requireGitVersion, SORTED_SET_SOURCE } from './merge-drivers';
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

describe('the count-baseline merge driver', () => {
	// The shape of krusty's clippy-baseline.tsv: `count<TAB>file<TAB>finding`, one line per file
	// and finding, in byte order of the whole line.
	const BASELINE = 'clippy-baseline.tsv';
	const COUNTS = 'clippy-baseline.tsv merge=count-baseline\n';
	const row = (count: number, file: string, finding: string) => `${count}\t${file}\t${finding}`;
	const tsv = (...rows: string[]) => rows.map((r) => `${r}\n`).join('');
	/** Commits `text` as the baseline on `branch` (and `.gitattributes` when given). */
	const put = (branch: string, text: string, attributes?: string) => {
		git.git('checkout', '-q', branch);
		if (attributes !== undefined) writeFileSync(join(git.dir, '.gitattributes'), attributes);
		writeFileSync(join(git.dir, BASELINE), text);
		git.git('add', '-A');
		git.git('commit', '-q', '-m', `${branch}: baseline`);
	};
	/** Branches `ours` and `theirs` off main, writes their baselines, and merges them as the queue does. */
	const mergeCounts = (ours: string, theirs: string, r: GitRunner = runner) => {
		git.branch('ours', 'main');
		git.branch('theirs', 'main');
		put('ours', ours);
		put('theirs', theirs);
		const out = r.run([`--attr-source=${git.sha('main')}`, 'merge-tree', '--write-tree', '--name-only', '--no-messages', git.sha('ours'), git.sha('theirs')], { allowFail: true });
		const lines = out.out.split('\n').filter(Boolean);
		if (out.code !== 0) return { clean: false, conflicts: out.code === 1 ? lines.slice(1) : [], text: null };
		return { clean: true, conflicts: [], text: execFileSync('git', ['cat-file', 'blob', `${lines[0]}:${BASELINE}`], { cwd: git.dir, encoding: 'latin1' }) };
	};
	const A = 'src/a.rs';
	const B = 'src/b.rs';
	const MATCH = 'you seem to be trying to use `match` for destructuring a single pattern';
	const DEREF = 'this expression creates a reference which is immediately dereferenced by the compiler';
	const BASE_ROWS = tsv(row(1, B, DEREF), row(3, A, DEREF), row(5, A, MATCH));

	test('two PRs that lower the same count merge into the sum of what each fixed', () => {
		put('main', BASE_ROWS, COUNTS);
		const r = mergeCounts(tsv(row(1, B, DEREF), row(3, A, DEREF), row(4, A, MATCH)), tsv(row(1, B, DEREF), row(3, A, DEREF), row(3, A, MATCH)));
		expect(r).toEqual({ clean: true, conflicts: [], text: tsv(row(1, B, DEREF), row(2, A, MATCH), row(3, A, DEREF)) });
	});

	test('a count raised on one side and lowered on the other adds both changes', () => {
		put('main', BASE_ROWS, COUNTS);
		const r = mergeCounts(tsv(row(1, B, DEREF), row(4, A, DEREF), row(5, A, MATCH)), tsv(row(1, A, DEREF), row(1, B, DEREF), row(5, A, MATCH)));
		expect(r).toEqual({ clean: true, conflicts: [], text: tsv(row(1, B, DEREF), row(2, A, DEREF), row(5, A, MATCH)) });
	});

	test('a finding fixed on both sides down to nothing is dropped, and so is one removed on one side and lowered on the other', () => {
		put('main', tsv(row(2, A, DEREF), row(2, A, MATCH), row(3, B, DEREF)), COUNTS);
		const r = mergeCounts(tsv(row(1, A, DEREF), row(3, B, DEREF)), tsv(row(1, A, DEREF), row(1, A, MATCH), row(3, B, DEREF)));
		expect(r).toEqual({ clean: true, conflicts: [], text: tsv(row(3, B, DEREF)) });
	});

	test('a finding added on one side and another removed on the other keeps both changes, in byte order', () => {
		put('main', BASE_ROWS, COUNTS);
		const r = mergeCounts(tsv(row(1, B, DEREF), row(1, B, MATCH), row(3, A, DEREF), row(5, A, MATCH)), tsv(row(3, A, DEREF), row(5, A, MATCH)));
		expect(r).toEqual({ clean: true, conflicts: [], text: tsv(row(1, B, MATCH), row(3, A, DEREF), row(5, A, MATCH)) });
	});

	test('the same new finding added on both sides counts both', () => {
		put('main', BASE_ROWS, COUNTS);
		const r = mergeCounts(tsv(row(1, B, DEREF), row(1, B, MATCH), row(3, A, DEREF), row(5, A, MATCH)), tsv(row(1, B, DEREF), row(1, B, MATCH), row(3, A, DEREF), row(4, A, MATCH)));
		expect(r).toEqual({ clean: true, conflicts: [], text: tsv(row(1, B, DEREF), row(2, B, MATCH), row(3, A, DEREF), row(4, A, MATCH)) });
	});

	test('a count that is not a whole number falls back to the line merge, which conflicts', () => {
		put('main', BASE_ROWS, COUNTS);
		const r = mergeCounts(tsv(row(1, B, DEREF), row(3, A, DEREF), row(4, A, MATCH)), tsv(row(1, B, DEREF), row(3, A, DEREF), `x\t${A}\t${MATCH}`));
		expect(r).toEqual({ clean: false, conflicts: [BASELINE], text: null });
	});

	test('a line without a key falls back to the line merge', () => {
		put('main', BASE_ROWS, COUNTS);
		const r = mergeCounts(tsv(row(1, B, DEREF), row(3, A, DEREF), row(4, A, MATCH)), tsv(row(1, B, DEREF), row(3, A, DEREF), '3'));
		expect(r).toEqual({ clean: false, conflicts: [BASELINE], text: null });
	});

	test('a finding listed twice falls back to the line merge', () => {
		put('main', BASE_ROWS, COUNTS);
		const r = mergeCounts(tsv(row(1, B, DEREF), row(3, A, DEREF), row(4, A, MATCH)), tsv(row(1, B, DEREF), row(2, A, MATCH), row(3, A, DEREF), row(3, A, MATCH)));
		expect(r).toEqual({ clean: false, conflicts: [BASELINE], text: null });
	});

	test('lines out of byte order fall back to the line merge', () => {
		put('main', tsv(row(5, A, MATCH), row(3, A, DEREF), row(1, B, DEREF)), COUNTS);
		const r = mergeCounts(tsv(row(4, A, MATCH), row(3, A, DEREF), row(1, B, DEREF)), tsv(row(3, A, MATCH), row(3, A, DEREF), row(1, B, DEREF)));
		expect(r).toEqual({ clean: false, conflicts: [BASELINE], text: null });
	});

	test('a baseline both sides add, with no version before, merges as an empty one', () => {
		git.git('checkout', '-q', 'main');
		writeFileSync(join(git.dir, '.gitattributes'), COUNTS);
		git.git('add', '-A');
		git.git('commit', '-q', '-m', 'attributes');
		const r = mergeCounts(tsv(row(1, A, DEREF), row(2, A, MATCH)), tsv(row(1, A, MATCH), row(1, B, DEREF)));
		expect(r).toEqual({ clean: true, conflicts: [], text: tsv(row(1, A, DEREF), row(1, B, DEREF), row(3, A, MATCH)) });
	});

	test('CRLF lines keep their line ends', () => {
		const crlf = (...rows: string[]) => rows.map((x) => `${x}\r\n`).join('');
		put('main', crlf(row(1, B, DEREF), row(3, A, DEREF), row(5, A, MATCH)), COUNTS);
		const r = mergeCounts(crlf(row(1, B, DEREF), row(3, A, DEREF), row(4, A, MATCH)), crlf(row(1, B, DEREF), row(3, A, DEREF), row(3, A, MATCH)));
		expect(r).toEqual({ clean: true, conflicts: [], text: crlf(row(1, B, DEREF), row(2, A, MATCH), row(3, A, DEREF)) });
	});

	test('without the attributes the same merge conflicts', () => {
		put('main', BASE_ROWS, '');
		const r = mergeCounts(tsv(row(1, B, DEREF), row(3, A, DEREF), row(4, A, MATCH)), tsv(row(1, B, DEREF), row(3, A, DEREF), row(3, A, MATCH)));
		expect(r).toEqual({ clean: false, conflicts: [BASELINE], text: null });
	});

	test('without the driver environment the same merge conflicts', () => {
		put('main', BASE_ROWS, COUNTS);
		const r = mergeCounts(tsv(row(1, B, DEREF), row(3, A, DEREF), row(4, A, MATCH)), tsv(row(1, B, DEREF), row(3, A, DEREF), row(3, A, MATCH)), new GitRunner(git.dir));
		expect(r).toEqual({ clean: false, conflicts: [BASELINE], text: null });
	});

	test("GitHub's line merge conflicts where the queue's merge sums the counts", () => {
		put('main', BASE_ROWS, COUNTS);
		git.branch('ours', 'main');
		git.branch('theirs', 'main');
		put('ours', tsv(row(1, B, DEREF), row(3, A, DEREF), row(4, A, MATCH)));
		put('theirs', tsv(row(1, B, DEREF), row(3, A, DEREF), row(3, A, MATCH)));
		const t = mergeTrees(runner, git.sha('ours'), git.sha('theirs'), git.sha('main'));
		expect(t.line).toBeNull();
		expect(git.git('show', `${t.queue}:${BASELINE}`)).toBe(tsv(row(1, B, DEREF), row(2, A, MATCH), row(3, A, DEREF)).trimEnd());
	});
});

describe('where the attributes come from', () => {
	test('a PR that adds the attributes does not get the driver: only the base decides', () => {
		write('main', BASE);
		const r = merge([...HEADER, 'a.kt', 'c.kt', 'd.kt', 'e.kt'], [...HEADER, 'a.kt', 'b.kt', 'd.kt', 'e.kt'], { attrsOn: 'theirs' });
		expect(r).toEqual({ clean: false, conflicts: [LIST], text: null });
	});
});

describe('bytes and order', () => {
	/** Commits `bytes` as the list on `branch`. */
	const writeBytes = (branch: string, entries: Buffer[], attributes?: string) => {
		git.git('checkout', '-q', branch);
		if (attributes !== undefined) writeFileSync(join(git.dir, '.gitattributes'), attributes);
		mkdirSync(join(git.dir, 'lists'), { recursive: true });
		writeFileSync(join(git.dir, LIST), Buffer.concat(entries.flatMap((e) => [e, Buffer.from('\n')])));
		git.git('add', '-A');
		git.git('commit', '-q', '-m', `${branch}: ${entries.length} lines`);
	};
	const b = (s: string) => Buffer.from(s, 'latin1');
	const mergeBytes = (ours: Buffer[], theirs: Buffer[]) => {
		git.branch('ours', 'main');
		git.branch('theirs', 'main');
		writeBytes('ours', ours);
		writeBytes('theirs', theirs);
		const r = runner.run([`--attr-source=${git.sha('main')}`, 'merge-tree', '--write-tree', '--name-only', '--no-messages', git.sha('ours'), git.sha('theirs')], { allowFail: true });
		if (r.code !== 0) return null;
		return execFileSync('git', ['cat-file', 'blob', `${r.out.split('\n')[0]}:${LIST}`], { cwd: git.dir });
	};

	test('an entry that is not UTF-8 keeps its bytes', () => {
		// 0xE9 alone is "é" in Latin-1, and not valid UTF-8.
		writeBytes('main', [b('# header'), b('a.kt'), b('b.kt'), b('caf\xe9.kt'), b('d.kt')], SET);
		const out = mergeBytes([b('# header'), b('a.kt'), b('caf\xe9.kt'), b('d.kt')], [b('# header'), b('a.kt'), b('b.kt'), b('caf\xe9.kt')]);
		expect(out).toEqual(Buffer.from('# header\na.kt\ncaf\xe9.kt\n', 'latin1'));
	});

	test('UTF-8 entries are kept in byte order', () => {
		// "z" (0x7a) sorts before "é" (0xc3 0xa9) by bytes.
		const u = (s: string) => Buffer.from(s, 'utf8');
		writeBytes('main', [u('a.kt'), u('b.kt'), u('z.kt'), u('é.kt')], SET);
		const out = mergeBytes([u('a.kt'), u('y.kt'), u('z.kt'), u('é.kt')], [u('a.kt'), u('b.kt'), u('z.kt'), u('é.kt'), u('ü.kt')]);
		expect(out?.toString('utf8')).toBe('a.kt\ny.kt\nz.kt\né.kt\nü.kt\n');
	});

	test('CRLF lines keep their line ends', () => {
		writeBytes('main', [b('a.kt\r'), b('b.kt\r'), b('c.kt\r'), b('d.kt\r')], SET);
		const out = mergeBytes([b('a.kt\r'), b('c.kt\r'), b('d.kt\r')], [b('a.kt\r'), b('b.kt\r'), b('d.kt\r')]);
		expect(out?.toString('latin1')).toBe('a.kt\r\nd.kt\r\n');
	});
});

describe('the driver environment', () => {
	const saved = { ...process.env };
	afterEach(() => {
		for (const k of Object.keys(process.env)) if (k.startsWith('GIT_CONFIG_') && !(k in saved)) delete process.env[k];
		for (const [k, v] of Object.entries(saved)) if (k.startsWith('GIT_CONFIG_')) process.env[k] = v;
	});

	test('gitConfigEnv appends after the entries already in the environment', () => {
		const base = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*', GIT_CONFIG_KEY_1: 'core.x', GIT_CONFIG_VALUE_1: 'y' };
		expect(gitConfigEnv([['a.b', 'c']], base)).toEqual({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'a.b', GIT_CONFIG_VALUE_2: 'c' });
		expect(gitConfigEnv([['a.b', 'c']], {})).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' });
		expect(() => gitConfigEnv([['a.b', 'c']], { GIT_CONFIG_COUNT: 'x' })).toThrow(/GIT_CONFIG_COUNT/);
	});

	test("the server's own GIT_CONFIG_* entries still apply beside the driver", () => {
		process.env.GIT_CONFIG_COUNT = '1';
		process.env.GIT_CONFIG_KEY_0 = 'queue.server';
		process.env.GIT_CONFIG_VALUE_0 = 'kept';
		const withServer = new GitRunner(git.dir, mergeDriverEnv(join(git.dir, '.git')));
		expect(withServer.run(['config', '--get', 'queue.server']).out).toBe('kept');
		expect(withServer.run(['config', '--get', 'merge.sorted-set.driver']).out).toMatch(/sorted-set\.cjs' %O %A %B$/);
		expect(withServer.run(['config', '--get', 'merge.count-baseline.driver']).out).toMatch(/count-baseline\.cjs' %O %A %B$/);
		write('main', BASE, SET);
		const r = merge([...HEADER, 'a.kt', 'c.kt', 'd.kt', 'e.kt'], [...HEADER, 'a.kt', 'b.kt', 'd.kt', 'e.kt'], { runner: withServer });
		expect(r).toEqual({ clean: true, conflicts: [], text: list('a.kt', 'd.kt', 'e.kt') });
	});

	test('the driver file is replaced through a rename, never written in place', () => {
		const folder = join(git.dir, '.git', 'merge-drivers');
		const file = join(folder, 'sorted-set.cjs');
		// Another name for the same file: a write in place would change it too.
		const other = join(git.dir, '.git', 'other.cjs');
		writeFileSync(other, '// an older driver\n');
		rmSync(file);
		linkSync(other, file);
		mergeDriverEnv(join(git.dir, '.git'));
		expect(readFileSync(file, 'utf8')).toBe(SORTED_SET_SOURCE);
		expect(readFileSync(other, 'utf8')).toBe('// an older driver\n');
		expect(readdirSync(folder).sort()).toEqual(['count-baseline.cjs', 'sorted-set.cjs']);
	});

	test('an up-to-date driver file is left as it is', () => {
		for (const name of ['sorted-set.cjs', 'count-baseline.cjs']) {
			const file = join(git.dir, '.git', 'merge-drivers', name);
			const before = statSync(file).ino;
			mergeDriverEnv(join(git.dir, '.git'));
			expect(statSync(file).ino).toBe(before);
		}
	});

	test('each driver file holds its own program', () => {
		const folder = join(git.dir, '.git', 'merge-drivers');
		expect(readFileSync(join(folder, 'sorted-set.cjs'), 'utf8')).toBe(SORTED_SET_SOURCE);
		expect(readFileSync(join(folder, 'count-baseline.cjs'), 'utf8')).toBe(COUNT_BASELINE_SOURCE);
	});
});

describe('the line merge GitHub makes', () => {
	/** Branches `ours` and `theirs` off main, each changing the given files. */
	const branches = (ours: Record<string, string>, theirs: Record<string, string>) => {
		for (const [name, files] of [['ours', ours], ['theirs', theirs]] as const) {
			git.branch(name, 'main');
			git.git('checkout', '-q', name);
			for (const [path, text] of Object.entries(files)) writeFileSync(join(git.dir, path), text);
			git.git('add', '-A');
			git.git('commit', '-q', '-m', name);
		}
	};
	const ATTRS = 'lists/** merge=sorted-set\nnotes.txt merge=union\n';
	const lines = (...l: string[]) => l.map((x) => `${x}\n`).join('');

	beforeEach(() => {
		git.git('checkout', '-q', 'main');
		writeFileSync(join(git.dir, 'notes.txt'), lines('one'));
		write('main', BASE, ATTRS);
	});

	test("ignores every merge attribute, union too, as GitHub's merge does; the queue's merge applies them", () => {
		// GitHub's merge doesn't honor .gitattributes merge drivers: github.com/orgs/community/discussions/9288
		branches({ 'notes.txt': lines('one', 'two') }, { 'notes.txt': lines('one', 'three') });
		const t = mergeTrees(runner, git.sha('ours'), git.sha('theirs'), git.sha('main'));
		expect(t.line).toBeNull();
		expect(git.git('show', `${t.queue}:notes.txt`)).toBe('one\ntwo\nthree');
	});

	test('a sorted-set list merges only with the queue driver; the line merge conflicts', () => {
		branches({ [LIST]: lines(...HEADER, 'a.kt', 'c.kt', 'd.kt', 'e.kt') }, { [LIST]: lines(...HEADER, 'a.kt', 'b.kt', 'd.kt', 'e.kt') });
		const t = mergeTrees(runner, git.sha('ours'), git.sha('theirs'), git.sha('main'));
		expect(git.git('show', `${t.queue}:${LIST}`)).toBe(list('a.kt', 'd.kt', 'e.kt'));
		expect(t.line).toBeNull();
	});

	test('changes far apart in a sorted-set list give the same tree either way', () => {
		branches({ [LIST]: lines(...HEADER, 'b.kt', 'c.kt', 'd.kt', 'e.kt') }, { [LIST]: lines(...HEADER, 'a.kt', 'b.kt', 'c.kt', 'd.kt') });
		const t = mergeTrees(runner, git.sha('ours'), git.sha('theirs'), git.sha('main'));
		expect(t.queue).not.toBeNull();
		expect(t.line).toBe(t.queue);
	});

	test('the drivers come from the attributes given, not from the commit merged onto or the PR', () => {
		// `ours` stands for master after a PR that dropped the attributes landed; `theirs` adds them itself.
		const routed = git.sha('main');
		branches(
			{ [LIST]: lines(...HEADER, 'a.kt', 'c.kt', 'd.kt', 'e.kt'), '.gitattributes': '' },
			{ [LIST]: lines(...HEADER, 'a.kt', 'b.kt', 'd.kt', 'e.kt'), '.gitattributes': ATTRS }
		);
		const t = mergeTrees(runner, git.sha('ours'), git.sha('theirs'), routed);
		expect(t.line).toBeNull();
		expect(t.queue).not.toBeNull();
		git.git('checkout', '-q', 'main');
		writeFileSync(join(git.dir, '.gitattributes'), '');
		git.git('commit', '-q', '-am', 'no attributes');
		expect(mergeTrees(runner, git.sha('ours'), git.sha('theirs'), git.sha('main'))).toEqual({ queue: null, line: null });
	});
});

describe('the git version', () => {
	test('needs git 2.41 or newer, for --attr-source', () => {
		expect(MIN_GIT_VERSION).toBe('2.41');
		expect(gitVersionProblem('git version 2.40.1\n')).toMatch(/git 2\.40 is too old .* needs git 2\.41 or newer/);
		expect(gitVersionProblem('git version 1.9.5')).toMatch(/too old/);
		expect(gitVersionProblem('git version 2.41.0')).toBeNull();
		expect(gitVersionProblem('git version 2.43.0.windows.1')).toBeNull();
		expect(gitVersionProblem('git version 3.0.0')).toBeNull();
		expect(gitVersionProblem('something else')).toMatch(/Could not read the git version/);
	});

	test('the git these tests run on passes', () => {
		expect(() => requireGitVersion()).not.toThrow();
	});

	test('an old git fails the merge that needs it, with the reason', () => {
		expect(() => requireGitVersion(() => 'git version 2.40.1')).toThrow(/git 2\.40 is too old/);
		expect(() => requireGitVersion(() => 'git version 2.45.2')).not.toThrow();
	});
});
