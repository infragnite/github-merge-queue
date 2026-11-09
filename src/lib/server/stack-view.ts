// The dashboard's view of a repository's stacks: each stack as rows from its root down,
// indented by depth, with what the dashboard needs to show next to each PR.

import type { LinkStatus, StackAnalysis } from './stacks';

export interface StackRow {
	pr: number;
	depth: number;
	title: string;
	url: string;
	/** How this PR sits on its parent; null for the root. */
	link: LinkStatus | null;
	/** True when this PR or anything below it has a blocking issue. */
	broken: boolean;
	issues: Array<{ severity: 'blocking' | 'warning'; message: string }>;
	/** The PR's queue status, or null when it is not queued. */
	queue: string | null;
}

export interface StackView {
	root: number;
	rows: StackRow[];
}

export function stackView(
	analysis: StackAnalysis,
	prs: Map<number, { title: string; url: string }>,
	queue: Map<number, string>
): StackView[] {
	return analysis.stacks.map((members) => {
		const root = members[0];
		const rows: StackRow[] = [];
		const visit = (n: number, depth: number) => {
			const info = analysis.prs.get(n);
			if (!info) return;
			const meta = prs.get(n);
			rows.push({
				pr: n,
				depth,
				title: meta?.title ?? '',
				url: meta?.url ?? '',
				link: depth === 0 ? null : info.link,
				broken: info.broken,
				issues: info.issues.map((i) => ({ severity: i.severity, message: i.message })),
				queue: queue.get(n) ?? null
			});
			for (const c of [...info.children].sort((a, b) => a - b)) visit(c, depth + 1);
		};
		visit(root, 0);
		return { root, rows };
	});
}
