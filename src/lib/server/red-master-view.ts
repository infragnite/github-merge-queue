// What the queue page says while the default branch is red: why batches look the way they do,
// how many PRs are left to try, and what gets the queue back to normal batches.

import type { MasterHealth } from './batch-store';

export interface RedMasterView {
	sha: string;
	/** When the branch turned red (epoch ms). */
	since: number;
	/** batches: PRs not tried on it yet go in batches; alone: each gets one try alone; waiting: none left. */
	phase: 'batches' | 'alone' | 'waiting';
	/** PRs still to try in this phase. */
	left: number;
	text: string;
}

/** PRs that can still be tried: in line or in a batch now. Held and finished ones are not. */
const TRYABLE = ['queued', 'checking'];

const prs = (n: number) => `${n} PR${n === 1 ? '' : 's'}`;

/**
 * `health.tried` holds `pr@head` once a PR's head failed in a batch on the red branch, and
 * `pr@head!` once it failed alone (see `failedOnRed`); a push makes the PR untried again.
 */
export function redMasterView(
	health: MasterHealth | null,
	items: { pr_number: number; head_sha: string | null; status: string }[],
	branch: string
): RedMasterView | null {
	if (!health || health.state !== 'red') return null;
	const tried = new Set(health.tried);
	const live = items.filter((i) => TRYABLE.includes(i.status) && i.head_sha);
	const inBatch = live.filter((i) => !tried.has(`${i.pr_number}@${i.head_sha}`)).length;
	const alone = live.filter((i) => !tried.has(`${i.pr_number}@${i.head_sha}!`)).length;
	const base = { sha: health.sha, since: health.since };
	const why = `${branch} fails CI on its own, so no batch can be blamed.`;
	const fix = 'To get back to normal batches, queue a fix with `/mq queue --priority urgent`.';
	if (inBatch > 0)
		return { ...base, phase: 'batches', left: inBatch, text: `${why} Batches of PRs not tried on it yet run side by side until one passes and lands; ${prs(inBatch)} left. ${fix}` };
	if (alone > 0)
		return {
			...base,
			phase: 'alone',
			left: alone,
			text: `${why} Every PR was tried in a batch on it, so each now gets one try alone, in case another PR in its batch broke it; ${prs(alone)} left. ${fix}`
		};
	return { ...base, phase: 'waiting', left: 0, text: `${branch} fails CI on its own, and every PR in the queue failed on it. The queue waits for a push to a PR or a fix: queue one with \`/mq queue --priority urgent\`.` };
}
