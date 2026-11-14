import { subscribeRepoChanges } from './events';

/** Invalidation hints only. Reconnects reconcile state, rather than replaying sensitive events. */
export function repoChangeResponse(repoIds: number[], signal: AbortSignal, subscribe = subscribeRepoChanges): Response {
	let stop: (close?: boolean) => void = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			let closed = false;
			const send = (text: string) => { if (!closed) controller.enqueue(encoder.encode(text)); };
			const unsubscribe = subscribe(repoIds, () => send('event: change\ndata: {}\n\n'));
			const heartbeat = setInterval(() => send(': heartbeat\n\n'), 15_000);
			// Periodically reauthorize the session and repository access on reconnect.
			const expiry = setTimeout(() => stop(), 60_000);
			const abort = () => stop();
			stop = (close = true) => {
				if (closed) return;
				closed = true;
				unsubscribe();
				clearInterval(heartbeat);
				clearTimeout(expiry);
				signal.removeEventListener('abort', abort);
				if (close) controller.close();
			};
			signal.addEventListener('abort', abort, { once: true });
			// Initial/reconnected streams refresh anything missed while disconnected.
			send('retry: 2000\nevent: change\ndata: {}\n\n');
			if (signal.aborted) stop();
		},
		cancel() { stop(false); }
	});
	return new Response(body, { headers: {
		'content-type': 'text/event-stream',
		'cache-control': 'private, no-store, no-transform',
		'x-accel-buffering': 'no'
	} });
}
