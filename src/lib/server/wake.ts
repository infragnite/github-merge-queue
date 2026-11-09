// Webhooks mark a repo dirty so the processor runs its batch tick right away
// instead of waiting for the next polling slot.

const dirty = new Set<number>();

export function markDirty(repoId: number) {
	dirty.add(repoId);
}

/** True (once) when something changed for this repo since the last call. */
export function takeDirty(repoId: number): boolean {
	return dirty.delete(repoId);
}
