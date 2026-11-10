import { describe, expect, test } from 'vitest';
import { HOLD_CODES, holdAdvice, type HoldCode } from './batching';

/** Waiting on other PRs or on the queue: nothing for the author to do. */
const SILENT: HoldCode[] = ['deferred', 'parent-held', 'parent-not-ready', 'not-fetched'];
import * as format from './hold-format';
import { ejectedNotice, holdCheck, holdNotice, NEXT_ACTIONS, readNotice, statusBlock } from './hold-format';

describe('the hold comment', () => {
	test('says what holds the PR and the one thing to do, in one line; the code is in the hidden block', () => {
		const body = holdNotice({ pr: 2, head: 'abc123', code: 'changes-requested', reason: 'Changes requested' });
		expect(body).toBe(
			[
				'**Merge queue:** Changes requested. Address them, then get the review approved or dismissed.',
				'',
				'<!-- merge-queue {"v":1,"kind":"hold","pr":2,"head":"abc123","code":"changes-requested","reason":"Changes requested","nextActions":["address-review"]} -->'
			].join('\n')
		);
	});

	test('no heading and no "needs attention": a comment from the queue is one already', () => {
		for (const code of HOLD_CODES) {
			const body = holdNotice({ pr: 5, head: 'h', code, reason: 'Some reason', files: ['a'], fix: 'git x' });
			expect(body, code).not.toMatch(/Needs attention|###|What to do/i);
			expect(body.split('\n\n').length, code).toBeLessThanOrEqual(4);
		}
	});

	test("a reason that ends a sentence itself gets no second period", () => {
		expect(holdNotice({ pr: 1, head: 'h', code: 'failed', reason: 'Failed in batch 3.' })).toMatch(/^\*\*Merge queue:\*\* Failed in batch 3\. Fix/);
	});

	test('gives a command to run where there is one', () => {
		const body = holdNotice({ pr: 7, head: 'h', code: 'draft', reason: 'Draft' });
		expect(body).toMatch(/^\*\*Merge queue:\*\* Draft\. Mark it ready for review\.\n\n```sh\ngh pr ready 7\n```\n\n<!-- merge-queue /);
		expect(holdNotice({ pr: 7, head: 'h', code: 'ci-failed', reason: 'Checks failed' })).toContain('```sh\ngh pr checks 7\n```');
		// No command we can be sure of: no block.
		expect(holdNotice({ pr: 7, head: 'h', code: 'not-approved', reason: 'Not approved' })).not.toContain('```');
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
		// Trying the rebase shows the files: the comment is the reason and the commands, nothing else.
		expect(body).toBe(
			[
				'**Merge queue:** conflicts with main. Rebase it and push:',
				'',
				'```sh\ngit fetch origin main && git rebase FETCH_HEAD\n# resolve the conflicts, then\ngit push --force-with-lease\n```',
				'',
				'<!-- merge-queue {"v":1,"kind":"hold","pr":3,"head":"h3","code":"conflict","reason":"conflicts with main","files":["a.ts","b.ts"],"nextActions":["resolve-conflict"]} -->'
			].join('\n')
		);
		expect(readNotice(body)).toMatchObject({ kind: 'hold', code: 'conflict', files: ['a.ts', 'b.ts'], nextActions: ['resolve-conflict'] });
	});

	test('the conflicting files are only in the hidden block, all of them', () => {
		const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
		const body = holdNotice({ pr: 3, head: 'h', code: 'conflict', reason: 'Conflicts with main', files, fix: 'x' });
		expect(body.slice(0, body.indexOf('<!--'))).not.toContain('f0.ts');
		expect(readNotice(body)?.files).toEqual(files);
	});

	test('every hold code has advice, a next action, and reads back from its comment', () => {
		for (const code of HOLD_CODES.filter((c) => !SILENT.includes(c) && c !== 'conflict')) {
			const body = holdNotice({ pr: 5, head: 'h5', code, reason: `held for ${code}` });
			// The reason, then one action as a sentence (a conflict's action is its command).
			expect(body, code).toMatch(new RegExp(`^\\*\\*Merge queue:\\*\\* held for ${code}\\. [A-Z][^\\n]+\\.(\\n|$)`));
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

	test('a hold the author can do nothing about has no action, so nothing is said about it', () => {
		for (const code of SILENT) {
			expect(holdAdvice(code), code).toBe('');
			expect(NEXT_ACTIONS[code], code).toEqual([]);
		}
		// Every other code names one.
		for (const code of HOLD_CODES.filter((c) => !SILENT.includes(c))) expect(holdAdvice(code), code).not.toBe('');
	});

	test('next actions are stable ids an agent can switch on', () => {
		const all = Object.values(NEXT_ACTIONS).flat();
		for (const a of all) expect(a).toMatch(/^[a-z]+(-[a-z]+)*$/);
		expect(NEXT_ACTIONS['parent-not-queued']).toEqual(['queue-parent']);
		expect(NEXT_ACTIONS.draft).toEqual(['mark-ready']);
		// Rebasing onto the parent's head is not retargeting the base: an agent tells them apart.
		expect(NEXT_ACTIONS['stack-broken']).toEqual(['restack']);
		expect(NEXT_ACTIONS['wrong-base']).toEqual(['retarget']);
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
		const quoted = `> ${holdNotice({ pr: 1, head: 'a', code: 'draft', reason: 'Draft' })}\n\n${ejectedNotice({ pr: 1, head: 'b', reason: 'Failed' })}`;
		expect(readNotice(quoted)).toMatchObject({ kind: 'ejected', head: 'b' });
	});

	test('a /mq status reply has a status block in the same format', () => {
		const queue = { status: 'queued', position: 2, priority: 'normal', enqueuedAt: 't', lastMessage: 'x --> y', batch: null };
		const steps = [{ do: 'queue', pr: 1, why: 'Stacked on #1, which isn\'t queued' }];
		const block = statusBlock({ pr: 2, head: 'abc', queue, code: 'parent-not-queued', reason: 'Parent #1 is not queued', steps });
		expect(block.indexOf('-->')).toBe(block.length - 3);
		expect(readNotice(`Some prose\n\n${block}`)).toEqual({
			v: 1,
			kind: 'status',
			pr: 2,
			head: 'abc',
			code: 'parent-not-queued',
			reason: 'Parent #1 is not queued',
			queue,
			steps,
			nextActions: ['queue-parent']
		});
		// Not queued and nothing to do: no code, no reason.
		expect(readNotice(statusBlock({ pr: 3, head: null, queue: null, steps: [] }))).toEqual({ v: 1, kind: 'status', pr: 3, head: null, queue: null, steps: [], nextActions: [] });
	});
});

describe('the other comments', () => {
	test('there is no "back in line" comment: it gives no action, and the check going back to queued says it', () => {
		expect(format).not.toHaveProperty('releasedNotice');
	});

	test('removed from the queue: the same lead, the action, then the CI run', () => {
		const body = ejectedNotice({ pr: 4, head: 'h4', reason: 'Fails on its own on top of main', link: 'https://ci/run/1' });
		expect(body).toBe(
			[
				'**Merge queue:** Removed from the queue: Fails on its own on top of main. Fix the failure, push, and queue it again.',
				'',
				'CI run: https://ci/run/1',
				'',
				'<!-- merge-queue {"v":1,"kind":"ejected","pr":4,"head":"h4","reason":"Fails on its own on top of main","nextActions":["fix-failure","requeue"]} -->'
			].join('\n')
		);
		expect(ejectedNotice({ pr: 4, head: 'h4', reason: 'Failed.' })).toMatch(/^\*\*Merge queue:\*\* Removed from the queue: Failed\. Fix the failure/);
		expect(readNotice(body)).toEqual({ v: 1, kind: 'ejected', pr: 4, head: 'h4', reason: 'Fails on its own on top of main', nextActions: ['fix-failure', 'requeue'] });
		expect(ejectedNotice({ pr: 4, head: null, reason: 'r' })).not.toContain('CI run');
	});
});

describe('the hold on the check run', () => {
	test('the title is the reason (the conclusion already says action required); the summary is the comment', () => {
		const h = { pr: 7, head: 'h7', code: 'draft' as HoldCode, reason: 'Draft' };
		const c = holdCheck(h);
		expect(c.title).toBe('Draft');
		expect(c.summary).toBe(holdNotice(h));
	});

	test('a very long reason is cut in the title, never in the summary', () => {
		const reason = 'x'.repeat(400);
		const c = holdCheck({ pr: 1, head: 'h', code: 'failed', reason });
		expect(c.title.length).toBeLessThanOrEqual(200);
		expect(c.title.endsWith('...')).toBe(true);
		expect(c.summary).toContain(reason);
	});
});
