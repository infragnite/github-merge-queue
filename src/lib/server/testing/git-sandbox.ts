// A throwaway git repository that models a GitHub repo with pull requests,
// so stack detection can be tested against real git history (real rebases,
// squash merges, amends) rather than hand-written commit lists.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PRSnapshot, StackCommit, StackInput } from '../stacks';
import type { GhCompare, GhPull, StackGitHub } from '../stack-source';

interface SandboxPR {
	number: number;
	headRef: string;
	baseRef: string;
	state: 'open' | 'closed';
	merged: boolean;
	closedAt: string | null;
	/** Head at close time; GitHub keeps it after the branch is gone. */
	frozenHead: string | null;
}

export class GitSandbox {
	readonly dir: string;
	private clock = 1_760_000_000;
	private prs = new Map<number, SandboxPR>();
	private heads = new Map<number, Set<string>>();
	private deleted = new Map<string, string>();
	/** When false, head SHAs are not recorded (no webhook/polling history). */
	recordHistory = true;

	constructor() {
		this.dir = mkdtempSync(join(tmpdir(), 'stack-sandbox-'));
		this.git('init', '-q', '-b', 'main');
		this.git('config', 'user.email', 'dev@example.com');
		this.git('config', 'user.name', 'Dev');
		this.git('config', 'commit.gpgsign', 'false');
		this.git('commit', '-q', '--allow-empty', '-m', 'initial');
	}

	cleanup() {
		rmSync(this.dir, { recursive: true, force: true });
	}

	git(...args: string[]): string {
		const at = `@${this.clock} +0000`;
		return execFileSync('git', args, {
			cwd: this.dir,
			encoding: 'utf8',
			env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, GIT_EDITOR: 'true' },
			stdio: ['ignore', 'pipe', 'pipe']
		}).trim();
	}

	private tick() {
		this.clock += 60;
	}

	now(): string {
		return new Date(this.clock * 1000).toISOString();
	}

	sha(ref: string): string {
		return this.git('rev-parse', ref);
	}

	branch(name: string, from: string) {
		this.git('branch', name, from);
	}

	/** Adds a commit to `branch`; `file` defaults to one file per message. */
	commit(branch: string, message: string, file = `${message.replace(/\W+/g, '-')}.txt`): string {
		this.tick();
		this.git('checkout', '-q', branch);
		writeFileSync(join(this.dir, file), `${message}\n${this.clock}\n`);
		this.git('add', '-A');
		this.git('commit', '-q', '-m', message);
		this.observe();
		return this.sha('HEAD');
	}

	/** `git commit --amend` keeping author, date and (unless given) message. */
	amend(branch: string, newMessage?: string) {
		this.tick();
		this.git('checkout', '-q', branch);
		writeFileSync(join(this.dir, `amend-${this.clock}.txt`), 'amended\n');
		this.git('add', '-A');
		if (newMessage) this.git('commit', '-q', '--amend', '-m', newMessage);
		else this.git('commit', '-q', '--amend', '--no-edit');
		this.observe();
	}

	/** `git rebase <onto>` of `branch`. */
	rebase(branch: string, onto: string) {
		this.tick();
		this.git('checkout', '-q', branch);
		this.git('rebase', '-q', onto);
		this.observe();
	}

	/** `git rebase --onto <onto> <upstream> <branch>` — the restack operation. */
	rebaseOnto(branch: string, onto: string, upstream: string) {
		this.tick();
		this.git('rebase', '-q', '--onto', onto, upstream, branch);
		this.observe();
	}

	/** Replaces a branch with one fresh commit on top of `from` (force-push). */
	forcePush(branch: string, from: string, message: string) {
		this.tick();
		this.git('checkout', '-q', '-B', branch, from);
		this.commit(branch, message);
	}

	/** Merges `source` into `branch` with a merge commit. */
	mergeInto(branch: string, source: string) {
		this.tick();
		this.git('checkout', '-q', branch);
		this.git('merge', '-q', '--no-ff', '--no-edit', source);
		this.observe();
	}

	openPR(number: number, headRef: string, baseRef: string) {
		this.prs.set(number, {
			number,
			headRef,
			baseRef,
			state: 'open',
			merged: false,
			closedAt: null,
			frozenHead: null
		});
		this.observe();
	}

	retarget(number: number, baseRef: string) {
		this.pr(number).baseRef = baseRef;
	}

	/** Merges a PR into its base the way GitHub would. */
	merge(number: number, method: 'squash' | 'merge' | 'rebase') {
		const pr = this.pr(number);
		this.tick();
		const head = this.sha(pr.headRef);
		if (method === 'squash') {
			this.git('checkout', '-q', pr.baseRef);
			this.git('merge', '-q', '--squash', pr.headRef);
			this.git('commit', '-q', '-m', `Squashed #${number}`);
		} else if (method === 'merge') {
			this.git('checkout', '-q', pr.baseRef);
			this.git('merge', '-q', '--no-ff', '-m', `Merge #${number}`, pr.headRef);
		} else {
			this.git('checkout', '-q', '-B', `rebase-merge-${number}`, pr.headRef);
			this.git('rebase', '-q', pr.baseRef);
			this.git('checkout', '-q', pr.baseRef);
			this.git('merge', '-q', '--ff-only', `rebase-merge-${number}`);
			this.git('branch', '-q', '-D', `rebase-merge-${number}`);
		}
		Object.assign(pr, { state: 'closed', merged: true, closedAt: this.now(), frozenHead: head });
	}

	close(number: number) {
		const pr = this.pr(number);
		this.tick();
		Object.assign(pr, { state: 'closed', closedAt: this.now(), frozenHead: this.sha(pr.headRef) });
	}

	/**
	 * Deletes a branch. With `retarget`, open PRs based on it move to the
	 * deleted PR's base (GitHub's behaviour after merge + auto-delete);
	 * otherwise GitHub closes them.
	 */
	deleteBranch(name: string, opts: { retarget?: boolean; recordWebhook?: boolean } = {}) {
		this.tick();
		this.git('checkout', '-q', 'main');
		const owner = [...this.prs.values()].find((p) => p.headRef === name);
		for (const pr of this.prs.values()) {
			if (pr.state !== 'open' || pr.headRef === name) continue;
			if (pr.baseRef !== name) continue;
			if (opts.retarget && owner) pr.baseRef = owner.baseRef;
			else Object.assign(pr, { state: 'closed', closedAt: this.now(), frozenHead: this.sha(pr.headRef) });
		}
		if (owner && owner.state === 'open') this.close(owner.number);
		this.git('branch', '-q', '-D', name);
		if (opts.recordWebhook !== false) this.deleted.set(name, this.now());
	}

	pr(number: number): SandboxPR {
		const pr = this.prs.get(number);
		if (!pr) throw new Error(`no PR #${number}`);
		return pr;
	}

	private observe() {
		if (!this.recordHistory) return;
		for (const pr of this.prs.values()) {
			if (pr.state !== 'open') continue;
			const set = this.heads.get(pr.number) ?? new Set();
			set.add(this.sha(pr.headRef));
			this.heads.set(pr.number, set);
		}
	}

	forgetHistory() {
		this.heads.clear();
		this.deleted.clear();
	}

	branches(): Set<string> {
		return new Set(
			this.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean)
		);
	}

	/** `default..head` the way the compare API reports it, oldest first. */
	commitsBetween(base: string, head: string): StackCommit[] {
		const out = this.git('log', '--reverse', '--format=%H%x00%ae%x00%aI%x00%B%x1e', `${base}..${head}`);
		return out
			.split('\x1e')
			.map((s) => s.trim())
			.filter(Boolean)
			.map((rec) => {
				const [sha, authorEmail, authoredAt, message] = rec.split('\x00');
				return { sha, authorEmail, authoredAt, message: message.trim() };
			});
	}

	snapshot(number: number): PRSnapshot {
		const pr = this.pr(number);
		const headSha = pr.frozenHead ?? this.sha(pr.headRef);
		return {
			number,
			state: pr.state,
			merged: pr.merged,
			headRef: pr.headRef,
			headSha,
			baseRef: pr.baseRef,
			commits: pr.state === 'open' ? this.commitsBetween('main', headSha) : null,
			closedAt: pr.closedAt
		};
	}

	input(): StackInput {
		return {
			defaultBranch: 'main',
			prs: [...this.prs.keys()].map((n) => this.snapshot(n)),
			knownHeads: new Map(this.heads),
			existingBranches: this.branches(),
			deletedBranches: new Map(this.deleted)
		};
	}

	/** Pull requests as the GitHub list endpoint returns them. */
	pulls(state: 'open' | 'closed'): GhPull[] {
		return [...this.prs.values()]
			.filter((p) => p.state === state)
			.map((p) => ({
				number: p.number,
				state: p.state,
				merged_at: p.merged ? p.closedAt : null,
				closed_at: p.closedAt,
				head: { ref: p.headRef, sha: p.frozenHead ?? this.sha(p.headRef) },
				base: { ref: p.baseRef }
			}));
	}

	/** A GitHub client answering from this repository. */
	client(calls: string[] = []): StackGitHub {
		return {
			listOpenPRs: async () => (calls.push('open'), this.pulls('open')),
			listRecentlyClosedPRs: async () => (calls.push('closed'), this.pulls('closed')),
			getBranchSha: async (branch) => {
				calls.push(`branch:${branch}`);
				return this.branches().has(branch) ? this.sha(branch) : null;
			},
			compare: async (base, head, page, perPage): Promise<GhCompare | null> => {
				calls.push(`compare:${head.slice(0, 7)}:${page}`);
				let all: StackCommit[];
				try {
					all = this.commitsBetween(base, head);
				} catch {
					return null;
				}
				return {
					total_commits: all.length,
					commits: all.slice((page - 1) * perPage, page * perPage).map((c) => ({
						sha: c.sha,
						commit: { message: c.message, author: { email: c.authorEmail, date: c.authoredAt } }
					}))
				};
			}
		};
	}

	knownHeads(): Map<number, string[]> {
		return new Map([...this.heads].map(([n, s]) => [n, [...s]]));
	}

	deletedBranches(): Map<string, string> {
		return new Map(this.deleted);
	}
}
