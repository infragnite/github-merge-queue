<script lang="ts">
	import type { RunSlot } from '$lib/run-order';

	// The queue's own work: forming a batch, preparing a bisection step, landing, or the step of it that failed.
	let { slot }: { slot: RunSlot } = $props();
	const failed = $derived(slot.state === 'failed');
</script>

<div class="rounded-xl border px-3 py-2 text-sm {failed ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50/60'}" role={failed ? 'alert' : undefined}>
	<div class="flex min-w-0 flex-wrap items-center gap-2">
		<span class="inline-block h-2 w-2 shrink-0 rounded-full {failed ? 'bg-red-500' : 'bg-amber-400 motion-safe:animate-pulse'}" aria-hidden="true"></span>
		<span class="font-medium {failed ? 'text-red-800' : 'text-gray-900'}">{slot.label}</span>
		{#if slot.prs.length}<span class="min-w-0 truncate text-xs text-gray-500">{slot.prs.map((n) => `#${n}`).join(' ')}</span>{/if}
	</div>
	{#if slot.detail}<p class="mt-0.5 break-words pl-4 text-xs tabular-nums {failed ? 'font-mono text-red-700' : 'text-gray-600'}">{slot.detail}</p>{/if}
</div>
