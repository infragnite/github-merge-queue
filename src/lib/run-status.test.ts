import { describe, expect, test } from 'vitest';
import { runStatus } from './run-status';

const progress = (done: number, failed: number, total = 40) => ({ total, done, failed, running: total - done, url: null, failedJobs: [] });
type Run = Parameters<typeof runStatus>[0];
const run = (over: Partial<Run> = {}): Run => ({ kind: 'batch', status: 'testing', ci: 'pending', prs: [{ pr: 1 }, { pr: 2 }], finishedAt: null, progress: null, ...over });

describe('the status a run shows', () => {
	test('a run with a failed job whose other jobs still go is failing, not failed', () => {
		expect(runStatus(run({ progress: progress(10, 1) }))).toBe('failing');
		expect(runStatus(run({ kind: 'try', prs: [{ pr: 7 }], progress: progress(10, 1) }))).toBe('failing');
		expect(runStatus(run({ kind: 'bisect', progress: progress(10, 2) }))).toBe('failing');
	});

	test('a run of one PR decided at its first failed job stays failing while its other jobs run for the log', () => {
		expect(runStatus(run({ kind: 'bisect', status: 'failed', ci: 'failure', prs: [{ pr: 7 }], finishedAt: '2026-11-11 10:00:00', progress: progress(12, 1) }))).toBe('failing');
	});

	test('once every job is done it is failed', () => {
		expect(runStatus(run({ kind: 'bisect', status: 'failed', ci: 'failure', prs: [{ pr: 7 }], finishedAt: '2026-11-11 10:00:00', progress: progress(40, 1) }))).toBe('failed');
		expect(runStatus(run({ status: 'failed', ci: 'failure', finishedAt: '2026-11-11 10:00:00' }))).toBe('failed');
	});

	test('a run without a failed job keeps its own status', () => {
		expect(runStatus(run({ progress: progress(10, 0) }))).toBe('testing');
		expect(runStatus(run({ status: 'bisecting', ci: 'failure', progress: progress(40, 3) }))).toBe('bisecting');
		expect(runStatus(run({ status: 'cancelled', ci: 'pending', progress: progress(10, 1) }))).toBe('cancelled');
	});

	test('a try or a check of the default branch that passed is passed: it landed nothing', () => {
		expect(runStatus(run({ kind: 'try', status: 'landed', ci: 'success', finishedAt: 'x' }))).toBe('passed');
		expect(runStatus(run({ kind: 'baseline', status: 'landed', ci: 'success', finishedAt: 'x' }))).toBe('passed');
		expect(runStatus(run({ kind: 'batch', status: 'landed', ci: 'success', finishedAt: 'x' }))).toBe('landed');
	});
});
