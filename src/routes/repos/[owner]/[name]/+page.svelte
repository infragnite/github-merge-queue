<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import QueueItem from '$lib/components/QueueItem.svelte';
	import AttentionRow from '$lib/components/AttentionRow.svelte';
	import BatchCard from '$lib/components/BatchCard.svelte';
	import SavingsCard from '$lib/components/SavingsCard.svelte';
	import PrepCard from '$lib/components/PrepCard.svelte';
	import { runningWork } from '$lib/running-work';
	import { historyOutcome, historyTimeline, type HistoryEntry } from '$lib/history-timeline';
	import { queueSummary } from '$lib/queue-summary';
	import { page } from '$app/state';

	let { data, form } = $props();

	// The streamed sections keep showing what they last loaded while a refresh is in flight,
	// so the page doesn't empty and relayout every time it refreshes.
	type Loaded<T> = T extends Promise<infer V> ? V : never;
	let pipe = $state<Loaded<typeof data.pipeline> | null>(null);
	let board = $state<Loaded<typeof data.board> | null>(null);
	// How far the server's clock is ahead of this browser's, so a step's running time is right.
	let skew = $state(0);
	// Ticks every second, so how long a step has been running counts up between refreshes.
	let clock = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (clock = Date.now()), 1000);
		return () => clearInterval(id);
	});
	$effect(() => {
		let current = true;
		data.pipeline
			.then((v) => {
				if (!current) return;
				pipe = v;
				skew = v.serverTime ? v.serverTime - Date.now() : 0;
			})
			.catch(() => {});
		data.board.then((v) => current && (board = v)).catch(() => {});
		return () => {
			current = false;
		};
	});
	let showAddDialog = $state(false);
	let refreshing = $state(false);
	let dragIndex = $state<number | null>(null);
	let dragOverIndex = $state<number | null>(null);
	let reordering = $state(false);
	let search = $state('');

	const batchMode = $derived(data.mode === 'batch');
	// Without write access (or signed out on a public page): everything shows, nothing can be changed.
	// The server checks the role on every action anyway; this only hides what would be refused.
	const readonly = $derived(!data.can.queue);
	// The queue as the planners see it (built on the server by their queue model): stacks in the
	// order the queue takes them, and the PRs held back until someone acts, with why.
	const items = $derived(new Map(data.queueItems.map((i) => [i.pr_number, i])));
	type BoardStack = NonNullable<typeof board>['stacks'][number];
	type BoardHeld = NonNullable<typeof board>['attention'][number];
	const needle = $derived(search.trim().toLowerCase().replace(/^#/, ''));
	const matchesPr = (n: number) => {
		const i = items.get(n);
		return !needle || String(n).startsWith(needle) || (!!i && (i.pr_title.toLowerCase().includes(needle) || i.author_login.toLowerCase().includes(needle)));
	};
	// PRs a batch is being formed from show in its preparation row, not again in line.
	const forming = $derived(new Set(pipe?.activity?.phase?.kind === 'forming' ? pipe.activity.phase.prs : []));
	const lineStacks = $derived((board?.stacks ?? []).map((s: BoardStack) => ({ ...s, rows: s.rows.filter((r) => !forming.has(r.pr)) })).filter((s: BoardStack) => s.rows.length > 0));
	// A stack shows whole while any of its PRs matches the search.
	const shownStacks = $derived(lineStacks.filter((s: BoardStack) => s.rows.some((r) => matchesPr(r.pr))));
	const inLine = $derived(lineStacks.reduce((n: number, s: BoardStack) => n + s.rows.length, 0));
	const attention = $derived((board?.attention ?? []).filter((h: BoardHeld) => items.has(h.pr)));
	// Everything running now, the queue's own preparation first, in the order it holds the runners.
	const work = $derived(pipe ? runningWork({ active: pipe.active, master: pipe.master ? { ...pipe.master, branch: data.repo.default_branch } : null, activity: pipe.activity, now: clock + skew }) : []);
	const view = $derived(((v) => (v === 'attention' || v === 'history' ? v : 'now'))(page.url.searchParams.get('view')));
	const summary = $derived(queueSummary(work, inLine));
	// Finished batches and the PRs that left the queue, in one list, by day, filtered.
	let outcome = $state('all');
	let historySearch = $state('');
	const timeline = $derived(historyTimeline(pipe?.recent ?? [], data.history));
	const outcomeOf = (e: HistoryEntry) => historyOutcome(e);
	const shownHistory = $derived(
		timeline.filter((e) => {
			if (outcome !== 'all' && historyOutcome(e) !== outcome) return false;
			const q = historySearch.trim().replace(/^#/, '');
			if (!q) return true;
			return e.kind === 'pr' ? String(e.row.pr_number).startsWith(q) : e.card.prs.some((x) => String(x.pr).startsWith(q)) || String(e.card.number) === q;
		})
	);
	const dayLabel = (ms: number) => {
		const d = new Date(ms).toDateString();
		if (d === new Date(clock).toDateString()) return 'Today';
		if (d === new Date(clock - 86_400_000).toDateString()) return 'Yesterday';
		return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
	};
	const historyDays = $derived(
		shownHistory.reduce((days: { label: string; entries: HistoryEntry[] }[], e) => {
			const label = dayLabel(e.at);
			const last = days.at(-1);
			if (last?.label === label) last.entries.push(e);
			else days.push({ label, entries: [e] });
			return days;
		}, [])
	);
	const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const took = (c: { createdAt: string; finishedAt: string | null }) => {
		if (!c.finishedAt) return '';
		const m = Math.max(0, Math.round((Date.parse(c.finishedAt.replace(' ', 'T') + 'Z') - Date.parse(c.createdAt.replace(' ', 'T') + 'Z')) / 60000));
		return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
	};

	const MASTER: Record<string, { label: string; tone: string; dot: string; hint: string }> = {
		green: { label: 'green', tone: 'text-green-700', dot: 'bg-green-500', hint: 'Batches build on it' },
		verifying: { label: 'CI after the last landing', tone: 'text-sky-700', dot: 'bg-sky-500', hint: 'The tree already passed in its batch; this run refreshes caches and releases' },
		checking: { label: 'checking a commit pushed outside the queue', tone: 'text-amber-700', dot: 'bg-amber-500', hint: 'Batches wait for this check' },
		red: { label: 'red', tone: 'text-red-700', dot: 'bg-red-500', hint: 'Only PRs that pass on it can land' }
	};

	async function refresh() {
		refreshing = true;
		await invalidateAll();
		refreshing = false;
	}

	// Auto-refresh every 10s when queue is active
	$effect(() => {
		const hasActive = data.queueItems.some(
			(i) => !['merged', 'failed', 'cancelled'].includes(i.status)
		);
		if (!hasActive) return;

		const id = setInterval(refresh, 10_000);
		return () => clearInterval(id);
	});

	function handleDragStart(index: number) {
		dragIndex = index;
	}

	function handleDragOver(e: DragEvent, index: number) {
		e.preventDefault();
		dragOverIndex = index;
	}

	function handleDragEnd() {
		dragIndex = null;
		dragOverIndex = null;
	}

	async function handleDrop(e: DragEvent, dropIndex: number) {
		e.preventDefault();
		if (dragIndex === null || dragIndex === dropIndex || needle) {
			handleDragEnd();
			return;
		}

		// Whole stacks move, by the indices of the list as shown; PRs being formed into a batch stay
		// first and everything else keeps its place after them.
		const order = lineStacks.map((s: BoardStack) => s.rows.map((r) => items.get(r.pr)!.id));
		const [moved] = order.splice(dragIndex, 1);
		order.splice(dropIndex, 0, moved);
		const byPosition = [...data.queueItems].sort((a, b) => a.position - b.position);
		const rows = [...byPosition.filter((i) => forming.has(i.pr_number)).map((i) => i.id), ...order.flat()];
		const inRows = new Set(rows);
		const orderedIds = [...rows, ...byPosition.map((i) => i.id).filter((id) => !inRows.has(id))];
		reordering = true;

		const formData = new FormData();
		formData.set('order', JSON.stringify(orderedIds));

		await fetch(`?/reorder`, {
			method: 'POST',
			body: formData
		});

		await invalidateAll();
		reordering = false;
		handleDragEnd();
	}

</script>

<svelte:head>
	<title>{data.repo.owner}/{data.repo.name} - Merge Queue</title>
</svelte:head>

<div class="space-y-4">
	<!-- Header: the repository, its default branch, how it merges, and what batching saved. -->
	<div class="flex items-start gap-3">
		{#if !data.anonymous}
			<a href="/" class="mt-1.5 shrink-0 text-gray-400 transition-colors hover:text-gray-600" aria-label="Back to dashboard">
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
				</svg>
			</a>
		{/if}
		<div class="min-w-0 flex-1">
			<h1 class="truncate text-xl font-bold text-gray-900 sm:text-2xl">
				<a href="https://github.com/{data.repo.owner}/{data.repo.name}" target="_blank" rel="noopener" class="hover:text-indigo-600">
					{data.repo.owner}<span class="text-gray-400">/</span>{data.repo.name}
				</a>
			</h1>
			<p class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500">
				<span>into <span class="font-mono text-gray-700">{data.repo.default_branch}</span></span>
				{#if pipe?.master}
					{@const m = MASTER[pipe.master.state] ?? { label: pipe.master.state, tone: 'text-gray-700', dot: 'bg-gray-400', hint: '' }}
					<span class="inline-flex items-center gap-1 {m.tone}" title={m.hint}><span class="h-1.5 w-1.5 rounded-full {m.dot}" aria-hidden="true"></span>{m.label} <span class="font-mono">{pipe.master.sha.slice(0, 7)}</span></span>
				{/if}
				{#if data.readonly}
					<span>{batchMode ? `batches of up to ${data.limits.maxBatch}` : 'one by one'}</span>
				{:else}
					<a href="/repos/{data.repo.owner}/{data.repo.name}/settings#strategy" class="hover:text-indigo-600" title="How the queue merges PRs; change it in the queue settings">{batchMode ? `batches of up to ${data.limits.maxBatch}` : 'one by one'}</a>
				{/if}
				<SavingsCard savings={data.savings} />
			</p>
		</div>
		<div class="flex shrink-0 items-center gap-1.5">
			{#if !data.readonly}
				<a href="/repos/{data.repo.owner}/{data.repo.name}/settings" class="rounded-lg p-2 text-gray-500 transition-colors hover:bg-surface-sunken hover:text-gray-800" aria-label="Queue settings" title="Queue settings: merge strategy, batches, CI">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
						<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
					</svg>
				</a>
			{/if}
			<button onclick={refresh} disabled={refreshing} class="rounded-lg p-2 text-gray-500 transition-colors hover:bg-surface-sunken hover:text-gray-800 disabled:opacity-50" aria-label="Refresh queue">
				<svg class="h-4 w-4 {refreshing ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
				</svg>
			</button>
			{#if !readonly}
				<button
					onclick={() => (showAddDialog = true)}
					class="ml-1 inline-flex items-center gap-1 whitespace-nowrap rounded-lg bg-indigo-600 px-2.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
					title={data.openPrs.length === 0 ? 'Every open PR is already queued' : `${data.openPrs.length} open PRs not queued`}
					aria-label="Add a PR"
				>
					<svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25z" /></svg><span class="hidden sm:inline">Add PR</span>
				</button>
			{/if}
		</div>
	</div>

	{#if pipe?.error}<p class="text-sm text-red-600">{pipe.error}</p>{/if}
	{#if form?.error}<p class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{form.error}</p>{/if}
	{#if pipe?.tickError && !pipe.rateLimitedUntil}
		<p class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
			The queue's last step failed: <span class="font-mono text-xs">{pipe.tickError.message}</span>
			{#if pipe.tickError.count > 1}<span class="text-xs text-red-600"> · {pipe.tickError.count}× since {new Date(pipe.tickError.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>{/if}
			<span class="block text-xs text-red-600">It tries again on its next step.</span>
		</p>
	{/if}
	{#if pipe?.rateLimitedUntil}
		<p class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
			GitHub's rate limit for this app is used up. The queue and CI progress resume at {new Date(pipe.rateLimitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; CI itself keeps running.
		</p>
	{/if}
	{#if pipe?.paused}
		<form method="POST" action="?/resume" use:enhance class="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
			<span class="min-w-0 flex-1">{data.readonly ? pipe.paused : `Paused: ${pipe.paused}`}</span>
			{#if data.can.resume}<button type="submit" class="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700">Resume</button>{/if}
		</form>
	{/if}

	<!-- Views: what runs now and the line; what needs someone; what already happened. -->
	<nav class="sticky top-0 z-20 -mx-4 flex gap-1 border-b border-border-subtle bg-surface/95 px-4 text-sm backdrop-blur sm:static sm:mx-0 sm:px-0" aria-label="Queue views">
		{#each [{ key: 'now', label: 'Now' }, { key: 'attention', label: 'Needs attention' }, { key: 'history', label: 'History' }] as v (v.key)}
			<a
				href={v.key === 'now' ? `/repos/${data.repo.owner}/${data.repo.name}` : `?view=${v.key}`}
				data-sveltekit-noscroll
				data-sveltekit-replacestate
				aria-current={view === v.key ? 'page' : undefined}
				class="-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 {view === v.key ? 'border-gray-900 font-medium text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'}"
			>
				{v.label}
				{#if v.key === 'attention' && attention.length > 0}
					<span class="inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded-full bg-red-600 px-1.5 text-[11px] font-semibold tabular-nums text-white" aria-hidden="true"
						><svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.1 2.6a1 1 0 011.8 0l5.8 10.6a1 1 0 01-.9 1.5H2.2a1 1 0 01-.9-1.5zM7.25 6v3.5h1.5V6zm0 4.75v1.5h1.5v-1.5z" /></svg>{attention.length}</span
					><span class="sr-only">: {attention.length} PR{attention.length === 1 ? '' : 's'} held</span>
				{/if}
			</a>
		{/each}
	</nav>

	{#if view === 'now'}
		<!-- One line over everything: what runs, what prepares, how much CI waits. -->
		{#if pipe}
			<p class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600" aria-label="Summary">
				{#each summary as part (part.label)}
					<span><span class="font-semibold tabular-nums {part.label.includes('failed') ? 'text-red-700' : 'text-gray-900'}">{part.value}</span> {part.label}</span>
				{/each}
			</p>
		{/if}

		<div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
			<!-- Running work in run order: preparation first, then the runs; cards keep their place. -->
			<section aria-labelledby="running" class="min-w-0 space-y-3">
				<h2 id="running" class="text-xs font-semibold uppercase tracking-wide text-gray-500">Running</h2>
				{#if !pipe}
					<p class="text-sm text-gray-500">Loading…</p>
				{:else if work.length === 0}
					<p class="rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">{batchMode && inLine ? 'Nothing is running. The next batch starts when the collect window ends or it is full.' : 'Nothing is running.'}</p>
				{:else}
					{#each work as w (w.key)}
						{#if w.kind === 'run'}
							<BatchCard batch={w.card} owner={data.repo.owner} name={data.repo.name} canCancel={data.can.cancel} progressErrors={pipe.progressErrors} stopsEarly={data.stopsEarly} prep={w.prep} now={clock + skew} />
						{:else}
							<PrepCard slot={w.slot} />
						{/if}
					{/each}
				{/if}
			</section>

			<section class="min-w-0 space-y-3 lg:sticky lg:top-4" aria-labelledby="in-line">
				<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h2 id="in-line" class="text-xs font-semibold uppercase tracking-wide text-gray-500">In line <span class="tabular-nums text-gray-500">{inLine}</span></h2>
					{#if data.queueItems.length > 0}
						<input type="search" bind:value={search} placeholder="Find #, title or author" class="ml-auto w-full rounded-lg border border-border-subtle bg-surface-raised px-2.5 py-1 text-sm sm:w-48" aria-label="Find a PR in the queue" />
					{/if}
				</div>
				{#if board?.error}<p class="text-sm text-red-600">{board.error}</p>{/if}
				{#if data.queueItems.length === 0}
					<p class="rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">Queue is empty.{#if !readonly} Add a pull request to start.{/if}</p>
				{:else if shownStacks.length > 0}
					<div class="overflow-hidden rounded-xl border border-border-subtle bg-surface-raised lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto" role="list">
						{#each shownStacks as st, index (st.root)}
							{@const drag = !batchMode && !needle && data.can.reorder && !readonly}
							<div
								role="listitem"
								draggable={drag ? 'true' : undefined}
								ondragstart={drag ? () => handleDragStart(index) : undefined}
								ondragover={drag ? (e) => handleDragOver(e, index) : undefined}
								ondrop={drag ? (e) => handleDrop(e, index) : undefined}
								ondragend={drag ? handleDragEnd : undefined}
								class="border-b border-border-subtle last:border-b-0 {st.rows.length > 1 ? 'border-l-2 border-l-sky-200' : ''} {dragOverIndex === index && dragIndex !== index ? 'border-t-2 border-t-indigo-400' : ''} {dragIndex === index ? 'opacity-40' : ''} {reordering ? 'pointer-events-none' : ''}"
							>
								{#each st.rows as r, k (r.pr)}
									<QueueItem
										{readonly}
										canUrgent={data.can.urgent}
										item={items.get(r.pr)!}
										position={k === 0 ? index + 1 : null}
										repoOwner={data.repo.owner}
										repoName={data.repo.name}
										reorderable={drag && k === 0}
										{batchMode}
										depth={r.depth}
										parent={k === 0 ? st.on : null}
										after={r.after ?? []}
										warnings={board?.warnings[r.pr] ?? []}
									/>
								{/each}
							</div>
						{/each}
					</div>
					<p class="text-xs text-gray-500">{batchMode ? 'Urgent first, then in line order; a stack goes as one.' : data.can.reorder ? 'Drag to reorder; a stack goes as one.' : 'In line order; a stack goes as one.'}</p>
				{:else if needle}
					<p class="text-sm text-gray-500">No queued PR matches “{search}”.</p>
				{:else if board}
					<p class="text-sm text-gray-500">Nothing is waiting in line.</p>
				{/if}
			</section>
		</div>
	{:else if view === 'attention'}
		<section aria-label="Needs attention" class="space-y-3">
			{#if attention.length === 0}
				<p class="rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">{board ? 'Nothing needs attention.' : 'Loading…'}</p>
			{:else}
				<p class="text-sm text-gray-600">These PRs are held until someone acts. Each one says what to do; the queue takes them again once it is done.</p>
				<div class="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-surface-raised">
					{#each attention as h (h.pr)}
						<AttentionRow item={items.get(h.pr)!} why={h.reason} warnings={board?.warnings[h.pr] ?? []} repoOwner={data.repo.owner} repoName={data.repo.name} {readonly} />
					{/each}
				</div>
			{/if}
		</section>
	{:else}
		<section aria-label="History" class="space-y-3">
			<div class="flex flex-wrap items-center gap-2">
				{#each [{ k: 'all', l: 'All' }, { k: 'landed', l: 'Landed' }, { k: 'failed', l: 'Failed' }] as f (f.k)}
					<button type="button" onclick={() => (outcome = f.k)} aria-pressed={outcome === f.k} class="rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset {outcome === f.k ? 'bg-gray-900 text-white ring-gray-900' : 'text-gray-600 ring-border-subtle hover:bg-surface-sunken'}">{f.l}</button>
				{/each}
				<input type="search" bind:value={historySearch} placeholder="PR #" class="ml-auto w-28 rounded-lg border border-border-subtle bg-surface-raised px-2.5 py-1 text-sm" aria-label="Find a PR in the history" />
			</div>
			{#if shownHistory.length === 0}
				<p class="rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">{pipe ? 'Nothing here yet.' : 'Loading…'}</p>
			{/if}
			{#each historyDays as day (day.label)}
				<div>
					<h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">{day.label}</h3>
					<ul class="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-surface-raised text-sm">
						{#each day.entries as e (e.key)}
							{@const ok = outcomeOf(e) === 'landed'}
							<li>
								{#if e.kind === 'batch'}
									<details class="group">
										<summary class="flex min-w-0 cursor-pointer list-none items-center gap-3 px-4 py-2.5 hover:bg-surface-sunken/60 [&::-webkit-details-marker]:hidden">
											<svg class="h-3 w-3 shrink-0 text-gray-400 transition-transform group-open:rotate-90" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5z" /></svg>
											<span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] {ok ? 'bg-green-50 text-green-700' : outcomeOf(e) === 'failed' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-500'}" aria-hidden="true">{ok ? '✓' : outcomeOf(e) === 'failed' ? '✕' : '–'}</span>
											<span class="shrink-0 font-medium text-gray-900">{e.card.express ? 'Urgent batch' : 'Batch'} #{e.card.number}</span>
											<span class="min-w-0 truncate text-gray-500">{e.card.prs.length} PR{e.card.prs.length === 1 ? '' : 's'} · {e.card.status === 'superseded' ? 'rebuilt' : e.card.status}{e.card.bisection.length ? ` · ${e.card.bisection.length} bisection step${e.card.bisection.length === 1 ? '' : 's'}` : ''}</span>
											<span class="ml-auto shrink-0 text-xs tabular-nums text-gray-500">{took(e.card)} · {clockTime(e.at)}</span>
										</summary>
										<ul class="space-y-0.5 border-t border-border-subtle bg-surface-sunken/40 px-4 py-2 text-[13px]">
											{#each e.card.prs as pr (pr.pr)}
												{@const row = e.rows.find((r) => r.pr_number === pr.pr)}
												<li class="flex min-w-0 items-center gap-2 pl-8">
													<a href={row?.pr_url || pr.url || `https://github.com/${data.repo.owner}/${data.repo.name}/pull/${pr.pr}`} target="_blank" rel="noopener" class="shrink-0 font-mono text-xs text-gray-500 hover:text-indigo-600">#{pr.pr}</a>
													<span class="min-w-0 truncate text-gray-800">{pr.title}</span>
													{#if row}<span class="ml-auto shrink-0 text-xs {row.status === 'merged' ? 'text-green-700' : 'text-red-700'}">{row.status}</span>{/if}
												</li>
											{/each}
										</ul>
									</details>
								{:else}
									<div class="flex min-w-0 items-center gap-3 px-4 py-2.5">
										<span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] {ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}" aria-hidden="true">{ok ? '✓' : '✕'}</span>
										<a href={e.row.pr_url} target="_blank" rel="noopener" class="shrink-0 font-mono text-xs text-gray-500 hover:text-indigo-600">#{e.row.pr_number}</a>
										<span class="min-w-0 truncate text-gray-900">{e.row.pr_title}</span>
										<span class="hidden shrink-0 text-xs text-gray-500 sm:inline">{e.row.author_login}</span>
										<span class="ml-auto shrink-0 text-xs tabular-nums text-gray-500"><span class={ok ? 'text-green-700' : 'text-red-700'}>{e.row.status}</span> · {clockTime(e.at)}</span>
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</section>
	{/if}
</div>

<!-- Add PR Dialog -->
{#if showAddDialog}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onkeydown={(e) => e.key === 'Escape' && (showAddDialog = false)}
	>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="fixed inset-0" onclick={() => (showAddDialog = false)}></div>
		<div class="relative w-full max-w-lg rounded-xl bg-surface-raised p-6 shadow-2xl">
			<h2 class="mb-4 text-lg font-semibold text-gray-900">Add Pull Request to Queue</h2>

			{#if data.openPrs.length === 0}
				<p class="text-sm text-gray-500">No open pull requests available.</p>
			{:else}
				<div class="max-h-96 space-y-2 overflow-y-auto">
					{#each data.openPrs as pr (pr.number)}
						<form method="POST" action="?/addToQueue" use:enhance={() => {
							return async ({ update }) => {
								showAddDialog = false;
								await update();
							};
						}}>
							<input type="hidden" name="pr_number" value={pr.number} />
							<input type="hidden" name="pr_title" value={pr.title} />
							<input type="hidden" name="pr_url" value={pr.url} />
							<input type="hidden" name="author_login" value={pr.author} />
							<input type="hidden" name="author_avatar" value={pr.authorAvatar} />
							<button
								type="submit"
								class="flex w-full items-center gap-3 rounded-lg border border-border-subtle p-3 text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50/50"
							>
								<img src={pr.authorAvatar} alt="" class="h-8 w-8 rounded-full" />
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<span class="font-medium text-gray-900">#{pr.number}</span>
										{#if pr.draft}
											<span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">Draft</span>
										{/if}
									</div>
									<p class="truncate text-sm text-gray-500">{pr.title}</p>
								</div>
								<span class="text-xs text-gray-400">{pr.author}</span>
							</button>
						</form>
					{/each}
				</div>
			{/if}

			<div class="mt-4 flex justify-end">
				<button
					onclick={() => (showAddDialog = false)}
					class="rounded-lg border border-border-subtle px-4 py-2 text-sm text-gray-600 hover:bg-surface-sunken"
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}
