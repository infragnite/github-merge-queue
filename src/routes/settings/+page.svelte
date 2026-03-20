<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let repoInput = $state('');
	let adding = $state(false);
</script>

<svelte:head>
	<title>Settings - Merge Queue</title>
</svelte:head>

<div class="space-y-8">
	<div class="flex items-center gap-3">
		<a href="/" class="text-gray-400 transition-colors hover:text-gray-600" aria-label="Back to dashboard">
			<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
			</svg>
		</a>
		<h1 class="text-2xl font-bold text-gray-900">Settings</h1>
	</div>

	<!-- Add Repository -->
	<div class="rounded-xl border border-border-subtle bg-surface-raised p-6">
		<h2 class="mb-4 text-lg font-semibold text-gray-900">Add Repository</h2>
		<form
			method="POST"
			action="?/add"
			use:enhance={() => {
				adding = true;
				return async ({ update }) => {
					adding = false;
					repoInput = '';
					await update();
				};
			}}
		>
			<div class="flex gap-3">
				<input
					type="text"
					name="repo"
					bind:value={repoInput}
					placeholder="owner/repository"
					class="flex-1 rounded-lg border border-border-subtle bg-surface px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
				/>
				<button
					type="submit"
					disabled={!repoInput.includes('/') || adding}
					class="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{adding ? 'Adding...' : 'Add'}
				</button>
			</div>
			{#if form?.error}
				<p class="mt-2 text-sm text-red-600">{form.error}</p>
			{/if}
		</form>
	</div>

	<!-- Repository List -->
	<div class="rounded-xl border border-border-subtle bg-surface-raised p-6">
		<h2 class="mb-4 text-lg font-semibold text-gray-900">Repositories</h2>
		{#if data.repos.length === 0}
			<p class="text-sm text-gray-500">No repositories configured yet.</p>
		{:else}
			<div class="divide-y divide-border-subtle">
				{#each data.repos as repo (repo.id)}
					<div class="flex items-center justify-between py-3">
						<div class="flex items-center gap-3">
							<svg class="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
							</svg>
							<div>
								<a
									href="/repos/{repo.owner}/{repo.name}"
									class="font-medium text-gray-900 hover:text-indigo-600"
								>
									{repo.owner}/{repo.name}
								</a>
								<p class="text-xs text-gray-400">
									Branch: {repo.default_branch} &middot; Added {new Date(repo.created_at + 'Z').toLocaleDateString()}
								</p>
							</div>
						</div>
						<form method="POST" action="?/remove" use:enhance>
							<input type="hidden" name="repo_id" value={repo.id} />
							<button
								type="submit"
								class="rounded-lg px-3 py-1.5 text-sm text-red-600 transition-colors hover:bg-red-50"
								onclick={(e) => {
									if (!confirm(`Remove ${repo.owner}/${repo.name}? This will also clear its queue.`)) {
										e.preventDefault();
									}
								}}
							>
								Remove
							</button>
						</form>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
