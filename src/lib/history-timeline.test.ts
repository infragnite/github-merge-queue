import { describe, expect, test } from 'vitest';
import { historyTimeline, type HistoryRow } from './history-timeline';
import type { BatchCard, BatchPR } from './server/batch-view';

const pr = (n: number): BatchPR => ({ pr: n, title: '', url: '', depth: 0, parent: null, link: null });
const batch = (id: number, prs: number[], createdAt: string, finishedAt: string | null, status: BatchCard['status'] = 'landed'): BatchCard => ({
	id,
	number: id,
	kind: 'batch',
	branch: `mq/${id}`,
	status,
	express: false,
	ci: status === 'landed' ? 'success' : 'failure',
	headSha: `h${id}`,
	createdAt,
	finishedAt,
	context: [],
	landed: [],
	prs: prs.map(pr),
	bisection: [],
	progress: null
});
const row = (id: number, n: number, completed_at: string, status: HistoryRow['status'] = 'merged'): HistoryRow => ({ id, pr_number: n, pr_title: `PR ${n}`, pr_url: '', author_login: 'a', status, completed_at });

describe('history: finished batches and merged PRs in one list', () => {
	test('newest first; a PR merged by a batch shows under that batch, not again on its own', () => {
		const recent = [batch(2, [3, 4], '2026-11-11 10:00:00', '2026-11-11 10:30:00'), batch(1, [1, 2], '2026-11-11 09:00:00', '2026-11-11 09:30:00')];
		const history = [row(14, 4, '2026-11-11 10:31:00'), row(13, 3, '2026-11-11 10:31:00'), row(12, 2, '2026-11-11 09:31:00'), row(11, 1, '2026-11-11 09:31:00')];
		const t = historyTimeline(recent, history);
		expect(t.map((e) => e.key)).toEqual(['b2', 'b1']);
		expect(t[0]).toMatchObject({ kind: 'batch', rows: [{ pr_number: 3 }, { pr_number: 4 }] });
	});

	test('a batch PR without a known title takes the one its history row kept', () => {
		const t = historyTimeline([batch(1, [1, 2], '2026-11-11 09:00:00', '2026-11-11 09:30:00')], [row(11, 1, '2026-11-11 09:31:00')]);
		expect(t[0].kind === 'batch' && t[0].card.prs.map((p) => p.title)).toEqual(['PR 1', '']);
	});

	test('a PR that went through a failed batch and landed in a later one belongs to the later one', () => {
		const recent = [batch(2, [1], '2026-11-11 10:00:00', '2026-11-11 10:30:00'), batch(1, [1, 2], '2026-11-11 09:00:00', '2026-11-11 09:30:00', 'failed')];
		const t = historyTimeline(recent, [row(11, 1, '2026-11-11 10:31:00')]);
		expect(t.map((e) => [e.key, e.kind === 'batch' ? e.rows.map((r) => r.pr_number) : []])).toEqual([
			['b2', [1]],
			['b1', []]
		]);
	});

	test('a PR no shown batch carries (one by one, or an older batch) stands on its own, in time order', () => {
		const recent = [batch(5, [7], '2026-11-11 10:00:00', '2026-11-11 10:30:00')];
		const history = [row(3, 9, '2026-11-11 11:00:00'), row(2, 7, '2026-11-11 10:31:00'), row(1, 8, '2026-11-11 08:00:00', 'failed')];
		expect(historyTimeline(recent, history).map((e) => e.key)).toEqual(['h3', 'b5', 'h1']);
	});

	test('a batch is placed by when it finished, or when it started if it has not', () => {
		const recent = [batch(2, [], '2026-11-11 10:00:00', null, 'superseded'), batch(1, [], '2026-11-11 09:00:00', '2026-11-11 10:10:00', 'cancelled')];
		expect(historyTimeline(recent, []).map((e) => [e.key, e.at])).toEqual([
			['b1', Date.parse('2026-11-11T10:10:00Z')],
			['b2', Date.parse('2026-11-11T10:00:00Z')]
		]);
	});

	test('a PR completed before a batch carrying it was created is not that batch\'s', () => {
		const recent = [batch(5, [7], '2026-11-11 10:00:00', '2026-11-11 10:30:00', 'failed')];
		expect(historyTimeline(recent, [row(1, 7, '2026-11-11 09:00:00')]).map((e) => e.key)).toEqual(['b5', 'h1']);
	});
});
