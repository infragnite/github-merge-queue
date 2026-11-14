/** Event hints trigger a coalesced refresh; polling reconciles missed events every 30s. */
export function watchRepoUpdates(refresh: () => Promise<unknown>, url = '/api/ui/events'): () => void {
	let stream: EventSource | null = null;
	let pending: ReturnType<typeof setTimeout> | undefined;
	let running = false;
	let dirty = false;
	let disposed = false;
	let lastStart = 0;
	const request = () => {
		if (disposed) return;
		dirty = true;
		if (pending || running || document.visibilityState !== 'visible') return;
		pending = setTimeout(run, Math.max(100, lastStart + 1000 - Date.now()));
	};
	const run = async () => {
		pending = undefined;
		if (disposed || document.visibilityState !== 'visible') return;
		dirty = false;
		running = true;
		lastStart = Date.now();
		try { await refresh(); } catch { /* Keep the last view until another hint or reconciliation. */ }
		finally { running = false; if (dirty) request(); }
	};
	const connect = () => {
		if (disposed || document.visibilityState !== 'visible') { stream?.close(); stream = null; return; }
		if (!stream) {
			stream = new EventSource(url);
			stream.addEventListener('change', request);
		}
		request();
	};
	const reconcile = setInterval(request, 30_000);
	document.addEventListener('visibilitychange', connect);
	connect();
	return () => {
		disposed = true;
		stream?.close();
		clearInterval(reconcile);
		clearTimeout(pending);
		document.removeEventListener('visibilitychange', connect);
	};
}
