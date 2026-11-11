<script lang="ts">
	import { enhance } from '$app/forms';
	import { actionsUrl } from '$lib/actions-link';
	import { runNote } from '$lib/run-note';
	import { runStatus } from '$lib/run-status';
	import { batchStats } from '$lib/batch-stats';
	import type { RunSlot } from '$lib/run-order';
	import BatchCard from './BatchCard.svelte';
	import PrepCard from './PrepCard.svelte';
	import type { BatchCard as Card } from '$lib/server/batch-view';

	let {
		batch,
		owner,
		name,
		inBatch = false,
		step = null,
		canCancel = false,
		progressErrors = {},
		stopsEarly = true,
		prep = [],
		now = Date.now()
	}: {
		batch: Card;
		owner: string;
		name: string;
		/** A run drawn inside its batch: no errors of its own, the batch shows how it went. */
		inBatch?: boolean;
		step?: number | null;
		canCancel?: boolean;
		/** Why CI progress could not be read, by head commit. */
		progressErrors?: Record<string, string>;
		/** The repo's stop-on-first-failure setting, for why a run goes on. */
		stopsEarly?: boolean;
		/** The queue's own work on this batch now: preparing a bisection step, landing. */
		prep?: RunSlot[];
		now?: number;
	} = $props();
	const progressError = $derived(progressErrors[batch.headSha] ?? null);
	const cancellable = $derived(canCancel && batch.kind === 'batch' && ['testing', 'retrying', 'bisecting', 'passed'].includes(batch.status));

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

	const fmt = (ms: number) => {
		const m = Math.max(0, Math.round(ms / 60000));
		return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
	};

	const p = $derived(batch.progress);
	const status = $derived(runStatus(batch));
	// Why a run of one PR goes on after a failure; inside a batch the batch tells how it went.
	const note = $derived(inBatch ? null : runNote(batch, stopsEarly));
	const stats = $derived(batchStats(batch, now));
	// A batch shows how many jobs failed; which ones, only a run of its own (a try) names.
	const namesFailures = $derived(!inBatch && batch.kind !== 'batch');
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
	const finishedRuns = $derived(batch.bisection.filter((r) => !stats.running.includes(r)));
	const pct = (n: number) => (p && p.total > 0 ? (n / p.total) * 100 : 0);
	const live = $derived(!batch.finishedAt || status === 'failing');
	const tone = $derived(status === 'failing' ? 'border-red-200' : live ? 'border-amber-200' : 'border-border-subtle');
</script>

<div id={inBatch ? undefined : `batch-${batch.id}`} class="scroll-mt-4 rounded-xl border bg-surface-raised {tone} {inBatch ? 'p-2.5' : 'p-4'}">
	<div class="flex flex-wrap items-center gap-2 text-sm">
		{#if live}<span class="inline-block h-2 w-2 shrink-0 rounded-full {status === 'failing' ? 'bg-red-500' : 'bg-amber-400'} motion-safe:animate-pulse" aria-hidden="true"></span>{/if}
		<span class="font-semibold text-gray-900">{batch.express ? 'Urgent batch' : KIND[batch.kind]} {batch.kind === 'batch' ? `#${batch.number}` : step !== null ? step : ''}</span>
		<span class="rounded px-1.5 py-0.5 text-xs {STATUS[status] ?? 'bg-gray-100 text-gray-600'}">{batch.kind !== 'batch' && status === 'passed' ? 'passed' : (LABEL[status] ?? status)}</span>
		{#if batch.kind !== 'batch' && batch.prs.length > 0}<span class="min-w-0 truncate text-xs text-gray-500">{batch.prs.length === 1 ? `#${batch.prs[0].pr} alone` : prList(batch.prs.map((x) => x.pr))}</span>{/if}
		<a href={actionsUrl(owner, name, batch.branch)} target="_blank" rel="noopener" class="text-xs text-gray-500 hover:text-indigo-600" title="GitHub Actions runs of {batch.branch}">Actions</a>
		<span class="ml-auto text-xs tabular-nums text-gray-500">{batch.finishedAt ? `took ${fmt(stats.elapsedMs)}` : fmt(stats.elapsedMs)}</span>
		{#if cancellable}
			<form
				method="POST"
				action="/repos/{owner}/{name}?/cancelBatch"
				use:enhance={({ cancel }) => {
					if (!confirm(`Cancel batch ${batch.number}? Its CI stops and its PRs go back in line, blamed for nothing. Batches built on it are rebuilt.`)) cancel();
				}}
			>
				<input type="hidden" name="batch_id" value={batch.id} />
				<button type="submit" class="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-red-50 hover:text-red-700" aria-label="Cancel batch {batch.number}">Cancel</button>
			</form>
		{/if}
	</div>

	{#if note}<p class="mt-1 text-xs text-gray-600">{note}</p>{/if}

	<!-- Statistics: the jobs of its CI, or the runs of its bisection. -->
	{#if stats.jobs && p}
		<div class="mt-2">
			<div class="flex h-1.5 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuenow={p.done} aria-valuemax={p.total} aria-label="CI jobs finished">
				<div class="bg-green-500" style="width: {pct(p.done - p.failed)}%"></div>
				<div class="bg-red-500" style="width: {pct(p.failed)}%"></div>
				<div class="animate-pulse bg-amber-400" style="width: {pct(p.running)}%"></div>
			</div>
			<dl class="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-500">
				<div><dt class="inline">jobs</dt> <dd class="inline font-medium tabular-nums text-gray-700">{stats.jobs.done}/{stats.jobs.total}</dd></div>
				{#if stats.jobs.running}<div><dd class="inline font-medium tabular-nums text-gray-700">{stats.jobs.running}</dd> <dt class="inline">running</dt></div>{/if}
				{#if stats.jobs.waiting}<div><dd class="inline font-medium tabular-nums text-gray-700">{stats.jobs.waiting}</dd> <dt class="inline">waiting for a runner</dt></div>{/if}
				{#if stats.jobs.failed}<div class="text-red-600"><dd class="inline font-medium tabular-nums">{stats.jobs.failed}</dd> <dt class="inline">failed{namesFailures ? `: ${p.failedJobs.join(', ')}` : ''}</dt></div>{/if}
				{#if p.url && !inBatch}<a href={p.url} target="_blank" rel="noopener" class="hover:text-indigo-600">open CI</a>{/if}
			</dl>
		</div>
		{#if progressError && !inBatch}<p class="mt-1 text-xs text-red-600">Last known progress; reading it now failed: {progressError}</p>{/if}
	{:else if stats.runs}
		<dl class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
			<div><dd class="inline font-medium tabular-nums text-gray-700">{stats.runs.total}</dd> <dt class="inline">bisection run{stats.runs.total === 1 ? '' : 's'}</dt></div>
			{#if stats.runs.running}<div><dd class="inline font-medium tabular-nums text-gray-700">{stats.runs.running}</dd> <dt class="inline">running</dt></div>{/if}
			{#if stats.runs.passed}<div><dd class="inline font-medium tabular-nums text-gray-700">{stats.runs.passed}</dd> <dt class="inline">passed</dt></div>{/if}
			{#if stats.runs.failed}<div><dd class="inline font-medium tabular-nums text-gray-700">{stats.runs.failed}</dd> <dt class="inline">failed</dt></div>{/if}
			{#if verdictCounts.length}<span class="text-gray-300" aria-hidden="true">|</span>{/if}
			{#each verdictCounts as [v, c] (v)}
				<span class="inline-flex items-center gap-1"
					><span class="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] leading-none {VERDICT[v].cls}" aria-hidden="true">{VERDICT[v].icon}</span
					><span class="font-medium text-gray-700">{c}</span> {VERDICT[v].label}</span
				>
			{/each}
		</dl>
	{:else if batch.status === 'testing' && !batch.finishedAt}
		<p class="mt-2 text-xs {progressError && !inBatch ? 'text-red-600' : 'text-gray-500'}">{progressError && !inBatch ? `Could not read CI progress: ${progressError}` : 'Waiting for its CI to start.'}</p>
	{/if}

	{#if batch.context.length > 0}
		<p class="mt-1 text-xs text-gray-500">On top of {prList(batch.context)}, which passed</p>
	{/if}

	<!-- What runs inside the batch now: the queue preparing its next step, and its runs still going. -->
	{#if prep.length > 0 || stats.running.length > 0}
		<div class="mt-3 space-y-2 border-l-2 border-amber-200 pl-3">
			{#each prep as slot (slot.key)}
				<PrepCard {slot} />
			{/each}
			{#each stats.running as run (run.id)}
				<BatchCard batch={run} {owner} {name} inBatch step={batch.bisection.indexOf(run) + 1} {progressErrors} {stopsEarly} {now} />
			{/each}
		</div>
	{/if}

	{#if batch.kind === 'batch'}
		<ul class="mt-3 space-y-1 text-sm">
			{#each batch.prs as pr, i (pr.pr)}
				{#if pr.settled && !batch.prs[i - 1]?.settled && i > 0}
					<li class="pt-1 text-xs font-medium text-gray-400" aria-hidden="true">Settled: landed, ejected or back in line</li>
				{/if}
				<li class="flex min-w-0 items-center gap-2 {pr.settled ? 'opacity-60' : ''}" style="padding-left: {pr.depth * 1.25}rem">
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
	{/if}

	{#if finishedRuns.length > 0}
		<details class="mt-3">
			<summary class="cursor-pointer text-xs text-gray-500 hover:text-gray-700">{finishedRuns.length} finished bisection run{finishedRuns.length === 1 ? '' : 's'}</summary>
			<div class="mt-2 space-y-2 border-l-2 border-gray-200 pl-3">
				{#each finishedRuns as run (run.id)}
					<BatchCard batch={run} {owner} {name} inBatch step={batch.bisection.indexOf(run) + 1} {stopsEarly} {now} />
				{/each}
			</div>
		</details>
	{/if}
</div>
