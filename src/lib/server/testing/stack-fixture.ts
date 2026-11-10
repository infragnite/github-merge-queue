// Hand-built stack analyses and PR states for planner tests.

import type { PRState, Priority, QueueEntry } from '../batching';
import type { PRStackInfo, StackAnalysis, StackIssue } from '../stacks';

export const MIN = 60 * 1000;
export const NOW = Date.parse('2026-11-09T12:00:00Z');

/** A stack analysis of `open` PRs: `parents` maps child -> parent among open PRs. */
export function stacks(open: number[], parents: Record<number, number> = {}, issues: StackIssue[] = []): StackAnalysis {
	const prs = new Map<number, PRStackInfo>();
	for (const n of open) {
		prs.set(n, {
			number: n,
			parent: parents[n] ?? null,
			link: parents[n] ? 'healthy' : null,
			children: [],
			depth: 0,
			expectedBase: 'main',
			issues: issues.filter((i) => i.pr === n),
			broken: false
		});
	}
	for (const info of prs.values()) if (info.parent !== null) prs.get(info.parent)?.children.push(info.number);
	for (const info of prs.values()) {
		let d = 0;
		for (let p = info.parent; p !== null; p = prs.get(p)?.parent ?? null) d++;
		info.depth = d;
		info.broken = info.issues.some((i) => i.severity === 'blocking');
	}
	for (const info of prs.values()) {
		for (let p = info.parent; p !== null; p = prs.get(p)?.parent ?? null) {
			if (prs.get(p)?.broken) info.broken = true;
		}
	}
	return { prs, stacks: [], issues };
}

/** A PR that is ready to go: green, approved on its head. */
export function ready(pr: number, over: Partial<PRState> = {}): PRState {
	return {
		pr,
		headSha: `sha${pr}`,
		draft: false,
		ciGreen: true,
		approvedShas: [`sha${pr}`],
		changesRequested: false,
		...over
	};
}

/** A queue entry enqueued `minutesAgo` before NOW. */
export function entry(pr: number, minutesAgo: number, priority: Priority = 'normal', position?: number): QueueEntry {
	return { pr, enqueuedAt: NOW - minutesAgo * MIN, priority, ...(position === undefined ? {} : { position }) };
}
