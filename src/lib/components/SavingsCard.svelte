<script lang="ts">
	import type { SavingsView } from '$lib/server/ci-savings';

	// CI time saved by batching over the last 30 days, as a few words in the page subtitle; how
	// it is counted on hover.
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
</script>

<span class="whitespace-nowrap text-xs text-gray-500" title={how}>
	{#if !perRun || !w}
		CI savings: measuring
	{:else if w.landed === 0}
		CI savings: nothing landed in 30 days
	{:else if w.savedMs >= 0}
		saved <span class="font-medium tabular-nums text-green-700">{fmt(w.savedMs)}</span> of CI in 30 days
	{:else}
		<span class="font-medium tabular-nums text-amber-700">{fmt(w.savedMs)}</span> more CI than one by one, 30 days
	{/if}
</span>
