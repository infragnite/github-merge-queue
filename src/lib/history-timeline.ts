// The queue page's history: finished batches and PRs that left the queue (merged or failed), in
// one list, newest first. A PR merged by a shown batch is listed under that batch only.

import type { BatchCard } from './server/batch-view';

export interface HistoryRow {
	id: number;
	pr_number: number;
	pr_title: string;
	pr_url: string;
	author_login: string;
	status: string;
	completed_at: string;
}

export type HistoryEntry<R extends HistoryRow = HistoryRow> =
	| { kind: 'batch'; key: string; at: number; card: BatchCard; rows: R[] }
	| { kind: 'pr'; key: string; at: number; row: R };

const sqlTime = (t: string) => Date.parse(t.replace(' ', 'T') + 'Z');

export function historyTimeline<R extends HistoryRow>(recent: BatchCard[], history: R[]): HistoryEntry<R>[] {
	const batches = recent.map((card) => ({ kind: 'batch' as const, key: `b${card.id}`, at: sqlTime(card.finishedAt ?? card.createdAt), start: sqlTime(card.createdAt), card, rows: [] as R[] }));
	const out: HistoryEntry<R>[] = [];
	for (const row of history) {
		const done = sqlTime(row.completed_at);
		// The last batch carrying it that started before it left the queue.
		const home = batches.filter((b) => b.start <= done && b.card.prs.some((p) => p.pr === row.pr_number)).sort((x, y) => y.start - x.start)[0];
		if (home) home.rows.push(row);
		else out.push({ kind: 'pr', key: `h${row.id}`, at: done, row });
	}
	for (const b of batches) b.rows.sort((x, y) => b.card.prs.findIndex((p) => p.pr === x.pr_number) - b.card.prs.findIndex((p) => p.pr === y.pr_number));
	out.push(...batches.map(({ kind, key, at, card, rows }) => ({ kind, key, at, card, rows })));
	return out.sort((x, y) => y.at - x.at || (x.kind === 'pr' ? -1 : 1));
}
