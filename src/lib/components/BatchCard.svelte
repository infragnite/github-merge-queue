<script lang="ts">
	import { enhance } from '$app/forms';
	import BatchCard from './BatchCard.svelte';
	import type { BatchCard as Card } from '$lib/server/batch-view';

	let {
		batch,
		owner,
		name,
		nested = false,
		step = null,
		canCancel = false,
		progressErrors = {}
	}: {
		batch: Card;
		owner: string;
		name: string;
		nested?: boolean;
		step?: number | null;
		canCancel?: boolean;
		/** Why CI progress could not be read, by head commit. */
		progressErrors?: Record<string, string>;
	} = $props();
	const progressError = $derived(progressErrors[batch.headSha] ?? null);
	const cancellable = $derived(canCancel && batch.kind === 'batch' && ['testing', 'retrying', 'bisecting', 'passed'].includes(batch.status));

	const KIND: Record<Card['kind'], string> = { batch: 'Batch', bisect: 'Bisection step', try: 'Tried alone', baseline: 'Master check' };
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
		(batch.kind === 'try' || batch.kind === 'baseline') && batch.status === 'landed'
			? 'passed'
			: batch.status === 'testing' && p && p.failed > 0
				? 'failing'
				: batch.status
	);
	const prList = (ns: number[]) => ns.map((n) => `#${n}`).join(', ');
	// What the runs showed about a PR, as an icon; what is happening to it, as a mark on that icon.
	const VERDICT: Record<string, { label: string; icon: string; cls: string }> = {
		passing: { label: 'passing', icon: '✓', cls: 'bg-green-100 text-green-700' },
		unknown: { label: 'unknown', icon: '?', cls: 'bg-gray-100 text-gray-500' },
		failing: { label: 'failing', icon: '✕', cls: 'bg-red-100 text-red-700' }
	};
	const ACTIVITY: Record<string, { label: string; cls: string }> = {
		checking: { label: 'checking', cls: 'ring-2 ring-amber-400 motion-safe:animate-pulse' },
		landed: { label: 'landed', cls: '!bg-green-600 !text-white' },
		left: { label: 'back in line', cls: 'opacity-50' }
	};
	const count = <T,>(values: T[], order: string[]) =>
		order.map((k) => [k, values.filter((v) => v === k).length] as const).filter(([, c]) => c > 0);
	const verdictCounts = $derived(count(batch.prs.map((p) => p.verdict), ['passing', 'unknown', 'failing']));
	const activityCounts = $derived(count(batch.prs.map((p) => p.activity), ['checking', 'landed', 'left']));
	const runningRuns = $derived(batch.bisection.filter((r) => r.ci === 'pending' && !['cancelled', 'superseded'].includes(r.status)).length);
	const pct = (q: NonNullable<Card['progress']>, n: number) => (q.total > 0 ? (n / q.total) * 100 : 0);
	// Bisection steps whose CI is going now, numbered as in the list below.
	const nowSteps = $derived(
		batch.bisection.map((run, i) => ({ run, step: i + 1 })).filter(({ run }) => run.ci === 'pending' && !['cancelled', 'superseded'].includes(run.status))
	);
</script>

<div id={nested ? undefined : `batch-${batch.id}`} class="scroll-mt-4 rounded-xl border border-border-subtle bg-surface-raised {nested ? 'p-3' : 'p-4'}">
	<div class="flex flex-wrap items-center gap-2 text-sm">
		<span class="font-semibold text-gray-900">{KIND[batch.kind]} {batch.kind === 'batch' ? `#${batch.id}` : step !== null ? step : ''}</span>
		<span class="rounded px-1.5 py-0.5 text-xs {STATUS[status] ?? 'bg-gray-100 text-gray-600'}">{batch.kind !== 'batch' && status === 'passed' ? 'passed' : (LABEL[status] ?? status)}</span>
		{#if batch.express}<span class="rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-700" title="A small batch of urgent PRs, ahead of the rest">urgent</span>{/if}
		<a href="https://github.com/{owner}/{name}/commit/{batch.headSha}" target="_blank" rel="noopener" class="hidden max-w-[12rem] truncate font-mono text-[11px] text-gray-400 hover:text-indigo-600 sm:inline" title={batch.branch}>{batch.branch}</a>
		<span class="ml-auto text-xs text-gray-400">{batch.finishedAt ? `took ${since(batch.createdAt, batch.finishedAt)}` : `running ${since(batch.createdAt, null)}`}</span>
		{#if cancellable}
			<form
				method="POST"
				action="/repos/{owner}/{name}?/cancelBatch"
				use:enhance={({ cancel }) => {
					if (!confirm(`Cancel batch ${batch.id}? Its CI stops and its PRs go back in line, blamed for nothing. Batches built on it are rebuilt.`)) cancel();
				}}
			>
				<input type="hidden" name="batch_id" value={batch.id} />
				<button type="submit" class="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-red-50 hover:text-red-700" aria-label="Cancel batch {batch.id}">Cancel</button>
			</form>
		{/if}
	</div>


{#snippet bar(p: NonNullable<Card['progress']>)}
	<div class="flex h-2 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuenow={p.done} aria-valuemax={p.total} aria-label="CI jobs finished">
		<div class="bg-green-500" style="width: {pct(p, p.done - p.failed)}%"></div>
		<div class="bg-red-500" style="width: {pct(p, p.failed)}%"></div>
		<div class="bg-amber-400 motion-safe:animate-pulse" style="width: {pct(p, p.running)}%"></div>
	</div>
	<div class="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-500">
		<span>{p.done}/{p.total} jobs done</span>
		{#if p.running > 0}<span>{p.running} running</span>{/if}
		{#if p.total - p.done - p.running > 0}<span>{p.total - p.done - p.running} waiting for a runner</span>{/if}
		{#if p.failed > 0}<span class="text-red-600">failed: {p.failedJobs.join(', ')}</span>{/if}
		{#if p.url}<a href={p.url} target="_blank" rel="noopener" class="hover:text-indigo-600">open CI</a>{/if}
	</div>
{/snippet}

	{#if batch.status === 'bisecting'}
		<!-- What runs now leads; the batch's own run already ended and failed. -->
		{#each nowSteps as { run, step } (run.id)}
			{@const err = progressErrors[run.headSha] ?? null}
			<div class="mt-2 rounded-lg bg-amber-50/60 px-2.5 py-2">
				<p class="mb-1.5 text-xs text-gray-700">
					<span class="font-semibold">Now: step {step}</span>
					<span class="text-gray-500">· {run.prs.length === 1 && !run.context.length ? `#${run.prs[0].pr} alone` : prList(run.prs.map((x) => x.pr))}</span>
					{#if run.context.length}<span class="text-gray-500"> on top of {prList(run.context)}</span>{/if}
				</p>
				{#if run.progress}
					{@render bar(run.progress)}
					{#if err}<p class="mt-1 text-xs text-red-600">Last known progress; reading it now failed: {err}</p>{/if}
				{:else}
					<p class="text-xs {err ? 'text-red-600' : 'text-gray-500'}">{err ? `Could not read CI progress: ${err}` : 'No CI run found for it yet.'}</p>
				{/if}
			</div>
		{:else}
			<p class="mt-2 text-xs text-gray-500">Between steps: the queue starts the next one on its next run, after any urgent batch.</p>
		{/each}
		<p class="mt-1.5 text-xs text-gray-500">
			The batch's own run failed{p && p.failed > 0 ? `: ${p.failedJobs.join(', ')}` : ''}{#if p?.url}&nbsp;·&nbsp;<a href={p.url} target="_blank" rel="noopener" class="hover:text-indigo-600">open CI</a>{/if}
		</p>
	{:else if p}
		<div class="mt-2">{@render bar(p)}</div>
		{#if progressError}<p class="mt-1 text-xs text-red-600">Last known progress; reading it now failed: {progressError}</p>{/if}
	{:else if batch.status === 'testing' && !batch.finishedAt}
		<p class="mt-2 text-xs {progressError ? 'text-red-600' : 'text-gray-500'}">{progressError ? `Could not read CI progress: ${progressError}` : 'No CI run found for it yet.'}</p>
	{/if}

	{#if batch.context.length > 0}
		<p class="mt-2 text-xs text-gray-500">On top of {prList(batch.context)}, which passed</p>
	{/if}

	{#if verdictCounts.length}
		<p class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
			{#each verdictCounts as [v, c] (v)}
				<span class="inline-flex items-center gap-1"
					><span class="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] leading-none {VERDICT[v].cls}" aria-hidden="true">{VERDICT[v].icon}</span
					><span class="font-semibold">{c}</span> {VERDICT[v].label}</span
				>
			{/each}
			{#if activityCounts.length}<span class="text-gray-300" aria-hidden="true">|</span>{/if}
			{#each activityCounts as [a, c] (a)}
				<span class="inline-flex items-center gap-1"
					><span class="inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-100 text-[10px] leading-none text-gray-500 {ACTIVITY[a].cls}" aria-hidden="true"></span
					><span class="font-semibold">{c}</span> {ACTIVITY[a].label}</span
				>
			{/each}
		</p>
	{/if}

	<ul class="mt-2 space-y-1 text-sm">
		{#each batch.prs as pr (pr.pr)}
			<li class="flex min-w-0 items-center gap-2" style="padding-left: {pr.depth * 1.25}rem">
				{#if pr.depth > 0}<span class="text-gray-400" aria-hidden="true">└</span>{/if}
				{#if pr.verdict}
					{@const label = [VERDICT[pr.verdict].label, pr.activity ? ACTIVITY[pr.activity].label : null].filter(Boolean).join(', ')}
					<span
						class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] leading-none {VERDICT[pr.verdict].cls} {pr.activity ? ACTIVITY[pr.activity].cls : ''}"
						title="{label}{pr.trail ? `\n${pr.trail}` : ': not in any run yet'}"
						role="img"
						aria-label={label}>{VERDICT[pr.verdict].icon}</span
					>
				{/if}
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
		<details class="mt-3">
			<summary class="cursor-pointer text-xs text-gray-500 hover:text-gray-700">
				{batch.bisection.length} bisection step{batch.bisection.length === 1 ? '' : 's'}{runningRuns ? `, ${runningRuns} going` : ''}
			</summary>
			<div class="mt-2 space-y-2 border-l-2 border-orange-200 pl-3">
				{#each batch.bisection as run, i (run.id)}
					<BatchCard batch={run} {owner} {name} nested step={i + 1} {progressErrors} />
				{/each}
			</div>
		</details>
	{/if}
</div>
