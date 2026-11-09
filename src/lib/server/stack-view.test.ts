import { afterEach, expect, test } from 'vitest';
import { analyzeStacks } from './stacks';
import { stackView } from './stack-view';
import { GitSandbox } from './testing/git-sandbox';

let git: GitSandbox;
afterEach(() => git?.cleanup());

test('lists each stack from its root down, children by number, with titles and queue status', () => {
	git = new GitSandbox();
	git.branch('a', 'main');
	git.commit('a', 'a1');
	git.branch('c', 'a');
	git.commit('c', 'c1');
	git.branch('b', 'a');
	git.commit('b', 'b1');
	git.branch('lone', 'main');
	git.commit('lone', 'l1');
	git.openPR(1, 'a', 'main');
	git.openPR(3, 'c', 'a');
	git.openPR(2, 'b', 'a');
	git.openPR(9, 'lone', 'main');

	const meta = new Map([1, 2, 3, 9].map((n) => [n, { title: `PR ${n}`, url: `https://x/${n}` }]));
	const view = stackView(analyzeStacks(git.input()), meta, new Map([[2, 'queued']]));

	expect(view).toEqual([
		{
			root: 1,
			rows: [
				{ pr: 1, depth: 0, title: 'PR 1', url: 'https://x/1', link: null, broken: false, issues: [], queue: null },
				{ pr: 2, depth: 1, title: 'PR 2', url: 'https://x/2', link: 'healthy', broken: false, issues: [], queue: 'queued' },
				{ pr: 3, depth: 1, title: 'PR 3', url: 'https://x/3', link: 'healthy', broken: false, issues: [], queue: null }
			]
		}
	]);
});
