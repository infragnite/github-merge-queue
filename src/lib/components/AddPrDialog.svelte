<script lang="ts">
	import { enhance } from '$app/forms';

	type OpenPr = { number: number; title: string; url: string; author: string; authorAvatar: string; draft: boolean };
	let { open = $bindable(false), prs, canUrgent }: { open: boolean; prs: OpenPr[]; canUrgent: boolean } = $props();

	let dialog = $state<HTMLDialogElement | null>(null);
	let search = $state('');
	let showDrafts = $state(false);
	let pending = $state<string | null>(null);
	let error = $state<string | null>(null);

	// A native modal: focus moves in and stays, Escape closes it, the page behind is inert.
	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			search = '';
			error = null;
			dialog.showModal();
		} else if (!open && dialog.open) dialog.close();
	});

	const needle = $derived(search.trim().toLowerCase().replace(/^#/, ''));
	const matches = (pr: OpenPr) =>
		!needle || String(pr.number).startsWith(needle) || pr.title.toLowerCase().includes(needle) || pr.author.toLowerCase().includes(needle);
	const ready = $derived(prs.filter((p) => !p.draft && matches(p)));
	const drafts = $derived(prs.filter((p) => p.draft && matches(p)));
	const draftCount = $derived(prs.filter((p) => p.draft).length);
	const readyCount = $derived(prs.length - draftCount);

	const submit = (key: string): import('@sveltejs/kit').SubmitFunction => () => {
		pending = key;
		error = null;
		return async ({ result, update }) => {
			pending = null;
			if (result.type === 'failure') {
				// Shown here, where the user is looking; the dialog stays open to pick again.
				error = String(result.data?.error ?? 'The PR could not be queued');
				return;
			}
			open = false;
			await update();
		};
	};
</script>

<dialog
	bind:this={dialog}
	onclose={() => (open = false)}
	onclick={(e) => e.target === dialog && (open = false)}
	aria-labelledby="add-pr-title"
	class="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl bg-surface-raised p-0 shadow-2xl backdrop:bg-black/50"
>
	<div class="flex max-h-[85vh] flex-col p-5 sm:p-6">
		<h2 id="add-pr-title" class="text-lg font-semibold text-gray-900">Add a pull request to the queue</h2>

		{#if prs.length === 0}
			<p class="mt-3 text-sm text-gray-500">Every open pull request is already queued.</p>
		{:else}
			<input
				bind:value={search}
				type="search"
				placeholder="Search by number, title or author"
				aria-label="Search pull requests"
				class="mt-3 w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
			/>
			<p class="mt-1.5 text-xs text-gray-500">
				{readyCount} open{draftCount ? ` · ${draftCount} draft${draftCount === 1 ? '' : 's'}` : ''}{needle ? ` · ${ready.length + (showDrafts ? drafts.length : 0)} shown` : ''}
			</p>

			{#if error}<p class="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>{/if}

			<ul class="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto">
				{#each [...ready, ...(showDrafts ? drafts : [])] as pr (pr.number)}
					<li class="flex items-center gap-3 rounded-lg border border-border-subtle p-3 {pr.draft ? 'bg-surface-sunken/60' : ''}">
						<img src={pr.authorAvatar} alt="" class="h-8 w-8 shrink-0 rounded-full" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<a href={pr.url} target="_blank" rel="noopener" class="font-medium text-gray-900 hover:text-indigo-600">#{pr.number}</a>
								{#if pr.draft}<span class="rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-600">Draft</span>{/if}
								<span class="truncate text-xs text-gray-500">{pr.author}</span>
							</div>
							<p class="truncate text-sm text-gray-600">{pr.title}</p>
							{#if pr.draft}<p class="text-xs text-gray-500">Waits in line until it is marked ready on GitHub.</p>{/if}
						</div>
						<form method="POST" action="?/addToQueue" use:enhance={submit(`${pr.number}`)} class="flex shrink-0 flex-col gap-1.5 sm:flex-row">
							<input type="hidden" name="pr_number" value={pr.number} />
							<button
								type="submit"
								disabled={pending !== null}
								class="min-h-9 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
							>
								{pending === `${pr.number}` ? 'Adding…' : 'Add'}
							</button>
							{#if canUrgent && !pr.draft}
								<button
									type="submit"
									name="priority"
									value="urgent"
									disabled={pending !== null}
									title="Queue it as urgent: it goes first, in the urgent batch"
									class="min-h-9 rounded-md border border-border-subtle px-3 py-1.5 text-sm text-gray-700 hover:bg-surface-sunken disabled:opacity-50"
								>
									Urgent
								</button>
							{/if}
						</form>
					</li>
				{:else}
					<li class="py-3 text-sm text-gray-500">
						{needle ? `No ready pull request matches “${search}”.` : 'Every open pull request that is ready is already queued.'}
					</li>
				{/each}
			</ul>

			{#if drafts.length > 0 || showDrafts}
				<button type="button" onclick={() => (showDrafts = !showDrafts)} class="mt-2 self-start text-sm text-indigo-600 hover:underline">
					{showDrafts ? 'Hide drafts' : `Show ${needle ? `${drafts.length} matching` : draftCount} draft${(needle ? drafts.length : draftCount) === 1 ? '' : 's'}`}
				</button>
			{/if}
		{/if}

		<div class="mt-4 flex justify-end">
			<button type="button" onclick={() => (open = false)} class="rounded-lg border border-border-subtle px-4 py-2 text-sm text-gray-600 hover:bg-surface-sunken">Close</button>
		</div>
	</div>
</dialog>
