<script lang="ts">
	import type { RepoSummary } from '$lib/server/repo-summary';

	let { repo }: { repo: { owner: string; name: string; default_branch: string; summary: RepoSummary } } = $props();

	const STATE = {
		running: { label: 'Running', tone: 'bg-indigo-100 text-indigo-800', dot: 'bg-indigo-500' },
		waiting: { label: 'Waiting', tone: 'bg-gray-100 text-gray-700', dot: 'bg-gray-400' },
		paused: { label: 'Paused', tone: 'bg-red-100 text-red-800', dot: 'bg-red-500' },
		red: { label: 'Default branch red', tone: 'bg-red-100 text-red-800', dot: 'bg-red-500' },
		idle: { label: 'Idle', tone: 'bg-gray-100 text-gray-600', dot: 'bg-gray-300' }
	} as const;

	const s = $derived(repo.summary);
	const st = $derived(STATE[s.state]);
	const hint = $derived(
		s.state === 'paused'
			? `Paused: ${s.paused}`
			: s.state === 'red'
				? `${repo.default_branch} is failing CI; only PRs that pass on it can land`
				: s.state === 'waiting'
					? s.triesWaiting > 0 ? 'Tries are queued to start' : 'PRs are in line; none is being tested yet (CI, approvals or a batch to fill)'
					: undefined
	);
</script>

<a
	href="/repos/{repo.owner}/{repo.name}"
	class="group block rounded-xl border bg-surface-raised p-4 transition-all hover:shadow-md {s.attention > 0 ? 'border-red-200 hover:border-red-300' : 'border-border-subtle hover:border-indigo-200'}"
>
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0 flex-1">
			<h3 class="truncate text-sm font-semibold text-gray-900 group-hover:text-indigo-600" title="{repo.owner}/{repo.name}">
				{repo.owner}<span class="text-gray-400">/</span>{repo.name}
			</h3>
			<p class="mt-1 truncate text-xs text-gray-500">
				{s.modeLabel} · into <code class="rounded bg-gray-100 px-1 py-0.5">{repo.default_branch}</code>
			</p>
		</div>
		<span class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium {st.tone}" title={hint}>
			<span class="h-1.5 w-1.5 rounded-full {st.dot}" aria-hidden="true"></span>
			{st.label}
		</span>
	</div>

	{#if s.state === 'paused' && s.paused}
		<p class="mt-2 line-clamp-2 text-xs text-red-700">{s.paused}</p>
	{/if}

	<div class="mt-3 flex items-center justify-between gap-3 border-t border-border-subtle pt-3 text-sm">
		<span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
			{#if s.attention > 0}
				<span class="font-medium whitespace-nowrap text-red-700">{s.attention} need{s.attention === 1 ? 's' : ''} attention</span>
			{/if}
			{#if s.testing > 0}
				<span class="whitespace-nowrap text-indigo-700">{s.testing} testing</span>
			{/if}
			{#if s.waiting > 0}
				<span class="whitespace-nowrap text-gray-600">{s.waiting} waiting</span>
			{/if}
			{#if s.triesRunning > 0}<span class="whitespace-nowrap text-indigo-700">{s.triesRunning} {s.triesRunning === 1 ? 'try' : 'tries'} active</span>{/if}
			{#if s.triesWaiting > 0}<span class="whitespace-nowrap text-gray-600">{s.triesWaiting} {s.triesWaiting === 1 ? 'try' : 'tries'} queued</span>{/if}
			{#if s.baselineRunning}<span class="whitespace-nowrap text-indigo-700">Checking {repo.default_branch}</span>{/if}
			{#if s.attention + s.testing + s.waiting + s.triesRunning + s.triesWaiting === 0 && !s.baselineRunning}
				<span class="text-gray-500">Nothing queued</span>
			{/if}
		</span>
		<svg class="h-4 w-4 shrink-0 text-gray-300 transition-colors group-hover:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
		</svg>
	</div>
</a>
