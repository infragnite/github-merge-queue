/**
 * Where to send the user after signing in: a path on this site, or null. Browsers drop tabs and
 * newlines and read a backslash as a slash, so `/\t/evil.com` or `/\\evil.com` would leave the
 * site; anything with whitespace, control characters or a backslash is refused, and what is left
 * must resolve to this site's origin.
 */
export function safeNext(next: string | null | undefined, appUrl: string | undefined): string | null {
	if (!next || next.length > 512 || !next.startsWith('/') || next.startsWith('//') || /[\x00-\x20\x7f\\]/.test(next)) return null;
	try {
		const base = new URL(appUrl || 'http://localhost:3000');
		const u = new URL(next, base);
		if (u.origin !== base.origin) return null;
		return u.pathname + u.search;
	} catch {
		return null;
	}
}
