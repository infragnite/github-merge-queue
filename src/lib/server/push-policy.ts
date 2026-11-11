// The default branch's rules that decide whether the queue may push to a PR head without costing
// the PR its approval, per repository (see `pushKeepsApprovalFrom`).
//
// They are read from the rulesets and classic branch protection and kept for hours: the rules
// change rarely, and a tick must not spend API calls on them. A change to a ruleset or branch
// protection rule (webhook) forgets the repository's rules at once. The rules are kept, not the
// answer, so a change to the queue's own settings (requireApproval) applies at once.

import type { PushRules } from './github';

const TTL_MS = 6 * 60 * 60 * 1000;

const cache = new Map<number, { until: number; value: Promise<PushRules> }>();

/** The repository's rules, loaded with `load` when it has none or they are older than the TTL. */
export function pushRulesCached(repoId: number, load: () => Promise<PushRules>, now = Date.now()): Promise<PushRules> {
	const hit = cache.get(repoId);
	if (hit && hit.until > now) return hit.value;
	const value = load();
	cache.set(repoId, { until: now + TTL_MS, value });
	// A failed read is not an answer: the next tick asks again.
	value.catch(() => {
		if (cache.get(repoId)?.value === value) cache.delete(repoId);
	});
	return value;
}

/** Forgets the repository's rules, after they changed. */
export function forgetPushPolicy(repoId: number) {
	cache.delete(repoId);
}

/** Events that change a repository's branch rules. */
export function changesBranchRules(event: string | null): boolean {
	return event === 'repository_ruleset' || event === 'branch_protection_rule' || event === 'branch_protection_configuration';
}
