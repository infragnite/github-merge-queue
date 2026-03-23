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
		: item.status === 'conflict'
			? 'border-orange-200 shadow-sm'
			: 'border-border-subtle'}"
>
	<div class="flex items-start gap-4">
		<!-- Drag handle -->
		<div class="flex shrink-0 cursor-grab items-center text-gray-300 hover:text-gray-500 active:cursor-grabbing" title="Drag to reorder">
			<svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
				<circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
				<circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
				<circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
			</svg>
		</div>

		<!-- Position -->
		<div
			class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold {isActive
				? 'bg-indigo-100 text-indigo-700'
				: item.status === 'conflict'
					? 'bg-orange-100 text-orange-700'
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

			{#if item.status === 'conflict'}
				<div class="mt-2 flex items-center gap-2 rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-700">
					<svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
					</svg>
					{#if item.author_login === 'dependabot[bot]'}
					<span>Merge conflicts.</span>
					<a
						href={item.pr_url}
						target="_blank"
						rel="noopener"
						class="font-medium underline hover:text-orange-900"
					>Comment <code>@dependabot recreate</code> on the PR</a>
				{:else}
					<span>Merge conflicts.</span>
					<a
						href="{item.pr_url}/conflicts"
						target="_blank"
						rel="noopener"
						class="font-medium underline hover:text-orange-900"
					>Resolve on GitHub</a>
				{/if}
				<span class="text-orange-400">&middot; Will retry automatically</span>
				</div>
			{:else if item.error_message}
				<div class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
					{item.error_message}
				</div>
			{/if}
		</div>

		<!-- Actions -->
		<div class="flex shrink-0 items-center gap-1">
			{#if item.status === 'failed'}
				<form method="POST" action="/repos/{repoOwner}/{repoName}?/retry" use:enhance>
					<input type="hidden" name="item_id" value={item.id} />
					<button
						type="submit"
						class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
						title="Retry"
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
						</svg>
					</button>
				</form>
			{/if}
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
</div>
