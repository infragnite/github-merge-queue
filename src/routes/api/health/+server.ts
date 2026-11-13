import { json } from '@sveltejs/kit';
import { processorProblem } from '$lib/server/processor';
import type { RequestHandler } from './$types';

/**
 * Liveness probe: answers while the event loop is free, and fails (503) when the queue's
 * processor stopped finishing cycles, so a container health check can restart a hung queue.
 */
export const GET: RequestHandler = () => {
	const problem = processorProblem();
	const body = { ok: problem === null, uptimeSeconds: Math.round(process.uptime()), ...(problem ? { problem } : {}) };
	return json(body, { status: problem ? 503 : 200 });
};
