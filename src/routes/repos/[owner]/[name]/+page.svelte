<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import QueueItem from '$lib/components/QueueItem.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import BatchCard from '$lib/components/BatchCard.svelte';
	import SavingsCard from '$lib/components/SavingsCard.svelte';
	import { runOrder } from '$lib/run-order';

	let { data, form } = $props();

	// The streamed sections keep showing what they last loaded while a refresh is in flight,
	// so the page doesn't empty and relayout every time it refreshes.
	type Loaded<T> = T extends Promise<infer V> ? V : never;
	let pipe = $state<Loaded<typeof data.pipeline> | null>(null);
	let board = $state<Loaded<typeof data.board> | null>(null);
	$effect(() => {
		let current = true;
		data.pipeline.then((v) => current && (pipe = v)).catch(() => {});
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
	// order the queue takes them, and the PRs held back, waiting or needing someone, with why.
	const items = $derived(new Map(data.queueItems.map((i) => [i.pr_number, i])));
	type BoardStack = NonNullable<typeof board>['stacks'][number];
	type BoardHeld = NonNullable<typeof board>['waiting'][number];
	const needle = $derived(search.trim().toLowerCase().replace(/^#/, ''));
	const matchesPr = (n: number) => {
		const i = items.get(n);
		return !needle || String(n).startsWith(needle) || (!!i && (i.pr_title.toLowerCase().includes(needle) || i.author_login.toLowerCase().includes(needle)));
	};
	// A stack shows whole while any of its PRs matches the search.
	const shownStacks = $derived((board?.stacks ?? []).filter((s: BoardStack) => s.rows.some((r) => matchesPr(r.pr))));
	const inLine = $derived((board?.stacks ?? []).reduce((n: number, s: BoardStack) => n + s.rows.length, 0));
	const waiting = $derived((board?.waiting ?? []).filter((h: BoardHeld) => items.has(h.pr)));
	const attention = $derived((board?.attention ?? []).filter((h: BoardHeld) => items.has(h.pr)));
	// What runs CI now: the batches and their bisection steps. What comes next is not guessed.
	const runs = $derived(pipe ? runOrder({ active: pipe.active, upNext: [], express: false }) : []);

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

	<SavingsCard savings={data.savings} />

	<!-- Wide screens: the queue in the wide column (golden ratio), what's happening now beside it. -->
	<div class="grid grid-cols-1 gap-5 lg:grid-cols-[1.618fr_1fr]">
		<!-- Side column: Now and Needs attention. On a phone this comes first. -->
		<aside class="min-w-0 space-y-5 lg:sticky lg:top-4 lg:order-2 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
			{#if runs.length > 0}
				<section aria-labelledby="run-order">
					<h2 id="run-order" class="mb-2 text-base font-semibold text-gray-900">Run order</h2>
					<ol class="overflow-hidden rounded-xl border border-border-subtle bg-surface-raised text-sm">
						{#each runs as r, i (r.key)}
							<li class="flex min-w-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5 last:border-b-0 {r.state === 'running' ? 'bg-amber-50/60' : ''}">
								<span class="w-4 shrink-0 text-center text-xs text-gray-400">
									{#if r.state === 'running'}<span class="inline-block h-2 w-2 rounded-full bg-amber-400 motion-safe:animate-pulse" role="img" aria-label="running"></span>{:else}{i + 1 - runs.filter((x) => x.state === 'running').length}{/if}
								</span>
								{#if r.batch !== null}
									<a href="#batch-{r.batch}" class="shrink-0 font-medium text-gray-900 hover:text-indigo-600">{r.label}</a>
								{:else}
									<span class="shrink-0 font-medium {r.urgent ? 'text-indigo-700' : 'text-gray-900'}">{r.label}</span>
								{/if}
								<span class="shrink-0 text-xs text-gray-500">{r.detail}</span>
								<span class="min-w-0 truncate text-xs text-gray-400" title={r.prs.map((n) => `#${n}`).join(' ')}>{r.prs.map((n) => `#${n}`).join(' ')}</span>
							</li>
						{/each}
					</ol>
				</section>
			{/if}
			{#if pipe}
				<section class="space-y-3" aria-labelledby="now">
					<h2 id="now" class="text-base font-semibold text-gray-900">
						{batchMode ? 'Batches' : 'Being tested'}
					</h2>
					{#if pipe.active.length === 0}
						<p class="text-sm text-gray-500">
							{batchMode && inLine ? 'Nothing is being tested; the next batch starts when the collect window ends or it is full.' : 'Nothing is being tested.'}
						</p>
					{/if}
					{#each pipe.active as batch (batch.id)}
						<BatchCard {batch} owner={data.repo.owner} name={data.repo.name} canCancel={data.can.cancel} progressErrors={pipe.progressErrors} />
					{/each}
				</section>
			{/if}

		</aside>

		<!-- Main column: Up next and the queue. -->
		<div class="min-w-0 space-y-5 lg:order-1">
			{#snippet held(title: string, list: BoardHeld[], tone: string, needsSomeone: boolean)}
				<section aria-label={title}>
					<h2 class="mb-2 text-base font-semibold {needsSomeone ? 'text-red-800' : 'text-gray-900'}">{title} · {list.length}</h2>
					<div class="overflow-hidden rounded-xl border {tone} bg-surface-raised" role="list">
						{#each list as h (h.pr)}
							<div role="listitem">
								<QueueItem {readonly} canUrgent={data.can.urgent} item={items.get(h.pr)!} repoOwner={data.repo.owner} repoName={data.repo.name} {batchMode} why={h.reason} {needsSomeone} warnings={board?.warnings[h.pr] ?? []} />
							</div>
						{/each}
					</div>
				</section>
			{/snippet}

			{#if attention.length > 0}{@render held('Needs attention', attention, 'border-red-200', true)}{/if}

			{#if data.queueItems.length === 0}
				<div class="rounded-xl border border-dashed border-gray-300 bg-surface-raised p-12 text-center">
					<svg class="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
					</svg>
					<h3 class="mt-4 text-sm font-medium text-gray-900">Queue is empty</h3>
					{#if !readonly}<p class="mt-1 text-sm text-gray-500">Add a pull request to start the merge queue.</p>{/if}
				</div>
			{:else}
				<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h2 class="text-base font-semibold text-gray-900">Queue · {inLine}</h2>
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
					<section aria-label="In line">
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
											warnings={board?.warnings[r.pr] ?? []}
										/>
									{/each}
								</div>
							{/each}
						</div>
					</section>
				{:else if needle}
					<p class="text-sm text-gray-500">No queued PR matches “{search}”.</p>
				{:else if board && inLine === 0}
					<p class="text-sm text-gray-500">Nothing can go now.</p>
				{/if}

				{#if waiting.length > 0}{@render held('Waiting', waiting, 'border-border-subtle', false)}{/if}
			{/if}

			{#if pipe && pipe.recent.length > 0}
				<details class="rounded-xl border border-border-subtle bg-surface-raised p-3">
					<summary class="cursor-pointer text-sm font-medium text-gray-700">Recent batches · {pipe.recent.length}</summary>
					<div class="mt-3 space-y-2">
						{#each pipe.recent as batch (batch.id)}
							<BatchCard {batch} owner={data.repo.owner} name={data.repo.name} nested />
						{/each}
					</div>
				</details>
			{/if}

			<!-- History -->
			{#if data.history.length > 0}
				<details class="rounded-xl border border-border-subtle bg-surface-raised">
					<summary class="cursor-pointer px-4 py-2.5 text-sm font-medium text-gray-700">History · {data.history.length}</summary>
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<tbody class="divide-y divide-border-subtle">
								{#each data.history as h (h.id)}
									<tr class="hover:bg-surface-sunken/50">
										<td class="px-4 py-2">
											<a href={h.pr_url} target="_blank" rel="noopener" class="font-medium hover:text-indigo-600">#{h.pr_number}</a>
											<span class="ml-1.5 text-gray-500">{h.pr_title}</span>
										</td>
										<td class="hidden px-4 py-2 text-gray-500 sm:table-cell">{h.author_login}</td>
										<td class="px-4 py-2"><StatusBadge status={h.status} /></td>
										<td class="hidden whitespace-nowrap px-4 py-2 text-gray-400 sm:table-cell">{new Date(h.completed_at + 'Z').toLocaleString()}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</details>
			{/if}
		</div>
	</div>
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
