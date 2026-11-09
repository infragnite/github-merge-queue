import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Liveness probe: answers as long as the event loop is free. */
export const GET: RequestHandler = () => json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
