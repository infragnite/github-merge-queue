<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import QueueItem from '$lib/components/QueueItem.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import BatchCard from '$lib/components/BatchCard.svelte';
	import { queueView, type Row } from '$lib/queue-view';

	let { data } = $props();

	// The streamed sections keep showing what they last loaded while a refresh is in flight,
	// so the page doesn't empty and relayout every time it refreshes.
	type Loaded<T> = T extends Promise<infer V> ? V : never;
	let pipe = $state<Loaded<typeof data.pipeline> | null>(null);
	let stacks = $state<Loaded<typeof data.stacks> | null>(null);
	$effect(() => {
		let current = true;
		data.pipeline.then((v) => current && (pipe = v));
		data.stacks.then((v) => current && (stacks = v));
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
	const view = $derived(
		queueView({
			items: data.queueItems,
			mode: batchMode ? 'batch' : 'serial',
			batches: (pipe?.active ?? []).filter((b) => b.kind === 'batch').map((b) => ({ id: b.id, status: b.status, prs: b.prs.map((p) => p.pr) })),
			stacks: stacks?.stacks ?? null,
			limits: data.limits
		})
	);
	const needle = $derived(search.trim().toLowerCase().replace(/^#/, ''));
	const matches = (r: Row) =>
		!needle ||
		String(r.item.pr_number).startsWith(needle) ||
		r.item.pr_title.toLowerCase().includes(needle) ||
		r.item.author_login.toLowerCase().includes(needle);
	const shownRows = $derived(view.rows.filter(matches));
	const shownNext = $derived(view.upNext.filter(matches));
	const inLine = $derived(view.rows.length + view.upNext.length);
	const inFlightCount = $derived(view.inFlight.reduce((n, g) => n + g.prs.length, 0));
	const brokenStacks = $derived((stacks?.stacks ?? []).filter((s) => s.rows.some((r) => r.broken)).length);

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

		// Only the rows in line move; the rest keep their place after them.
		const rows = view.rows.map((r) => r.item.id);
		const [moved] = rows.splice(dragIndex, 1);
		rows.splice(dropIndex, 0, moved);
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

	function confirmMode(e: SubmitEvent) {
		const to = (e.submitter as HTMLButtonElement | null)?.value;
		if (!to || to === data.mode) return;
		const text =
			to === 'serial'
				? 'Switch to one by one? Batches being tested now are stopped and their PRs go back in line; PRs then merge one at a time in the order shown.'
				: 'Switch to batches? PRs are then tested together, urgent first and then oldest, and the order can no longer be dragged.';
		if (!confirm(text)) e.preventDefault();
	}
</script>

<svelte:head>
	<title>{data.repo.owner}/{data.repo.name} - Merge Queue</title>
</svelte:head>

<div class="space-y-5">
	<!-- Header -->
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex min-w-0 items-center gap-3">
			<a href="/" class="shrink-0 text-gray-400 transition-colors hover:text-gray-600" aria-label="Back to dashboard">
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
				</svg>
			</a>
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
						<span class="ml-1 rounded px-1.5 py-0.5 text-xs {m.tone}" title={m.hint}>{m.label} at {pipe.master.sha.slice(0, 7)}</span>
					{/if}
				</p>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<form method="POST" action="?/setMode" use:enhance onsubmit={confirmMode} class="flex overflow-hidden rounded-lg border border-border-subtle text-sm" aria-label="Merge mode">
				{#each [['serial', 'One by one'], ['batch', 'Batches']] as [value, label] (value)}
					<button
						type="submit"
						name="mode"
						{value}
						aria-pressed={data.mode === value}
						class="whitespace-nowrap px-3 py-1.5 transition-colors {data.mode === value ? 'bg-indigo-600 text-white' : 'bg-surface-raised text-gray-600 hover:bg-surface-sunken'}"
						title={value === 'batch' ? 'Test queued PRs together in batches, urgent first' : 'Test and merge PRs one at a time, in the order you set'}
					>{label}</button>
				{/each}
			</form>
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
			<button
				onclick={() => (showAddDialog = true)}
				class="whitespace-nowrap rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
				title={data.openPrs.length === 0 ? 'Every open PR is already queued' : `${data.openPrs.length} open PRs not queued`}
			>
				+ Add PR
			</button>
		</div>
	</div>

	{#if pipe?.error}<p class="text-sm text-red-600">{pipe.error}</p>{/if}
	{#if pipe?.paused}
		<form method="POST" action="?/resume" use:enhance class="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
			<span class="min-w-0 flex-1">Paused: {pipe.paused}</span>
			<button type="submit" class="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700">Resume</button>
		</form>
	{/if}

	<!-- Wide screens: the queue in the wide column (golden ratio), what's happening now beside it. -->
	<div class="grid grid-cols-1 gap-5 lg:grid-cols-[1.618fr_1fr]">
		<!-- Side column: Now and Needs attention. On a phone this comes first. -->
		<aside class="min-w-0 space-y-5 lg:sticky lg:top-4 lg:order-2 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
			{#if pipe}
				<section class="space-y-3" aria-labelledby="now">
					<h2 id="now" class="text-base font-semibold text-gray-900">
						{batchMode ? 'Testing now' : 'In progress'}
					</h2>
					{#if pipe.active.length === 0}
						<p class="text-sm text-gray-500">
							{batchMode ? (inLine ? 'Nothing is being tested; the next batch starts when the collect window ends or it is full.' : 'Nothing is being tested.') : 'Batches are off; the queue merges one PR at a time.'}
						</p>
					{/if}
					{#each pipe.active as batch (batch.id)}
						<BatchCard {batch} owner={data.repo.owner} name={data.repo.name} />
					{/each}
				</section>
			{/if}

		</aside>

		<!-- Main column: Up next and the queue. -->
		<div class="min-w-0 space-y-5 lg:order-1">
			{#if view.attention.length > 0}
				<section aria-labelledby="attention">
					<h2 id="attention" class="mb-2 text-base font-semibold text-red-800">Needs attention · {view.attention.length}</h2>
					<div class="overflow-hidden rounded-xl border border-red-200 bg-surface-raised" role="list">
						{#each view.attention as a (a.item.id)}
							<div role="listitem">
								<QueueItem item={a.item} repoOwner={data.repo.owner} repoName={data.repo.name} {batchMode} stack={a.stack} why={a.item.status === 'conflict' ? null : a.why} />
							</div>
						{/each}
					</div>
				</section>
			{/if}

			{#if data.queueItems.length === 0}
				<div class="rounded-xl border border-dashed border-gray-300 bg-surface-raised p-12 text-center">
					<svg class="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
					</svg>
					<h3 class="mt-4 text-sm font-medium text-gray-900">Queue is empty</h3>
					<p class="mt-1 text-sm text-gray-500">Add a pull request to start the merge queue.</p>
				</div>
			{:else}
				<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h2 class="text-base font-semibold text-gray-900">Queue · {inLine}</h2>
					<span class="text-xs text-gray-500">
						{batchMode ? 'urgent first, then oldest' : 'drag to reorder'}{inFlightCount ? ` · ${inFlightCount} being tested` : ''}{view.attention.length ? ` · ${view.attention.length} need attention` : ''}
					</span>
					<input
						type="search"
						bind:value={search}
						placeholder="Find #, title or author"
						class="ml-auto w-full rounded-lg border border-border-subtle bg-surface-raised px-2.5 py-1 text-sm sm:w-56"
						aria-label="Find a PR in the queue"
					/>
				</div>

				{#if view.inFlight.length > 0}
					<div class="space-y-1">
						{#each view.inFlight as g (g.batch)}
							<a href="#batch-{g.batch}" class="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50/50 px-3 py-1.5 text-sm hover:bg-indigo-50">
								<span class="shrink-0 whitespace-nowrap font-medium text-indigo-900">Batch #{g.batch}</span>
								<span class="shrink-0 whitespace-nowrap text-indigo-800">{g.prs.length} PRs · {g.status}</span>
								<span class="min-w-0 truncate text-xs text-indigo-700/70">{g.prs.map((n) => `#${n}`).join(' ')}</span>
							</a>
						{/each}
					</div>
				{/if}

				{#if batchMode && shownNext.length > 0}
					<section aria-labelledby="next">
						<h3 id="next" class="mb-1 text-sm font-medium text-gray-700">
							{view.express ? 'Next: urgent batch' : 'Likely next batch'} · {view.upNext.length}
							<span class="font-normal text-gray-500">(PRs whose checks or parent aren't ready are skipped)</span>
						</h3>
						<div class="overflow-hidden rounded-xl border border-indigo-200 bg-surface-raised" role="list">
							{#each shownNext as r (r.item.id)}
								<div role="listitem">
									<QueueItem item={r.item} position={r.position} repoOwner={data.repo.owner} repoName={data.repo.name} batchMode stack={r.stack} />
								</div>
							{/each}
						</div>
					</section>
				{/if}

				{#if shownRows.length > 0}
					<section aria-label="Waiting in line">
						{#if batchMode && view.upNext.length > 0}<h3 class="mb-1 text-sm font-medium text-gray-700">After that</h3>{/if}
						<div class="overflow-hidden rounded-xl border border-border-subtle bg-surface-raised" role="list">
							{#each shownRows as r, index (r.item.id)}
								{#if batchMode || needle}
									<div role="listitem">
										<QueueItem item={r.item} position={r.position} repoOwner={data.repo.owner} repoName={data.repo.name} {batchMode} stack={r.stack} />
									</div>
								{:else}
									<div
										draggable="true"
										ondragstart={() => handleDragStart(index)}
										ondragover={(e) => handleDragOver(e, index)}
										ondrop={(e) => handleDrop(e, index)}
										ondragend={handleDragEnd}
										class="{dragOverIndex === index && dragIndex !== index ? 'border-t-2 border-indigo-400' : ''} {dragIndex === index ? 'opacity-40' : ''} {reordering ? 'pointer-events-none' : ''}"
										role="listitem"
									>
										<QueueItem item={r.item} position={r.position} repoOwner={data.repo.owner} repoName={data.repo.name} reorderable batchMode={false} stack={r.stack} />
									</div>
								{/if}
							{/each}
						</div>
					</section>
				{:else if needle && shownNext.length === 0}
					<p class="text-sm text-gray-500">No queued PR matches “{search}”.</p>
				{/if}
			{/if}

			<!-- Stacks: open by default when one is broken. -->
			{#if stacks && (stacks.error || stacks.stacks.length > 0)}
				<details class="rounded-xl border border-border-subtle bg-surface-raised" open={brokenStacks > 0}>
					<summary class="cursor-pointer px-4 py-2.5 text-sm font-medium text-gray-700">
						Stacks · {stacks.stacks.length}{brokenStacks ? ` · ${brokenStacks} broken` : ''}
					</summary>
					{#if stacks.error}
						<p class="px-4 pb-3 text-sm text-red-600">{stacks.error}</p>
					{/if}
					<div class="space-y-3 px-3 pb-3">
						{#each stacks.stacks as stack (stack.root)}
							<div class="overflow-hidden rounded-lg border border-border-subtle">
								{#each stack.rows as row (row.pr)}
									<div class="border-b border-border-subtle px-3 py-1.5 text-sm last:border-b-0" style="padding-left: {0.75 + row.depth * 1.25}rem">
										<div class="flex min-w-0 items-center gap-2">
											{#if row.depth > 0}<span class="text-gray-400" aria-hidden="true">└</span>{/if}
											<a href={row.url || `https://github.com/${data.repo.owner}/${data.repo.name}/pull/${row.pr}`} target="_blank" rel="noopener" class="shrink-0 font-medium hover:text-indigo-600">#{row.pr}</a>
											<span class="min-w-0 flex-1 truncate text-gray-600">{row.title || 'not queued'}</span>
											{#if row.link && row.link !== 'healthy'}
												<span class="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">{row.link}</span>
											{/if}
											{#if row.queue && row.queue !== 'queued'}<StatusBadge status={row.queue} />{/if}
										</div>
										{#each row.issues as issue, i (i)}
											<p class="mt-0.5 text-xs {issue.severity === 'blocking' ? 'text-red-600' : 'text-amber-700'}">{issue.message}</p>
										{/each}
									</div>
								{/each}
							</div>
						{/each}
					</div>
				</details>
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
