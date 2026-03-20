<script lang="ts">
	import RepoCard from '$lib/components/RepoCard.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';

	let { data } = $props();
</script>

<svelte:head>
	<title>Dashboard - Merge Queue</title>
</svelte:head>

<div class="space-y-8">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-gray-900">Dashboard</h1>
			<p class="mt-1 text-sm text-gray-500">Manage your merge queues across repositories</p>
		</div>
		<a
			href="/settings"
			class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
		>
			Add Repository
		</a>
	</div>

	<!-- Repos Grid -->
	{#if data.repos.length === 0}
		<div class="rounded-xl border border-dashed border-gray-300 bg-surface-raised p-12 text-center">
			<svg class="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v6m3-3H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			<h3 class="mt-4 text-sm font-medium text-gray-900">No repositories</h3>
			<p class="mt-1 text-sm text-gray-500">Add a repository to start using the merge queue.</p>
			<a
				href="/settings"
				class="mt-4 inline-flex items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
			>
				Add Repository
			</a>
		</div>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.repos as repo (repo.id)}
				<RepoCard {repo} />
			{/each}
		</div>
	{/if}

	<!-- Recent History -->
	{#if data.history.length > 0}
		<div>
			<h2 class="mb-4 text-lg font-semibold text-gray-900">Recent Activity</h2>
			<div class="overflow-hidden rounded-xl border border-border-subtle bg-surface-raised">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-border-subtle bg-surface-sunken">
							<th class="px-4 py-3 text-left font-medium text-gray-600">Pull Request</th>
							<th class="px-4 py-3 text-left font-medium text-gray-600">Repository</th>
							<th class="px-4 py-3 text-left font-medium text-gray-600">Status</th>
							<th class="px-4 py-3 text-left font-medium text-gray-600">Time</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border-subtle">
						{#each data.history as item (item.id)}
							<tr class="hover:bg-surface-sunken/50">
								<td class="px-4 py-3">
									<a href={item.pr_url} target="_blank" rel="noopener" class="font-medium text-gray-900 hover:text-indigo-600">
										#{item.pr_number}
									</a>
									<span class="ml-2 text-gray-500">{item.pr_title}</span>
								</td>
								<td class="px-4 py-3 text-gray-500">
									{item.repo_owner}/{item.repo_name}
								</td>
								<td class="px-4 py-3">
									<StatusBadge status={item.status} />
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-gray-400">
									{new Date(item.completed_at + 'Z').toLocaleString()}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
