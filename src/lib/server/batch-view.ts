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
	/** What a bisecting batch's runs showed about this PR (bisecting batches only). */
	verdict?: BisectVerdict;
	/** What is happening to it now, alongside the verdict. */
	activity?: BisectActivity | null;
	/** Landed, ejected or back in line: nothing more to find out about it in this bisection. */
	settled?: boolean;
	/** It failed alone and is to be ejected, once the default branch it failed on is known green. */
	awaitingEject?: boolean;
	/** The runs behind the verdict, for a tooltip. */
	trail?: string;
}

/**
 * What the runs showed about a PR of a bisecting batch: `failing` once ejected (it failed alone
 * on a branch known green, or is stacked on one that did), `passing` once it was in a run that
 * passed, else `unknown`.
 */
export type BisectVerdict = 'unknown' | 'passing' | 'failing';
/** And, independently, what is happening to it: in a run still going, merged, or back in line. */
export type BisectActivity = 'checking' | 'landed' | 'left';

export function bisectStates(
	b: Pick<BatchRow, 'members' | 'landed' | 'left_prs' | 'ejected'>,
	runs: Pick<BatchRow, 'members' | 'context' | 'ci_result' | 'status' | 'base_sha'>[]
) {
	const out = new Map<number, { verdict: BisectVerdict; activity: BisectActivity | null; trail: string; awaitingEject?: boolean }>();
	const tested = runs.map((r, i) => ({ r, step: i + 1 })).filter(({ r }) => r.status !== 'cancelled');
	for (const n of b.members) {
		const inRun = tested.filter(({ r }) => r.members.includes(n) || r.context.includes(n));
		const landed = b.landed.includes(n);
		// Failing only once ejected: a failure alone counts only on a branch known green, which the
		// queue settles before it ejects. Until then it is unknown (and checked again).
		const verdict: BisectVerdict = b.ejected.includes(n)
			? 'failing'
			: landed || inRun.some(({ r }) => r.ci_result === 'success')
				? 'passing'
				: 'unknown';
		const activity: BisectActivity | null = landed
			? 'landed'
			: b.left_prs.includes(n) && !b.ejected.includes(n)
				? 'left'
				: inRun.some(({ r }) => r.ci_result === 'pending')
					? 'checking'
					: null;
		const trail = inRun
			.map(({ r, step }) => {
				const result = r.ci_result === 'success' ? 'passed' : r.ci_result === 'failure' ? 'failed' : 'running';
				const how = r.members.length === 1 && r.members[0] === n ? 'alone' : `with ${r.members.length - 1} other${r.members.length === 2 ? '' : 's'}`;
				return `run ${step}: ${result} ${how} on ${r.base_sha.slice(0, 7)}`;
			})
			.join('\n');
		// Failed alone and not ejected yet: the ejection waits for the default branch to be known.
		const alone = inRun.filter(({ r }) => r.members.length === 1 && r.members[0] === n).at(-1);
		const awaitingEject = !landed && !b.ejected.includes(n) && !b.left_prs.includes(n) && alone?.r.ci_result === 'failure';
		out.set(n, { verdict, activity, trail, ...(awaitingEject ? { awaitingEject } : {}) });
	}
	return out;
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
	/** The batch's number in its repository, as shown. */
	number: number;
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

const LOG_RUN_MS = 2 * 60 * 60 * 1000;

/**
 * True while a run's CI may still be moving: it is running, or it is a run of one PR that failed
 * lately. That run was decided at its first failed job, and its other jobs go on for the log.
 */
export function ciMayStillRun(
	b: Pick<BatchRow, 'status' | 'ci_result' | 'members' | 'finished_at'>,
	now = Date.now(),
	/** Its last known progress: once every job is done, there is nothing more to read. */
	last?: { total: number; done: number } | null
): boolean {
	if (isRunning(b)) return true;
	if (b.status !== 'failed' || b.ci_result !== 'failure' || b.members.length !== 1 || !b.finished_at) return false;
	if (last && last.total > 0 && last.done >= last.total) return false;
	return now - Date.parse(b.finished_at.replace(' ', 'T') + 'Z') < LOG_RUN_MS;
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
	const states = b.kind === 'batch' && bisection.length ? bisectStates(b, bisection) : null;
	// A PR is drawn under its parent only while that parent is still to land with it: once the
	// parent merged (or left), the PR stands on its own.
	const gone = new Set([...b.landed, ...b.left_prs]);
	const under = (n: number) => {
		const p = parentOf(n);
		return p !== null && p !== n && members.has(p) && !gone.has(p) && !gone.has(n) ? p : null;
	};
	const depth = (n: number, seen = 0): number => {
		const p = under(n);
		return p !== null && seen < members.size ? depth(p, seen + 1) + 1 : 0;
	};
	// Each PR right after its parent (and its parent's other children), so the connector points at it.
	const order: number[] = [];
	const place = (n: number) => {
		if (order.includes(n)) return;
		order.push(n);
		for (const m of b.members) if (under(m) === n) place(m);
	};
	for (const n of b.members) if (under(n) === null) place(n);
	for (const n of b.members) place(n);
	// In a bisection, what is still to settle comes first; what has (landed, ejected, back in line)
	// follows, on its own rows.
	const settled = (n: number) => {
		const st = states?.get(n);
		return !!st && (st.verdict === 'failing' || st.activity === 'landed' || st.activity === 'left');
	};
	const rows = [...order.filter((n) => !settled(n)), ...order.filter(settled)];
	return {
		id: b.id,
		number: b.number,
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
		prs: rows.map((n) => ({
			pr: n,
			title: prs.get(n)?.title ?? '',
			url: prs.get(n)?.url ?? '',
			depth: settled(n) ? 0 : depth(n),
			...(states ? { settled: settled(n) } : {}),
			parent: parentOf(n),
			link: analysis?.prs.get(n)?.link ?? null,
			...(states ? states.get(n) : {})
		})),
		bisection: bisection.map((r) => batchCard(r, [], analysis, prs, progress)),
		progress: progress.get(b.head_sha) ?? null
	};
}
