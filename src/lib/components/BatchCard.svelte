<script lang="ts">
	import { enhance } from '$app/forms';
	import { runHref } from '$lib/actions-link';
	import { runNote } from '$lib/run-note';
	import { runStatus } from '$lib/run-status';
	import { batchStats } from '$lib/batch-stats';
	import type { RunSlot } from '$lib/run-order';
	import PrepCard from './PrepCard.svelte';
	import StatusChip from './StatusChip.svelte';
	import type { BatchCard as Card } from '$lib/server/batch-view';

	// A running batch or run of its own (a try, the check of the default branch). Colour lives in
	// the status chip and the bars only; what runs inside a batch is a row in its well.
	let {
		batch,
		owner,
		name,
		canCancel = false,
		progressErrors = {},
		stopsEarly = true,
		prep = [],
		now = Date.now()
	}: {
		batch: Card;
		owner: string;
		name: string;
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
	const p = $derived(batch.progress);
	const status = $derived(runStatus(batch));
	const stats = $derived(batchStats(batch, now));
	const note = $derived(runNote(batch, stopsEarly));
	const waiting = $derived(!batch.finishedAt && ['testing', 'retrying'].includes(batch.status));
	// Close the actions menu on a click outside it or on Escape.
	function dismiss(el: HTMLDetailsElement) {
		const close = (e: Event) => {
			if (!el.open) return;
			if (e instanceof KeyboardEvent ? e.key === 'Escape' : !el.contains(e.target as Node)) el.open = false;
		};
		document.addEventListener('click', close);
		document.addEventListener('keydown', close);
		return {
			destroy: () => {
				document.removeEventListener('click', close);
				document.removeEventListener('keydown', close);
			}
		};
	}
	// A big batch lists its first PRs; the rest fold away.
	const MAX_PRS = 8;
	const live = $derived(!batch.finishedAt || status === 'failing');

	const fmt = (ms: number) => {
		const m = Math.max(0, Math.floor(ms / 60000));
		return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
	};
	const title = $derived(
		batch.kind === 'batch'
			? `${batch.express ? 'Urgent batch' : 'Batch'} #${batch.number}`
			: batch.kind === 'try'
				? `Try #${batch.prs[0]?.pr ?? ''}`
				: batch.kind === 'baseline'
					? 'Check of master'
					: 'Bisection step'
	);
	const DOT: Record<string, string> = { testing: 'bg-sky-500', retrying: 'bg-sky-500', bisecting: 'bg-violet-500', failing: 'bg-red-500', passed: 'bg-green-500' };
	const pct = (n: number, total: number) => (total > 0 ? (n / total) * 100 : 0);

	// A bisection, PR by PR: cleared, still suspect, in a step running now, or pinned down.
	const SEG: Record<string, { cls: string; label: string }> = {
		cleared: { cls: 'bg-green-500', label: 'cleared' },
		checking: { cls: 'bg-sky-400', label: 'in a step' },
		suspect: { cls: 'bg-gray-300', label: 'suspect' },
		failing: { cls: 'bg-red-500', label: 'failing' }
	};
	const segOf = (pr: Card['prs'][number]) =>
		pr.verdict === 'failing' ? 'failing' : pr.verdict === 'passing' || pr.activity === 'landed' ? 'cleared' : pr.activity === 'checking' ? 'checking' : 'suspect';
	const bisecting = $derived(stats.runs !== null);
	const segs = $derived(batch.prs.map((x) => ({ pr: x.pr, seg: segOf(x) })));
	const segCount = (k: string) => segs.filter((s) => s.seg === k).length;
	// In a bisection only the PRs still to settle are listed; the rest fold away.
	const open = $derived(bisecting ? batch.prs.filter((x) => !x.settled && x.verdict !== 'passing') : batch.prs);
	const folded = $derived(bisecting ? batch.prs.filter((x) => !open.includes(x)) : []);
	const finished = $derived(batch.bisection.filter((r) => !stats.running.includes(r)));
	const stepNo = (r: Card) => batch.bisection.indexOf(r) + 1;
	const prLink = (n: number, url = '') => url || `https://github.com/${owner}/${name}/pull/${n}`;
</script>

{#snippet prRow(pr: Card['prs'][number])}
	<li class="flex min-w-0 items-center gap-2" style="padding-left: {pr.depth}rem">
					{#if pr.depth > 0}<span class="text-gray-300" aria-hidden="true">└</span>{/if}
					{#if bisecting}<span class="h-1.5 w-1.5 shrink-0 rounded-full {SEG[segOf(pr)].cls}" title={SEG[segOf(pr)].label} aria-label={SEG[segOf(pr)].label}></span>{/if}
					<a href={prLink(pr.pr, pr.url)} target="_blank" rel="noopener" class="shrink-0 font-mono text-xs text-gray-500 hover:text-indigo-600">#{pr.pr}</a>
					<span class="min-w-0 truncate text-gray-800" title={pr.trail || pr.title}>{pr.title}</span>
					{#if pr.link && pr.link !== 'healthy'}<span class="shrink-0 rounded bg-amber-50 px-1.5 text-[11px] text-amber-800">{pr.link}</span>{/if}
				</li>
{/snippet}

{#snippet jobsBar(pr: NonNullable<Card['progress']>, small: boolean)}
	<div class="flex overflow-hidden rounded-full bg-gray-100 {small ? 'h-1 w-16 shrink-0' : 'h-1.5'}" role="progressbar" aria-valuenow={pr.done} aria-valuemax={pr.total} aria-label="CI jobs finished">
		<div class="bg-green-500" style="width: {pct(pr.done - pr.failed, pr.total)}%"></div>
		<div class="bg-red-500" style="width: {pct(pr.failed, pr.total)}%"></div>
		<div class="bg-sky-300" style="width: {pct(pr.running, pr.total)}%"></div>
	</div>
{/snippet}

<article id="batch-{batch.id}" class="scroll-mt-4 rounded-xl border border-border-subtle bg-surface-raised p-3 shadow-sm sm:p-4">
	<header class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
		<span class="h-2 w-2 shrink-0 rounded-full {DOT[status] ?? 'bg-gray-300'} {live ? 'motion-safe:animate-pulse' : ''}" aria-hidden="true"></span>
		<h3 class="shrink-0 text-sm font-semibold text-gray-900">{title}</h3>
		{#if batch.kind === 'batch'}<span class="hidden shrink-0 text-xs text-gray-500 sm:inline">{batch.prs.length} PR{batch.prs.length === 1 ? '' : 's'}</span>{/if}
		<span class="min-w-0 truncate"><StatusChip {status} label={status === 'passed' && batch.kind === 'batch' ? 'passed, landing' : null} /></span>
		<span class="ml-auto shrink-0 text-xs tabular-nums text-gray-500" title="Started {batch.createdAt} UTC">{fmt(stats.elapsedMs)}</span>
		<details class="relative shrink-0" use:dismiss>
			<summary class="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md text-gray-500 hover:bg-surface-sunken hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 sm:h-7 sm:w-7 [&::-webkit-details-marker]:hidden" aria-label="Actions for {title}">
				<svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" /></svg>
			</summary>
			<div class="absolute right-0 z-10 mt-1 w-52 overflow-hidden rounded-lg border border-border-subtle bg-surface-raised py-1 text-sm shadow-lg">
				<a href={runHref(owner, name, batch)} target="_blank" rel="noopener" class="block px-3 py-1.5 text-gray-700 hover:bg-surface-sunken">{batch.runUrl ? 'Open the CI run' : 'GitHub Actions runs'}</a>
				{#if p?.url}<a href={p.url} target="_blank" rel="noopener" class="block px-3 py-1.5 text-gray-700 hover:bg-surface-sunken">{p.failed ? 'Open the failed job' : 'Open a running job'}</a>{/if}
				<a href="https://github.com/{owner}/{name}/commit/{batch.headSha}" target="_blank" rel="noopener" class="block px-3 py-1.5 text-gray-700 hover:bg-surface-sunken">Commit <span class="font-mono text-xs text-gray-500">{batch.headSha.slice(0, 7)}</span></a>
				{#if cancellable}
					<form
						method="POST"
						action="/repos/{owner}/{name}?/cancelBatch"
						use:enhance={({ cancel }) => {
							if (!confirm(`Cancel batch ${batch.number}? Its CI stops and its PRs go back in line, blamed for nothing. Batches built on it are rebuilt.`)) cancel();
						}}
						class="border-t border-border-subtle"
					>
						<input type="hidden" name="batch_id" value={batch.id} />
						<button type="submit" class="block w-full px-3 py-1.5 text-left text-red-700 hover:bg-red-50">Cancel batch</button>
					</form>
				{/if}
			</div>
		</details>
	</header>

	<!-- Statistics: the jobs of its CI, or how far its bisection has got. -->
	{#if bisecting}
		<div class="mt-2.5">
			<div class="flex h-1.5 gap-px overflow-hidden rounded-full" role="img" aria-label="{segCount('cleared')} cleared, {segCount('checking')} in a step, {segCount('suspect')} suspect, {segCount('failing')} failing">
				{#each segs as s (s.pr)}<div class="flex-1 {SEG[s.seg].cls}" title="#{s.pr}: {SEG[s.seg].label}"></div>{/each}
			</div>
			<p class="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-500">
				{#each ['cleared', 'checking', 'suspect', 'failing'] as k (k)}
					{#if segCount(k)}<span class="inline-flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full {SEG[k].cls}" aria-hidden="true"></span><span class="font-medium tabular-nums text-gray-800">{segCount(k)}</span> {SEG[k].label}</span>{/if}
				{/each}
				<span><span class="font-medium tabular-nums text-gray-800">{stats.runs?.total}</span> step{stats.runs?.total === 1 ? '' : 's'}</span>
			</p>
		</div>
	{:else if p && stats.jobs}
		<div class="mt-2.5">
			{@render jobsBar(p, false)}
			<p class="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-500">
				<span><span class="font-medium tabular-nums text-gray-800">{stats.jobs.done}/{stats.jobs.total}</span> jobs</span>
				{#if stats.jobs.running}<span><span class="font-medium tabular-nums text-gray-800">{stats.jobs.running}</span> running</span>{/if}
				{#if stats.jobs.waiting}<span><span class="font-medium tabular-nums text-gray-800">{stats.jobs.waiting}</span> waiting for a runner</span>{/if}
				{#if stats.jobs.failed}<span class="text-red-700"><span class="font-medium tabular-nums">{stats.jobs.failed}</span> failed{batch.kind !== 'batch' ? `: ${p.failedJobs.join(', ')}` : ''}</span>{/if}
			</p>
		</div>
		{#if progressError}<p class="mt-1 text-xs text-gray-500" title={progressError}>Last known progress; reading it now failed: {progressError}</p>{/if}
	{:else if progressError}
		<p class="mt-2 text-xs text-gray-500" title={progressError}>Could not read CI progress: {progressError}</p>
	{:else if waiting}
		<p class="mt-2 text-xs text-gray-500">Waiting for its CI to start.</p>
	{/if}
	{#if note}<p class="mt-1.5 text-xs text-gray-600">{note}</p>{/if}

	<!-- What runs inside the batch now: preparation first, then each step still going, one row each. -->
	{#if prep.length > 0 || stats.running.length > 0}
		<div class="mt-3 divide-y divide-border-subtle overflow-hidden rounded-lg bg-surface-sunken/60">
			{#each prep as slot (slot.key)}
				<PrepCard {slot} inWell />
			{/each}
			{#each stats.running as run (run.id)}
				{@const rs = runStatus(run)}
				<div class="flex min-w-0 items-center gap-2 px-3 py-2 text-sm">
					<span class="h-1.5 w-1.5 shrink-0 rounded-full {rs === 'failing' ? 'bg-red-500' : 'bg-sky-500'}" aria-hidden="true"></span>
					<a href={runHref(owner, name, run)} target="_blank" rel="noopener" class="shrink-0 font-medium text-gray-900 hover:text-indigo-600" title={run.runUrl ? `CI run of ${run.branch}` : `GitHub Actions runs of ${run.branch}`}>Step {stepNo(run)}</a>
					<span class="min-w-0 truncate font-mono text-xs text-gray-500" title={run.prs.map((x) => `#${x.pr}`).join(' ')}>{run.prs.length === 1 ? `#${run.prs[0].pr} alone` : run.prs.map((x) => `#${x.pr}`).join(' ')}</span>
					{#if rs === 'failing'}<StatusChip status="failing" />{/if}
					<span class="ml-auto flex shrink-0 items-center gap-2">
						{#if run.progress}<span class="hidden sm:flex">{@render jobsBar(run.progress, true)}</span><span class="w-11 text-right text-xs tabular-nums text-gray-500">{run.progress.done}/{run.progress.total}</span>{/if}
						<span class="hidden w-12 text-right text-xs tabular-nums text-gray-500 sm:inline">{fmt(batchStats(run, now).elapsedMs)}</span>
					</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if batch.kind === 'batch'}
		{#if batch.context.length > 0}<p class="mt-2 text-xs text-gray-500">On top of {batch.context.map((n) => `#${n}`).join(' ')}, which passed</p>{/if}
		<ul class="mt-2.5 space-y-0.5 text-[13px]">
			{#each open.slice(0, MAX_PRS) as pr (pr.pr)}{@render prRow(pr)}{/each}
		</ul>
		{#if open.length > MAX_PRS}
			<details class="mt-1">
				<summary class="cursor-pointer select-none text-xs text-gray-500 hover:text-gray-800">+{open.length - MAX_PRS} more</summary>
				<ul class="mt-0.5 space-y-0.5 text-[13px]">
					{#each open.slice(MAX_PRS) as pr (pr.pr)}{@render prRow(pr)}{/each}
				</ul>
			</details>
		{/if}
		{#if folded.length > 0 || finished.length > 0}
			<details class="mt-2 text-xs text-gray-500">
				<summary class="cursor-pointer select-none hover:text-gray-800">
					{[folded.length ? `${folded.length} settled` : '', finished.length ? `${finished.length} finished step${finished.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}
				</summary>
				<ul class="mt-1.5 space-y-0.5">
					{#each folded as pr (pr.pr)}
						<li class="flex min-w-0 items-center gap-2">
							<span class="h-1.5 w-1.5 shrink-0 rounded-full {SEG[segOf(pr)].cls}" aria-hidden="true"></span>
							<a href={prLink(pr.pr, pr.url)} target="_blank" rel="noopener" class="shrink-0 font-mono hover:text-indigo-600">#{pr.pr}</a>
							<span class="min-w-0 truncate">{pr.title}</span>
							<span class="ml-auto shrink-0">{pr.activity === 'landed' ? 'landed' : pr.activity === 'left' ? 'back in line' : pr.verdict === 'failing' ? 'failing' : 'cleared'}</span>
						</li>
					{/each}
					{#each finished as run (run.id)}
						<li class="flex min-w-0 items-center gap-2">
							<span class="shrink-0">Step {stepNo(run)}</span>
							<span class="min-w-0 truncate font-mono">{run.prs.map((x) => `#${x.pr}`).join(' ')}</span>
							<span class="ml-auto shrink-0"><StatusChip status={runStatus(run) === 'landed' ? 'passed' : runStatus(run)} /></span>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	{/if}
</article>
