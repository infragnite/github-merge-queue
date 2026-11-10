// `/mq` commands in PR comments. Not implemented yet.
import type { Role } from './api-auth';
import type { Priority } from './batching';
import type { StackAnalysis } from './stacks';
import type { Repo } from '$lib/types';

export type Command =
	| { name: 'queue'; priority: Priority }
	| { name: 'dequeue' | 'retry' | 'try' | 'status' | 'help' }
	| { name: 'invalid'; error: string };

export interface PRComment {
	pr: number;
	commentId: number;
	body: string;
	login: string;
	bot: boolean;
}

export type Reaction = '+1' | 'confused';

export interface CommandResult {
	command: Command['name'];
	ok: boolean;
	reaction: Reaction;
	reply: string | null;
}

export interface CommandDeps {
	role(login: string): Promise<Role>;
	pr(n: number): Promise<{ number: number; title: string; html_url: string; state: string; user: { login: string; avatar_url: string } }>;
	analysis(): Promise<StackAnalysis>;
	startTry(n: number): Promise<{ branch: string }>;
	react(commentId: number, content: Reaction): Promise<void>;
	reply(n: number, body: string): Promise<void>;
	wake(): void;
	queueUrl: string;
}

export function parseCommand(_body: string): Command | null {
	throw new Error('not implemented');
}

export function commentFromPayload(_payload: Record<string, unknown>): PRComment | null {
	throw new Error('not implemented');
}

export function resetCommandLimits() {}

export async function runCommand(_repo: Repo, _deps: CommandDeps, _c: PRComment): Promise<CommandResult | null> {
	throw new Error('not implemented');
}
