import { describe, expect, test } from 'vitest';
import { actionsUrl, runHref } from './actions-link';

describe('a run’s GitHub Actions link', () => {
	test("is the Actions list of the run's branch, which GitHub filters to its runs", () => {
		expect(actionsUrl('qnox', 'krusty', 'mq/batch-1794317435772-bisect-9-1794327486263')).toBe(
			'https://github.com/qnox/krusty/actions?query=branch%3Amq%2Fbatch-1794317435772-bisect-9-1794327486263'
		);
	});

	test('is the run itself once CI listed it', () => {
		expect(runHref('qnox', 'krusty', { branch: 'mq/batch-1', runUrl: 'https://github.com/qnox/krusty/runs/42' })).toBe('https://github.com/qnox/krusty/runs/42');
	});

	test("is the branch's runs until then", () => {
		expect(runHref('qnox', 'krusty', { branch: 'mq/batch-1', runUrl: null })).toBe(actionsUrl('qnox', 'krusty', 'mq/batch-1'));
	});
});
