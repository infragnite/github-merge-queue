<script lang="ts">
	import StatusBadge from './StatusBadge.svelte';
	import type { RepoWithStats } from '$lib/types';

	let { repo }: { repo: RepoWithStats } = $props();

	const statusText = $derived.by(() => {
		if (repo.queue_count === 0) return 'Idle';
		if (repo.queue_count === 1) return '1 PR in queue';
		return `${repo.queue_count} PRs in queue`;
	});
</script>

<a
	href="/repos/{repo.owner}/{repo.name}"
	class="group block rounded-xl border border-border-subtle bg-surface-raised p-5 transition-all hover:border-indigo-200 hover:shadow-md"
>
	<div class="flex items-start justify-between">
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-2">
				<svg class="h-4 w-4 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
				</svg>
				<h3 class="truncate text-sm font-semibold text-gray-900 group-hover:text-indigo-600">
					{repo.owner}/{repo.name}
				</h3>
			</div>
			<p class="mt-1.5 text-xs text-gray-400">
				Branch: <code class="rounded bg-gray-100 px-1 py-0.5">{repo.default_branch}</code>
			</p>
		</div>
		{#if repo.current_status}
			<StatusBadge status={repo.current_status} />
		{/if}
	</div>

	<div class="mt-4 flex items-center justify-between border-t border-border-subtle pt-3">
		<span class="text-sm {repo.queue_count > 0 ? 'font-medium text-indigo-600' : 'text-gray-400'}">
			{statusText}
		</span>
		<svg class="h-4 w-4 text-gray-300 transition-colors group-hover:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
		</svg>
	</div>
</a>
