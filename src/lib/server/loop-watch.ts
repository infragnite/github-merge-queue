// Logs whenever the event loop was blocked long enough for requests to stall, so an
// unresponsive app says why in its own logs instead of just going quiet.

const CHECK_MS = 1_000;
/** A stall longer than this is logged. */
const STALL_MS = 2_000;

let timer: ReturnType<typeof setInterval> | null = null;

export function watchEventLoop(log: (msg: string) => void = console.warn) {
	if (timer) return;
	let expected = Date.now() + CHECK_MS;
	timer = setInterval(() => {
		const now = Date.now();
		const late = now - expected;
		if (late >= STALL_MS) log(`[merge-queue] Event loop was blocked for ${late} ms`);
		expected = now + CHECK_MS;
	}, CHECK_MS);
	timer.unref();
}
