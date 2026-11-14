<script lang="ts">
	import GitHubRefs from './GitHubRefs.svelte';
	import type { RunSlot } from '$lib/run-order';

	// The queue's own work: forming a batch, preparing a bisection step, landing, or the step of it
	// that failed. A row, not a card: it holds no runner yet. `inWell`: drawn inside a batch card.
	let { slot, owner, name, commits = [], inWell = false }: { slot: RunSlot; owner: string; name: string; commits?: string[]; inWell?: boolean } = $props();
	const failed = $derived(slot.state === 'failed');
</script>

<div
	class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm {inWell ? 'px-3 py-2' : `rounded-lg border border-dashed px-3 py-2 ${failed ? 'border-red-300 bg-red-50/50' : 'border-gray-300'}`}"
	role={failed ? 'alert' : 'status'}
>
	{#if failed}
		<svg class="h-3.5 w-3.5 shrink-0 text-red-600" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.5h1.5v4.5h-1.5V4.5zm0 6h1.5V12h-1.5v-1.5z" /></svg>
	{:else}
		<svg class="h-3.5 w-3.5 shrink-0 text-amber-500 motion-safe:animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-opacity=".25" stroke-width="2" /><path d="M14 8a6 6 0 00-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
	{/if}
	<span class="font-medium {failed ? 'text-red-800' : 'text-gray-900'}"><GitHubRefs text={slot.label} {owner} {name} {commits} /></span>
	{#if slot.prs.length}<span class="font-mono text-xs text-gray-500" title={slot.prs.map((n) => `#${n}`).join(' ')}>{#each slot.prs.slice(0, 6) as pr, i}{i > 0 ? ' ' : ''}<a href="https://github.com/{owner}/{name}/pull/{pr}" target="_blank" rel="noopener" class="hover:text-indigo-600 hover:underline">#{pr}</a>{/each}{slot.prs.length > 6 ? ` +${slot.prs.length - 6}` : ''}</span>{/if}
	{#if slot.detail}<span class="min-w-0 basis-full break-words pl-5.5 text-xs tabular-nums sm:basis-auto sm:pl-0 {failed ? 'font-mono text-red-700' : 'text-gray-500'}"><span class="hidden text-gray-300 sm:inline" aria-hidden="true">· </span><GitHubRefs text={slot.detail} {owner} {name} {commits} /></span>{/if}
</div>
