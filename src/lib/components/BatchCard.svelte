<script lang="ts">
	import BatchCard from './BatchCard.svelte';
	import type { BatchCard as Card } from '$lib/server/batch-view';

	let { batch, owner, name, nested = false }: { batch: Card; owner: string; name: string; nested?: boolean } = $props();

	const KIND: Record<Card['kind'], string> = { batch: 'Batch', bisect: 'Bisection run', try: 'Try alone', baseline: 'Master check' };
	const STATUS: Record<string, string> = {
		testing: 'bg-amber-100 text-amber-800',
		retrying: 'bg-amber-100 text-amber-800',
		bisecting: 'bg-orange-100 text-orange-800',
		passed: 'bg-green-100 text-green-800',
		landed: 'bg-green-100 text-green-800',
		failed: 'bg-red-100 text-red-800',
		superseded: 'bg-gray-100 text-gray-600',
		cancelled: 'bg-gray-100 text-gray-600'
	};
	const LABEL: Record<string, string> = {
		testing: 'testing',
		retrying: 're-running failed jobs',
		bisecting: 'bisecting',
		passed: 'passed, waiting to land',
		landed: 'landed',
		failed: 'failed',
		superseded: 'superseded',
		cancelled: 'cancelled'
	};

	function since(sqlTime: string, end: string | null): string {
		const start = Date.parse(sqlTime.replace(' ', 'T') + 'Z');
		const ms = (end ? Date.parse(end.replace(' ', 'T') + 'Z') : Date.now()) - start;
		const m = Math.max(0, Math.round(ms / 60000));
		return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
	}

	// A bisection or try run that passed is stored as landed; it landed nothing itself.
	const status = $derived(batch.kind !== 'batch' && batch.status === 'landed' ? 'passed' : batch.status);
	const p = $derived(batch.progress);
	const pct = (n: number) => (p && p.total > 0 ? (n / p.total) * 100 : 0);
</script>

<div class="rounded-xl border border-border-subtle bg-surface-raised {nested ? 'p-3' : 'p-4'}">
	<div class="flex flex-wrap items-center gap-2 text-sm">
		<span class="font-semibold text-gray-900">{KIND[batch.kind]} {batch.kind === 'batch' ? `#${batch.id}` : ''}</span>
		<span class="rounded px-1.5 py-0.5 text-xs {STATUS[status] ?? 'bg-gray-100 text-gray-600'}">{batch.kind !== 'batch' && status === 'passed' ? 'passed' : (LABEL[status] ?? status)}</span>
		{#if batch.express}<span class="rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-700">express</span>{/if}
		<a href="https://github.com/{owner}/{name}/commit/{batch.headSha}" target="_blank" rel="noopener" class="font-mono text-xs text-gray-500 hover:text-indigo-600">{batch.branch}</a>
		<span class="ml-auto text-xs text-gray-400">{batch.finishedAt ? `took ${since(batch.createdAt, batch.finishedAt)}` : `running ${since(batch.createdAt, null)}`}</span>
	</div>

	{#if p}
		<div class="mt-2">
			<div class="flex h-2 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuenow={p.done} aria-valuemax={p.total} aria-label="CI jobs finished">
				<div class="bg-green-500" style="width: {pct(p.done - p.failed)}%"></div>
				<div class="bg-red-500" style="width: {pct(p.failed)}%"></div>
				<div class="animate-pulse bg-amber-400" style="width: {pct(p.running)}%"></div>
			</div>
			<div class="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-500">
				<span>{p.done}/{p.total} jobs done</span>
				{#if p.running > 0}<span>{p.running} running</span>{/if}
				{#if p.total - p.done - p.running > 0}<span>{p.total - p.done - p.running} waiting for a runner</span>{/if}
				{#if p.failed > 0}<span class="text-red-600">failed: {p.failedJobs.join(', ')}</span>{/if}
				{#if p.url}<a href={p.url} target="_blank" rel="noopener" class="hover:text-indigo-600">open CI</a>{/if}
			</div>
		</div>
	{:else if batch.status === 'testing' && !batch.finishedAt}
		<p class="mt-2 text-xs text-gray-500">CI has not started yet.</p>
	{/if}

	{#if batch.context.length > 0}
		<p class="mt-2 text-xs text-gray-500">On top of {batch.context.map((n) => `#${n}`).join(', ')} (already passed)</p>
	{/if}

	<ul class="mt-2 space-y-1 text-sm">
		{#each batch.prs as pr (pr.pr)}
			<li class="flex min-w-0 items-center gap-2" style="padding-left: {pr.depth * 1.25}rem">
				{#if pr.depth > 0}<span class="text-gray-400" aria-hidden="true">└</span>{/if}
				<a href={pr.url || `https://github.com/${owner}/${name}/pull/${pr.pr}`} target="_blank" rel="noopener" class="font-medium hover:text-indigo-600">#{pr.pr}</a>
				<span class="min-w-0 truncate text-gray-600">{pr.title}</span>
				{#if pr.parent !== null && pr.depth === 0}
					<span class="shrink-0 text-xs text-gray-400">stacked on #{pr.parent}</span>
				{/if}
				{#if pr.link && pr.link !== 'healthy'}
					<span class="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">{pr.link}</span>
				{/if}
			</li>
		{/each}
	</ul>

	{#if batch.bisection.length > 0}
		<div class="mt-3 space-y-2 border-l-2 border-orange-200 pl-3">
			{#each batch.bisection as run (run.id)}
				<BatchCard batch={run} {owner} {name} nested />
			{/each}
		</div>
	{/if}
</div>
