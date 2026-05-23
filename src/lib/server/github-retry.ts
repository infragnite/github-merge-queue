export class GitHubError extends Error {
	constructor(
		public status: number,
		message: string,
		public body?: { message?: string; sha?: string; [k: string]: unknown }
	) {
		super(message);
	}
}

// Treats both a 401 status and `body.message === "Bad credentials"` as a
// signal to refresh. GitHub typically returns 401 for revoked installation
// tokens, but has also been observed returning 403 with the same body
// message in some edge cases — both should trigger a single retry.
function isBadCredentials(e: unknown): e is GitHubError {
	return (
		e instanceof GitHubError && (e.status === 401 || e.body?.message === 'Bad credentials')
	);
}

// One-retry-on-401 wrapper. Load-bearing: a cached installation token can be
// rejected mid-life (key rotation, revocation, or a malformed expires_at that
// caches it effectively forever). Without this retry, every subsequent call
// would fail until the process restarts. Exactly one retry — no loops.
export type MergeResult = {
	merged: boolean;
	sha: string | null;
	message: string | undefined;
};

export function mergeResultFromData(data: {
	merged?: unknown;
	sha?: unknown;
	message?: unknown;
}): MergeResult {
	return {
		merged: !!data.merged,
		sha: typeof data.sha === 'string' ? data.sha : null,
		message: typeof data.message === 'string' ? data.message : undefined
	};
}

// Translates a failed merge attempt into a structured result. Only
// `GitHubError` (HTTP non-2xx with parsed body) maps to a failed merge —
// network errors, JSON parse failures, etc. are re-thrown so callers can
// distinguish "GitHub said no" from "we couldn't reach GitHub".
export function mergeResultFromError(e: unknown): MergeResult {
	if (!(e instanceof GitHubError)) throw e;
	return { merged: false, sha: null, message: e.message };
}

export async function withTokenRefreshOn401<T>(
	getToken: () => Promise<string>,
	invalidate: () => void,
	call: (token: string) => Promise<T>
): Promise<T> {
	const token = await getToken();
	let original: unknown;
	try {
		return await call(token);
	} catch (e) {
		if (!isBadCredentials(e)) throw e;
		original = e;
	}
	invalidate();
	let fresh: string;
	try {
		fresh = await getToken();
	} catch (refreshError) {
		// Refresh failed (e.g. JWT mint error). Surface the refresh error but
		// preserve the original 401 as `cause` for diagnosability.
		(refreshError as Error).cause = original;
		throw refreshError;
	}
	return await call(fresh);
}
