// Wires the batch queue (batch-queue.ts) to GitHub, GitHub Actions and a
// local bare mirror of the repository.

import { env } from '$env/dynamic/private';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as github from './github';
import { buildBatch, GitRunner } from './batch-builder';
import { getQueueSettings, type CISettings } from './batch-store';
import { analyzeRepoStacks } from './stack-runtime';
import type { LivePR, QueueDeps } from './batch-queue';
import type { GhReview } from './github';

type RepoRef = { id: number; owner: string; name: string; default_branch: string };

const WRITERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Approval state from a PR's reviews: the latest decisive review of each
 * reviewer with write access counts. Returns the head SHAs approvals were
 * given on, and whether anyone's latest word is "changes requested".
 */
export function approvalsFrom(reviews: GhReview[], author: string): { approvedShas: string[]; changesRequested: boolean } {
	const latest = new Map<string, GhReview>();
	for (const r of [...reviews].sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at))) {
		const who = r.user?.login;
		if (!who || who === author || !WRITERS.has(r.author_association)) continue;
		if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') latest.set(who, r);
	}
	const approvedShas = [...latest.values()].filter((r) => r.state === 'APPROVED').map((r) => r.commit_id);
	const changesRequested = [...latest.values()].some((r) => r.state === 'CHANGES_REQUESTED');
	return { approvedShas: [...new Set(approvedShas)], changesRequested };
}

/** Result of the required check from its check runs on one commit. */
export function checkResult(runs: Array<{ status: string; conclusion: string | null }>): 'pending' | 'success' | 'failure' {
	if (runs.length === 0 || runs.some((r) => r.status !== 'completed')) return 'pending';
	return runs.every((r) => r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped')
		? 'success'
		: 'failure';
}

/** A bare mirror per repository, fetched by SHA with the installation token. */
export class Mirror {
	readonly git: GitRunner;

	constructor(private readonly repo: RepoRef) {
		const dir = join(env.MIRROR_DIR || './data/mirrors', repo.owner, `${repo.name}.git`);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			new GitRunner(dir).run(['init', '-q', '--bare']);
		}
		this.git = new GitRunner(dir);
	}

	private get url() {
		return `https://github.com/${this.repo.owner}/${this.repo.name}.git`;
	}

	private async auth(): Promise<string[]> {
		const token = await github.getInstallationTokenForGit();
		const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
		return ['-c', `http.extraheader=Authorization: Basic ${basic}`];
	}

	has(sha: string): boolean {
		return this.git.run(['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }).code === 0;
	}

	async fetch(shas: string[]) {
		const missing = [...new Set(shas)].filter((s) => !this.has(s));
		if (missing.length === 0) return;
		this.git.run([...(await this.auth()), 'fetch', '-q', '--no-tags', this.url, ...missing]);
	}

	async push(branch: string, sha: string) {
		this.git.run([...(await this.auth()), 'push', '-q', '--force', this.url, `${sha}:refs/heads/${branch}`]);
	}
}

export function liveDeps(repo: RepoRef): QueueDeps {
	const { owner, name } = repo;
	const mirror = new Mirror(repo);
	const ci = (): CISettings => getQueueSettings(repo.id).ci;

	return {
		repo,
		now: () => Date.now(),
		analysis: () => analyzeRepoStacks(repo),
		git: {
			fetch: (shas) => mirror.fetch(shas),
			tree: async (sha) => mirror.git.run(['rev-parse', `${sha}^{tree}`]).out,
			build: async (base, members) => buildBatch(mirror.git, base, members)
		},
		ci: {
			start: async (branch, baseSha, headSha, prs) => {
				await github.dispatchWorkflow(owner, name, ci().workflow, branch, {
					base_sha: baseSha,
					head_sha: headSha,
					batch: prs.join(',')
				});
			},
			result: async (headSha) => checkResult(await github.checkRunsNamed(owner, name, headSha, ci().requiredCheck)),
			rerunFailed: async (headSha) => {
				const runs = await github.workflowRunsForSha(owner, name, headSha);
				const failed = runs.filter((r) => r.status === 'completed' && r.conclusion === 'failure');
				for (const r of failed) await github.rerunFailedJobs(owner, name, r.id);
				return failed.length > 0;
			}
		},
		github: {
			defaultBranchSha: async () => {
				const sha = await github.getBranchSha(owner, name, repo.default_branch);
				if (!sha) throw new Error(`default branch ${repo.default_branch} not found`);
				return sha;
			},
			pr: async (n): Promise<LivePR> => {
				const p = await github.getPR(owner, name, n);
				const [reviews, checks] = await Promise.all([
					github.listReviews(owner, name, n),
					github.checkRunsNamed(owner, name, p.head.sha, ci().requiredCheck)
				]);
				const result = checkResult(checks);
				return {
					pr: n,
					headSha: p.head.sha,
					draft: !!p.draft,
					ciGreen: result === 'pending' ? null : result === 'success',
					...approvalsFrom(reviews, p.user?.login ?? ''),
					title: p.title,
					url: p.html_url,
					authorLogin: p.user?.login ?? '',
					baseRef: p.base.ref,
					state: p.state,
					merged: !!p.merged
				};
			},
			pushBranch: (branch, sha) => mirror.push(branch, sha),
			deleteBranch: (branch) => github.deleteBranch(owner, name, branch),
			retargetBase: async (n, base) => {
				await github.setPRBase(owner, name, n, base);
			},
			squashMerge: async (n, title, sha) => {
				const r = await github.squashMergeAt(owner, name, n, title, sha);
				return { merged: r.merged, message: r.message };
			},
			setStatus: async (sha, state, description) => {
				await github.createCommitStatus(owner, name, sha, { state, context: ci().testedStatus, description });
			},
			comment: async (n, body) => {
				await github.commentOnPR(owner, name, n, body);
			}
		}
	};
}
