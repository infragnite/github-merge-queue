// Dependencies a PR declares in its description, one `Depends-On:` line each (the syntax Mergify and
// Zuul read), and the graph the planners order the queue by: each PR's open git parent first, then
// the open PRs it declares. A declared dependency is a stack parent that shares no commits: the PR
// never lands before it and is never tested without it.
//
// Pure: the runtime reads the descriptions and the state of each PR they name.

import type { HoldCode } from './batching';
import type { StackAnalysis } from './stacks';

export type DepRef =
	| { kind: 'pr'; pr: number; text: string }
	| { kind: 'other-repo'; repo: string; pr: number; text: string }
	| { kind: 'invalid'; text: string };

const KEYWORD = /^ {0,3}(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?depends-on(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(.*)$/i;
const FENCE = /^ {0,3}(```|~~~)/;
const NUMBER = /^#(\d+)$/;
const SHORT = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const LINK = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/** The `Depends-On:` references in a PR description, in order, each PR once. */
export function parseDependsOn(body: string | null | undefined, repo: { owner: string; name: string }): DepRef[] {
	const out: DepRef[] = [];
	const seen = new Set<string>();
	const self = `${repo.owner}/${repo.name}`.toLowerCase();
	const add = (r: DepRef) => {
		const key = r.kind === 'pr' ? `#${r.pr}` : r.kind === 'other-repo' ? `${r.repo.toLowerCase()}#${r.pr}` : `?${r.text}`;
		if (r.kind !== 'invalid' && seen.has(key)) return;
		seen.add(key);
		out.push(r);
	};
	const ref = (text: string): DepRef => {
		const n = text.match(NUMBER);
		if (n) return { kind: 'pr', pr: Number(n[1]), text };
		const m = text.match(SHORT) ?? text.match(LINK);
		if (!m) return { kind: 'invalid', text };
		const name = `${m[1]}/${m[2]}`;
		return name.toLowerCase() === self ? { kind: 'pr', pr: Number(m[3]), text } : { kind: 'other-repo', repo: name, pr: Number(m[3]), text };
	};
	// Examples are not declarations: lines in code blocks, quotes and HTML comments are skipped.
	let fence: string | null = null;
	let comment = false;
	for (const raw of (body ?? '').split(/\r?\n/)) {
		let line = raw;
		if (fence) {
			if (line.trimStart().startsWith(fence)) fence = null;
			continue;
		}
		const f = line.match(FENCE);
		if (f) {
			fence = f[1];
			continue;
		}
		if (comment) {
			const end = line.indexOf('-->');
			if (end < 0) continue;
			comment = false;
			line = line.slice(end + 3);
		}
		// Whatever an HTML comment hides on the line is gone; one left open hides the lines after it.
		line = line.replace(/<!--.*?-->/g, '');
		const open = line.indexOf('<!--');
		if (open >= 0) {
			comment = true;
			line = line.slice(0, open);
		}
		const m = line.match(KEYWORD);
		if (!m) continue;
		// Comma-separated parts; a part of references may also separate them by spaces, and a part
		// that isn't one is quoted back whole ("the cache PR").
		const parts = m[1].split(',').map((p) => p.trim()).filter(Boolean);
		if (!parts.length) add({ kind: 'invalid', text: '' });
		for (const part of parts) {
			const refs = part.split(/\s+/).map(ref);
			if (refs.some((r) => r.kind === 'invalid')) add({ kind: 'invalid', text: part });
			else refs.forEach(add);
		}
	}
	return out;
}

/** What a declared dependency names: an open PR, one merged or closed, or none at all. */
export interface DepTarget {
	state: 'open' | 'merged' | 'closed' | 'missing';
}

export interface Problem {
	code: HoldCode;
	reason: string;
}

export interface DeclaredDeps {
	/** Each PR's declared dependencies that are still open, in the order declared. */
	on: Map<number, number[]>;
	/** PRs a declaration holds, with the first thing wrong with their declarations. */
	problems: Map<number, Problem>;
}

/** What each PR's declarations mean, given the state of each PR they name. */
export function declaredDeps(refs: Map<number, DepRef[]>, target: (pr: number) => DepTarget): DeclaredDeps {
	const on = new Map<number, number[]>();
	const problems = new Map<number, Problem>();
	for (const [n, list] of refs) {
		const open: number[] = [];
		const problem = (p: Problem) => {
			if (!problems.has(n)) problems.set(n, p);
		};
		for (const r of list) {
			const line = `\`Depends-On:${r.text ? ` ${r.text}` : ''}\``;
			if (r.kind === 'invalid') {
				problem({ code: 'dependency-invalid', reason: `${line} names no pull request` });
				continue;
			}
			if (r.kind === 'other-repo') {
				problem({ code: 'dependency-invalid', reason: `${line} is in another repository; only pull requests of this one can be dependencies` });
				continue;
			}
			if (r.pr === n) {
				problem({ code: 'dependency-invalid', reason: 'A `Depends-On:` line names this pull request itself' });
				continue;
			}
			const t = target(r.pr).state;
			if (t === 'open') open.push(r.pr);
			else if (t === 'closed') problem({ code: 'dependency-closed', reason: `Depends on #${r.pr}, which was closed without merging` });
			else if (t === 'missing') problem({ code: 'dependency-invalid', reason: `${line} is not a pull request here` });
		}
		if (open.length) on.set(n, open);
	}
	return { on, problems };
}

export interface DependencyGraph {
	/** Everything `n` must land after: its open git parent first, then what it declares. */
	depsOf(n: number): number[];
	/** Only what `n` declares (without its git parent). */
	declaredOf(n: number): number[];
	/** PRs the dependencies hold: the declarations' own problems and every PR in a cycle. */
	problems: Map<number, Problem>;
}

/** The git parents and declared dependencies together, with cycles found and cut. */
export function dependencyGraph(analysis: StackAnalysis, declared: DeclaredDeps): DependencyGraph {
	const git = (n: number): number | null => {
		const p = analysis.prs.get(n)?.parent ?? null;
		return p !== null && analysis.prs.has(p) ? p : null;
	};
	const decl = (n: number) => (declared.on.get(n) ?? []).filter((p) => p !== git(n));
	const all = (n: number) => {
		const p = git(n);
		return [...(p === null ? [] : [p]), ...decl(n)];
	};
	const problems = new Map(declared.problems);

	// Cycles: strongly connected parts of more than one PR (a PR never declares itself: that is
	// refused as invalid before). Git edges alone never loop, so each cycle has a declaration.
	const nodes = new Set<number>([...analysis.prs.keys(), ...declared.on.keys(), ...[...declared.on.values()].flat()]);
	const index = new Map<number, number>();
	const low = new Map<number, number>();
	const stack: number[] = [];
	const onStack = new Set<number>();
	const inCycle = new Set<number>();
	let counter = 0;
	const strong = (v: number) => {
		index.set(v, counter);
		low.set(v, counter++);
		stack.push(v);
		onStack.add(v);
		for (const w of all(v)) {
			if (!index.has(w)) {
				strong(w);
				low.set(v, Math.min(low.get(v)!, low.get(w)!));
			} else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
		}
		if (low.get(v) === index.get(v)) {
			const part: number[] = [];
			for (let w = stack.pop()!; ; w = stack.pop()!) {
				onStack.delete(w);
				part.push(w);
				if (w === v) break;
			}
			if (part.length > 1) for (const w of part) inCycle.add(w);
		}
	};
	for (const v of [...nodes].sort((a, b) => a - b)) if (!index.has(v)) strong(v);

	// The shortest way from `n` back to itself, inside its cycle: the PRs between, in order.
	const wayBack = (n: number): number[] => {
		const from = new Map<number, number>();
		const todo = [n];
		while (todo.length) {
			const v = todo.shift()!;
			for (const w of all(v)) {
				if (!inCycle.has(w)) continue;
				if (w === n) {
					const path: number[] = [];
					for (let u = v; u !== n; u = from.get(u)!) path.unshift(u);
					return path;
				}
				if (!from.has(w)) {
					from.set(w, v);
					todo.push(w);
				}
			}
		}
		return [];
	};
	for (const n of [...inCycle].sort((a, b) => a - b)) {
		if (!problems.has(n)) problems.set(n, { code: 'dependency-cycle', reason: `Depends on itself through ${wayBack(n).map((p) => `#${p}`).join(' → ')}` });
	}

	// A cycle's declarations are cut, so nothing loops; its PRs are held anyway.
	const declaredOf = (n: number) => (inCycle.has(n) ? [] : decl(n));
	return {
		declaredOf,
		depsOf: (n) => {
			const p = git(n);
			return [...new Set([...(p === null ? [] : [p]), ...declaredOf(n)])];
		},
		problems
	};
}
