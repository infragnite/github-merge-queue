export type GitHubRef = { text: string; href?: string };

/** Plain text only: renderers create anchors without interpreting HTML. */
export function githubRefs(text: string, owner: string, repo: string, commits: string[] = []): GitHubRef[] {
	const parts: GitHubRef[] = [];
	const refs = /(?<![\w/#-])(?:([\w.-]+\/[\w.-]+)?#(\d+)|[a-fA-F0-9]{7,40})(?![\w/])/g;
	let cursor = 0;
	for (const match of text.matchAll(refs)) {
		const start = match.index!;
		const label = match[0];
		let href: string | undefined;
		if (match[2]) {
			// Batch and step numbers are internal identities, not GitHub issues.
			if (!/\b(?:batch|step|position)\s*$/i.test(text.slice(0, start))) {
				href = `https://github.com/${match[1] ?? `${owner}/${repo}`}/issues/${match[2]}`;
			}
		} else {
			const full = commits.find((sha) => sha.startsWith(label));
			if (full || (/[a-f]/i.test(label) && /[0-9]/.test(label)) || /\b(?:commit|head|tree|sha|base)\s+$/i.test(text.slice(0, start))) href = `https://github.com/${owner}/${repo}/commit/${full ?? label}`;
		}
		if (!href) continue;
		if (start > cursor) parts.push({ text: text.slice(cursor, start) });
		parts.push({ text: label, href });
		cursor = start + label.length;
	}
	if (cursor < text.length) parts.push({ text: text.slice(cursor) });
	return parts;
}
