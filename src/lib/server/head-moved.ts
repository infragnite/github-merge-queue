// The queue pushes to a PR's own branch (restacking it, or merging the default branch into it to
// land) with a lease on the head it read. When the author pushed after that read, GitHub refuses
// the push: the author's work stays, and the queue reads the new head and decides again. That is
// not a failure anyone has to act on.

/** A push leased on `expected` found `branch` somewhere else: it was pushed to (or deleted) since the queue read it. */
export class HeadMovedError extends Error {
	constructor(
		readonly branch: string,
		readonly expected: string
	) {
		super(`${branch} is no longer at ${expected.slice(0, 8)}: it was pushed to`);
		this.name = 'HeadMovedError';
	}
}

/** Whether a failed `git push --force-with-lease` was refused for its lease, by git's own words. */
export function leaseLost(message: string): boolean {
	return /\[rejected\][^\n]*\(stale info\)/.test(message);
}
