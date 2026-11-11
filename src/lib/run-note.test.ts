import { describe, expect, test } from 'vitest';
import { runNote } from './run-note';

const progress = (done: number, failed: number, total = 40) => ({ total, done, failed, running: 2, url: null, failedJobs: [] });
const run = (prs: number[], over: Partial<Parameters<typeof runNote>[0]> = {}) => ({ prs: prs.map((pr) => ({ pr })), ci: 'pending' as string, finishedAt: null as string | null, progress: null as ReturnType<typeof progress> | null, ...over });

describe('why a run goes on', () => {
	test('a run that has no failed job says nothing, even one that will run to the end', () => {
		expect(runNote(run([3241]))).toBeNull();
		expect(runNote(run([3241], { progress: progress(15, 0) }))).toBeNull();
		expect(runNote(run([3364, 3365]), false)).toBeNull();
	});

	test('once a job failed, a run of one PR says it runs to the end and how many jobs are left', () => {
		expect(runNote(run([3241], { progress: progress(15, 1) }))).toBe('A job failed. #3241 runs to the end so its author gets every error: 25 jobs left.');
	});

	test('with stop on first failure off, a run that failed a job says it goes to the end because of that setting', () => {
		expect(runNote(run([3241], { progress: progress(15, 1) }), false)).toBe('A job failed. It runs to the end: stop on first failure is off in the settings.');
		expect(runNote(run([3364, 3365], { progress: progress(15, 1) }), false)).toBe('A job failed. It runs to the end: stop on first failure is off in the settings.');
	});

	test('a run of one PR decided at its first failed job says its other jobs run only for the log', () => {
		expect(runNote(run([3241], { ci: 'failure', finishedAt: '2026-11-10 16:36:00', progress: progress(15, 1) }))).toBe(
			"Failed at its first failed job. Its other 25 jobs go on only for #3241's full log; nothing waits for them."
		);
	});

	test('a run of several PRs, or one that has ended, needs no note', () => {
		expect(runNote(run([3364, 3365], { progress: progress(15, 1) }))).toBeNull();
		expect(runNote(run([3241], { ci: 'failure', finishedAt: '2026-11-10 17:00:00', progress: progress(40, 3) }))).toBeNull();
	});
});
