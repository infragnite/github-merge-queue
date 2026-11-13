// Whether the processor still makes progress: a cycle that never finishes (an await that never
// settles) or none finishing at all means the queue has stopped, though the server still answers.

/** A cycle may wait on GitHub and git for a while; one this long has hung. */
const HUNG_MS = 10 * 60_000;

const min = (ms: number) => Math.floor(ms / 60_000);

export function livenessProblem(s: { now: number; startedAt: number; lastCycleEnd: number | null; runningSince: number | null }): string | null {
	if (s.runningSince !== null && s.now - s.runningSince >= HUNG_MS) return `the processor cycle started ${min(s.now - s.runningSince)} min ago has not finished`;
	const last = s.lastCycleEnd ?? s.startedAt;
	if (s.runningSince === null && s.now - last >= HUNG_MS) return `no processor cycle has finished in ${min(s.now - last)} min`;
	return null;
}
