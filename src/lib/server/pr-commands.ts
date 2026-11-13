// `/mq` commands in PR comments, so a person or an agent can work the queue from the pull request
// itself, with nothing but a comment. They come in through the `issue_comment` webhook.
//
//   /mq queue [--priority low|normal|urgent]   queue the PR                     (write; urgent: maintain)
//   /mq dequeue                                take it out of the queue         (write)
//   /mq retry                                  put it back after the queue threw it out   (write)
//   /mq try                                    one CI run on top of the default branch    (write, batch mode)
//   /mq status                                 where it stands and what to do   (read)
//   /mq help                                   these commands                   (read)
//
// The command must start the comment; only its first line is read, so the rest can say why.
// The commenter's role on the repository decides, as on the agent API: the same checks in
// api-service run for both. A done command gets a 👍 on the comment; a refused one a 😕 and a
// short reply that says why. Parents are not queued with a child: each PR is queued by someone.

import * as db from './db';
import * as store from './batch-store';
import * as api from './api-service';
import { atLeast, AuthError, requireRole, type Caller, type Role } from './api-auth';
import { lastEventOf } from './events';
import { statusBlock } from './hold-format';
import { RequestLimiter } from './request-limit';
import type { Priority } from './batching';
import type { StackAnalysis } from './stacks';
import type { Repo } from '$lib/types';
import { log } from './log';

export type Command =
	| { name: 'queue'; priority: Priority }
	| { name: 'dequeue' | 'retry' | 'try' | 'status' | 'help' }
	| { name: 'invalid'; error: string };

export interface PRComment {
	pr: number;
	commentId: number;
	body: string;
	login: string;
	/** Posted by a GitHub App or another bot account. */
	bot: boolean;
}

export type Reaction = '+1' | 'confused';

export interface CommandResult {
	command: Command['name'];
	ok: boolean;
	reaction: Reaction;
	/** The reply posted on the PR, if any. */
	reply: string | null;
}

export interface CommandDeps {
	/** The commenter's role on the repository, from GitHub. */
	role(login: string): Promise<Role>;
	pr(n: number): Promise<{ number: number; title: string; html_url: string; state: string; user: { login: string; avatar_url: string } }>;
	analysis(): Promise<StackAnalysis>;
	/** Starts a try run (under the repo lock); throws with the queue's reason when it can't. */
	startTry(n: number): Promise<{ branch: string }>;
	react(commentId: number, content: Reaction): Promise<void>;
	reply(n: number, body: string): Promise<void>;
	/** Tells the processor the queue changed. */
	wake(): void;
	/** The repository's page in the app. */
	queueUrl: string;
}

const PRIORITIES: Priority[] = ['urgent', 'normal', 'low'];
const BARE = ['dequeue', 'retry', 'try', 'status', 'help'] as const;

/** The command a comment starts with; null when it doesn't start with `/mq`. */
export function parseCommand(body: string): Command | null {
	const line = (body ?? '').trimStart().split(/\r?\n/, 1)[0].trim();
	const words = line.split(/\s+/);
	if (words[0].toLowerCase() !== '/mq') return null;
	const name = (words[1] ?? 'help').toLowerCase();
	const args = words.slice(2);
	if (name === 'queue') {
		let priority: Priority = 'normal';
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			const m = a.match(/^--priority(?:=(.*))?$/i);
			if (!m) return { name: 'invalid', error: `\`/mq queue\` does not take \`${a}\`; it takes \`--priority low|normal|urgent\`` };
			const v = (m[1] ?? args[++i] ?? '').toLowerCase();
			if (!v) return { name: 'invalid', error: '--priority needs a value: urgent, normal, low' };
			if (!PRIORITIES.includes(v as Priority)) return { name: 'invalid', error: `Priority \`${v}\` is not one of urgent, normal, low` };
			priority = v as Priority;
		}
		return { name: 'queue', priority };
	}
	if ((BARE as readonly string[]).includes(name)) {
		if (args.length) return { name: 'invalid', error: `\`/mq ${name}\` takes no arguments, not \`${args.join(' ')}\`` };
		return { name: name as (typeof BARE)[number] };
	}
	return { name: 'invalid', error: `Unknown command \`${words[1]}\`` };
}

/** A new `/mq` comment on a pull request, from an `issue_comment` webhook payload; else null. */
export function commentFromPayload(payload: Record<string, unknown>): PRComment | null {
	const p = payload as {
		action?: string;
		issue?: { number?: number; pull_request?: unknown };
		comment?: { id?: number; body?: string | null; user?: { login?: string; type?: string } };
	};
	if (p.action !== 'created' || !p.issue?.pull_request || !p.issue.number) return null;
	const c = p.comment;
	if (!c?.id || typeof c.body !== 'string' || !c.user?.login) return null;
	if (parseCommand(c.body) === null) return null;
	return { pr: p.issue.number, commentId: c.id, body: c.body, login: c.user.login, bot: c.user.type === 'Bot' };
}

// Replies are writes GitHub counts against the app (80 a minute); one commenter can't spend them.
let replies = new RequestLimiter(10, 10);

export function resetCommandLimits() {
	replies = new RequestLimiter(10, 10);
}

/** A refusal the commenter is shown as is. */
class Refused extends Error {}

/** Runs the command a comment starts with. Null when it is not a command, or GitHub can't say who wrote it. */
export async function runCommand(repo: Repo, deps: CommandDeps, c: PRComment): Promise<CommandResult | null> {
	const command = parseCommand(c.body);
	if (!command) return null;
	let role: Role;
	try {
		role = await deps.role(c.login);
	} catch (e) {
		// Nobody acts on a guess about who they are.
		log.error("/mq command: could not look up the commenter's role", { repo: `${repo.owner}/${repo.name}`, pr: c.pr, by: c.login, err: e });
		return null;
	}
	// A bot reads at most, as an installation token does on the API: its rights can't be checked.
	const caller: Caller = { login: c.login, role: c.bot && atLeast(role, 'read') ? 'read' : role, app: c.bot };

	let ok = true;
	let text: string | null;
	try {
		requireRole(caller, 'read', 'Using the merge queue');
		text = await perform(repo, deps, c.pr, caller, command);
	} catch (e) {
		ok = false;
		if (e instanceof AuthError || e instanceof api.ApiError || e instanceof Refused) {
			text = unname(e.message, c.pr);
		} else {
			log.error('/mq command failed', { repo: `${repo.owner}/${repo.name}`, pr: c.pr, command: command.name, err: e });
			text = `Could not ${command.name === 'try' ? 'start a try run' : `run \`/mq ${command.name}\``}: something went wrong in the merge queue. Try again shortly.`;
		}
	}
	const reaction: Reaction = ok ? '+1' : 'confused';
	await deps.react(c.commentId, reaction).catch((e) => log.warn('/mq command: reaction not posted', { comment: c.commentId, err: e }));
	let reply: string | null = null;
	if (text !== null && replies.take(`${repo.id}:${c.login.toLowerCase()}`) === 0) {
		reply = `${quote(c.body)}\n\n${text}`;
		await deps.reply(c.pr, reply).catch((e) => {
			log.warn('/mq command: reply not posted', { pr: c.pr, err: e });
			reply = null;
		});
	}
	return { command: command.name, ok, reaction, reply };
}

/**
 * `text` with its own PR, `#n`, said as "this PR": a reply sits on that PR, so it never names it.
 * For reasons the queue words for any page (refusals, holds, next actions); other PRs stay named.
 */
export function unname(text: string, n: number): string {
	return text
		.replace(new RegExp(`(?<![\\w#])#${n}(?!\\d)`, 'g'), 'this PR')
		.replace(/(^|\n|[.:;!?]\s+)this PR/g, '$1This PR');
}

/** The command's first line, quoted: a reply never starts with `/mq`, so it is never run. */
function quote(body: string): string {
	const line = body.trimStart().split(/\r?\n/, 1)[0].trim();
	return `> ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`;
}

/** Does the command; returns the reply to post (null for none), or throws a refusal. */
async function perform(repo: Repo, deps: CommandDeps, n: number, caller: Caller, command: Command): Promise<string | null> {
	switch (command.name) {
		case 'invalid':
			throw new Refused(`${command.error}. Comment \`/mq help\` for the commands.`);
		case 'help':
			return HELP;
		case 'status':
			return status(repo, deps, n);
		case 'queue': {
			requireRole(caller, 'write', 'Queueing a PR');
			if (command.priority === 'urgent') requireRole(caller, 'maintain', 'Queueing a PR as urgent');
			api.enqueue(repo, caller, await deps.pr(n), { priority: command.priority });
			deps.wake();
			return null;
		}
		case 'dequeue':
			api.dequeue(repo, caller, n);
			deps.wake();
			return null;
		case 'retry':
			return retry(repo, deps, n, caller);
		case 'try': {
			requireRole(caller, 'write', 'Starting a try run');
			if (store.getQueueSettings(repo.id).mode !== 'batch') throw new Refused('Try runs need the queue in batch mode');
			let run: { branch: string };
			try {
				run = await deps.startTry(n);
			} catch (e) {
				if (e instanceof Error && /is not open|does not apply|comes from a fork|is already being tried/.test(e.message)) throw new Refused(e.message);
				throw e;
			}
			return `Started a try run on top of \`${repo.default_branch}\`, on branch \`${run.branch}\`. Its CI shows on that branch; nothing is merged. If it passes and neither this PR nor \`${repo.default_branch}\` changes, \`/mq queue\` lands it without another run.`;
		}
	}
}

/** Back in line after the queue threw the PR out, with the priority it had. */
async function retry(repo: Repo, deps: CommandDeps, n: number, caller: Caller): Promise<string | null> {
	requireRole(caller, 'write', 'Retrying a PR');
	const entry = api.queueEntry(repo.id, n);
	if (entry) {
		deps.wake();
		return `Already in the queue (${where(repo, entry)}). It goes into the next batch once nothing holds it; \`/mq status\` says what does.`;
	}
	const last = lastEventOf(repo.id, n, ['queued', 'dequeued', 'ejected', 'merged', 'cancelled']);
	if (last?.kind !== 'ejected') {
		throw new Refused(`Not removed from the queue by a failure, so there is nothing to retry. Comment \`/mq queue\` to queue it.`);
	}
	const queuedBefore = lastEventOf(repo.id, n, ['queued']);
	const had = PRIORITIES.includes(queuedBefore?.data.priority as Priority) ? (queuedBefore!.data.priority as Priority) : 'normal';
	const priority: Priority = had === 'urgent' && !atLeast(caller.role, 'maintain') ? 'normal' : had;
	api.enqueue(repo, caller, await deps.pr(n), { priority });
	deps.wake();
	return priority === had ? null : `Queued again at normal priority: it was urgent, and urgent needs maintain access.`;
}

type Entry = NonNullable<ReturnType<typeof api.queueEntry>>;

function waitingCount(repo: Repo): number {
	return db.getQueueItems(repo.id).filter((i) => api.WAITING_STATUSES.includes(i.status)).length;
}

function where(repo: Repo, e: Entry): string {
	const state = e.batch ? `testing in batch ${e.batch.number}` : e.status;
	return `position ${e.position} of ${waitingCount(repo)}, ${e.priority} priority, ${state}`;
}

async function status(repo: Repo, deps: CommandDeps, n: number): Promise<string> {
	let analysis: StackAnalysis | null = null;
	try {
		analysis = await deps.analysis();
	} catch (e) {
		log.warn('/mq status: no stack analysis', { pr: n, err: e });
	}
	const known = analysis?.prs.has(n) ? api.stackState(repo, n, analysis) : null;
	const found = known?.queue ?? api.queueEntry(repo.id, n, analysis);
	const entry = found && { ...found, lastMessage: found.lastMessage && unname(found.lastMessage, n) };
	const it = db.getQueueItems(repo.id).find((i) => i.pr_number === n);
	const held = it ? store.currentHold(it) : null;
	const hold = held && { ...held, reason: unname(held.reason, n) };
	const next = (known?.nextActions ?? []).map((a) => ({ ...a, why: unname(a.why, n) }));

	const lines: string[] = [];
	if (entry) {
		lines.push(`In the merge queue: ${where(repo, entry)}.`);
		if (hold) lines.push(`Held (\`${hold.code}\`): ${hold.reason}`);
		else if (entry.lastMessage) lines.push(`Last message: ${entry.lastMessage}`);
	} else {
		lines.push(`Not in the merge queue. Comment \`/mq queue\` to queue it.`);
	}
	if (next.length) {
		lines.push('', 'What to do:');
		for (const a of next) lines.push(actionLine(a));
	}
	lines.push('', `[Queue page](${deps.queueUrl})`);
	lines.push('', statusBlock({ pr: n, head: it?.head_sha ?? null, queue: entry, ...(hold ? { code: hold.code, reason: hold.reason } : {}), steps: next }));
	return lines.join('\n');
}

function actionLine(a: api.NextAction): string {
	const head = (text: string) => `- \`${a.do}\`: ${text}`;
	const code = (cmd: string) => `\n  \`${cmd}\``;
	switch (a.do) {
		case 'restack':
			return head(`Restack onto ${a.onto}. ${a.why}`) + code(a.cmd);
		case 'resolve-conflict':
			return head(`Resolve the conflict. ${a.why}`) + code(a.cmd);
		case 'retarget-base':
			return head(`Change the base branch to \`${a.base}\`. ${a.why}`);
		case 'wait-for':
			return head(`Wait for #${a.pr}. ${a.why}`);
		case 'queue':
		case 'queue-dependency':
			return head(`Queue #${a.pr} (comment \`/mq queue\` on it). ${a.why}`);
		case 'edit-dependencies':
			return head(`Fix or remove that \`Depends-On:\` line in the description. ${a.why}`);
		case 'mark-ready':
			return head(`Mark it ready for review. ${a.why}`);
		case 'fix':
			return head(a.why);
	}
}

const HELP = [
	'Merge queue commands. Start a comment on the pull request with one; only the first line is read.',
	'',
	'| Command | What it does | Access |',
	'| --- | --- | --- |',
	'| `/mq queue [--priority low\\|normal\\|urgent]` | Queue this PR. Its parents are not queued with it. | write (urgent: maintain) |',
	'| `/mq dequeue` | Take it out of the queue, unless a batch is testing it | write |',
	'| `/mq retry` | Queue it again after the queue removed it on a failure | write |',
	'| `/mq try` | One CI run of it on top of the default branch; nothing is merged, and a pass lets `/mq queue` land it without another run while neither changes | write |',
	'| `/mq status` | Where it stands, what holds it, and what to do | read |',
	'| `/mq help` | This list | read |'
].join('\n');
