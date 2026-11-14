import { expect, test } from 'vitest';
import { githubRefs } from './github-refs';

test('PR/issue references and cross-repository issues link to GitHub', () => {
	expect(githubRefs('Fetching #3498 after team/other#42', 'o', 'r')).toEqual([
		{ text: 'Fetching ' }, { text: '#3498', href: 'https://github.com/o/r/issues/3498' },
		{ text: ' after ' }, { text: 'team/other#42', href: 'https://github.com/team/other/issues/42' }
	]);
});

test('commit references preserve full known SHAs, including numeric abbreviations', () => {
	const sha = '1234567abcdef1234567abcdef1234567abcdef123';
	expect(githubRefs('1234567, commit deadbeef and a1b2c3d.', 'o', 'r', [sha]).filter((p) => p.href)).toEqual([
		{ text: '1234567', href: `https://github.com/o/r/commit/${sha}` },
		{ text: 'deadbeef', href: 'https://github.com/o/r/commit/deadbeef' },
		{ text: 'a1b2c3d', href: 'https://github.com/o/r/commit/a1b2c3d' }
	]);
});

test('batch/step numbers, branch names, timestamps and ordinary words are not issue or commit references', () => {
	const text = 'Batch #88, Step #2, position #1, mq/try-1234567, 1794655857390, defaced';
	expect(githubRefs(text, 'o', 'r')).toEqual([{ text }]);
});

test('text remains plain data, including markup around identifiers', () => {
	const text = '<script>alert(1)</script> #7';
	expect(githubRefs(text, 'o', 'r')[0].text).toBe('<script>alert(1)</script> ');
});
