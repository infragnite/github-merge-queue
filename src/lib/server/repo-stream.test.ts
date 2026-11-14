import { afterEach, expect, test, vi } from 'vitest';
import { repoChangeResponse } from './repo-stream';

afterEach(() => vi.useRealTimers());

test('stream sends invalidation hints, never event contents, and unsubscribes on abort', async () => {
	const abort = new AbortController();
	let changed = () => {};
	const off = vi.fn();
	const subscribe = vi.fn((ids: number[], listener: () => void) => { changed = listener; return off; });
	const response = repoChangeResponse([12], abort.signal, subscribe);
	expect(subscribe.mock.calls[0][0]).toEqual([12]);
	expect(response.headers.get('content-type')).toBe('text/event-stream');
	expect(response.headers.get('cache-control')).toContain('private');
	const reader = response.body!.getReader();
	expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: change\ndata: {}');
	changed();
	expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: change\ndata: {}\n\n');
	abort.abort();
	expect(off).toHaveBeenCalledOnce();
	expect((await reader.read()).done).toBe(true);
});

test('closing a tab cleans up subscriptions and streams expire for reauthorization', async () => {
	vi.useFakeTimers();
	const off = vi.fn();
	const response = repoChangeResponse([1], new AbortController().signal, () => off);
	await response.body!.cancel();
	expect(off).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
	const expired = vi.fn();
	const next = repoChangeResponse([1], new AbortController().signal, () => expired);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(expired).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
	await next.body!.cancel();
});
