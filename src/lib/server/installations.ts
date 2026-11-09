/**
 * The App's installations: one per account (an org or a user) it is installed on, each with its
 * own token. A repository's calls use the token of the installation on its owner, so repositories
 * of several accounts (e.g. infragnite/* and qnox/*) can be managed side by side.
 */

export interface InstallationApi {
	/** Every installation of the App (authenticated as the App itself). */
	listInstallations(): Promise<Array<{ id: number; account: { login: string } | null }>>;
	createToken(installationId: number): Promise<{ token: string; expires_at: string }>;
}

/** The account a REST path acts on (`/repos/{owner}/…`, `/orgs/{org}/…`), or null for one that names none. */
export function ownerOfPath(path: string): string | null {
	const m = /^\/(?:repos|orgs)\/([^/?#]+)/.exec(path);
	return m ? decodeURIComponent(m[1]) : null;
}

/** How long an account the App is not installed on is remembered as such, before asking GitHub again. */
const MISS_REFRESH_MS = 60_000;

export class Installations {
	private byOwner = new Map<string, number>();
	private loadedAt: number | null = null;
	private tokens = new Map<number, { token: string; expiresAt: number }>();

	constructor(
		private readonly api: InstallationApi,
		private readonly now: () => number = Date.now
	) {}

	/** Installation ids, freshly listed. */
	async ids(): Promise<number[]> {
		await this.load();
		return [...new Set(this.byOwner.values())];
	}

	/** The installation on [owner]; an account the App is not installed on is an error, not another account's token. */
	async idFor(owner: string): Promise<number> {
		const key = owner.toLowerCase();
		const known = this.byOwner.get(key);
		if (known !== undefined) return known;
		if (this.loadedAt === null || this.now() - this.loadedAt >= MISS_REFRESH_MS) {
			await this.load();
			const found = this.byOwner.get(key);
			if (found !== undefined) return found;
		}
		throw new Error(`The merge queue GitHub App is not installed on ${owner}`);
	}

	async token(installationId: number): Promise<string> {
		const cached = this.tokens.get(installationId);
		if (cached && cached.expiresAt > this.now() + 60_000) return cached.token;
		const data = await this.api.createToken(installationId);
		this.tokens.set(installationId, { token: data.token, expiresAt: new Date(data.expires_at).getTime() });
		return data.token;
	}

	/** Drops a token GitHub rejected, so the next call mints a fresh one. */
	forget(installationId: number) {
		this.tokens.delete(installationId);
	}

	private async load() {
		const list = await this.api.listInstallations();
		this.byOwner = new Map(
			list.filter((i) => i.account).map((i) => [i.account!.login.toLowerCase(), i.id] as const)
		);
		this.loadedAt = this.now();
	}
}
