import { describe, expect, test } from 'vitest';
import { actionsUrl } from './actions-link';

describe('a run’s GitHub Actions link', () => {
	test("is the Actions list of the run's branch, which GitHub filters to its runs", () => {
		expect(actionsUrl('qnox', 'krusty', 'mq/batch-1794317435772-bisect-9-1794327486263')).toBe(
			'https://github.com/qnox/krusty/actions?query=branch%3Amq%2Fbatch-1794317435772-bisect-9-1794327486263'
		);
	});
});
