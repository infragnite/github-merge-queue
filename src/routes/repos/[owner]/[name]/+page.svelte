<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import QueueItem from '$lib/components/QueueItem.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';

	let { data } = $props();
	let showAddDialog = $state(false);
	let refreshing = $state(false);

	async function refresh() {
		refreshing = true;
		await invalidateAll();
		refreshing = false;
	}

	// Auto-refresh every 10s when queue is active
	$effect(() => {
		const hasActive = data.queueItems.some(
			(i) => !['merged', 'failed', 'cancelled'].includes(i.status)
		);
		if (!hasActive) return;

		const id = setInterval(refresh, 10_000);
		return () => clearInterval(id);
	});
</script>

<svelte:head>
	<title>{data.repo.owner}/{data.repo.name} - Merge Queue</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<a href="/" class="text-gray-400 transition-colors hover:text-gray-600" aria-label="Back to dashboard">
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
				</svg>
			</a>
			<div>
				<h1 class="text-2xl font-bold text-gray-900">
					<a
						href="https://github.com/{data.repo.owner}/{data.repo.name}"
						target="_blank"
						rel="noopener"
						class="hover:text-indigo-600"
					>
						{data.repo.owner}<span class="text-gray-400">/</span>{data.repo.name}
					</a>
				</h1>
				<p class="text-sm text-gray-500">Target branch: <code class="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{data.repo.default_branch}</code></p>
			</div>
		</div>
		<div class="flex items-center gap-3">
			<button
				onclick={refresh}
				disabled={refreshing}
				class="rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-surface-sunken disabled:opacity-50"
				aria-label="Refresh queue"
			>
				<svg class="h-4 w-4 {refreshing ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
				</svg>
			</button>
			<button
				onclick={() => (showAddDialog = true)}
				disabled={data.openPrs.length === 0}
				class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
			>
				Add PR to Queue
			</button>
		</div>
	</div>

	<!-- Queue -->
	{#if data.queueItems.length === 0}
		<div class="rounded-xl border border-dashed border-gray-300 bg-surface-raised p-12 text-center">
			<svg class="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
			</svg>
			<h3 class="mt-4 text-sm font-medium text-gray-900">Queue is empty</h3>
			<p class="mt-1 text-sm text-gray-500">Add a pull request to start the merge queue.</p>
		</div>
	{:else}
		<div class="space-y-3">
			{#each data.queueItems as item, index (item.id)}
				<QueueItem {item} position={index + 1} repoOwner={data.repo.owner} repoName={data.repo.name} />
			{/each}
		</div>
	{/if}

	<!-- History -->
	{#if data.history.length > 0}
		<div>
			<h2 class="mb-3 text-lg font-semibold text-gray-900">History</h2>
			<div class="overflow-hidden rounded-xl border border-border-subtle bg-surface-raised">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-border-subtle bg-surface-sunken">
							<th class="px-4 py-2.5 text-left font-medium text-gray-600">PR</th>
							<th class="px-4 py-2.5 text-left font-medium text-gray-600">Author</th>
							<th class="px-4 py-2.5 text-left font-medium text-gray-600">Status</th>
							<th class="px-4 py-2.5 text-left font-medium text-gray-600">Time</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border-subtle">
						{#each data.history as h (h.id)}
							<tr class="hover:bg-surface-sunken/50">
								<td class="px-4 py-2.5">
									<a href={h.pr_url} target="_blank" rel="noopener" class="font-medium hover:text-indigo-600">
										#{h.pr_number}
									</a>
									<span class="ml-1.5 text-gray-500">{h.pr_title}</span>
								</td>
								<td class="px-4 py-2.5 text-gray-500">{h.author_login}</td>
								<td class="px-4 py-2.5"><StatusBadge status={h.status} /></td>
								<td class="whitespace-nowrap px-4 py-2.5 text-gray-400">
									{new Date(h.completed_at + 'Z').toLocaleString()}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>

<!-- Add PR Dialog -->
{#if showAddDialog}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onkeydown={(e) => e.key === 'Escape' && (showAddDialog = false)}
	>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="fixed inset-0" onclick={() => (showAddDialog = false)}></div>
		<div class="relative w-full max-w-lg rounded-xl bg-surface-raised p-6 shadow-2xl">
			<h2 class="mb-4 text-lg font-semibold text-gray-900">Add Pull Request to Queue</h2>

			{#if data.openPrs.length === 0}
				<p class="text-sm text-gray-500">No open pull requests available.</p>
			{:else}
				<div class="max-h-96 space-y-2 overflow-y-auto">
					{#each data.openPrs as pr (pr.number)}
						<form method="POST" action="?/addToQueue" use:enhance={() => {
							return async ({ update }) => {
								showAddDialog = false;
								await update();
							};
						}}>
							<input type="hidden" name="pr_number" value={pr.number} />
							<input type="hidden" name="pr_title" value={pr.title} />
							<input type="hidden" name="pr_url" value={pr.url} />
							<input type="hidden" name="author_login" value={pr.author} />
							<input type="hidden" name="author_avatar" value={pr.authorAvatar} />
							<button
								type="submit"
								class="flex w-full items-center gap-3 rounded-lg border border-border-subtle p-3 text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50/50"
							>
								<img src={pr.authorAvatar} alt="" class="h-8 w-8 rounded-full" />
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<span class="font-medium text-gray-900">#{pr.number}</span>
										{#if pr.draft}
											<span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">Draft</span>
										{/if}
									</div>
									<p class="truncate text-sm text-gray-500">{pr.title}</p>
								</div>
								<span class="text-xs text-gray-400">{pr.author}</span>
							</button>
						</form>
					{/each}
				</div>
			{/if}

			<div class="mt-4 flex justify-end">
				<button
					onclick={() => (showAddDialog = false)}
					class="rounded-lg border border-border-subtle px-4 py-2 text-sm text-gray-600 hover:bg-surface-sunken"
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}
