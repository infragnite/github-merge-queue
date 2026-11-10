// What the queue tells a PR, in one format: the comment that notifies its author (an agent, often)
// and the check run's summary. Each carries a stable code and a hidden machine-readable block,
// `<!-- merge-queue {json} -->`, so an agent reads why the PR is held and what to do without
// parsing prose.

import { holdAdvice, type HoldCode } from './batching';

/** Stable ids of what to do about each hold, for agents to switch on. */
export const NEXT_ACTIONS: Record<HoldCode, string[]> = {
	draft: ['mark-ready'],
	'not-fetched': [],
	'ci-failed': ['fix-checks'],
	'not-approved': ['get-approval'],
	'stale-approval': ['get-approval'],
	'changes-requested': ['address-review'],
	'stack-broken': ['retarget'],
	'wrong-base': ['retarget'],
	'parent-not-ready': ['fix-parent'],
	'parent-held': ['fix-parent'],
	'parent-not-queued': ['queue-parent'],
	deferred: ['rebase-or-wait'],
	conflict: ['resolve-conflict'],
	failed: ['fix-failure']
};

export type NoticeKind = 'hold' | 'released' | 'ejected';

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
}

export interface HoldInfo {
	pr: number;
	head: string | null;
	code: HoldCode;
	reason: string;
	/** A conflict's files. */
	files?: string[];
	/** A conflict's commands, run before resolving it. */
	fix?: string;
}

const HEADING = '### Needs attention in the merge queue';
const MAX_FILES = 20;
const MAX_TITLE = 200;

/** The block, escaped so nothing in it can end the HTML comment early. */
function marker(n: QueueNotice): string {
	const json = JSON.stringify(n).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
	return `<!-- merge-queue ${json} -->`;
}

/** A command that fixes the hold, when there is one we can be sure of. */
function command(h: HoldInfo): string | null {
	if (h.code === 'conflict' && h.fix) return `${h.fix}\n# resolve the conflicts, then\ngit push --force-with-lease`;
	if (h.code === 'draft') return `gh pr ready ${h.pr}`;
	if (h.code === 'ci-failed') return `gh pr checks ${h.pr}`;
	return null;
}

function holdBody(h: HoldInfo): string {
	const parts = [`**${h.reason}** · \`${h.code}\``];
	if (h.files?.length) {
		const shown = h.files.slice(0, MAX_FILES).map((f) => `- \`${f}\``);
		if (h.files.length > MAX_FILES) shown.push(`- and ${h.files.length - MAX_FILES} more`);
		parts.push(`Conflicting files:\n${shown.join('\n')}`);
	}
	const advice = holdAdvice(h.code);
	if (advice) parts.push(`**What to do:** ${advice}`);
	const cmd = command(h);
	if (cmd) parts.push(`**To fix:**\n\n\`\`\`sh\n${cmd}\n\`\`\``);
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

/** The comment telling a PR what holds it in the queue and what to do. */
export function holdNotice(h: HoldInfo): string {
	return `${HEADING}\n\n${holdBody(h)}`;
}

/** The check run for a hold: the reason in its title (one line, as lists show it), the comment as its summary. */
export function holdCheck(h: HoldInfo): { title: string; summary: string } {
	const title = `Needs attention: ${h.reason}`;
	return { title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 3)}...` : title, summary: holdBody(h) };
}

export function releasedNotice(n: { pr: number; head: string | null }): string {
	return `Back in line in the merge queue.\n\n${marker({ v: 1, kind: 'released', pr: n.pr, head: n.head, nextActions: [] })}`;
}

export function ejectedNotice(n: { pr: number; head: string | null; reason: string; link?: string }): string {
	const run = n.link ? `\n\nCI run: ${n.link}` : '';
	const block = marker({ v: 1, kind: 'ejected', pr: n.pr, head: n.head, reason: n.reason, nextActions: ['fix-failure', 'requeue'] });
	return `Removed from the merge queue: ${n.reason}${run}\n\n${block}`;
}

const KINDS: ReadonlySet<string> = new Set<NoticeKind>(['hold', 'released', 'ejected']);

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
