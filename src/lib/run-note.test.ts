import { describe, expect, test } from 'vitest';
import { runNote } from './run-note';

const progress = (done: number, failed: number, total = 40) => ({ total, done, failed, running: 2, url: null, failedJobs: [] });
const run = (prs: number[], over: Partial<Parameters<typeof runNote>[0]> = {}) => ({ prs: prs.map((pr) => ({ pr })), ci: 'pending' as string, finishedAt: null as string | null, progress: null as ReturnType<typeof progress> | null, ...over });

describe('why a run goes on', () => {
	test('a run of one PR says it runs to the end, and once a job failed, how many jobs are left', () => {
		expect(runNote(run([3241]))).toBe('Runs to the end: #3241 is tested alone, so its author gets every error. Runs of several PRs stop at their first failure.');
		expect(runNote(run([3241], { progress: progress(15, 1) }))).toBe('A job failed. #3241 runs to the end so its author gets every error: 25 jobs left.');
	});

	test('with stop on first failure off, every run goes to the end, and the note says that', () => {
		expect(runNote(run([3241], { progress: progress(15, 1) }), false)).toBe('Runs to the end: stop on first failure is off in the settings.');
		expect(runNote(run([3364, 3365]), false)).toBe('Runs to the end: stop on first failure is off in the settings.');
	});

	test('a run of several PRs, or one that has ended, needs no note', () => {
		expect(runNote(run([3364, 3365], { progress: progress(15, 1) }))).toBeNull();
		expect(runNote(run([3241], { ci: 'failure', finishedAt: '2026-11-10 17:00:00', progress: progress(40, 3) }))).toBeNull();
	});
});
