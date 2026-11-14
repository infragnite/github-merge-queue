import { beforeEach, expect, test, vi } from 'vitest';
const fake = vi.hoisted(() => ({ visible: vi.fn(), stream: vi.fn(), settings: vi.fn(), known: vi.fn() }));
vi.mock('$lib/server/db', () => ({ getRepos: () => [{ id: 1 }, { id: 2 }] }));
vi.mock('$lib/server/visible-repos', () => ({ visibleRepos: fake.visible }));
vi.mock('$lib/server/batch-store', () => ({ getQueueSettings: fake.settings }));
vi.mock('$lib/server/public-view', () => ({ knownPublic: fake.known }));
vi.mock('$lib/server/repo-stream', () => ({ repoChangeResponse: fake.stream }));
const { GET } = await import('./+server');
const call = (path: string, user: { login: string } | null = { login: 'dev' }) => GET({ locals: { user }, request: new Request(`http://localhost${path}`), url: new URL(`http://localhost${path}`) } as never);
beforeEach(() => {
	vi.clearAllMocks();
	fake.visible.mockResolvedValue([{ id: 1 }]);
	fake.stream.mockReturnValue(new Response('stream'));
	fake.settings.mockReturnValue({ publicView: false });
	fake.known.mockReturnValue(false);
});

test('dashboard requires a session and subscribes only readable repositories', async () => {
	await expect(call('/api/ui/events', null)).rejects.toMatchObject({ status: 401 });
	expect(fake.stream).not.toHaveBeenCalled();
	await call('/api/ui/events');
	expect(fake.stream.mock.calls[0][0]).toEqual([1]);
});

test('a private repository cannot be subscribed without read access', async () => {
	fake.visible.mockResolvedValue([]);
	await expect(call('/api/ui/events?repo=2')).rejects.toMatchObject({ status: 404 });
	await expect(call('/api/ui/events?repo=2', null)).rejects.toMatchObject({ status: 404 });
	expect(fake.stream).not.toHaveBeenCalled();
});

test('a specific readable repo is the only subscription', async () => {
	await call('/api/ui/events?repo=1');
	expect(fake.visible.mock.calls[0][0]).toEqual([{ id: 1 }]);
	expect(fake.stream.mock.calls[0][0]).toEqual([1]);
});

test('anonymous specific streams require both public-view setting and known public visibility', async () => {
	fake.settings.mockReturnValue({ publicView: true });
	await expect(call('/api/ui/events?repo=1', null)).rejects.toMatchObject({ status: 404 });
	fake.known.mockReturnValue(true);
	await call('/api/ui/events?repo=1', null);
	expect(fake.stream.mock.calls[0][0]).toEqual([1]);
	expect(fake.visible).not.toHaveBeenCalled();
});
