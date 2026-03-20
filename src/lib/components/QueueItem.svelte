<script lang="ts">
	import { enhance } from '$app/forms';
	import StatusBadge from './StatusBadge.svelte';
	import type { QueueItem } from '$lib/types';

	let {
		item,
		position,
		repoOwner,
		repoName
	}: { item: QueueItem; position: number; repoOwner: string; repoName: string } = $props();

	const isActive = $derived(['updating', 'checking', 'merging'].includes(item.status));
	const canRemove = $derived(!['merging', 'merged'].includes(item.status));
</script>

<div
	class="rounded-xl border bg-surface-raised p-4 transition-all {isActive
		? 'border-indigo-200 shadow-sm'
		: 'border-border-subtle'}"
>
	<div class="flex items-start gap-4">
		<!-- Position -->
		<div
			class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold {isActive
				? 'bg-indigo-100 text-indigo-700'
				: 'bg-gray-100 text-gray-500'}"
		>
			{position}
		</div>

		<!-- PR Info -->
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-2">
				<a
					href={item.pr_url}
					target="_blank"
					rel="noopener"
					class="font-semibold text-gray-900 hover:text-indigo-600"
				>
					#{item.pr_number}
				</a>
				<StatusBadge status={item.status} />
			</div>
			<p class="mt-0.5 truncate text-sm text-gray-600">{item.pr_title}</p>

			<div class="mt-2 flex items-center gap-3 text-xs text-gray-400">
				{#if item.author_avatar}
					<div class="flex items-center gap-1.5">
						<img src={item.author_avatar} alt="" class="h-4 w-4 rounded-full" />
						<span>{item.author_login}</span>
					</div>
				{/if}
				<span>Queued by {item.queued_by}</span>
				{#if item.started_at}
					<span>&middot; Started {new Date(item.started_at + 'Z').toLocaleTimeString()}</span>
				{/if}
			</div>

			{#if item.error_message}
				<div class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
					{item.error_message}
				</div>
			{/if}
		</div>

		<!-- Actions -->
		{#if canRemove}
			<form method="POST" action="/repos/{repoOwner}/{repoName}?/removeFromQueue" use:enhance>
				<input type="hidden" name="item_id" value={item.id} />
				<button
					type="submit"
					class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
					title="Remove from queue"
				>
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</form>
		{/if}
	</div>
</div>
