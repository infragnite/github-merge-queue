import { describe, expect, test } from 'vitest';
import { approvalsFrom, checkResult } from './batch-live';
import type { GhReview } from './github';

const review = (login: string, state: string, sha: string, at: string, assoc = 'COLLABORATOR'): GhReview => ({
	user: { login },
	state,
	commit_id: sha,
	author_association: assoc,
	submitted_at: `2026-11-09T${at}:00Z`
});

describe('approvals from reviews', () => {
	test('the latest decisive review per reviewer counts', () => {
		const r = approvalsFrom(
			[
				review('ann', 'CHANGES_REQUESTED', 'a1', '10:00'),
				review('ann', 'COMMENTED', 'a1', '10:30'),
				review('ann', 'APPROVED', 'a2', '11:00')
			],
			'author'
		);
		expect(r).toEqual({ approvedShas: ['a2'], changesRequested: false });
	});

	test('changes requested by anyone blocks, even next to an approval', () => {
		const r = approvalsFrom([review('ann', 'APPROVED', 'a1', '10:00'), review('bob', 'CHANGES_REQUESTED', 'a1', '10:05')], 'x');
		expect(r.changesRequested).toBe(true);
	});

	test('a dismissed approval no longer counts', () => {
		const r = approvalsFrom([review('ann', 'APPROVED', 'a1', '10:00'), review('ann', 'DISMISSED', 'a1', '10:05')], 'x');
		expect(r.approvedShas).toEqual([]);
	});

	test('reviews from the author or from people without write access are ignored', () => {
		const r = approvalsFrom(
			[review('author', 'APPROVED', 'a1', '10:00', 'OWNER'), review('drive-by', 'APPROVED', 'a1', '10:00', 'CONTRIBUTOR')],
			'author'
		);
		expect(r.approvedShas).toEqual([]);
	});
});

describe('required check result', () => {
	test('pending until every run of the check completed', () => {
		expect(checkResult([])).toBe('pending');
		expect(checkResult([{ status: 'in_progress', conclusion: null }])).toBe('pending');
	});

	test('success only when every run succeeded or was skipped', () => {
		expect(checkResult([{ status: 'completed', conclusion: 'success' }])).toBe('success');
		expect(checkResult([{ status: 'completed', conclusion: 'skipped' }])).toBe('success');
		expect(checkResult([{ status: 'completed', conclusion: 'failure' }])).toBe('failure');
		expect(checkResult([{ status: 'completed', conclusion: 'cancelled' }])).toBe('failure');
	});
});
