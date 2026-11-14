// A watchdog thread that says what blocks the server. The queue runs on one event loop: while
// something synchronous runs on it (a git child process, a long loop), no request is answered and
// no tick runs, and the server can't log anything itself. A worker thread keeps running then: it
// watches a heartbeat the main thread writes into shared memory, and when it stops for `stallMs`
// it logs how long, what the queue last said it was doing, the main thread's JavaScript stack
// (paused through the inspector) and the processes the server started, straight to file
// descriptor 2 (a worker's `console` goes through the blocked main thread).

import * as nodeFs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { log } from './log';

export interface StallChild {
	pid: number;
	/** 1 for a child of the server, 2 for its child, and so on. */
	depth: number;
	args: string;
}

export interface Stall {
	blockedMs: number;
	doing: string | null;
	/** The main thread's frames, innermost first, or null when it could not be paused. */
	stack: string[] | null;
	children: StallChild[];
}

/** The report, one `[stall]` line per fact. No free variables: the worker runs its source. */
export function formatStall(s: Stall): string {
	const lines = [`[stall] main thread blocked for ${Math.floor(s.blockedMs / 1000)} s`, `[stall] doing: ${s.doing ?? 'nothing recorded'}`];
	if (s.stack && s.stack.length) s.stack.forEach((f, i) => lines.push(i === 0 ? `[stall] at ${f}` : `[stall]    ${f}`));
	else lines.push('[stall] at: stack not captured (the main thread is inside a native call, such as a synchronous child process)');
	if (s.children.length === 0) lines.push('[stall] no child processes');
	for (const c of s.children) lines.push(`[stall] ${'  '.repeat(c.depth - 1)}child ${c.pid}: ${c.args}`);
	return lines.join('\n');
}

/** Credentials out of a command line. No free variables (see `formatStall`). */
export function redactArgs(text: string): string {
	return text
		.replace(/(x-access-token:)[^@\s]+/gi, '$1***')
		.replace(/(Authorization:\s*\w+\s+)\S+/gi, '$1***')
		.replace(/\bgh[opsu]_[A-Za-z0-9]{20,}/g, '***');
}

/**
 * The descendants of `pid`, read from `/proc` (Linux), each parent before its children. Takes its
 * helpers as arguments, with no free variables, so the worker can run this same source.
 */
export function childProcesses(
	pid: number,
	procRoot = '/proc',
	fs: Pick<typeof nodeFs, 'readdirSync' | 'readFileSync'> = nodeFs,
	redact: (s: string) => string = redactArgs
): StallChild[] {
	const out: StallChild[] = [];
	const childrenOf = (p: number): number[] => {
		const kids: number[] = [];
		let tasks: string[] = [];
		try {
			tasks = fs.readdirSync(`${procRoot}/${p}/task`) as string[];
		} catch {
			return kids;
		}
		for (const t of tasks) {
			try {
				for (const k of String(fs.readFileSync(`${procRoot}/${p}/task/${t}/children`, 'utf8')).split(/\s+/)) if (k) kids.push(Number(k));
			} catch {
				// a thread that ended meanwhile
			}
		}
		return kids;
	};
	const visit = (p: number, depth: number) => {
		if (depth > 8) return;
		for (const k of childrenOf(p)) {
			let args: string;
			try {
				args = String(fs.readFileSync(`${procRoot}/${k}/cmdline`, 'utf8')).split('\0').filter(Boolean).join(' ');
			} catch {
				continue; // gone
			}
			out.push({ pid: k, depth, args: redact(args) });
			visit(k, depth + 1);
		}
	};
	visit(pid, 1);
	return out;
}

// Shared memory: [0, 8) the heartbeat (epoch ms, float64), [8, 12) the length of `doing` in
// bytes, [16, 16 + DOING_BYTES) its UTF-8 bytes.
const DOING_BYTES = 2048;
const shared = new SharedArrayBuffer(16 + DOING_BYTES);
const heartbeat = new Float64Array(shared, 0, 1);
const doingLength = new Int32Array(shared, 8, 1);
const doingBytes = new Uint8Array(shared, 16, DOING_BYTES);
const encoder = new TextEncoder();
const scopes: string[] = [];

function publish() {
	const text = scopes.join(' · ');
	const bytes = encoder.encode(text).subarray(0, DOING_BYTES);
	doingBytes.set(bytes);
	Atomics.store(doingLength, 0, bytes.length);
}

/** What the server does now, as the stall report will say it; null for nothing. Replaces every scope. */
export function doing(label: string | null) {
	scopes.length = 0;
	if (label) scopes.push(label);
	publish();
}

export function currentDoing(): string | null {
	return scopes.length ? scopes.join(' · ') : null;
}

/** Runs `fn` with `label` added to what the server is doing, until it returns or its promise settles. */
export function withDoing<T>(label: string, fn: () => T): T {
	scopes.push(label);
	publish();
	const end = () => {
		const i = scopes.lastIndexOf(label);
		if (i >= 0) scopes.splice(i, 1);
		publish();
	};
	let r: T;
	try {
		r = fn();
	} catch (e) {
		end();
		throw e;
	}
	if (r instanceof Promise) return r.finally(end) as T;
	end();
	return r;
}

const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const inspector = require('node:inspector');
const formatStall = (${formatStall.toString()});
const redactArgs = (${redactArgs.toString()});
const childProcesses = (${childProcesses.toString()});
const { shared, pid, stallMs, checkMs, repeatMs, logFile, stderr, cwd } = workerData;
const heartbeat = new Float64Array(shared, 0, 1);
const doingLength = new Int32Array(shared, 8, 1);
const doingBytes = new Uint8Array(shared, 16, ${DOING_BYTES});
const decoder = new TextDecoder();
function write(text) {
	if (stderr) { try { fs.writeSync(2, text + '\\n'); } catch {} }
	if (logFile) { try { fs.appendFileSync(logFile, text + '\\n'); } catch {} }
}
const scripts = new Map();
function frame(f) {
	let url = f.url || scripts.get(f.location.scriptId) || '';
	if (url.startsWith('file://')) url = url.slice(7);
	if (cwd && url.startsWith(cwd + '/')) url = url.slice(cwd.length + 1);
	return (f.functionName || '(anonymous)') + ' (' + (url || '?') + ':' + (f.location.lineNumber + 1) + ')';
}
let session = null;
function captureStack(done) {
	try {
		session = new inspector.Session();
		session.connectToMainThread();
	} catch (e) { session = null; return done(null); }
	let finished = false;
	const finish = (stack) => {
		if (finished) return;
		finished = true;
		try { session.post('Debugger.resume'); } catch {}
		try { session.post('Debugger.disable'); } catch {}
		try { session.disconnect(); } catch {}
		session = null;
		done(stack);
	};
	session.on('Debugger.scriptParsed', (m) => { if (m.params.url) scripts.set(m.params.scriptId, m.params.url); });
	session.once('Debugger.paused', (m) => finish(m.params.callFrames.slice(0, 15).map(frame)));
	session.post('Debugger.enable', () => session && session.post('Debugger.pause'));
	setTimeout(() => finish(null), 2000);
}
let stalledSince = 0;
let lastReport = 0;
let capturing = false;
setInterval(() => {
	const age = Date.now() - heartbeat[0];
	if (age < stallMs) {
		if (stalledSince) write('[stall] main thread free again after ' + Math.round((Date.now() - stalledSince) / 1000) + ' s');
		stalledSince = 0;
		return;
	}
	if (capturing || (stalledSince && Date.now() - lastReport < repeatMs)) return;
	if (!stalledSince) stalledSince = heartbeat[0];
	lastReport = Date.now();
	const n = Atomics.load(doingLength, 0);
	const doing = n ? decoder.decode(doingBytes.slice(0, n)) : null;
	const children = childProcesses(pid, '/proc', fs, redactArgs);
	capturing = true;
	captureStack((stack) => {
		capturing = false;
		write(formatStall({ blockedMs: age, doing, stack, children }));
	});
}, checkMs);
`;

let worker: Worker | null = null;
let beat: ReturnType<typeof setInterval> | null = null;

export interface StallWatchOptions {
	/** How long without a heartbeat counts as blocked. */
	stallMs?: number;
	checkMs?: number;
	/** While still blocked, report again this often. */
	repeatMs?: number;
	/** Also append reports to this file. */
	logFile?: string;
	/** Write reports to file descriptor 2 (default true). */
	stderr?: boolean;
}

/** Starts the watchdog thread (once). */
export function startStallWatch(opts: StallWatchOptions = {}) {
	if (worker) return;
	const checkMs = opts.checkMs ?? 1_000;
	Atomics.store(new Int32Array(shared, 8, 1), 0, Atomics.load(doingLength, 0));
	heartbeat[0] = Date.now();
	beat = setInterval(() => (heartbeat[0] = Date.now()), Math.max(50, Math.floor(checkMs / 2)));
	beat.unref();
	worker = new Worker(WORKER_SOURCE, {
		eval: true,
		workerData: {
			shared,
			pid: process.pid,
			stallMs: opts.stallMs ?? 20_000,
			checkMs,
			repeatMs: opts.repeatMs ?? 60_000,
			logFile: opts.logFile ?? null,
			stderr: opts.stderr ?? true,
			cwd: process.cwd()
		}
	});
	worker.on('error', (err) => log.error('the stall watchdog thread stopped', { err }));
	worker.unref();
}

export async function stopStallWatch() {
	if (beat) clearInterval(beat);
	beat = null;
	const w = worker;
	worker = null;
	if (w) await w.terminate();
}
