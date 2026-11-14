<script lang="ts">
	import GitHubRefs from './GitHubRefs.svelte';
	import { enhance } from '$app/forms';
	import type { ViewItem } from '$lib/types';

	// A PR held until someone acts: what to do comes first, then which PR, then one labelled action.
	let {
		item,
		why,
		repoOwner,
		repoName,
		warnings = [],
		readonly = false
	}: { item: ViewItem; why: string | null; repoOwner: string; repoName: string; warnings?: string[]; readonly?: boolean } = $props();

	const action = (n: string) => `/repos/${repoOwner}/${repoName}?/${n}`;
	const conflict = $derived(item.status === 'conflict');
	const reason = $derived(conflict ? (item.author_login === 'dependabot[bot]' ? 'Merge conflict: comment @dependabot recreate on the PR. It is retried automatically.' : 'Merge conflict with the default branch: resolve it on GitHub. It is retried automatically.') : (why ?? 'Held until someone acts.'));
</script>

<div class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
	<div class="min-w-0 flex-1">
		<p class="text-sm text-gray-900"><GitHubRefs text={reason} owner={repoOwner} name={repoName} /></p>
		<p class="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-gray-500">
			<a href={item.pr_url} target="_blank" rel="noopener" class="shrink-0 font-mono hover:text-indigo-600">#{item.pr_number}</a>
			<span class="min-w-0 truncate"><GitHubRefs text={item.pr_title} owner={repoOwner} name={repoName} /></span>
			<span class="shrink-0">· {item.author_login}</span>
		</p>
		{#each warnings as w, i (i)}
			<p class="mt-0.5 text-xs text-amber-700"><GitHubRefs text={w} owner={repoOwner} name={repoName} /></p>
		{/each}
	</div>
	{#if !readonly}
		<div class="flex shrink-0 items-center gap-2">
			{#if conflict && item.author_login !== 'dependabot[bot]'}
				<a href="{item.pr_url}/conflicts" target="_blank" rel="noopener" class="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">Resolve on GitHub</a>
			{:else if item.status === 'failed'}
				<form method="POST" action={action('retry')} use:enhance>
					<input type="hidden" name="item_id" value={item.id} />
					<button type="submit" class="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">Retry</button>
				</form>
			{:else}
				<a href={item.pr_url} target="_blank" rel="noopener" class="rounded-md border border-border-subtle px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-surface-sunken">Open PR</a>
			{/if}
			<form
				method="POST"
				action={action('removeFromQueue')}
				use:enhance={({ cancel }) => {
					if (!confirm(`Remove #${item.pr_number} from the queue?`)) cancel();
				}}
			>
				<input type="hidden" name="item_id" value={item.id} />
				<button type="submit" class="rounded-md border border-border-subtle px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-red-200 hover:bg-red-50 hover:text-red-700">Remove</button>
			</form>
		</div>
	{/if}
</div>
