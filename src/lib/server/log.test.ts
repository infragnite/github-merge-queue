import { afterEach, describe, expect, test } from 'vitest';
import { log, setLogSink, setLogFormat } from './log';
import { GitHubError } from './github-retry';

const lines: Array<{ level: string; line: string }> = [];
const capture = () => setLogSink((level, line) => lines.push({ level, line }));
afterEach(() => {
	lines.length = 0;
	setLogSink(null);
	setLogFormat('json');
});

describe('structured log lines (one JSON object per line, for Loki)', () => {
	test('time, level, message and the fields that say where it happened', () => {
		capture();
		log.info('batch started', { repo: 'acme/repo', batch: 12, prs: [1, 2] });
		expect(lines).toHaveLength(1);
		const rec = JSON.parse(lines[0].line);
		expect(rec).toMatchObject({ level: 'info', msg: 'batch started', repo: 'acme/repo', batch: 12, prs: [1, 2] });
		expect(Date.parse(rec.time)).not.toBeNaN();
		expect(lines[0].line).not.toContain('\n');
	});

	test('fields left undefined are left out', () => {
		capture();
		log.warn('x', { repo: 'a/b', pr: undefined });
		expect(JSON.parse(lines[0].line)).not.toHaveProperty('pr');
		expect(lines[0].level).toBe('warn');
	});

	test('an error keeps its message, and a GitHub error its HTTP status and request id', () => {
		capture();
		log.error('tick failed', { err: new GitHubError(502, 'Bad Gateway', {}, 'ABCD:1234') });
		log.error('tick failed', { err: new Error('git failed') });
		log.error('tick failed', { err: 'just text' });
		const [gh, plain, text] = lines.map((l) => JSON.parse(l.line).err);
		expect(gh).toEqual({ message: 'Bad Gateway', status: 502, request_id: 'ABCD:1234' });
		expect(plain).toEqual({ message: 'git failed' });
		expect(text).toEqual({ message: 'just text' });
	});

	test('text format for reading locally', () => {
		capture();
		setLogFormat('text');
		log.info('batch started', { repo: 'acme/repo', batch: 12 });
		expect(lines[0].line).toMatch(/^\S+ info batch started repo=acme\/repo batch=12$/);
	});
});
