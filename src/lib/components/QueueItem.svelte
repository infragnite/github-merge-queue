<script lang="ts">
	import { enhance } from '$app/forms';
	import StatusBadge from './StatusBadge.svelte';
	import type { ViewItem } from '$lib/types';

	let {
		item,
		position = null,
		repoOwner,
		repoName,
		reorderable = false,
		batchMode,
		depth = 0,
		parent = null,
		after = [],
		also = [],
		why = null,
		needsSomeone = false,
		warnings = [],
		readonly = false,
		canUrgent = false
	}: {
		item: ViewItem;
		position?: number | null;
		repoOwner: string;
		repoName: string;
		reorderable?: boolean;
		batchMode: boolean;
		/** Its depth in its stack: children sit indented under their parent. */
		depth?: number;
		/** The PR it is stacked on, when that PR is not in line above it (being tested, or held). */
		parent?: number | null;
		/** PRs ahead it conflicts with: it goes once they land. */
		after?: number[];
		/** PRs in line above it that it also depends on (`Depends-On:`), besides the one it sits under. */
		also?: number[];
		/** Why the planner holds it, for a row under "Waiting" or "Needs attention". */
		why?: string | null;
		/** The hold needs someone to act, not only time. */
		needsSomeone?: boolean;
		/** Possible problems the stack analysis sees, short of holding it. */
		warnings?: string[];
		/** A signed-out visitor's view: no controls. */
		readonly?: boolean;
		/** Making a PR urgent needs maintain. */
		canUrgent?: boolean;
	} = $props();

	const isActive = $derived(['updating', 'checking', 'merging'].includes(item.status));
	const canRemove = $derived(!['merging', 'merged'].includes(item.status));
	const action = (name: string) => `/repos/${repoOwner}/${repoName}?/${name}`;
	const priority = $derived(item.priority ?? 'normal');
	// Plain queued rows carry no pill: only what differs from "waiting its turn" is shown.
	const showStatus = $derived(item.status !== 'queued');
	// What the planner says about it: the reason it is held, or nothing for a PR in line.
	const note = $derived(why);
	const noteTone = $derived(needsSomeone ? 'text-red-700' : 'text-gray-500');
	const prLink = (n: number) => `https://github.com/${repoOwner}/${repoName}/pull/${n}`;

	// Svelte adds touchstart as passive: a non-passive one keeps a press on the grip from selecting
	// text or opening the callout.
	let handle = $state<HTMLSpanElement | null>(null);
	$effect(() => {
		if (!handle) return;
		const el = handle;
		const prevent = (e: TouchEvent) => e.preventDefault();
		el.addEventListener('touchstart', prevent, { passive: false });
		return () => el.removeEventListener('touchstart', prevent);
	});
</script>

<div
	class="group flex min-w-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-sm last:border-b-0 {isActive
		? 'bg-indigo-50/40'
		: ''}"
	style={depth ? `padding-left: ${0.75 + depth * 1.25}rem` : undefined}
>
	{#if reorderable}
		<!-- Shown on wide screens and on any touch screen, where it is the way to drag (no long press needed). -->
		<span
			bind:this={handle}
			data-drag-handle
			class="hidden shrink-0 cursor-grab touch-none text-gray-300 select-none hover:text-gray-500 active:cursor-grabbing sm:inline pointer-coarse:inline [-webkit-touch-callout:none]"
			title="Drag to reorder"
			aria-hidden="true"
		>
			<svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
				<circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
				<circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
				<circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
			</svg>
		</span>
	{/if}
	{#if position !== null}
		<span class="w-6 shrink-0 text-right text-xs tabular-nums text-gray-500" title="Place in line">{position}</span>
	{/if}
	{#if depth > 0}<span class="shrink-0 text-gray-400" aria-hidden="true">└</span>{/if}
	<a href={item.pr_url} target="_blank" rel="noopener" class="shrink-0 font-medium text-gray-900 hover:text-indigo-600">#{item.pr_number}</a>
	<div class="min-w-0 flex-1">
		<div class="flex min-w-0 items-center gap-1.5">
			<p class="min-w-0 truncate text-gray-700" title={item.pr_title}>{item.pr_title}</p>
			{#if parent !== null}
				<a href={prLink(parent)} target="_blank" rel="noopener" class="shrink-0 rounded bg-sky-50 px-1 text-xs text-sky-700 hover:underline" title="Lands after #{parent}">on #{parent}</a>
			{/if}
			{#each also as d (d)}
				<a href={prLink(d)} target="_blank" rel="noopener" class="shrink-0 rounded bg-sky-50 px-1 text-xs text-sky-700 hover:underline" title="Depends on #{d}; lands after it">needs #{d}</a>
			{/each}
			{#if after.length}
				<span class="shrink-0 rounded bg-gray-100 px-1 text-xs text-gray-600" title="Conflicts with {after.map((n) => `#${n}`).join(', ')}, ahead of it; it goes once they land">after {after.map((n) => `#${n}`).join(' ')}</span>
			{/if}
		</div>
		{#if item.status === 'conflict'}
			<p class="truncate text-xs text-orange-700">
				Merge conflict:
				{#if item.author_login === 'dependabot[bot]'}
					<a href={item.pr_url} target="_blank" rel="noopener" class="underline">comment <code>@dependabot recreate</code></a>
				{:else}
					<a href="{item.pr_url}/conflicts" target="_blank" rel="noopener" class="underline">resolve on GitHub</a>
				{/if}; retried automatically
			</p>
		{:else if note}
			<p class="truncate text-xs {noteTone}" title={note}>{note}</p>
		{/if}
		{#each warnings as w, i (i)}
			<p class="truncate text-xs text-amber-700" title={w}>{w}</p>
		{/each}
	</div>
	<span class="hidden shrink-0 text-xs text-gray-500 md:inline lg:hidden 2xl:inline">{item.author_login}</span>
	{#if batchMode && priority !== 'normal'}
		<span class="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium {priority === 'urgent' ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-100 text-gray-500'}">{priority}</span>
	{/if}
	{#if showStatus}<StatusBadge status={item.status} />{/if}
	{#if !readonly && batchMode && (item.status === 'queued' || item.status === 'conflict')}
		<form method="POST" action={action('setPriority')} use:enhance class="hidden shrink-0 sm:block sm:opacity-0 sm:transition-opacity sm:focus-within:opacity-100 sm:group-hover:opacity-100">
			<input type="hidden" name="pr_number" value={item.pr_number} />
			<select
				name="priority"
				value={priority}
				onchange={(e) => e.currentTarget.form?.requestSubmit()}
				class="rounded border border-border-subtle bg-transparent py-0.5 pl-1 pr-6 text-xs text-gray-600"
				aria-label="Priority of #{item.pr_number}"
				title="Urgent PRs go first, together in an express batch"
			>
				<option value="urgent" disabled={!canUrgent && priority !== 'urgent'}>urgent</option>
				<option value="normal">normal</option>
				<option value="low">low</option>
			</select>
		</form>
	{/if}
	<div class="flex shrink-0 items-center">
		{#if readonly}
			<!-- nothing to change -->
		{:else if item.status === 'failed'}
			<form method="POST" action={action('retry')} use:enhance>
				<input type="hidden" name="item_id" value={item.id} />
				<button type="submit" class="rounded p-2 text-gray-500 sm:p-1 hover:bg-indigo-50 hover:text-indigo-600" title="Put back in the queue" aria-label="Retry #{item.pr_number}">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
					</svg>
				</button>
			</form>
		{/if}
		{#if canRemove && !readonly}
			<form
				method="POST"
				action={action('removeFromQueue')}
				use:enhance={({ cancel }) => {
					if (!confirm(`Remove #${item.pr_number} from the queue?${isActive ? ' It is being tested in a batch right now.' : ''}`)) cancel();
				}}
			>
				<input type="hidden" name="item_id" value={item.id} />
				<button type="submit" class="rounded p-2 text-gray-500 sm:p-1 hover:bg-red-50 hover:text-red-600" title="Remove from queue" aria-label="Remove #{item.pr_number} from the queue">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</form>
		{/if}
	</div>
</div>
