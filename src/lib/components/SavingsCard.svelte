<script lang="ts">
	import type { SavingsView } from '$lib/server/ci-savings';

	// CI time saved by batching over the last 30 days, in one line; how it is counted on hover.
	let { savings }: { savings: SavingsView } = $props();

	const w = $derived(savings.windows.find((x) => x.key === '30d') ?? null);

	const fmt = (ms: number) => {
		const min = Math.abs(ms) / 60_000;
		if (min < 60) return `${Math.round(min)} min`;
		const h = min / 60;
		return `${h < 100 ? h.toFixed(1) : Math.round(h)} h`;
	};
	const perRun = $derived(savings.perRun);
	const how = $derived(
		perRun && w
			? [
					`Last 30 days: ${w.landed} PRs landed in ${w.runs} CI runs, ${fmt(w.spentMs)} of CI jobs against ${fmt(w.aloneMs)} to run each PR on its own.`,
					`One by one they would have kept CI busy for ${fmt(w.aloneWallMs)} back to back.`,
					`A PR on its own costs the typical queue run: ${fmt(perRun.jobMs)} of CI jobs, the median of ${perRun.samples} ${perRun.single ? 'runs of a single PR' : 'finished runs'}.`
				].join('\n')
			: 'No finished queue run has been timed yet.'
	);
	const less = $derived(w && w.aloneMs > 0 ? Math.round((1 - w.spentMs / w.aloneMs) * 100) : null);
</script>

<p class="inline-flex items-baseline gap-1.5 whitespace-nowrap rounded-lg border border-border-subtle bg-surface-raised px-2.5 py-1 text-xs text-gray-500" title={how}>
	<span>CI saved, 30 days</span>
	{#if !perRun || !w}
		<span class="text-gray-400">measuring</span>
	{:else if w.landed === 0}
		<span class="text-gray-400">nothing landed</span>
	{:else}
		<span class="text-sm font-semibold tabular-nums {w.savedMs >= 0 ? 'text-green-700' : 'text-amber-700'}">{w.savedMs >= 0 ? fmt(w.savedMs) : `−${fmt(w.savedMs)}`}</span>
		{#if less !== null}<span class="tabular-nums">{less}% less</span>{/if}
	{/if}
</p>
