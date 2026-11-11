import { describe, expect, test } from 'vitest';
import { pushKeepsApprovalFrom as from, type BranchRule, type ClassicReviews } from './github';
import { changesBranchRules, forgetPushPolicy, pushRulesCached } from './push-policy';

/** The answer for a queue that does not require an approval itself. */
const pushKeepsApprovalFrom = (rules: BranchRule[], classic: ClassicReviews) => from(rules, classic, { queueRequiresApproval: false });

const pr = (parameters: Record<string, unknown>): BranchRule => ({ type: 'pull_request', parameters });

describe('whether a push to a PR keeps its approval', () => {
	test('no review rule, or rules that need no approval, keep it', () => {
		expect(pushKeepsApprovalFrom([], null)).toBe(true);
		expect(pushKeepsApprovalFrom([{ type: 'deletion' }, { type: 'non_fast_forward' }], null)).toBe(true);
		// krusty-style: neither GitHub nor the queue requires an approval, so a dismissed one blocks nothing.
		expect(
			pushKeepsApprovalFrom(
				[pr({ required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, require_extra_approval_for_unattributed_changes: true })],
				null
			)
		).toBe(true);
	});

	describe('where the queue requires an approval itself (requireApproval)', () => {
		const queue = { queueRequiresApproval: true };
		test('a rule that dismisses approvals on push takes it away, even when GitHub requires none', () => {
			const krusty = pr({ required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, require_extra_approval_for_unattributed_changes: true });
			expect(from([krusty], null, queue)).toBe(false);
			expect(from([pr({ required_approving_review_count: 0, dismiss_stale_reviews_on_push: true })], null, queue)).toBe(false);
			expect(from([], { required_approving_review_count: 0, dismiss_stale_reviews: true }, queue)).toBe(false);
		});

		test('with no approval count, last-push and unattributed-change rules ask for nothing: the queue keeps the approval it carries over', () => {
			// GitHub applies both only with a non-zero approval count (the REST schema says so for the
			// unattributed rule, which is about pull requests Copilot opens).
			expect(from([pr({ required_approving_review_count: 0, require_last_push_approval: true, require_extra_approval_for_unattributed_changes: true })], null, queue)).toBe(true);
			expect(from([], { required_approving_review_count: 0, require_last_push_approval: true }, queue)).toBe(true);
		});

		test('no review rule at all keeps it', () => {
			expect(from([], null, queue)).toBe(true);
		});
	});

	test('a required approval that no push takes away keeps it', () => {
		expect(pushKeepsApprovalFrom([pr({ required_approving_review_count: 2 })], null)).toBe(true);
		expect(pushKeepsApprovalFrom([], { required_approving_review_count: 1, dismiss_stale_reviews: false })).toBe(true);
	});

	test('a ruleset that dismisses on push, asks the last push to be approved, or an unattributed commit to be approved, does not', () => {
		expect(pushKeepsApprovalFrom([pr({ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true })], null)).toBe(false);
		expect(pushKeepsApprovalFrom([pr({ required_approving_review_count: 1, require_last_push_approval: true })], null)).toBe(false);
		expect(pushKeepsApprovalFrom([pr({ required_approving_review_count: 1, require_extra_approval_for_unattributed_changes: true })], null)).toBe(false);
	});

	test('any one rule that takes the approval away decides, rulesets and classic protection alike', () => {
		expect(pushKeepsApprovalFrom([pr({ required_approving_review_count: 1 }), pr({ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true })], null)).toBe(false);
		expect(pushKeepsApprovalFrom([pr({ required_approving_review_count: 1 })], { required_approving_review_count: 1, dismiss_stale_reviews: true })).toBe(false);
		expect(pushKeepsApprovalFrom([], { required_approving_review_count: 1, require_last_push_approval: true })).toBe(false);
	});

	test('classic protection the App may not read (it needs Administration) leaves the rulesets to decide', () => {
		expect(pushKeepsApprovalFrom([], 'unreadable')).toBe(true);
		expect(pushKeepsApprovalFrom([pr({ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true })], 'unreadable')).toBe(false);
	});
});

describe('the per-repo cache of the rules', () => {
	const none = { rules: [], classic: null };
	test('one read per repo until the TTL passes', async () => {
		forgetPushPolicy(901);
		let reads = 0;
		const load = async () => (++reads, none);
		await pushRulesCached(901, load, 0);
		await pushRulesCached(901, load, 60 * 60 * 1000);
		expect(reads).toBe(1);
		await pushRulesCached(901, load, 7 * 60 * 60 * 1000);
		expect(reads).toBe(2);
	});

	test('a rules webhook forgets it; other repos keep theirs', async () => {
		forgetPushPolicy(902);
		forgetPushPolicy(903);
		let reads = 0;
		const load = async () => (++reads, none);
		await pushRulesCached(902, load, 0);
		await pushRulesCached(903, load, 0);
		expect(changesBranchRules('repository_ruleset')).toBe(true);
		expect(changesBranchRules('branch_protection_rule')).toBe(true);
		expect(changesBranchRules('pull_request')).toBe(false);
		forgetPushPolicy(902);
		await pushRulesCached(902, load, 1);
		await pushRulesCached(903, load, 1);
		expect(reads).toBe(3);
	});

	test('a failed read is not kept', async () => {
		forgetPushPolicy(904);
		let reads = 0;
		await expect(pushRulesCached(904, async () => (++reads, Promise.reject(new Error('rate limited'))), 0)).rejects.toThrow();
		await new Promise((r) => setTimeout(r, 0));
		expect(await pushRulesCached(904, async () => (++reads, none), 1)).toEqual(none);
		expect(reads).toBe(2);
	});
});
