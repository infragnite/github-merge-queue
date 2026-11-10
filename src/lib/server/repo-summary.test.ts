import { expect, test } from 'vitest';
import { summarize } from './repo-summary';
import type { QueueItem } from '../types';

let nextId = 1;
function item(pr: number, over: Partial<QueueItem> & { hold?: string } = {}): QueueItem {
	return {
		id: nextId++,
		repo_id: 1,
		pr_number: pr,
		pr_title: `PR ${pr}`,
		pr_url: `https://x/${pr}`,
		author_login: 'a',
		author_avatar: '',
		head_sha: null,
		status: 'queued',
		position: pr,
		error_message: null,
		queued_by: 'a',
		created_at: '2026-11-09 10:00:00',
		started_at: null,
		completed_at: null,
		priority: 'normal',
		...over
	} as QueueItem;
}

const base = { mode: 'batch' as const, maxBatch: 8, expressMax: 2, paused: null, masterRed: false, batches: [] };

test('batch mode counts the PRs in flight as testing, the rest as waiting, failures as attention', () => {
	const s = summarize({
		...base,
		items: [item(1, { status: 'checking' }), item(2, { status: 'checking' }), item(3), item(4), item(5, { status: 'failed', error_message: 'CI failed' }), item(6, { status: 'conflict' })],
		batches: [{ id: 1, status: 'testing', prs: [1, 2] }]
	});
	expect(s).toMatchObject({ state: 'running', testing: 2, waiting: 2, attention: 2, modeLabel: 'Batches of up to 8' });
});

test('one by one counts the PR under test once, not also as waiting', () => {
	const s = summarize({ ...base, mode: 'serial', items: [item(1, { status: 'checking' }), item(2), item(3)] });
	expect(s).toMatchObject({ state: 'running', testing: 1, waiting: 2, attention: 0, modeLabel: 'One by one' });
});

test('a PR held for a reason only a person can fix needs attention; one that waits by itself does not', () => {
	const s = summarize({
		...base,
		items: [
			item(1, { error_message: 'Needs an approval', hold: JSON.stringify({ reason: 'Needs an approval', wait: false }) }),
			item(2, { error_message: 'CI is running', hold: JSON.stringify({ reason: 'CI is running', wait: true }) })
		]
	});
	expect(s).toMatchObject({ state: 'waiting', testing: 0, waiting: 1, attention: 1 });
});

test('paused wins over a red default branch, which wins over running', () => {
	const items = [item(1, { status: 'checking' })];
	const batches = [{ id: 1, status: 'testing', prs: [1] }];
	expect(summarize({ ...base, items, batches, paused: 'CI is misconfigured', masterRed: true }).state).toBe('paused');
	expect(summarize({ ...base, items, batches, masterRed: true }).state).toBe('red');
	expect(summarize({ ...base, items: [] }).state).toBe('idle');
});
