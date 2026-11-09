// The dashboard's view of the batch pipeline: each batch with its PRs (indented where one is
// stacked on another in the same batch), its bisection runs, and how far its CI has got.

import type { BatchRow } from './batch-store';
import type { LinkStatus, StackAnalysis } from './stacks';

export interface BatchPR {
	pr: number;
	title: string;
	url: string;
	/** Depth within this batch: 1 under a parent that is in the same batch, and so on. */
	depth: number;
	/** The open PR it is stacked on, in this batch or not. */
	parent: number | null;
	link: LinkStatus | null;
}

export interface CIProgress {
	total: number;
	done: number;
	failed: number;
	running: number;
	/** Link to a job of the run, for opening it on GitHub. */
	url: string | null;
	failedJobs: string[];
}

export interface BatchCard {
	id: number;
	kind: BatchRow['kind'];
	branch: string;
	status: BatchRow['status'];
	express: boolean;
	ci: BatchRow['ci_result'];
	headSha: string;
	createdAt: string;
	finishedAt: string | null;
	/** PRs below the tested ones that already passed (bisection only). */
	context: number[];
	/** PRs of a bisecting batch that already landed. */
	landed: number[];
	prs: BatchPR[];
	bisection: BatchCard[];
	progress: CIProgress | null;
}

const PASSING = new Set(['success', 'skipped', 'neutral']);

/** Job counts from a commit's check runs. */
export function summarizeJobs(jobs: Array<{ name: string; status: string; conclusion: string | null; html_url: string }>): CIProgress {
	const done = jobs.filter((j) => j.status === 'completed');
	const failed = done.filter((j) => !PASSING.has(j.conclusion ?? ''));
	return {
		total: jobs.length,
		done: done.length,
		failed: failed.length,
		running: jobs.filter((j) => j.status === 'in_progress').length,
		url: (failed[0] ?? jobs.find((j) => j.status !== 'completed') ?? jobs[0])?.html_url ?? null,
		failedJobs: failed.map((j) => j.name).sort()
	};
}

/** True while a batch's CI may still be moving, so its progress is worth fetching. */
export function isRunning(b: Pick<BatchRow, 'status'>): boolean {
	return b.status === 'testing' || b.status === 'retrying' || b.status === 'bisecting';
}

export function batchCard(
	b: BatchRow,
	bisection: BatchRow[],
	analysis: StackAnalysis | null,
	prs: Map<number, { title: string; url: string }>,
	progress: Map<string, CIProgress>
): BatchCard {
	const members = new Set(b.members);
	const parentOf = (n: number) => analysis?.prs.get(n)?.parent ?? null;
	const depth = (n: number): number => {
		const p = parentOf(n);
		return p !== null && members.has(p) ? depth(p) + 1 : 0;
	};
	return {
		id: b.id,
		kind: b.kind,
		branch: b.branch,
		status: b.status,
		express: b.express,
		ci: b.ci_result,
		headSha: b.head_sha,
		createdAt: b.created_at,
		finishedAt: b.finished_at,
		context: b.context,
		landed: b.landed,
		prs: b.members.map((n) => ({
			pr: n,
			title: prs.get(n)?.title ?? '',
			url: prs.get(n)?.url ?? '',
			depth: depth(n),
			parent: parentOf(n),
			link: analysis?.prs.get(n)?.link ?? null
		})),
		bisection: bisection.map((r) => batchCard(r, [], analysis, prs, progress)),
		progress: progress.get(b.head_sha) ?? null
	};
}
