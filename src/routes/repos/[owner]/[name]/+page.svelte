<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import QueueItem from '$lib/components/QueueItem.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import BatchCard from '$lib/components/BatchCard.svelte';
	import SavingsCard from '$lib/components/SavingsCard.svelte';
	import PrepCard from '$lib/components/PrepCard.svelte';
	import { runningWork } from '$lib/running-work';
	import { historyTimeline } from '$lib/history-timeline';
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
	// A stack shows whole while any of its PRs matches the search.
	const shownStacks = $derived((board?.stacks ?? []).filter((s: BoardStack) => s.rows.some((r) => matchesPr(r.pr))));
	const inLine = $derived((board?.stacks ?? []).reduce((n: number, s: BoardStack) => n + s.rows.length, 0));
	const attention = $derived((board?.attention ?? []).filter((h: BoardHeld) => items.has(h.pr)));
	// Everything running now, the queue's own preparation first, in the order it holds the runners.
	const work = $derived(pipe ? runningWork({ active: pipe.active, master: pipe.master ? { ...pipe.master, branch: data.repo.default_branch } : null, activity: pipe.activity, now: clock + skew }) : []);
	const view = $derived(((v) => (v === 'attention' || v === 'history' ? v : 'now'))(page.url.searchParams.get('view')));
	// Finished batches and the PRs that left the queue, in one list.
	const timeline = $derived(historyTimeline(pipe?.recent ?? [], data.history));
	const when = (ms: number) => {
		const d = new Date(ms);
		const today = new Date(clock).toDateString() === d.toDateString();
		return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	};

	const MASTER: Record<string, { label: string; tone: string; hint: string }> = {
		green: { label: 'green', tone: 'bg-green-100 text-green-800', hint: 'Batches build on it' },
		verifying: { label: 'CI running after the last landing', tone: 'bg-amber-100 text-amber-800', hint: 'The tree already passed in its batch; this run refreshes caches and releases' },
		checking: { label: 'checking a commit pushed outside the queue', tone: 'bg-amber-100 text-amber-800', hint: 'Batches wait for this check' },
		red: { label: 'red', tone: 'bg-red-100 text-red-800', hint: 'Only PRs that pass on it can land' }
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

		// Whole stacks move; everything else keeps its place after them.
		const order = (board?.stacks ?? []).map((s: BoardStack) => s.rows.map((r) => items.get(r.pr)!.id));
		const [moved] = order.splice(dragIndex, 1);
		order.splice(dropIndex, 0, moved);
		const rows = order.flat();
		const inRows = new Set(rows);
		const orderedIds = [...rows, ...[...data.queueItems].sort((a, b) => a.position - b.position).map((i) => i.id).filter((id) => !inRows.has(id))];
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

<div class="space-y-5">
	<!-- Header -->
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex min-w-0 items-center gap-3">
			{#if !data.anonymous}
				<a href="/" class="shrink-0 text-gray-400 transition-colors hover:text-gray-600" aria-label="Back to dashboard">
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
					</svg>
				</a>
			{/if}
			<div class="min-w-0">
				<h1 class="truncate text-xl font-bold text-gray-900 sm:text-2xl">
					<a href="https://github.com/{data.repo.owner}/{data.repo.name}" target="_blank" rel="noopener" class="hover:text-indigo-600">
						{data.repo.owner}<span class="text-gray-400">/</span>{data.repo.name}
					</a>
				</h1>
				<p class="text-sm text-gray-500">
					Into <code class="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{data.repo.default_branch}</code>
					{#if pipe?.master}
						{@const m = MASTER[pipe.master.state] ?? { label: pipe.master.state, tone: 'bg-gray-100 text-gray-700', hint: '' }}
						<span class="ml-1 rounded px-1.5 py-0.5 text-xs {m.tone}" title={m.hint}>{m.label} at <span class="whitespace-nowrap">{pipe.master.sha.slice(0, 7)}</span></span>
					{/if}
					{#if data.readonly}
						<span class="ml-1 whitespace-nowrap text-xs text-gray-500">{batchMode ? `Batches of up to ${data.limits.maxBatch}` : 'One by one'}</span>
					{:else}
					<a href="/repos/{data.repo.owner}/{data.repo.name}/settings#strategy" class="ml-1 whitespace-nowrap text-xs text-gray-500 underline decoration-dotted underline-offset-2 hover:text-indigo-600" title="How the queue merges PRs; change it in the queue settings"
						>{batchMode ? `Batches of up to ${data.limits.maxBatch}` : 'One by one'}</a
					>
					{/if}
				</p>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<SavingsCard savings={data.savings} />
			{#if !data.readonly}
			<a
				href="/repos/{data.repo.owner}/{data.repo.name}/settings"
				class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-subtle bg-surface-raised px-2.5 py-2 text-sm text-gray-700 transition-colors hover:bg-surface-sunken sm:py-1.5"
				aria-label="Queue settings"
				title="Queue settings: merge strategy, batches, CI"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
				</svg>
				<span class="hidden sm:inline">Queue settings</span>
			</a>
			{/if}
			<button
				onclick={refresh}
				disabled={refreshing}
				class="rounded-lg border border-border-subtle bg-surface-raised px-2.5 py-2 text-sm text-gray-600 transition-colors hover:bg-surface-sunken disabled:opacity-50"
				aria-label="Refresh queue"
			>
				<svg class="h-4 w-4 {refreshing ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
				</svg>
			</button>
			{#if !readonly}
			<button
				onclick={() => (showAddDialog = true)}
				class="whitespace-nowrap rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
				title={data.openPrs.length === 0 ? 'Every open PR is already queued' : `${data.openPrs.length} open PRs not queued`}
			>
				+ Add PR
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
	<nav class="flex gap-1 border-b border-border-subtle text-sm" aria-label="Queue views">
		{#each [{ key: 'now', label: 'Now' }, { key: 'attention', label: 'Needs attention' }, { key: 'history', label: 'History' }] as v (v.key)}
			<a
				href={v.key === 'now' ? `/repos/${data.repo.owner}/${data.repo.name}` : `?view=${v.key}`}
				data-sveltekit-noscroll
				data-sveltekit-replacestate
				aria-current={view === v.key ? 'page' : undefined}
				class="-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 {view === v.key ? 'border-indigo-600 font-medium text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'}"
			>
				{v.label}
				{#if v.key === 'now' && work.length > 0}
					<span class="rounded-full bg-amber-100 px-1.5 text-xs tabular-nums text-amber-800">{work.length}</span>
				{:else if v.key === 'attention' && attention.length > 0}
					<span class="inline-flex items-center gap-0.5 rounded-full bg-red-600 px-1.5 text-xs font-semibold tabular-nums text-white" aria-label="{attention.length} need attention"><span aria-hidden="true">!</span>{attention.length}</span>
				{/if}
			</a>
		{/each}
	</nav>

	{#if view === 'now'}
		<!-- Running work first: the queue's preparation, then the runs in the order they hold the runners. -->
		<section aria-labelledby="running" class="space-y-3">
			<h2 id="running" class="text-base font-semibold text-gray-900">Running</h2>
			{#if !pipe}
				<p class="text-sm text-gray-500">Loading…</p>
			{:else if work.length === 0}
				<p class="text-sm text-gray-500">{batchMode && inLine ? 'Nothing is running; the next batch starts when the collect window ends or it is full.' : 'Nothing is running.'}</p>
			{:else}
				<div class="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
					{#each work as w (w.key)}
						{#if w.kind === 'run'}
							<BatchCard batch={w.card} owner={data.repo.owner} name={data.repo.name} canCancel={data.can.cancel} progressErrors={pipe.progressErrors} stopsEarly={data.stopsEarly} prep={w.prep} now={clock + skew} />
						{:else}
							<PrepCard slot={w.slot} />
						{/if}
					{/each}
				</div>
			{/if}
		</section>

		<section class="space-y-3" aria-label="In line">
			{#if data.queueItems.length === 0}
				<div class="rounded-xl border border-dashed border-gray-300 bg-surface-raised p-8 text-center">
					<h3 class="text-sm font-medium text-gray-900">Queue is empty</h3>
					{#if !readonly}<p class="mt-1 text-sm text-gray-500">Add a pull request to start the merge queue.</p>{/if}
				</div>
			{:else}
				<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h2 class="text-base font-semibold text-gray-900">In line · {inLine}</h2>
					<span class="text-xs text-gray-500">
						{batchMode ? 'urgent first, then in line order; a stack goes as one' : data.can.reorder ? 'drag to reorder; a stack goes as one' : 'in line order; a stack goes as one'}
					</span>
					<input
						type="search"
						bind:value={search}
						placeholder="Find #, title or author"
						class="ml-auto w-full rounded-lg border border-border-subtle bg-surface-raised px-2.5 py-1 text-sm sm:w-56"
						aria-label="Find a PR in the queue"
					/>
				</div>

				{#if board?.error}<p class="text-sm text-red-600">{board.error}</p>{/if}

				{#if shownStacks.length > 0}
					<div class="overflow-hidden rounded-xl border border-border-subtle bg-surface-raised" role="list">
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
				{:else if needle}
					<p class="text-sm text-gray-500">No queued PR matches “{search}”.</p>
				{:else if board && inLine === 0}
					<p class="text-sm text-gray-500">Nothing is waiting in line.</p>
				{/if}
			{/if}
		</section>
	{:else if view === 'attention'}
		<section aria-label="Needs attention">
			{#if attention.length === 0}
				<p class="text-sm text-gray-500">{board ? 'Nothing needs attention.' : 'Loading…'}</p>
			{:else}
				<p class="mb-2 text-xs text-gray-500">Held back until someone acts; each says what to do.</p>
				<div class="overflow-hidden rounded-xl border border-red-200 bg-surface-raised" role="list">
					{#each attention as h (h.pr)}
						<div role="listitem">
							<QueueItem {readonly} canUrgent={data.can.urgent} item={items.get(h.pr)!} repoOwner={data.repo.owner} repoName={data.repo.name} {batchMode} why={h.reason} needsSomeone warnings={board?.warnings[h.pr] ?? []} />
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{:else}
		<section aria-label="History" class="space-y-2">
			{#if timeline.length === 0}
				<p class="text-sm text-gray-500">{pipe ? 'Nothing has finished yet.' : 'Loading…'}</p>
			{/if}
			{#each timeline as e (e.key)}
				<div class="flex gap-3">
					<time class="w-20 shrink-0 pt-3 text-right text-xs tabular-nums text-gray-400" datetime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>{when(e.at)}</time>
					<div class="min-w-0 flex-1">
						{#if e.kind === 'batch'}
							<BatchCard batch={e.card} owner={data.repo.owner} name={data.repo.name} stopsEarly={data.stopsEarly} now={clock + skew} />
						{:else}
							<div class="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border-subtle bg-surface-raised px-4 py-2.5 text-sm">
								<a href={e.row.pr_url} target="_blank" rel="noopener" class="font-medium hover:text-indigo-600">#{e.row.pr_number}</a>
								<span class="min-w-0 flex-1 truncate text-gray-600">{e.row.pr_title}</span>
								<span class="hidden text-xs text-gray-500 sm:inline">{e.row.author_login}</span>
								<StatusBadge status={e.row.status} />
							</div>
						{/if}
					</div>
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
