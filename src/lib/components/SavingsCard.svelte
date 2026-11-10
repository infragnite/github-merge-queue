<script lang="ts">
	import type { SavingsView } from '$lib/server/ci-savings';

	let { savings }: { savings: SavingsView } = $props();

	let key = $state('7d');
	const w = $derived(savings.windows.find((x) => x.key === key) ?? savings.windows[0]);

	const fmt = (ms: number) => {
		const min = Math.abs(ms) / 60_000;
		if (min < 60) return `${Math.round(min)} min`;
		const h = min / 60;
		return `${h < 100 ? h.toFixed(1) : Math.round(h)} h`;
	};
	const overhead = $derived(
		w
			? [
					['bisection', w.overhead.bisectMs],
					['re-runs of failed jobs', w.overhead.rerunMs],
					['rebuilt or cancelled batches', w.overhead.wastedMs],
					['tries and checks of the default branch', w.overhead.baselineMs]
				].filter(([, ms]) => (ms as number) >= 60_000) as Array<[string, number]>
			: []
	);
	const perRun = $derived(savings.perRun);
	const how = $derived(
		perRun
			? `A PR on its own costs the typical queue run: ${fmt(perRun.jobMs)} of CI jobs (${fmt(perRun.wallMs)} start to finish), the median of ${perRun.samples} ${perRun.single ? 'runs of a single PR' : 'finished runs'}. Re-runs of failed jobs are left out of it.`
			: ''
	);
</script>

<section class="rounded-xl border border-border-subtle bg-surface-raised px-4 py-3" aria-labelledby="saved">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 id="saved" class="text-sm font-semibold text-gray-900">CI time saved by batching</h2>
		<div class="flex overflow-hidden rounded-md border border-border-subtle text-xs" role="group" aria-label="Period">
			{#each savings.windows as x (x.key)}
				<button
					type="button"
					onclick={() => (key = x.key)}
					aria-pressed={key === x.key}
					title={x.label}
					class="px-2 py-0.5 {key === x.key ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-surface-sunken'}"
				>{x.key === 'all' ? 'All' : x.key}</button>
			{/each}
		</div>
	</div>
	{#if !perRun}
		<p class="mt-1 text-sm text-gray-500">Measuring: no finished queue run has been timed yet.</p>
	{:else if w.landed === 0}
		<p class="mt-1 text-sm text-gray-500">No PR landed through batches in this period{w.runs ? `; the queue's ${w.runs} runs took ${fmt(w.spentMs)} of CI` : ''}.</p>
	{:else}
		<div class="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
			<p class="text-2xl font-semibold tabular-nums {w.savedMs >= 0 ? 'text-green-700' : 'text-amber-700'}" title={how}>
				{w.savedMs >= 0 ? `${fmt(w.savedMs)} saved` : `${fmt(w.savedMs)} more`}
			</p>
			<p class="text-sm text-gray-600">
				{w.landed} PRs landed in {w.runs} CI runs instead of {w.landed}: {fmt(w.spentMs)} of CI jobs, against {fmt(w.aloneMs)} to run each PR on its own{w.aloneMs > 0 ? ` (${Math.round((1 - w.spentMs / w.aloneMs) * 100)}% less)` : ''}.
			</p>
		</div>
		<p class="mt-1 text-xs text-gray-500">
			One by one, those PRs would have kept CI busy for {fmt(w.aloneWallMs)} back to back.
			{#if overhead.length}The queue's time includes {overhead.map(([what, ms]) => `${fmt(ms)} of ${what}`).join(', ')}.{/if}
			<span class="underline decoration-dotted" title={how}>How it's counted</span>
		</p>
	{/if}
</section>
