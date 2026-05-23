export class GitHubError extends Error {
	constructor(
		public status: number,
		message: string,
		public body?: { message?: string; sha?: string; [k: string]: unknown }
	) {
		super(message);
	}
}

function isBadCredentials(e: unknown): e is GitHubError {
	return (
		e instanceof GitHubError && (e.status === 401 || e.body?.message === 'Bad credentials')
	);
}

// One-retry-on-401 wrapper. Load-bearing: a cached installation token can be
// rejected mid-life (key rotation, revocation, or a malformed expires_at that
// caches it effectively forever). Without this retry, every subsequent call
// would fail until the process restarts. Exactly one retry — no loops.
export async function withTokenRefreshOn401<T>(
	getToken: () => Promise<string>,
	invalidate: () => void,
	call: (token: string) => Promise<T>
): Promise<T> {
	const token = await getToken();
	try {
		return await call(token);
	} catch (e) {
		if (!isBadCredentials(e)) throw e;
		invalidate();
		const fresh = await getToken();
		return await call(fresh);
	}
}
