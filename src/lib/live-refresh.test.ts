import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { watchRepoUpdates } from './live-refresh';

class Source extends EventTarget {
	static instances: Source[] = [];
	closed = false;
	constructor(readonly url: string) { super(); Source.instances.push(this); }
	close() { this.closed = true; }
}
let visible = 'visible';
let doc: EventTarget;
let stop = () => {};
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(100_000);
	Source.instances = [];
	visible = 'visible';
	doc = new EventTarget();
	Object.defineProperty(doc, 'visibilityState', { get: () => visible });
	vi.stubGlobal('document', doc);
	vi.stubGlobal('EventSource', Source);
});
afterEach(() => { stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test('event bursts coalesce and reconciliation still refreshes after 30 seconds', async () => {
	const refresh = vi.fn(async () => {});
	stop = watchRepoUpdates(refresh, '/api/ui/events?repo=12');
	await vi.advanceTimersByTimeAsync(100);
	expect(refresh).toHaveBeenCalledTimes(1);
	for (let i = 0; i < 20; i++) Source.instances[0].dispatchEvent(new Event('change'));
	await vi.advanceTimersByTimeAsync(1000);
	expect(refresh).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(30_000);
	expect(refresh).toHaveBeenCalledTimes(3);
});

test('a change during a request is reconciled afterwards without overlapping requests', async () => {
	let complete = () => {};
	const refresh = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
	stop = watchRepoUpdates(refresh);
	await vi.advanceTimersByTimeAsync(100);
	Source.instances[0].dispatchEvent(new Event('change'));
	await vi.advanceTimersByTimeAsync(5000);
	expect(refresh).toHaveBeenCalledOnce();
	complete();
	await vi.advanceTimersByTimeAsync(1000);
	expect(refresh).toHaveBeenCalledTimes(2);
	complete();
});

test('hidden tabs disconnect, returning tabs reconcile, and disposal stops all refreshes', async () => {
	const refresh = vi.fn(async () => {});
	stop = watchRepoUpdates(refresh);
	await vi.advanceTimersByTimeAsync(100);
	visible = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
	expect(Source.instances[0].closed).toBe(true);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(refresh).toHaveBeenCalledOnce();
	visible = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
	await vi.advanceTimersByTimeAsync(100);
	expect(Source.instances).toHaveLength(2);
	expect(refresh).toHaveBeenCalledTimes(2);
	stop();
	Source.instances[1].dispatchEvent(new Event('change'));
	await vi.advanceTimersByTimeAsync(60_000);
	expect(refresh).toHaveBeenCalledTimes(2);
});

test('a failed refresh retains reconciliation and recovers on the next change', async () => {
	const refresh = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined);
	stop = watchRepoUpdates(refresh);
	await vi.advanceTimersByTimeAsync(100);
	Source.instances[0].dispatchEvent(new Event('change'));
	await vi.advanceTimersByTimeAsync(1000);
	expect(refresh).toHaveBeenCalledTimes(2);
});
