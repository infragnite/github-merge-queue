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
// Git reads drivers only from config, so the queue passes them in the environment of its own git
// runs (`mergeDriverEnv`); a merge it does not run (GitHub's own) never sees them.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
	const lines = fs.readFileSync(file, 'utf8').split('\\n');
	if (lines[lines.length - 1] === '') lines.pop();
	let i = 0;
	while (i < lines.length && (lines[i].startsWith('#') || lines[i].trim() === '')) i++;
	const entries = lines.slice(i);
	for (let k = 0; k < entries.length; k++) {
		if (entries[k].startsWith('#') || entries[k].trim() === '') return null;
		if (k > 0 && Buffer.compare(Buffer.from(entries[k - 1]), Buffer.from(entries[k])) >= 0) return null;
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
const entries = [...kept].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
const text = (header ? header + '\\n' : '') + entries.map((e) => e + '\\n').join('');
fs.writeFileSync(ours, text);
`;

/** Single-quotes `s` for the shell git runs a driver with. */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Writes the driver programs under `dir` and returns the environment that registers them with git
 * (`GIT_CONFIG_*`, so no config file changes). Pass it to the git runs that merge for the queue.
 */
export function mergeDriverEnv(dir: string): NodeJS.ProcessEnv {
	const folder = resolve(dir, 'merge-drivers');
	const file = join(folder, `${SORTED_SET_DRIVER}.cjs`);
	mkdirSync(folder, { recursive: true });
	let current: string | null = null;
	try {
		current = readFileSync(file, 'utf8');
	} catch {
		current = null;
	}
	if (current !== SORTED_SET_SOURCE) writeFileSync(file, SORTED_SET_SOURCE);
	return {
		GIT_CONFIG_COUNT: '2',
		GIT_CONFIG_KEY_0: `merge.${SORTED_SET_DRIVER}.name`,
		GIT_CONFIG_VALUE_0: 'sorted set of lines (merge queue)',
		GIT_CONFIG_KEY_1: `merge.${SORTED_SET_DRIVER}.driver`,
		GIT_CONFIG_VALUE_1: `${shellQuote(process.execPath)} ${shellQuote(file)} %O %A %B`
	};
}
