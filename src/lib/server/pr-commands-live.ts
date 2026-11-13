// `/mq` commands wired to GitHub and the live queue.
import { env } from '$env/dynamic/private';
import * as github from './github';
import { roleFromPermission } from './api-auth';
import { analyzeRepoStacks } from './stack-runtime';
import { startTry } from './batch-queue';
import { liveDeps } from './batch-live';
import { withRepoLock } from './repo-lock';
import { withActivity } from './activity';
import { markDirty } from './wake';
import { runCommand, type CommandDeps, type PRComment } from './pr-commands';
import type { Repo } from '$lib/types';
import { log } from './log';

function liveCommandDeps(repo: Repo): CommandDeps {
	const { owner, name } = repo;
	return {
		role: async (login) => roleFromPermission(await github.collaboratorRole(owner, name, login)),
		pr: (n) => github.getPR(owner, name, n),
		analysis: () => analyzeRepoStacks(repo),
		startTry: (n) => withRepoLock(repo.id, () => withActivity(liveDeps(repo), (d) => startTry(d, n), { buildKind: () => 'try' })),
		react: async (id, content) => {
			await github.reactToComment(owner, name, id, content);
		},
		reply: async (n, body) => {
			await github.commentOnPR(owner, name, n, body);
		},
		wake: () => markDirty(repo.id),
		queueUrl: `${(env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')}/repos/${owner}/${name}`
	};
}

export async function runLiveCommand(repo: Repo, c: PRComment): Promise<void> {
	const r = await runCommand(repo, liveCommandDeps(repo), c);
	if (r) log.info('/mq command', { repo: `${repo.owner}/${repo.name}`, pr: c.pr, command: r.command, by: c.login, outcome: r.ok ? 'done' : 'refused' });
}
