<script lang="ts">
	import { enhance } from '$app/forms';
	import RepoCard from '$lib/components/RepoCard.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';

	let { data, form } = $props();

	type Loaded<T> = T extends Promise<infer V> ? V : never;
	let addable = $state<Loaded<typeof data.addable> | null>(null);
	$effect(() => {
		let current = true;
		data.addable.then((v) => current && (addable = v)).catch(() => {});
		return () => {
			current = false;
		};
	});

	let adding = $state(false);
	let addOpen = $state(false);
	let pending = $state<string | null>(null);
	let search = $state('');
	let searchInput = $state<HTMLInputElement | null>(null);

	const needle = $derived(search.trim().toLowerCase());
	const found = $derived((addable?.repos ?? []).filter((r) => !needle || r.toLowerCase().includes(needle)));
	const attention = $derived(data.repos.reduce((n, r) => n + r.summary.attention, 0));
	// Repositories that need someone first, then the ones moving, then the rest by name.
	const RANK = { paused: 0, red: 1, running: 2, waiting: 3, idle: 4 } as const;
	const sorted = $derived(
		[...data.repos].sort(
			(a, b) =>
				Number(b.summary.attention > 0) - Number(a.summary.attention > 0) ||
				RANK[a.summary.state] - RANK[b.summary.state] ||
				`${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`)
		)
	);

	function openAdd() {
		addOpen = true;
		search = '';
		queueMicrotask(() => searchInput?.focus());
	}
</script>

<svelte:head>
	<title>Repositories - Merge Queue</title>
</svelte:head>

<div class="space-y-8">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="min-w-0">
			<h1 class="text-2xl font-bold text-gray-900">Repositories</h1>
			<p class="mt-1 text-sm text-gray-500">
				{#if data.repos.length === 0}
					Add a repository to start using the merge queue.
				{:else}
					{data.repos.length} {data.repos.length === 1 ? 'queue' : 'queues'}{#if attention > 0}{' · '}<span class="text-red-700">{attention} PR{attention === 1 ? '' : 's'} need{attention === 1 ? 's' : ''} attention</span>{/if}
				{/if}
			</p>
		</div>
		{#if !addOpen}
			<button type="button" onclick={openAdd} class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700">
				Add repository
			</button>
		{/if}
	</div>

	{#if form?.added}
		<p class="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" role="status">
			Added <a href="/repos/{form.added}" class="font-medium underline">{form.added}</a>. Its queue starts one by one; choose batches in its settings.
		</p>
	{/if}

	{#if addOpen}
		<section class="rounded-xl border border-border-subtle bg-surface-raised p-4 sm:p-5" aria-labelledby="add-title">
			<div class="flex items-center justify-between gap-3">
				<h2 id="add-title" class="text-base font-semibold text-gray-900">Add repository</h2>
				<button type="button" onclick={() => (addOpen = false)} class="rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-surface-sunken hover:text-gray-700">Close</button>
			</div>
			<p class="mt-0.5 text-sm text-gray-500">Repositories the app is installed on that you administer on GitHub.</p>

			{#if addable === null}
				<p class="mt-3 text-sm text-gray-500" role="status">Asking GitHub…</p>
			{:else}
				{#if addable.repos.length > 0}
					<input
						bind:this={searchInput}
						bind:value={search}
						type="search"
						placeholder="Search {addable.repos.length} repositories"
						aria-label="Search repositories"
						class="mt-3 w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
					/>
					<ul class="mt-2 max-h-72 divide-y divide-border-subtle overflow-y-auto rounded-lg border border-border-subtle">
						{#each found as full (full)}
							<li>
								<form
									method="POST"
									action="?/add"
									use:enhance={() => {
										adding = true;
										pending = full;
										return async ({ result, update }) => {
											await update();
											adding = false;
											pending = null;
											if (result.type === 'success') addOpen = false;
										};
									}}
								>
									<input type="hidden" name="repo" value={full} />
									<button type="submit" disabled={adding} class="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-indigo-50/50 disabled:opacity-60">
										<span class="truncate text-gray-900">{full}</span>
										<span class="shrink-0 text-xs font-medium text-indigo-600">{pending === full ? 'Adding…' : 'Add'}</span>
									</button>
								</form>
							</li>
						{:else}
							<li class="px-3 py-2.5 text-sm text-gray-500">No repository matches “{search}”.</li>
						{/each}
					</ul>
				{:else if !addable.error}
					<p class="mt-3 text-sm text-gray-500">There is no repository left to add: every one you administer that has the app is already here.</p>
				{/if}
				{#if addable.error}<p class="mt-3 text-sm text-red-600" role="alert">{addable.error}</p>{/if}
				<p class="mt-3 text-xs text-gray-500">
					Missing one?
					{#if addable.installUrl}
						<a href={addable.installUrl} target="_blank" rel="noopener" class="font-medium text-indigo-600 hover:underline">Install the app on it</a>, then come back here.
					{:else}
						Install the GitHub app on it, then come back here.
					{/if}
				</p>
			{/if}
			{#if form?.error}<p class="mt-2 text-sm text-red-600" role="alert">{form.error}</p>{/if}
		</section>
	{:else if form?.error}
		<p class="text-sm text-red-600" role="alert">{form.error}</p>
	{/if}

	{#if data.repos.length === 0}
		{#if !addOpen}
			<div class="rounded-xl border border-dashed border-gray-300 bg-surface-raised p-12 text-center">
				<h3 class="text-sm font-medium text-gray-900">No repositories</h3>
				<p class="mt-1 text-sm text-gray-500">Add a repository to start using the merge queue.</p>
				<button type="button" onclick={openAdd} class="mt-4 inline-flex items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
					Add repository
				</button>
			</div>
		{/if}
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each sorted as repo (repo.id)}
				<RepoCard {repo} />
			{/each}
		</div>
	{/if}

	{#if data.history.length > 0}
		<div>
			<h2 class="mb-4 text-lg font-semibold text-gray-900">Recent activity</h2>
			<div class="overflow-x-auto rounded-xl border border-border-subtle bg-surface-raised">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-border-subtle bg-surface-sunken">
							<th class="px-4 py-3 text-left font-medium text-gray-600">Pull Request</th>
							<th class="hidden px-4 py-3 text-left font-medium text-gray-600 sm:table-cell">Repository</th>
							<th class="px-4 py-3 text-left font-medium text-gray-600">Status</th>
							<th class="hidden px-4 py-3 text-left font-medium text-gray-600 sm:table-cell">Time</th>
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
									<span class="block text-xs text-gray-500 sm:hidden">{item.repo_owner}/{item.repo_name}</span>
								</td>
								<td class="hidden px-4 py-3 text-gray-500 sm:table-cell">
									{item.repo_owner}/{item.repo_name}
								</td>
								<td class="px-4 py-3">
									<StatusBadge status={item.status} />
								</td>
								<td class="hidden whitespace-nowrap px-4 py-3 text-gray-500 sm:table-cell">
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
