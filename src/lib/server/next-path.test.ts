import { expect, test } from 'vitest';
import { safeNext } from './next-path';

const APP = 'https://mq.example.com';

test('paths on this site come back, with their query', () => {
	expect(safeNext('/repos/qnox/krusty', APP)).toBe('/repos/qnox/krusty');
	expect(safeNext('/repos/a/b?x=1', APP)).toBe('/repos/a/b?x=1');
});

test('anything that could leave the site is refused', () => {
	for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', '/\n/evil.com', 'https://evil.com', 'evil.com', '\\\\evil.com', '/ /evil.com', '', null, '/x'.repeat(300)]) {
		expect(safeNext(bad, APP)).toBeNull();
	}
});
