// What the queue tells a PR, in one format: the comment that notifies its author (an agent, often)
// and the check run's summary. People read one line: the reason and what to do. Agents read the
// hidden block, `<!-- merge-queue {json} -->`, with its stable code and next actions, without
// parsing prose.

import { holdAdvice, type HoldCode } from './batching';

/** Stable ids of what to do about each hold, for agents to switch on. None: the PR waits on others. */
export const NEXT_ACTIONS: Record<HoldCode, string[]> = {
	draft: ['mark-ready'],
	'not-fetched': [],
	'ci-failed': ['fix-checks'],
	'not-approved': ['get-approval'],
	'stale-approval': ['get-approval'],
	'changes-requested': ['address-review'],
	'stack-broken': ['restack'],
	'wrong-base': ['retarget'],
	'try-pending': [],
	'not-tried': ['run-try'],
	'try-failed': ['fix-failure'],
	'parent-not-ready': [],
	'parent-held': [],
	'parent-not-queued': ['queue-parent'],
	'dependency-not-queued': ['queue-dependency'],
	'dependency-closed': ['edit-dependencies'],
	'dependency-invalid': ['edit-dependencies'],
	'dependency-cycle': ['edit-dependencies'],
	deferred: [],
	conflict: ['resolve-conflict'],
	'workflow-permission': ['grant-workflows-permission'],
	'merge-refused': ['fix-merge-refusal'],
	failed: ['fix-failure']
};

export type NoticeKind = 'hold' | 'ejected' | 'status';

/** The hidden block's content. Version 1. */
export interface QueueNotice {
	v: 1;
	kind: NoticeKind;
	pr: number;
	/** The PR head the notice was about, when known. */
	head: string | null;
	code?: HoldCode;
	reason?: string;
	files?: string[];
	nextActions: string[];
	/** A status: where the PR stands in the queue, null when it isn't in it. */
	queue?: StatusQueue | null;
	/** A status: each thing to do, with its command or the PR it is about (the agent API's next actions). */
	steps?: StatusStep[];
}

/** Where a PR stands in the queue, as the agent API gives it. */
export interface StatusQueue {
	status: string;
	position: number;
	priority: string;
	enqueuedAt: string;
	lastMessage: string | null;
	batch: unknown;
}

export interface StatusStep {
	do: string;
	why: string;
	[detail: string]: unknown;
}

export interface HoldInfo {
	pr: number;
	head: string | null;
	code: HoldCode;
	reason: string;
	/** A conflict's files. */
	files?: string[];
	/** A conflict's commands, run before resolving it; a broken stack's restack command. */
	fix?: string;
}

const LEAD = '**Merge queue:**';
const MAX_TITLE = 200;

/** The block, escaped so nothing in it can end the HTML comment early. */
function marker(n: QueueNotice): string {
	const json = JSON.stringify(n).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
	return `<!-- merge-queue ${json} -->`;
}

/** A command that fixes the hold, when there is one we can be sure of. */
function command(h: HoldInfo): string | null {
	if (h.code === 'conflict' && h.fix) return `${h.fix}\n# resolve the conflicts, then\ngit push --force-with-lease`;
	if (h.code === 'stack-broken' && h.fix) return `${h.fix}\n# resolve any conflicts, then\ngit push --force-with-lease`;
	if (h.code === 'draft') return `gh pr ready ${h.pr}`;
	if (h.code === 'ci-failed') return `gh pr checks ${h.pr}`;
	return null;
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * The comment telling a PR what holds it in the queue: the reason and the one thing to do, a
 * command where there is one, then the hidden block. No heading: a comment from the queue needs
 * attention by being there. A conflict's files are only in the block: the rebase shows them.
 */
export function holdNotice(h: HoldInfo): string {
	const advice = holdAdvice(h.code);
	const parts = [`${LEAD} ${sentence(h.reason)}${advice ? ` ${advice}` : ''}`];
	const cmd = command(h);
	if (cmd) parts.push(`\`\`\`sh\n${cmd}\n\`\`\``);
	parts.push(
		marker({
			v: 1,
			kind: 'hold',
			pr: h.pr,
			head: h.head,
			code: h.code,
			reason: h.reason,
			...(h.files?.length ? { files: h.files } : {}),
			nextActions: NEXT_ACTIONS[h.code]
		})
	);
	return parts.join('\n\n');
}

/** The check run for a hold: the reason as its title (action required says the rest), the comment as its summary. */
export function holdCheck(h: HoldInfo): { title: string; summary: string } {
	return { title: h.reason.length > MAX_TITLE ? `${h.reason.slice(0, MAX_TITLE - 3)}...` : h.reason, summary: holdNotice(h) };
}

/** The comment on an ejected PR: the same lead, what to do, then the CI run. */
export function ejectedNotice(n: { pr: number; head: string | null; reason: string; link?: string }): string {
	const parts = [`${LEAD} Removed from the queue: ${sentence(n.reason)} Fix the failure, push, and queue it again.`];
	if (n.link) parts.push(`CI run: ${n.link}`);
	parts.push(marker({ v: 1, kind: 'ejected', pr: n.pr, head: n.head, reason: n.reason, nextActions: ['fix-failure', 'requeue'] }));
	return parts.join('\n\n');
}

/** The hold-notice id for a step of the agent API, so a status and a hold say the same thing the same way. */
const STEP_IDS: Record<string, string | null> = {
	restack: 'restack',
	'retarget-base': 'retarget',
	queue: 'queue-parent',
	'queue-dependency': 'queue-dependency',
	'edit-dependencies': 'edit-dependencies',
	'resolve-conflict': 'resolve-conflict',
	'mark-ready': 'mark-ready',
	'wait-for': null,
	fix: null
};

/**
 * The block of a `/mq status` reply: the queue entry, the hold if there is one, and the steps,
 * with next-action ids from the hold's and the steps' own, as a hold notice gives them.
 */
export function statusBlock(s: { pr: number; head: string | null; queue: StatusQueue | null; code?: string; reason?: string; steps: StatusStep[] }): string {
	const ids = [...(s.code ? (NEXT_ACTIONS[s.code as HoldCode] ?? []) : []), ...s.steps.map((st) => STEP_IDS[st.do] ?? null)];
	return marker({
		v: 1,
		kind: 'status',
		pr: s.pr,
		head: s.head,
		...(s.code ? { code: s.code as HoldCode, reason: s.reason } : {}),
		queue: s.queue,
		steps: s.steps,
		nextActions: [...new Set(ids.filter((x): x is string => !!x))]
	});
}

const KINDS: ReadonlySet<string> = new Set<NoticeKind>(['hold', 'ejected', 'status']);

/** The last merge-queue block in a comment or summary; null when there is none it understands. */
export function readNotice(body: string): QueueNotice | null {
	// The JSON never holds a raw `>` (see `marker`), so the block ends at the first `-->`.
	const all = [...body.matchAll(/<!-- merge-queue (\{[^>]*\}) -->/g)];
	const last = all.at(-1);
	if (!last) return null;
	try {
		const n = JSON.parse(last[1]) as QueueNotice;
		if (n?.v !== 1 || !KINDS.has(n.kind) || typeof n.pr !== 'number') return null;
		return n;
	} catch {
		return null;
	}
}
