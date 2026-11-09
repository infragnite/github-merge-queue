<script lang="ts">
	import { enhance } from '$app/forms';
	import StatusBadge from './StatusBadge.svelte';
	import type { QueueItem } from '$lib/types';

	let {
		item,
		position,
		repoOwner,
		repoName,
		reorderable,
		batchMode
	}: { item: QueueItem; position: number; repoOwner: string; repoName: string; reorderable: boolean; batchMode: boolean } = $props();

	const isActive = $derived(['updating', 'checking', 'merging'].includes(item.status));
	const canRemove = $derived(!['merging', 'merged'].includes(item.status));
	const action = (name: string) => `/repos/${repoOwner}/${repoName}?/${name}`;
</script>

<div
	class="flex min-w-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-sm last:border-b-0 {isActive
		? 'bg-indigo-50/40'
		: item.status === 'conflict'
			? 'bg-orange-50/50'
			: ''}"
>
	{#if reorderable}
		<span class="shrink-0 cursor-grab text-gray-300 hover:text-gray-500 active:cursor-grabbing" title="Drag to reorder" aria-hidden="true">
			<svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
				<circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
				<circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
				<circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
			</svg>
		</span>
		<span class="w-6 shrink-0 text-right text-xs tabular-nums text-gray-400">{position}</span>
	{/if}
	<a href={item.pr_url} target="_blank" rel="noopener" class="shrink-0 font-medium text-gray-900 hover:text-indigo-600">#{item.pr_number}</a>
	<div class="min-w-0 flex-1">
		<p class="truncate text-gray-700" title={item.pr_title}>{item.pr_title}</p>
		{#if item.status === 'conflict'}
			<p class="truncate text-xs text-orange-700">
				Merge conflicts:
				{#if item.author_login === 'dependabot[bot]'}
					<a href={item.pr_url} target="_blank" rel="noopener" class="underline">comment <code>@dependabot recreate</code></a>
				{:else}
					<a href="{item.pr_url}/conflicts" target="_blank" rel="noopener" class="underline">resolve on GitHub</a>
				{/if}; retried automatically
			</p>
		{:else if item.error_message}
			<p class="truncate text-xs text-red-700" title={item.error_message}>{item.error_message}</p>
		{/if}
	</div>
	<span class="hidden shrink-0 text-xs text-gray-400 sm:inline">{item.author_login}</span>
	<StatusBadge status={item.status} />
	{#if batchMode && (item.status === 'queued' || item.status === 'conflict')}
		<form method="POST" action={action('setPriority')} use:enhance class="shrink-0">
			<input type="hidden" name="pr_number" value={item.pr_number} />
			<select
				name="priority"
				value={item.priority ?? 'normal'}
				onchange={(e) => e.currentTarget.form?.requestSubmit()}
				class="rounded border border-border-subtle bg-transparent py-0.5 pl-1 pr-6 text-xs {item.priority === 'urgent' ? 'text-red-700' : item.priority === 'low' ? 'text-gray-400' : 'text-gray-600'}"
				aria-label="Priority of #{item.pr_number}"
			>
				<option value="urgent">urgent</option>
				<option value="normal">normal</option>
				<option value="low">low</option>
			</select>
		</form>
	{/if}
	<div class="flex shrink-0 items-center">
		{#if item.status === 'failed'}
			<form method="POST" action={action('retry')} use:enhance>
				<input type="hidden" name="item_id" value={item.id} />
				<button type="submit" class="rounded p-1 text-gray-400 hover:bg-indigo-50 hover:text-indigo-600" title="Retry" aria-label="Retry #{item.pr_number}">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
					</svg>
				</button>
			</form>
		{/if}
		{#if canRemove}
			<form method="POST" action={action('removeFromQueue')} use:enhance>
				<input type="hidden" name="item_id" value={item.id} />
				<button type="submit" class="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Remove from queue" aria-label="Remove #{item.pr_number} from the queue">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</form>
		{/if}
	</div>
</div>
