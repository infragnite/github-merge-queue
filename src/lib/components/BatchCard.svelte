<script lang="ts">
	import BatchCard from './BatchCard.svelte';
	import type { BatchCard as Card } from '$lib/server/batch-view';

	let { batch, owner, name, nested = false, step = null }: { batch: Card; owner: string; name: string; nested?: boolean; step?: number | null } = $props();

	const KIND: Record<Card['kind'], string> = { batch: 'Batch', bisect: 'Bisection run', try: 'Tried alone', baseline: 'Master check' };
	const STATUS: Record<string, string> = {
		testing: 'bg-amber-100 text-amber-800',
		retrying: 'bg-amber-100 text-amber-800',
		bisecting: 'bg-orange-100 text-orange-800',
		passed: 'bg-green-100 text-green-800',
		landed: 'bg-green-100 text-green-800',
		failed: 'bg-red-100 text-red-800',
		superseded: 'bg-gray-100 text-gray-600',
		cancelled: 'bg-gray-100 text-gray-600',
		failing: 'bg-red-100 text-red-800'
	};
	const LABEL: Record<string, string> = {
		testing: 'testing',
		retrying: 're-running failed jobs',
		bisecting: 'bisecting',
		passed: 'passed, waiting to land',
		landed: 'landed',
		failed: 'failed',
		superseded: 'rebuilt: the batch below it failed',
		cancelled: 'cancelled',
		failing: 'failing'
	};

	function since(sqlTime: string, end: string | null): string {
		const start = Date.parse(sqlTime.replace(' ', 'T') + 'Z');
		const ms = (end ? Date.parse(end.replace(' ', 'T') + 'Z') : Date.now()) - start;
		const m = Math.max(0, Math.round(ms / 60000));
		return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
	}

	// A bisection or try run that passed is stored as landed; it landed nothing itself.
	const p = $derived(batch.progress);
	// A run with a failed job will fail: say so before the remaining jobs finish.
	const status = $derived(
		batch.kind !== 'batch' && batch.status === 'landed'
			? 'passed'
			: batch.status === 'testing' && p && p.failed > 0
				? 'failing'
				: batch.status
	);
	const prList = (ns: number[]) => ns.map((n) => `#${n}`).join(', ');
	// Bisection's state in one line: where the failure has been narrowed to so far.
	const verdict = $derived.by(() => {
		if (batch.status !== 'bisecting') return null;
		const runs = batch.bisection;
		const failed = runs.filter((r) => r.status === 'failed' || (r.status === 'testing' && (r.progress?.failed ?? 0) > 0));
		const smallest = failed.sort((a, b) => a.prs.length - b.prs.length)[0];
		const total = batch.prs.length;
		if (smallest) {
			const n = smallest.prs.length;
			return n === 1
				? `Found it: #${smallest.prs[0].pr} breaks the batch`
				: `Narrowed to ${n} of ${total} PRs: ${prList(smallest.prs.map((x) => x.pr))}`;
		}
		const passed = runs.filter((r) => r.status === 'landed' || r.status === 'passed');
		if (passed.length) return `${prList(passed.flatMap((r) => r.prs.map((x) => x.pr)))} passed; testing the rest`;
		return `Splitting ${total} PRs in two to find which one fails`;
	});
	const pct = (n: number) => (p && p.total > 0 ? (n / p.total) * 100 : 0);
</script>

<div id={nested ? undefined : `batch-${batch.id}`} class="scroll-mt-4 rounded-xl border border-border-subtle bg-surface-raised {nested ? 'p-3' : 'p-4'}">
	<div class="flex flex-wrap items-center gap-2 text-sm">
		<span class="font-semibold text-gray-900">{KIND[batch.kind]} {batch.kind === 'batch' ? `#${batch.id}` : step !== null ? step : ''}</span>
		<span class="rounded px-1.5 py-0.5 text-xs {STATUS[status] ?? 'bg-gray-100 text-gray-600'}">{batch.kind !== 'batch' && status === 'passed' ? 'passed' : (LABEL[status] ?? status)}</span>
		{#if batch.express}<span class="rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-700" title="A small batch of urgent PRs, ahead of the rest">urgent</span>{/if}
		<a href="https://github.com/{owner}/{name}/commit/{batch.headSha}" target="_blank" rel="noopener" class="hidden max-w-[12rem] truncate font-mono text-[11px] text-gray-400 hover:text-indigo-600 sm:inline" title={batch.branch}>{batch.branch}</a>
		<span class="ml-auto text-xs text-gray-400">{batch.finishedAt ? `took ${since(batch.createdAt, batch.finishedAt)}` : `running ${since(batch.createdAt, null)}`}</span>
	</div>

	{#if verdict}
		<p class="mt-1 text-sm font-medium text-orange-800">{verdict}</p>
	{/if}

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
		<p class="mt-2 text-xs text-gray-500">On top of {prList(batch.context)}, which passed</p>
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
			{#each batch.bisection as run, i (run.id)}
				<BatchCard batch={run} {owner} {name} nested step={i + 1} />
			{/each}
		</div>
	{/if}
</div>
