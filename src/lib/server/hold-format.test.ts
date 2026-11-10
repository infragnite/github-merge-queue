import { describe, expect, test } from 'vitest';
import { HOLD_CODES, type HoldCode } from './batching';
import { ejectedNotice, holdCheck, holdNotice, NEXT_ACTIONS, readNotice, releasedNotice } from './hold-format';

describe('the hold comment', () => {
	test('says what holds the PR, its stable code, and what to do', () => {
		const body = holdNotice({ pr: 2, head: 'abc123', code: 'changes-requested', reason: '#2 has changes requested' });
		expect(body).toBe(
			[
				'### Needs attention in the merge queue',
				'',
				'**#2 has changes requested** · `changes-requested`',
				'',
				'**What to do:** address the requested changes, and get the review approved or dismissed.',
				'',
				'<!-- merge-queue {"v":1,"kind":"hold","pr":2,"head":"abc123","code":"changes-requested","reason":"#2 has changes requested","nextActions":["address-review"]} -->'
			].join('\n')
		);
	});

	test('gives a command to run where there is one', () => {
		const body = holdNotice({ pr: 7, head: 'h', code: 'draft', reason: '#7 is a draft' });
		expect(body).toContain('**To fix:**\n\n```sh\ngh pr ready 7\n```');
		expect(holdNotice({ pr: 7, head: 'h', code: 'ci-failed', reason: '#7 failed ci' })).toContain('```sh\ngh pr checks 7\n```');
		// No command we can be sure of: no block.
		expect(holdNotice({ pr: 7, head: 'h', code: 'not-approved', reason: '#7 needs an approval' })).not.toContain('To fix');
	});

	test('a conflict lists its files and the commands that fix it, in the same format', () => {
		const body = holdNotice({
			pr: 3,
			head: 'h3',
			code: 'conflict',
			reason: 'conflicts with main',
			files: ['a.ts', 'b.ts'],
			fix: 'git fetch origin main && git rebase FETCH_HEAD'
		});
		expect(body).toContain('**conflicts with main** · `conflict`');
		expect(body).toContain('Conflicting files:\n- `a.ts`\n- `b.ts`');
		expect(body).toContain('**To fix:**\n\n```sh\ngit fetch origin main && git rebase FETCH_HEAD\n# resolve the conflicts, then\ngit push --force-with-lease\n```');
		expect(body).toContain('The PR stays queued and is picked up again after the push.');
		expect(readNotice(body)).toMatchObject({ kind: 'hold', code: 'conflict', files: ['a.ts', 'b.ts'], nextActions: ['resolve-conflict'] });
	});

	test('lists at most 20 conflicting files, and says how many more there are', () => {
		const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
		const body = holdNotice({ pr: 3, head: 'h', code: 'conflict', reason: 'r', files, fix: 'x' });
		expect(body).toContain('- `f19.ts`\n- and 5 more');
		expect(body).not.toContain('`f20.ts`');
		expect(readNotice(body)?.files).toEqual(files);
	});

	test('every hold code has advice, a next action, and reads back from its comment', () => {
		for (const code of HOLD_CODES.filter((c) => c !== 'not-fetched')) {
			const body = holdNotice({ pr: 5, head: 'h5', code, reason: `held for ${code}` });
			expect(body, code).toMatch(/\*\*What to do:\*\* \S/);
			expect(NEXT_ACTIONS[code].length, code).toBeGreaterThan(0);
			expect(readNotice(body), code).toEqual({
				v: 1,
				kind: 'hold',
				pr: 5,
				head: 'h5',
				code,
				reason: `held for ${code}`,
				nextActions: NEXT_ACTIONS[code]
			});
		}
	});

	test('next actions are stable ids an agent can switch on', () => {
		const all = Object.values(NEXT_ACTIONS).flat();
		for (const a of all) expect(a).toMatch(/^[a-z]+(-[a-z]+)*$/);
		expect(NEXT_ACTIONS['parent-not-queued']).toEqual(['queue-parent']);
		expect(NEXT_ACTIONS.draft).toEqual(['mark-ready']);
		expect(NEXT_ACTIONS['not-fetched']).toEqual([]);
	});
});

describe('the hidden block', () => {
	test('text that would end an HTML comment early stays inside it', () => {
		const reason = 'branch feat--x --> <!-- injected -->';
		const body = holdNotice({ pr: 9, head: 'h', code: 'failed', reason });
		const marker = body.slice(body.lastIndexOf('<!-- merge-queue'));
		// One comment, closed once, at the very end.
		expect(marker.indexOf('-->')).toBe(marker.length - 3);
		expect(readNotice(body)?.reason).toBe(reason);
	});

	test('is the last merge-queue block that counts, and anything else reads as nothing', () => {
		expect(readNotice('no marker here')).toBeNull();
		expect(readNotice('<!-- merge-queue not json -->')).toBeNull();
		expect(readNotice('<!-- merge-queue {"v":2,"kind":"hold","pr":1} -->')).toBeNull();
		expect(readNotice('<!-- merge-queue {"v":1,"kind":"other","pr":1} -->')).toBeNull();
		const quoted = `> ${holdNotice({ pr: 1, head: 'a', code: 'draft', reason: 'old' })}\n\n${releasedNotice({ pr: 1, head: 'b' })}`;
		expect(readNotice(quoted)).toMatchObject({ kind: 'released', head: 'b' });
	});
});

describe('the other comments carry the block too', () => {
	test('back in line', () => {
		const body = releasedNotice({ pr: 4, head: 'h4' });
		expect(body.split('\n')[0]).toBe('Back in line in the merge queue.');
		expect(readNotice(body)).toEqual({ v: 1, kind: 'released', pr: 4, head: 'h4', nextActions: [] });
	});

	test('removed from the queue, with the CI run', () => {
		const body = ejectedNotice({ pr: 4, head: 'h4', reason: 'failed in batch 3', link: 'https://ci/run/1' });
		expect(body).toMatch(/^Removed from the merge queue: failed in batch 3\n\nCI run: https:\/\/ci\/run\/1\n\n<!-- merge-queue /);
		expect(readNotice(body)).toEqual({ v: 1, kind: 'ejected', pr: 4, head: 'h4', reason: 'failed in batch 3', nextActions: ['fix-failure', 'requeue'] });
		expect(ejectedNotice({ pr: 4, head: null, reason: 'r' })).not.toContain('CI run');
	});
});

describe('the hold on the check run', () => {
	test('the title keeps the one-line reason; the summary is the comment without its heading', () => {
		const h = { pr: 7, head: 'h7', code: 'draft' as HoldCode, reason: '#7 is a draft' };
		const c = holdCheck(h);
		expect(c.title).toBe('Needs attention: #7 is a draft');
		expect(c.summary).toBe(holdNotice(h).replace('### Needs attention in the merge queue\n\n', ''));
	});

	test('a very long reason is cut in the title, never in the summary', () => {
		const reason = 'x'.repeat(400);
		const c = holdCheck({ pr: 1, head: 'h', code: 'failed', reason });
		expect(c.title.length).toBeLessThanOrEqual(200);
		expect(c.title.endsWith('...')).toBe(true);
		expect(c.summary).toContain(reason);
	});
});
