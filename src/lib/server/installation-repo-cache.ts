type InstallationRepo = { full_name: string; default_branch: string };

/** Event bursts refresh summaries, not the App's installation listing on every hint. */
export function installationRepoCache(load: () => Promise<InstallationRepo[]>, now: () => number = Date.now) {
	let cached: { until: number; value: Promise<InstallationRepo[]> } | null = null;
	return () => {
		if (!cached || cached.until <= now()) {
			// Share in-flight requests and brief failures too, so an outage cannot cause a retry storm.
			cached = { until: now() + 30_000, value: Promise.resolve().then(load) };
		}
		return cached.value;
	};
}
