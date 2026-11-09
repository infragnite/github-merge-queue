// Stand-in for SvelteKit's `$env/dynamic/private` under vitest.
export const env: Record<string, string | undefined> = process.env;
