// Wires the batch queue (batch-queue.ts) to GitHub, GitHub Actions and a
// local bare mirror of the repository.

import { env } from '$env/dynamic/private';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as github from './github';
import { baselineCommit, buildBatch, GitRunner } from './batch-builder';
import { replay } from './rebase';
import { getQueueSettings, type CISettings } from './batch-store';
import { currentStackAnalysis } from './stack-runtime';
import { bumpGeneration, memoByGeneration } from './wake';
import type { LivePR, QueueDeps, Readiness } from './batch-queue';
import type { GhReview } from './github';

type RepoRef = { id: number; owner: string; name: string; default_branch: string };

const WRITERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Reviewers whose association could mean write access; their actual permission is checked next. */
export function candidateReviewers(reviews: GhReview[], author: string): string[] {
	return [
		...new Set(
			reviews
				.filter((r) => r.user?.login && r.user.login !== author && WRITERS.has(r.author_association))
				.map((r) => r.user!.login)
		)
	];
}

/**
 * Approval state from a PR's reviews: the latest decisive review of each
 * reviewer with write access (`canApprove`) counts. Returns the head SHAs
 * approvals were given on, and whether anyone's latest word is "changes requested".
 */
export function approvalsFrom(
	reviews: GhReview[],
	author: string,
	canApprove: (login: string) => boolean = () => true
): { approvedShas: string[]; changesRequested: boolean } {
	const latest = new Map<string, GhReview>();
	for (const r of [...reviews].sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at))) {
		const who = r.user?.login;
		if (!who || who === author || !WRITERS.has(r.author_association) || !canApprove(who)) continue;
		if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') latest.set(who, r);
	}
	const approvedShas = [...latest.values()].filter((r) => r.state === 'APPROVED').map((r) => r.commit_id);
	const changesRequested = [...latest.values()].some((r) => r.state === 'CHANGES_REQUESTED');
	return { approvedShas: [...new Set(approvedShas)], changesRequested };
}

/**
 * Result of the required check from its check runs on one commit. Only `success` passes: a
 * skipped or neutral required job proved nothing. With `notBefore` (when failed jobs were re-run),
 * runs that finished earlier are the old attempt and are ignored.
 */
export function checkResult(
	runs: Array<{ status: string; conclusion: string | null; completed_at?: string | null }>,
	notBefore?: number | null
): 'pending' | 'success' | 'failure' {
	if (notBefore) runs = runs.filter((r) => r.status !== 'completed' || !r.completed_at || Date.parse(r.completed_at) >= notBefore);
	if (runs.length === 0 || runs.some((r) => r.status !== 'completed')) return 'pending';
	return runs.every((r) => r.conclusion === 'success') ? 'success' : 'failure';
}

/**
 * Whether the required check already failed though its run still goes on: a job in the same
 * workflow run as the required check (the jobs it waits for) failed or timed out. Skipped and
 * cancelled jobs don't count, nor a job that finished before `notBefore` (a re-run's start).
 */
export function earlyFailure(
	required: Array<{ check_suite?: { id: number } }>,
	jobs: Array<{ name?: string; status: string; conclusion: string | null; completed_at?: string | null; check_suite?: { id: number } }>,
	notBefore?: number | null,
	/** Whether the gate waits for the job of this check run name (see `gateFeeds`); every job when absent. */
	feeds?: (name: string) => boolean,
	/** The check suites of the CI workflow's runs on the commit, for before the gate has a check run. */
	ciSuites?: ReadonlySet<number>
): boolean {
	// The gate's own workflow run, once the gate has a check run. Before that (GitHub makes it only
	// when everything it needs has ended), the CI workflow's runs, and its file says which jobs
	// feed the gate. Other workflows' jobs on the commit never count, whatever their names.
	const gate = new Set(required.flatMap((r) => (r.check_suite ? [r.check_suite.id] : [])));
	const suites = gate.size ? gate : feeds ? (ciSuites ?? new Set<number>()) : gate;
	if (!suites.size) return false;
	return jobs.some(
		(j) =>
			j.status === 'completed' &&
			(j.conclusion === 'failure' || j.conclusion === 'timed_out') &&
			!!j.check_suite &&
			suites.has(j.check_suite.id) &&
			(!feeds || (j.name !== undefined && feeds(j.name))) &&
			(!notBefore || !j.completed_at || Date.parse(j.completed_at) >= notBefore)
	);
}

/**
 * The jobs a workflow's gate (the job whose name or id is `gate`) waits for, through `needs`,
 * directly or not, and the gate itself: a predicate on check run names. A job's check runs are
 * named by its `name` (up to any expression in it: matrix jobs add their values) or its id, and a
 * reusable workflow's jobs `caller / callee`. Null when the workflow can't be read or has no such
 * job: nothing is then known to feed the gate.
 */
export function gateFeeds(workflow: string, gate: string): ((name: string) => boolean) | null {
	let doc: unknown;
	try {
		doc = parseYaml(workflow);
	} catch {
		return null;
	}
	const jobs = (doc as { jobs?: Record<string, { name?: unknown; needs?: unknown; 'continue-on-error'?: unknown }> } | null)?.jobs;
	if (!jobs || typeof jobs !== 'object') return null;
	const label = (id: string) => {
		const n = jobs[id]?.name;
		return typeof n === 'string' ? n.split('${{')[0].trim() || id : id;
	};
	const start = Object.keys(jobs).find((id) => id === gate || label(id) === gate);
	if (!start) return null;
	// A job allowed to fail (`continue-on-error`, or an expression that may allow it) doesn't fail the
	// gate, nor does a job only it needs (its failure just skips the tolerant one): neither decides
	// anything early. A gate that itself tolerates failed needs (checking `needs.*.result`) can't be
	// read from the file; early stop doesn't suit such a gate.
	const tolerant = (id: string) => {
		const c = jobs[id]?.['continue-on-error'];
		return c !== undefined && c !== false && c !== 'false';
	};
	const closure = new Set<string>();
	const visit = (id: string) => {
		if (closure.has(id) || !jobs[id] || tolerant(id)) return;
		closure.add(id);
		const needs = jobs[id].needs;
		for (const n of typeof needs === 'string' ? [needs] : Array.isArray(needs) ? needs : []) if (typeof n === 'string') visit(n);
	};
	visit(start);
	// A check run is named by its job's name with each expression replaced by its value (a matrix
	// job without a name adds its values in parentheses); a reusable workflow's jobs add ` / callee`.
	const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const matchers = [...closure].map((id) => {
		const n = jobs[id]?.name;
		const template = typeof n === 'string' && n.trim() ? n.trim() : id;
		const pattern = template
			.split(/\$\{\{[\s\S]*?\}\}/)
			.map(escape)
			.join('.+?');
		// A name that is only expressions says nothing about the check run's name: it matches none.
		if (!template.replace(/\$\{\{[\s\S]*?\}\}/g, '').trim()) return /(?!)/;
		const values = template.includes('${{') ? '' : '(?: \\(.+\\))?';
		return new RegExp(`^${pattern}${values}(?: / .+)?$`);
	});
	return (name) => matchers.some((m) => m.test(name));
}

/** A fetch or push gives up after this long. */
const NETWORK_TIMEOUT_MS = 10 * 60 * 1000;

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

	/** The token goes in through the environment, never the command line (which errors and `ps` show). */
	private async auth(): Promise<NodeJS.ProcessEnv> {
		const token = await github.getInstallationTokenForGit(this.repo.owner);
		const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
		return {
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'http.extraheader',
			GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
			GIT_TERMINAL_PROMPT: '0',
			// A stalled transfer (under 1 KB/s for a minute) fails instead of hanging.
			GIT_HTTP_LOW_SPEED_LIMIT: '1000',
			GIT_HTTP_LOW_SPEED_TIME: '60'
		};
	}

	has(sha: string): boolean {
		return this.git.run(['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }).code === 0;
	}

	async fetch(shas: string[]) {
		const missing = [...new Set(shas)].filter((s) => !this.has(s));
		if (missing.length === 0) return;
		await this.network(`fetch ${missing.map((s) => s.slice(0, 8)).join(' ')}`, [
			'fetch', '-q', '--no-tags', this.url, ...missing
		]);
	}

	async push(branch: string, sha: string) {
		await this.network(`push ${sha.slice(0, 8)} to ${branch}`, [
			'push', '-q', '--force', this.url, `${sha}:refs/heads/${branch}`
		]);
	}

	/** Force-pushes `sha` to `branch` only if the branch is still at `expected`. */
	async pushLease(branch: string, sha: string, expected: string) {
		await this.network(`push ${sha.slice(0, 8)} to ${branch} (lease ${expected.slice(0, 8)})`, [
			'push', '-q', `--force-with-lease=refs/heads/${branch}:${expected}`, this.url, `${sha}:refs/heads/${branch}`
		]);
	}

	/** Runs a fetch or push off the event loop, logging what it did and how long it took. */
	private async network(what: string, args: string[]) {
		const name = `${this.repo.owner}/${this.repo.name}`;
		const started = Date.now();
		try {
			await this.git.runAsync(args, { env: await this.auth(), timeoutMs: NETWORK_TIMEOUT_MS });
			console.log(`[git] ${name}: ${what} took ${Date.now() - started} ms`);
		} catch (err) {
			console.error(`[git] ${name}: ${what} failed after ${Date.now() - started} ms: ${err instanceof Error ? err.message : err}`);
			throw err;
		}
	}
}

// Reviews cost a call per open PR; webhooks bump the repo's generation when PRs change, and the
// queue's own merges and pushes do too.
const reviewsMemo = memoByGeneration<GhReview[]>(10 * 60 * 1000);

const ROLE_TTL_MS = 10 * 60 * 1000;
const roleCache = new Map<string, { role: string; until: number }>();

async function canWrite(owner: string, name: string, login: string): Promise<boolean> {
	const key = `${owner}/${name}:${login}`.toLowerCase();
	let hit = roleCache.get(key);
	if (!hit || hit.until < Date.now()) {
		hit = { role: await github.collaboratorRole(owner, name, login), until: Date.now() + ROLE_TTL_MS };
		roleCache.set(key, hit);
	}
	return ['write', 'maintain', 'admin'].includes(hit.role);
}

export function liveDeps(repo: RepoRef): QueueDeps {
	const { owner, name } = repo;
	const mirror = new Mirror(repo);
	const ci = (): CISettings => getQueueSettings(repo.id).ci;
	const dispatchRef = () => ci().dispatchRef || repo.default_branch;
	// What the required check waits for, read from the workflow file in the tested commit, by its blob.
	const gates = new Map<string, ((name: string) => boolean) | null>();
	const gateAt = (sha: string) => {
		const path = `${sha}:.github/workflows/${ci().workflow}`;
		const blob = mirror.git.run(['rev-parse', '--verify', '-q', path], { allowFail: true });
		if (blob.code !== 0 || !blob.out) return null;
		const key = `${blob.out}\0${ci().requiredCheck}`;
		if (!gates.has(key)) {
			const file = mirror.git.run(['cat-file', 'blob', blob.out], { allowFail: true });
			gates.set(key, file.code === 0 ? gateFeeds(file.out, ci().requiredCheck) : null);
		}
		return gates.get(key)!;
	};

	return {
		repo,
		now: () => Date.now(),
		analysis: () => currentStackAnalysis(repo),
		git: {
			fetch: (shas) => mirror.fetch(shas),
			tree: async (sha) => mirror.git.run(['rev-parse', `${sha}^{tree}`]).out,
			build: async (base, members) => buildBatch(mirror.git, base, members),
			restack: async (head, upstream, onto) => replay(mirror.git, { head, upstream, onto }),
			baseline: async (base) => baselineCommit(mirror.git, base)
		},
		ci: {
			// Pushing the mq/* branch triggers the workflow; the base is in the batch commit's trailer.
			start: async () => {},
			refreshCaches: async () => {
				await github.dispatchWorkflow(owner, name, ci().workflow, dispatchRef(), {});
			},
			result: async (headSha, notBefore, opts) => {
				const required = await github.checkRunsNamed(owner, name, headSha, ci().requiredCheck);
				const r = checkResult(required, notBefore);
				if (r !== 'pending' || !opts?.failFast) return r;
				// Only a job the required check waits for can decide it early; unknown, then no early stop.
				// The gate itself may not exist yet: GitHub makes its check run once its needs end.
				const feeds = gateAt(headSha);
				if (!feeds) return r;
				const file = `.github/workflows/${ci().workflow}`;
				const ciSuites = required.length
					? undefined
					: new Set((await github.workflowRunsForSha(owner, name, headSha)).filter((w) => w.path?.split('@')[0] === file).map((w) => w.check_suite_id));
				return earlyFailure(required, await github.actionsJobsForSha(owner, name, headSha), notBefore, feeds, ciSuites) ? 'failure' : 'pending';
			},
			cancel: async (headSha) => {
				const runs = await github.workflowRunsForSha(owner, name, headSha);
				for (const r of runs.filter((r) => r.status !== 'completed')) await github.cancelWorkflowRun(owner, name, r.id);
			},
			// Re-runs the workflow runs behind the required check's failed (or cancelled, timed-out) runs,
			// not whatever else failed on the commit.
			runUrl: async (headSha) => {
				const runs = await github.checkRunsNamed(owner, name, headSha, ci().requiredCheck);
				// A failed job's page shows the failure; otherwise any of the check's jobs.
				return (runs.find((r) => r.conclusion && r.conclusion !== 'success') ?? runs[0])?.html_url ?? null;
			},
			rerunFailed: async (headSha) => {
				const checks = await github.checkRunsNamed(owner, name, headSha, ci().requiredCheck);
				const suites = new Set(
					checks.filter((c) => c.status === 'completed' && c.conclusion !== 'success').flatMap((c) => (c.check_suite ? [c.check_suite.id] : []))
				);
				if (suites.size === 0) return 'none';
				const runs = (await github.workflowRunsForSha(owner, name, headSha)).filter((r) => suites.has(r.check_suite_id));
				if (runs.length === 0) return 'none';
				// GitHub re-runs failed jobs only once the whole run finished.
				if (runs.some((r) => r.status !== 'completed')) return 'wait';
				for (const r of runs) await github.rerunFailedJobs(owner, name, r.id);
				return 'rerun';
			}
		},
		github: {
			defaultBranchSha: async () => {
				const sha = await github.getBranchSha(owner, name, repo.default_branch);
				if (!sha) throw new Error(`default branch ${repo.default_branch} not found`);
				return sha;
			},
			openPRs: async (): Promise<LivePR[]> =>
				(await github.getOpenPRs(owner, name)).map((p) => ({
					pr: p.number,
					headSha: p.head.sha,
					headRef: p.head.ref,
					sameRepo: p.head.repo?.full_name?.toLowerCase() === `${owner}/${name}`.toLowerCase(),
					draft: !!p.draft,
					title: p.title,
					url: p.html_url,
					authorLogin: p.user?.login ?? '',
					baseRef: p.base.ref,
					state: 'open' as const,
					merged: false
				})),
			pr: async (n): Promise<LivePR> => {
				const p = await github.getPR(owner, name, n);
				return {
					pr: n,
					headSha: p.head.sha,
					headRef: p.head.ref,
					sameRepo: p.head.repo?.full_name?.toLowerCase() === `${owner}/${name}`.toLowerCase(),
					draft: !!p.draft,
					title: p.title,
					url: p.html_url,
					authorLogin: p.user?.login ?? '',
					baseRef: p.base.ref,
					state: p.state,
					merged: !!p.merged
				};
			},
			readiness: async (n, headSha, author, opts): Promise<Readiness> => {
				const settings = getQueueSettings(repo.id);
				const reviewsNow = () => github.listReviews(owner, name, n);
				// The check right before merging reads reviews fresh: a missed webhook must not land a dismissed approval.
				const [reviews, checks] = await Promise.all([
					settings.config.requireApproval || opts?.needApprovals
						? opts?.fresh
							? reviewsNow()
							: reviewsMemo(repo.id, `${n}:${headSha}`, reviewsNow)
						: Promise.resolve([]),
					settings.config.requirePRChecks
						? github.checkRunsNamed(owner, name, headSha, ci().requiredCheck)
						: Promise.resolve([])
				]);
				const writers = new Set<string>();
				for (const login of candidateReviewers(reviews, author)) {
					if (await canWrite(owner, name, login)) writers.add(login);
				}
				const result = checkResult(checks);
				return {
					ciGreen: result === 'pending' ? null : result === 'success',
					...approvalsFrom(reviews, author, (l) => writers.has(l))
				};
			},
			pushBranch: (branch, sha) => mirror.push(branch, sha),
			pushHead: async (branch, sha, expected) => {
				bumpGeneration(repo.id);
				await mirror.pushLease(branch, sha, expected);
			},
			deleteBranch: (branch) => github.deleteBranch(owner, name, branch),
			retargetBase: async (n, base) => {
				bumpGeneration(repo.id);
				await github.setPRBase(owner, name, n, base);
			},
			squashMerge: async (n, title, sha) => {
				bumpGeneration(repo.id);
				const r = await github.squashMergeAt(owner, name, n, title, sha);
				return { merged: r.merged, sha: r.sha, message: r.message };
			},
			setStatus: async (sha, state, description) => {
				await github.createCommitStatus(owner, name, sha, { state, context: ci().testedStatus, description });
			},
			setPRStatus: async (sha, state, description, opts) => {
				await github.createCommitStatus(owner, name, sha, {
					state,
					context: `${ci().prStatus}${opts?.suffix ?? ''}`,
					description,
					...(opts?.url ? { target_url: opts.url } : {})
				});
			},
			label: async (n, label, on) => {
				if (on) await github.addLabel(owner, name, n, label);
				else await github.removeLabel(owner, name, n, label);
			},
			comment: async (n, body) => {
				await github.commentOnPR(owner, name, n, body);
			}
		}
	};
}
