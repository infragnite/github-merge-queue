import { describe, expect, test } from 'vitest';
import { declaredDeps, dependencyGraph, parseDependsOn, type DepRef, type DepTarget } from './deps';
import { stacks } from './testing/stack-fixture';

const repo = { owner: 'acme', name: 'app' };
const parse = (body: string | null | undefined) => parseDependsOn(body, repo);

describe('Depends-On lines in a PR description', () => {
	test('no description, or none of the lines, means no dependencies', () => {
		expect(parse(null)).toEqual([]);
		expect(parse(undefined)).toEqual([]);
		expect(parse('')).toEqual([]);
		expect(parse('Fixes #12\n\nThis depends on #13 being merged first.')).toEqual([]);
	});

	test('one line per dependency, by number, link, or owner/repo#number of this repository', () => {
		const body = ['Adds the reader.', '', 'Depends-On: #4512', 'Depends-On: https://github.com/acme/app/pull/4519', 'Depends-On: acme/app#4520'].join('\n');
		expect(parse(body)).toEqual<DepRef[]>([
			{ kind: 'pr', pr: 4512, text: '#4512' },
			{ kind: 'pr', pr: 4519, text: 'https://github.com/acme/app/pull/4519' },
			{ kind: 'pr', pr: 4520, text: 'acme/app#4520' }
		]);
	});

	test('the keyword is read in any case, with any spacing, and a line may list several, comma- or space-separated', () => {
		expect(parse('depends-on:#1\nDEPENDS-ON :  #2, #3  #4\r\n  Depends-On: #5')).toEqual([
			{ kind: 'pr', pr: 1, text: '#1' },
			{ kind: 'pr', pr: 2, text: '#2' },
			{ kind: 'pr', pr: 3, text: '#3' },
			{ kind: 'pr', pr: 4, text: '#4' },
			{ kind: 'pr', pr: 5, text: '#5' }
		]);
	});

	test('a link may point into the PR (files, a commit, an anchor) and the repository is matched in any case', () => {
		expect(parse('Depends-On: https://github.com/ACME/App/pull/7/files#diff-1\nDepends-On: http://github.com/acme/app/pull/8/')).toEqual([
			{ kind: 'pr', pr: 7, text: 'https://github.com/ACME/App/pull/7/files#diff-1' },
			{ kind: 'pr', pr: 8, text: 'http://github.com/acme/app/pull/8/' }
		]);
	});

	test('a list item or bold keyword still counts', () => {
		expect(parse('- Depends-On: #1\n* Depends-On: #2\n**Depends-On:** #3')).toEqual([
			{ kind: 'pr', pr: 1, text: '#1' },
			{ kind: 'pr', pr: 2, text: '#2' },
			{ kind: 'pr', pr: 3, text: '#3' }
		]);
	});

	test('a dependency named twice counts once', () => {
		expect(parse('Depends-On: #1\nDepends-On: #1, https://github.com/acme/app/pull/1')).toEqual([{ kind: 'pr', pr: 1, text: '#1' }]);
	});

	test('lines in code blocks, quotes and HTML comments are examples, not declarations', () => {
		const body = [
			'```',
			'Depends-On: #1',
			'```',
			'~~~md',
			'Depends-On: #2',
			'~~~',
			'> Depends-On: #3',
			'<!-- Depends-On: #4 -->',
			'<!--',
			'Depends-On: #5',
			'-->',
			'    Depends-On: #6',
			'`Depends-On: #7`',
			'Depends-On: #8'
		].join('\n');
		expect(parse(body)).toEqual([{ kind: 'pr', pr: 8, text: '#8' }]);
	});

	test('a pull request of another repository is read as such', () => {
		expect(parse('Depends-On: other/lib#3\nDepends-On: https://github.com/acme/other/pull/4')).toEqual([
			{ kind: 'other-repo', repo: 'other/lib', pr: 3, text: 'other/lib#3' },
			{ kind: 'other-repo', repo: 'acme/other', pr: 4, text: 'https://github.com/acme/other/pull/4' }
		]);
	});

	test('anything else on the line is kept as an invalid reference, so the author can be told which', () => {
		expect(parse('Depends-On: the cache PR\nDepends-On:\nDepends-On: https://github.com/acme/app/issues/9, #10')).toEqual([
			{ kind: 'invalid', text: 'the cache PR' },
			{ kind: 'invalid', text: '' },
			{ kind: 'invalid', text: 'https://github.com/acme/app/issues/9' },
			{ kind: 'pr', pr: 10, text: '#10' }
		]);
	});
});

describe('what each declared dependency means for the PR', () => {
	const target =
		(states: Record<number, DepTarget['state']>) =>
		(n: number): DepTarget => ({ state: states[n] ?? 'open' });

	test('an open dependency orders the PR; a merged one is done and dropped', () => {
		const d = declaredDeps(
			new Map([
				[10, [{ kind: 'pr', pr: 1, text: '#1' }, { kind: 'pr', pr: 2, text: '#2' }] as DepRef[]],
				[11, []]
			]),
			target({ 2: 'merged' })
		);
		expect(d.on).toEqual(new Map([[10, [1]]]));
		expect(d.problems).toEqual(new Map());
	});

	test('a dependency closed without merging holds the PR until it is reopened or the line removed', () => {
		const d = declaredDeps(new Map([[10, [{ kind: 'pr', pr: 1, text: '#1' }] as DepRef[]]]), target({ 1: 'closed' }));
		expect(d.on).toEqual(new Map());
		expect(d.problems).toEqual(new Map([[10, { code: 'dependency-closed', reason: 'Depends on #1, which was closed without merging' }]]));
	});

	test('a line that names no pull request of this repository holds the PR, quoting the line', () => {
		const one = (refs: DepRef[], states: Record<number, DepTarget['state']> = {}) => declaredDeps(new Map([[10, refs]]), target(states)).problems.get(10);
		expect(one([{ kind: 'invalid', text: 'the cache PR' }])).toEqual({ code: 'dependency-invalid', reason: '`Depends-On: the cache PR` names no pull request' });
		expect(one([{ kind: 'invalid', text: '' }])).toEqual({ code: 'dependency-invalid', reason: '`Depends-On:` names no pull request' });
		expect(one([{ kind: 'other-repo', repo: 'other/lib', pr: 3, text: 'other/lib#3' }])).toEqual({
			code: 'dependency-invalid',
			reason: '`Depends-On: other/lib#3` is in another repository; only pull requests of this one can be dependencies'
		});
		expect(one([{ kind: 'pr', pr: 7, text: '#7' }], { 7: 'missing' })).toEqual({ code: 'dependency-invalid', reason: '`Depends-On: #7` is not a pull request here' });
		expect(one([{ kind: 'pr', pr: 10, text: '#10' }])).toEqual({ code: 'dependency-invalid', reason: '`Depends-On: #10` names this pull request itself' });
	});

	test('a problem holds the PR even when its other dependencies are fine; the first problem is the one said', () => {
		const d = declaredDeps(
			new Map([
				[
					10,
					[
						{ kind: 'pr', pr: 1, text: '#1' },
						{ kind: 'pr', pr: 2, text: '#2' },
						{ kind: 'invalid', text: 'x' }
					] as DepRef[]
				]
			]),
			target({ 2: 'closed' })
		);
		expect(d.on).toEqual(new Map([[10, [1]]]));
		expect(d.problems.get(10)?.code).toBe('dependency-closed');
	});
});

describe('the dependency graph: git parents and declared dependencies together', () => {
	test('a PR depends on its git parent first, then on what it declares, each once', () => {
		const g = dependencyGraph(stacks([1, 2, 3, 4], { 2: 1 }), { on: new Map([[2, [3, 1]], [4, [3]]]), problems: new Map() });
		expect(g.depsOf(2)).toEqual([1, 3]);
		expect(g.depsOf(4)).toEqual([3]);
		expect(g.depsOf(1)).toEqual([]);
		expect(g.declaredOf(2)).toEqual([3]);
		expect(g.problems).toEqual(new Map());
	});

	test('a git parent that is no longer open is not a dependency', () => {
		const a = stacks([2], {});
		a.prs.get(2)!.parent = 1;
		expect(dependencyGraph(a, { on: new Map(), problems: new Map() }).depsOf(2)).toEqual([]);
	});

	test('a cycle of declarations holds every PR in it, naming the way back to each', () => {
		// 1 -> 2 -> 3 -> 1, and 4 depends on 3 (held through it later, not by the cycle).
		const g = dependencyGraph(stacks([1, 2, 3, 4]), { on: new Map([[1, [2]], [2, [3]], [3, [1]], [4, [3]]]), problems: new Map() });
		expect(g.problems).toEqual(
			new Map([
				[1, { code: 'dependency-cycle', reason: 'Depends on itself through #2 → #3' }],
				[2, { code: 'dependency-cycle', reason: 'Depends on itself through #3 → #1' }],
				[3, { code: 'dependency-cycle', reason: 'Depends on itself through #1 → #2' }]
			])
		);
		// The cycle's declarations are dropped, so nothing loops; its members are held anyway.
		expect([g.depsOf(1), g.depsOf(2), g.depsOf(3), g.depsOf(4)]).toEqual([[], [], [], [3]]);
	});

	test('a declaration that points at a git child closes a cycle through the stack', () => {
		// 2 is stacked on 1 by git; 1 declares it depends on 2.
		const g = dependencyGraph(stacks([1, 2], { 2: 1 }), { on: new Map([[1, [2]]]), problems: new Map() });
		expect(g.problems).toEqual(
			new Map([
				[1, { code: 'dependency-cycle', reason: 'Depends on itself through #2' }],
				[2, { code: 'dependency-cycle', reason: 'Depends on itself through #1' }]
			])
		);
		// The git parent stays: the stack itself is not what loops.
		expect(g.depsOf(2)).toEqual([1]);
		expect(g.depsOf(1)).toEqual([]);
	});

	test("the declarations' own problems carry over", () => {
		const problems = new Map([[5, { code: 'dependency-closed' as const, reason: 'Depends on #9, which was closed without merging' }]]);
		expect(dependencyGraph(stacks([5]), { on: new Map(), problems }).problems).toEqual(problems);
	});

	test('a declaration of a PR that is not open (yet unknown to the analysis) is still a dependency', () => {
		// The resolver said it is open; the stack analysis may not have it (another base branch).
		expect(dependencyGraph(stacks([2]), { on: new Map([[2, [1]]]), problems: new Map() }).depsOf(2)).toEqual([1]);
	});
});
