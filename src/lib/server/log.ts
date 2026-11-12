// Structured log lines: one JSON object per line on stdout (stderr for warnings and errors). On
// the dev server Alloy ships the container's output to Loki, where `| json` turns the fields into
// labels to filter on: repo, pr, batch, event, delivery. LOG_FORMAT=text reads better locally,
// LOG_LEVEL (debug, info, warn, error, silent) drops what is below it.

import { GitHubError } from './github-retry';

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;
type Sink = (level: Level, line: string) => void;

const RANK: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const stdSink: Sink = (level, line) => (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
let sink: Sink = stdSink;
let threshold = RANK[(process.env.LOG_LEVEL as Level | 'silent') ?? 'info'] ?? RANK.info;
let format: 'json' | 'text' = process.env.LOG_FORMAT === 'text' ? 'text' : 'json';

/** For tests: every line goes to `s`, whatever LOG_LEVEL says; null puts stdout back. */
export function setLogSink(s: Sink | null) {
	sink = s ?? stdSink;
	threshold = s ? RANK.debug : (RANK[(process.env.LOG_LEVEL as Level | 'silent') ?? 'info'] ?? RANK.info);
}

export function setLogFormat(f: 'json' | 'text') {
	format = f;
}

/** What an error says, for a log line: its message, and for GitHub its HTTP status and request id. */
export function errorFields(err: unknown): Fields {
	if (err instanceof GitHubError) return { message: err.message, status: err.status, ...(err.requestId ? { request_id: err.requestId } : {}) };
	if (err instanceof Error) return { message: err.message };
	return { message: String(err) };
}

function clean(fields: Fields): Fields {
	const out: Fields = {};
	for (const [k, v] of Object.entries(fields)) {
		if (v === undefined) continue;
		out[k] = v instanceof Error || k === 'err' ? errorFields(v) : v;
	}
	return out;
}

function text(v: unknown): string {
	const s = typeof v === 'string' ? v : JSON.stringify(v);
	return /\s/.test(s) ? JSON.stringify(s) : s;
}

function write(level: Level, msg: string, fields: Fields = {}) {
	if (RANK[level] < threshold) return;
	const time = new Date().toISOString();
	const rest = clean(fields);
	const line =
		format === 'json'
			? JSON.stringify({ time, level, msg, ...rest })
			: [time, level, msg, ...Object.entries(rest).map(([k, v]) => `${k}=${text(v)}`)].join(' ');
	try {
		sink(level, line);
	} catch {
		// A broken stdout must not take the queue down with it.
	}
}

export const log = {
	debug: (msg: string, fields?: Fields) => write('debug', msg, fields),
	info: (msg: string, fields?: Fields) => write('info', msg, fields),
	warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
	error: (msg: string, fields?: Fields) => write('error', msg, fields)
};
