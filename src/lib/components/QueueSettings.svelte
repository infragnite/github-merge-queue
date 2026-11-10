<script lang="ts">
	import { enhance } from '$app/forms';
	import { BATCH_FIELDS, CI_FIELDS, shown, type SettingField } from '$lib/settings-form';

	type Settings = { config: object; ci: object };
	let {
		settings,
		canEdit,
		error = null,
		saved = false
	}: { settings: Settings & { defaults: Settings }; canEdit: boolean; error?: string | null; saved?: boolean } = $props();

	let saving = $state(false);
	const isDefault = (f: SettingField) => shown(f, settings) === shown(f, settings.defaults);
	const fmt = (f: SettingField, v: string | number | boolean) => (f.kind === 'boolean' ? (v ? 'on' : 'off') : f.kind === 'duration' ? `${v} ${f.unit}` : v === '' ? 'empty' : String(v));
</script>

<details class="rounded-xl border border-border-subtle bg-surface-raised" open={!!error}>
	<summary class="cursor-pointer px-4 py-2.5 text-sm font-medium text-gray-700">Settings</summary>
	<form
		method="POST"
		action="?/saveSettings"
		class="space-y-4 px-4 pb-4"
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				// Keep what was typed on an error; show the stored values after a save.
				await update({ reset: false });
				saving = false;
			};
		}}
	>
		{#if !canEdit}
			<p class="text-xs text-gray-500">Only repository admins can change these.</p>
		{/if}
		{#each [{ title: 'Batching', fields: BATCH_FIELDS }, { title: 'CI', fields: CI_FIELDS }] as group (group.title)}
			<fieldset class="space-y-2" disabled={!canEdit || saving}>
				<legend class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{group.title}</legend>
				{#each group.fields as f (f.name)}
					{@const v = shown(f, settings)}
					<label class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
						{#if f.kind === 'boolean'}
							<input type="checkbox" name={f.name} checked={v as boolean} class="rounded border-border-subtle" />
						{/if}
						<span class="min-w-0 flex-1 text-gray-800">
							{f.label}
							<span class="block text-xs text-gray-500">{f.help}{isDefault(f) ? '' : ` Default: ${fmt(f, shown(f, settings.defaults))}.`}</span>
						</span>
						{#if f.kind === 'number' || f.kind === 'duration'}
							<span class="flex shrink-0 items-center gap-1">
								<input type="number" name={f.name} value={v} min={f.min ?? 0} step={f.kind === 'duration' ? 'any' : 1} required class="w-24 rounded border border-border-subtle bg-transparent px-2 py-1 text-right text-sm tabular-nums" />
								{#if f.unit}<span class="w-6 text-xs text-gray-500">{f.unit}</span>{/if}
							</span>
						{:else if f.kind === 'text'}
							<input type="text" name={f.name} value={v} required={f.name !== 'ci.dispatchRef'} class="w-full rounded border border-border-subtle bg-transparent px-2 py-1 font-mono text-xs sm:w-56" />
						{/if}
					</label>
				{/each}
			</fieldset>
		{/each}
		{#if error}<p class="text-sm text-red-600" role="alert">{error}</p>{/if}
		{#if canEdit}
			<div class="flex items-center gap-3">
				<button type="submit" disabled={saving} class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{saving ? 'Saving…' : 'Save settings'}</button>
				{#if saved && !error}<span class="text-xs text-green-700">Saved. The queue uses them from its next step.</span>{/if}
			</div>
		{/if}
	</form>
</details>
