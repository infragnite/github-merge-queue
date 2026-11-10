// `/mq` commands wired to GitHub and the live queue. Not implemented yet.
import type { PRComment } from './pr-commands';
import type { Repo } from '$lib/types';

export async function runLiveCommand(_repo: Repo, _c: PRComment): Promise<void> {
	throw new Error('not implemented');
}
