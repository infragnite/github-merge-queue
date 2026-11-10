<script lang="ts">
	import { enhance } from '$app/forms';
	import { SETTING_GROUPS, shown, type SettingField } from '$lib/settings-form';

	let { data, form } = $props();

	let saving = $state(false);
	let switching = $state(false);
	let removing = $state(false);
	const base = $derived(`/repos/${data.repo.owner}/${data.repo.name}`);
	const isDefault = (f: SettingField) => shown(f, data.settings) === shown(f, data.settings.defaults);
	const fmt = (f: SettingField, v: string | number | boolean) => (f.kind === 'boolean' ? (v ? 'on' : 'off') : f.kind === 'duration' ? `${v} ${f.unit}` : v === '' ? 'empty' : String(v));

	const STRATEGIES = [
		{
			value: 'serial',
			title: 'One by one',
			body: 'Each PR is tested on top of the default branch and merged before the next starts. Simple and predictable; the queue moves at one CI run per PR.',
			order: 'You set the order by dragging PRs in the queue.'
		},
		{
			value: 'batch',
			title: 'Batches',
			body: 'PRs are tested together and merged together when the batch passes. A failed batch is narrowed down to the PR that breaks it; the rest still land.',
			order: 'Urgent PRs go first, then the queue order.'
		}
	] as const;

	// Asked in the enhance callback: `use:enhance` submits regardless of a prevented submit event.
	const confirmMode: import('@sveltejs/kit').SubmitFunction = ({ formData, cancel }) => {
		const to = formData.get('mode');
		const text =
			to === 'serial'
				? 'Switch to one by one now? The batches being tested stop, and their PRs go back in line, not marked as failed.'
				: 'Switch to batches now? The queue then tests PRs together, urgent first, and the order can no longer be dragged.';
		if (!confirm(text)) return cancel();
		switching = true;
		return async ({ update }) => {
			await update({ reset: false });
			switching = false;
		};
	};

	const confirmRemove: import('@sveltejs/kit').SubmitFunction = ({ cancel }) => {
		if (!confirm(`Remove ${data.repo.owner}/${data.repo.name} from the merge queue? Its queue, batches and settings are deleted; PRs and branches on GitHub stay.`)) return cancel();
		removing = true;
		return async ({ update }) => {
			await update();
			removing = false;
		};
	};
</script>

<svelte:head>
	<title>Settings · {data.repo.owner}/{data.repo.name} - Merge Queue</title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
	<div class="flex min-w-0 items-center gap-3">
		<a href={base} class="shrink-0 text-gray-400 transition-colors hover:text-gray-600" aria-label="Back to the queue">
			<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
			</svg>
		</a>
		<div class="min-w-0">
			<h1 class="truncate text-xl font-bold text-gray-900 sm:text-2xl">Queue settings</h1>
			<p class="truncate text-sm text-gray-500"><a href={base} class="hover:text-indigo-600">{data.repo.owner}/{data.repo.name}</a></p>
		</div>
	</div>

	{#if !data.canEdit}
		<p class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
			You can see these settings; only repository admins can change them (you have {data.role} access).
		</p>
	{/if}

	<nav aria-label="Sections" class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 text-sm sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
		{#each [{ id: 'strategy', title: 'Merge strategy' }, ...SETTING_GROUPS] as s (s.id)}
			<a href="#{s.id}" class="shrink-0 whitespace-nowrap rounded-full border border-border-subtle bg-surface-raised px-3 py-1 text-gray-600 hover:border-indigo-300 hover:text-indigo-700">{s.title}</a>
		{/each}
	</nav>

	<section id="strategy" class="scroll-mt-4 rounded-xl border border-border-subtle bg-surface-raised p-4 sm:p-5" aria-labelledby="strategy-title">
		<h2 id="strategy-title" class="text-base font-semibold text-gray-900">Merge strategy</h2>
		<p class="mt-0.5 text-sm text-gray-500">How the queue tests and merges PRs.</p>
		<div class="mt-3 grid gap-3 sm:grid-cols-2">
			{#each STRATEGIES as s (s.value)}
				{@const current = data.mode === s.value}
				<div class="flex flex-col rounded-lg border p-3 {current ? 'border-indigo-400 bg-indigo-50/50 ring-1 ring-indigo-400' : 'border-border-subtle'}">
					<div class="flex items-center gap-2">
						<span class="font-medium text-gray-900">{s.title}</span>
						{#if current}<span class="rounded bg-indigo-600 px-1.5 py-0.5 text-xs font-medium text-white">In use</span>{/if}
					</div>
					<p class="mt-1 flex-1 text-sm text-gray-600">{s.body}</p>
					<p class="mt-1 text-xs text-gray-500">{s.order}</p>
					{#if !current && data.canEdit}
						<form method="POST" action="?/setMode" use:enhance={confirmMode} class="mt-3">
							<input type="hidden" name="mode" value={s.value} />
							<button type="submit" disabled={switching} class="rounded-md border border-indigo-300 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">
								{switching ? 'Switching…' : `Switch to ${s.title.toLowerCase()}`}
							</button>
						</form>
					{/if}
				</div>
			{/each}
		</div>
		<p class="mt-2 text-xs text-gray-500">
			A switch takes effect at once, without saving.{data.mode === 'batch' ? ' Switching to one by one stops the batches being tested; their PRs go back in line, not marked as failed.' : ''}
		</p>
		{#if form?.modeError}<p class="mt-2 text-sm text-red-600" role="alert">{form.modeError}</p>{/if}
		{#if form?.modeSaved}<p class="mt-2 text-xs text-green-700" role="status">Switched. The queue works this way from its next step.</p>{/if}
	</section>

	<form
		method="POST"
		action="?/saveSettings"
		class="space-y-6"
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				// Keep what was typed on an error; show the stored values after a save.
				await update({ reset: false });
				saving = false;
			};
		}}
	>
		{#each SETTING_GROUPS as group (group.id)}
			<section id={group.id} class="scroll-mt-4 rounded-xl border border-border-subtle bg-surface-raised p-4 sm:p-5" aria-labelledby="{group.id}-title">
				<h2 id="{group.id}-title" class="text-base font-semibold text-gray-900">{group.title}</h2>
				<p class="mt-0.5 text-sm text-gray-500">
					{group.help}{group.id !== 'ci' && data.mode !== 'batch' ? ' Used when merging in batches.' : ''}
				</p>
				<fieldset class="mt-3 divide-y divide-border-subtle" disabled={!data.canEdit || saving}>
					<legend class="sr-only">{group.title}</legend>
					{#each group.fields as f (f.name)}
						{@const v = shown(f, data.settings)}
						{@const id = f.name.replace('.', '-')}
						<div class="-mx-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-l-2 px-2 py-2.5 {isDefault(f) ? 'border-transparent' : 'border-amber-400 bg-amber-50/40'}">
							<div class="min-w-0 flex-1">
								<label for={id} class="text-sm font-medium text-gray-800">{f.label}</label>
								<p id="{id}-help" class="text-xs text-gray-500">
									{f.help}
									{#if !isDefault(f)}<span class="font-medium text-amber-700">Changed from the default, {fmt(f, shown(f, data.settings.defaults))}.</span>{/if}
								</p>
							</div>
							{#if f.kind === 'boolean'}
								<span class="flex w-[7.75rem] shrink-0 justify-end"><input {id} type="checkbox" name={f.name} checked={v as boolean} aria-describedby="{id}-help" class="h-4 w-4 rounded border-border-subtle" /></span>
							{:else if f.kind === 'number' || f.kind === 'duration'}
								<span class="flex shrink-0 items-center gap-1">
									<input {id} type="number" name={f.name} value={v} min={f.min ?? 0} step={f.kind === 'duration' ? 'any' : 1} required aria-describedby="{id}-help" class="w-24 rounded border border-border-subtle bg-transparent px-2 py-1 text-right text-sm tabular-nums" />
									<span class="w-7 text-xs text-gray-500">{f.unit ?? ''}</span>
								</span>
							{:else if f.kind === 'text'}
								<input {id} type="text" name={f.name} value={v} required={f.name !== 'ci.dispatchRef'} aria-describedby="{id}-help" class="w-full rounded border border-border-subtle bg-transparent px-2 py-1 font-mono text-xs sm:w-60" />
							{/if}
						</div>
					{/each}
				</fieldset>
			</section>
		{/each}

		{#if form?.error && !data.canEdit}<p class="text-sm text-red-600" role="alert">{form.error}</p>{/if}
		{#if data.canEdit}
			<div class="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t border-border-subtle bg-surface px-1 py-3">
				<button type="submit" disabled={saving} class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{saving ? 'Saving…' : 'Save settings'}</button>
				{#if form?.error}<p class="text-sm text-red-600" role="alert">{form.error}</p>{/if}
				{#if form?.settingsSaved && !form?.error}<span class="text-sm text-green-700" role="status">Saved. The queue uses them from its next step.</span>{/if}
			</div>
		{/if}
	</form>

	{#if data.canRemove}
		<section id="danger" class="scroll-mt-4 rounded-xl border border-red-200 bg-surface-raised p-4 sm:p-5" aria-labelledby="danger-title">
			<h2 id="danger-title" class="text-base font-semibold text-red-800">Danger zone</h2>
			<div class="mt-2 flex flex-wrap items-center justify-between gap-3">
				<p class="min-w-0 flex-1 text-sm text-gray-600">
					Remove this repository from the merge queue. Its queue, batches and settings are deleted; PRs and branches on GitHub stay. You can add it again from the dashboard.
				</p>
				<form method="POST" action="?/remove" use:enhance={confirmRemove}>
					<button type="submit" disabled={removing} class="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
						{removing ? 'Removing…' : 'Remove repository'}
					</button>
				</form>
			</div>
			{#if form?.removeError}<p class="mt-2 text-sm text-red-600" role="alert">{form.removeError}</p>{/if}
		</section>
	{/if}
</div>
