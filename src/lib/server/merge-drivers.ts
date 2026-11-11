// Merge drivers the queue provides to the repositories it merges.
//
// A repository opts a file in with `.gitattributes` (`path merge=sorted-set`); the queue reads the
// attributes from the commit a merge lands on, never from a PR head, and only ever runs its own
// drivers, so a repository chooses among them but cannot make the queue run its code.
//
// `sorted-set` is for lists that are a set of lines: a leading header of comment (`#`) and blank
// lines, then unique entries in byte order, such as a test suite's expected-failure manifest. Two
// branches that remove or add neighbouring entries changed different elements, but a line merge
// reports a conflict. The driver keeps an entry exactly when both sides still have it or one side
// added it, and drops one that either side removed, so a merge never brings back an entry a branch
// deleted. It writes the entries back in byte order under the merged header. When both sides
// changed the header differently, or a version is not a set (a comment or blank line between
// entries, an entry out of order or repeated), it falls back to git's line merge and its conflict
// markers.
//
// `count-baseline` is for a list of counts, one line per key: `<count><TAB><key>`, a whole number
// then everything after the first tab, unique keys, whole lines in byte order, such as krusty's
// clippy-baseline.tsv (`count<TAB>file<TAB>finding`). Two branches that each fix some of a finding
// change the same line, which a line merge reports as a conflict, but the counts add up: the
// merged count of a key is the base count plus what each side changed (a missing key counts 0),
// and a key whose count is no longer above 0 is dropped. It writes the lines back in byte order.
// When a version does not parse that way (a count that is not a whole number, a line without a
// tab, a key listed twice, lines out of order), it falls back to git's line merge.
//
// Git reads drivers only from config, so the queue passes them in the environment of its own git
// runs (`mergeDriverEnv`); a merge it does not run (GitHub's own) never sees them. GitHub's merge
// reads no merge attributes at all, `merge=union` included, so where the queue merges as GitHub
// does it reads none either (`--attr-source` set to the empty tree).
//
// The driver handles a file as bytes (latin1 maps each byte to one character), so entries in any
// encoding keep their bytes, and byte order is the order of those characters.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SORTED_SET_DRIVER = 'sorted-set';

/** The driver program, run by git as `node <file> %O %A %B`; the result replaces `%A`. */
export const SORTED_SET_SOURCE = `'use strict';
// Written by the merge queue (merge-drivers.ts); rewritten on every start.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const [base, ours, theirs] = process.argv.slice(2);

function lineMerge() {
	const r = spawnSync('git', ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', ours, base, theirs], { stdio: 'inherit' });
	process.exit(r.status === null ? 2 : r.status);
}

// A header (leading comment and blank lines) and the entries after it, or null when it is not a set.
function split(file) {
	const lines = fs.readFileSync(file, 'latin1').split('\\n');
	if (lines[lines.length - 1] === '') lines.pop();
	let i = 0;
	while (i < lines.length && (lines[i].startsWith('#') || lines[i].trim() === '')) i++;
	const entries = lines.slice(i);
	for (let k = 0; k < entries.length; k++) {
		if (entries[k].startsWith('#') || entries[k].trim() === '') return null;
		if (k > 0 && entries[k - 1] >= entries[k]) return null;
	}
	return { header: lines.slice(0, i).join('\\n'), entries };
}

const o = split(base);
const a = split(ours);
const b = split(theirs);
if (!o || !a || !b) lineMerge();

let header;
if (a.header === b.header || o.header === b.header) header = a.header;
else if (o.header === a.header) header = b.header;
else lineMerge();

const inO = new Set(o.entries);
const inA = new Set(a.entries);
const inB = new Set(b.entries);
const kept = new Set();
for (const e of a.entries) if (inB.has(e) || !inO.has(e)) kept.add(e);
for (const e of b.entries) if (!inO.has(e)) kept.add(e);
const entries = [...kept].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
const text = (header ? header + '\\n' : '') + entries.map((e) => e + '\\n').join('');
fs.writeFileSync(ours, text, 'latin1');
`;

export const COUNT_BASELINE_DRIVER = 'count-baseline';

/** The driver program, run by git as `node <file> %O %A %B`; the result replaces `%A`. */
export const COUNT_BASELINE_SOURCE = `'use strict';
// Written by the merge queue (merge-drivers.ts); rewritten on every start.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const [base, ours, theirs] = process.argv.slice(2);

function lineMerge() {
	const r = spawnSync('git', ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', ours, base, theirs], { stdio: 'inherit' });
	process.exit(r.status === null ? 2 : r.status);
}

// Each key's count, or null when the file is not a count list.
function counts(file) {
	const lines = fs.readFileSync(file, 'latin1').split('\\n');
	if (lines[lines.length - 1] === '') lines.pop();
	const m = new Map();
	for (let k = 0; k < lines.length; k++) {
		const tab = lines[k].indexOf('\\t');
		if (tab < 0 || !/^[0-9]+$/.test(lines[k].slice(0, tab))) return null;
		const key = lines[k].slice(tab + 1);
		if (m.has(key) || (k > 0 && lines[k - 1] >= lines[k])) return null;
		m.set(key, Number(lines[k].slice(0, tab)));
	}
	return m;
}

const o = counts(base);
const a = counts(ours);
const b = counts(theirs);
if (!o || !a || !b) lineMerge();

const lines = [];
for (const key of new Set([...a.keys(), ...b.keys()])) {
	const n = (a.get(key) ?? 0) + (b.get(key) ?? 0) - (o.get(key) ?? 0);
	if (n > 0) lines.push(n + '\\t' + key);
}
lines.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
fs.writeFileSync(ours, lines.map((l) => l + '\\n').join(''), 'latin1');
`;

/** The drivers the queue provides: name, how git describes it, and its program. */
const DRIVERS: [name: string, label: string, source: string][] = [
	[SORTED_SET_DRIVER, 'sorted set of lines (merge queue)', SORTED_SET_SOURCE],
	[COUNT_BASELINE_DRIVER, 'counts per key (merge queue)', COUNT_BASELINE_SOURCE]
];

/** Single-quotes `s` for the shell git runs a driver with. */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `entries` as `GIT_CONFIG_*` variables appended after those already in `base` (the server's own,
 * such as `safe.directory`), which a run's environment would otherwise replace.
 */
export function gitConfigEnv(entries: [key: string, value: string][], base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const start = Number(base.GIT_CONFIG_COUNT ?? 0);
	if (!Number.isInteger(start) || start < 0) throw new Error(`GIT_CONFIG_COUNT is not a count: ${base.GIT_CONFIG_COUNT}`);
	const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(start + entries.length) };
	entries.forEach(([key, value], i) => {
		env[`GIT_CONFIG_KEY_${start + i}`] = key;
		env[`GIT_CONFIG_VALUE_${start + i}`] = value;
	});
	return env;
}

/** Writes `text` to `file` through a temporary file and a rename, so a git run never reads half of it. */
function writeAtomically(file: string, text: string) {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/**
 * Writes the driver programs under `dir` and returns the environment that registers them with git
 * (`GIT_CONFIG_*`, after the server's own, so no config file changes). Pass it to the git runs that
 * merge for the queue.
 */
export function mergeDriverEnv(dir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const folder = resolve(dir, 'merge-drivers');
	mkdirSync(folder, { recursive: true });
	const entries: [string, string][] = [];
	for (const [name, label, source] of DRIVERS) {
		const file = join(folder, `${name}.cjs`);
		let current: string | null = null;
		try {
			current = readFileSync(file, 'utf8');
		} catch {
			current = null;
		}
		if (current !== source) writeAtomically(file, source);
		entries.push([`merge.${name}.name`, label], [`merge.${name}.driver`, `${shellQuote(process.execPath)} ${shellQuote(file)} %O %A %B`]);
	}
	return gitConfigEnv(entries, base);
}

/** The oldest git the queue merges with: `--attr-source` came in 2.41 (`merge-tree --write-tree --merge-base` in 2.40). */
export const MIN_GIT_VERSION = '2.41';

/** Why the git that printed `version` (`git version x.y.z`) can't run the queue's merges, or null when it can. */
export function gitVersionProblem(version: string): string | null {
	const m = /^git version (\d+)\.(\d+)/.exec(version.trim());
	if (!m) return `Could not read the git version from "${version.trim()}"; the merge queue needs git ${MIN_GIT_VERSION} or newer`;
	const [major, minor] = MIN_GIT_VERSION.split('.').map(Number);
	const [a, b] = [Number(m[1]), Number(m[2])];
	if (a > major || (a === major && b >= minor)) return null;
	return `git ${a}.${b} is too old for the merge queue, which needs git ${MIN_GIT_VERSION} or newer (for --attr-source); upgrade git on the server`;
}

let gitProblem: string | null | undefined;

/**
 * Throws when the server's git can't run the queue's merges. Called by each git run that uses
 * `--attr-source`, so an old git stops building and landing (a tick error the queue page shows)
 * and nothing else. Asks git once per process, unless given `read`.
 */
export function requireGitVersion(read?: () => string) {
	if (read) {
		const problem = gitVersionProblem(read());
		if (problem) throw new Error(problem);
		return;
	}
	if (gitProblem === undefined) gitProblem = gitVersionProblem(execFileSync('git', ['--version'], { encoding: 'utf8' }));
	if (gitProblem) throw new Error(gitProblem);
}
