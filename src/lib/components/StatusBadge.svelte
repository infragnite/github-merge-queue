<script lang="ts">
	let { status }: { status: string } = $props();

	const config = $derived.by(() => {
		switch (status) {
			case 'queued':
				return { label: 'Queued', class: 'bg-gray-100 text-gray-700' };
			case 'updating':
				return { label: 'Updating', class: 'bg-blue-100 text-blue-700' };
			case 'checking':
				return { label: 'Checking CI', class: 'bg-amber-100 text-amber-700' };
			case 'merging':
				return { label: 'Merging', class: 'bg-purple-100 text-purple-700' };
			case 'merged':
				return { label: 'Merged', class: 'bg-emerald-100 text-emerald-700' };
			case 'failed':
				return { label: 'Failed', class: 'bg-red-100 text-red-700' };
			case 'cancelled':
				return { label: 'Cancelled', class: 'bg-gray-100 text-gray-500' };
			default:
				return { label: status, class: 'bg-gray-100 text-gray-600' };
		}
	});

	const isActive = $derived(['updating', 'checking', 'merging'].includes(status));
</script>

<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium {config.class}">
	{#if isActive}
		<span class="relative flex h-2 w-2">
			<span class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 {status === 'updating' ? 'bg-blue-400' : status === 'checking' ? 'bg-amber-400' : 'bg-purple-400'}"></span>
			<span class="relative inline-flex h-2 w-2 rounded-full {status === 'updating' ? 'bg-blue-500' : status === 'checking' ? 'bg-amber-500' : 'bg-purple-500'}"></span>
		</span>
	{/if}
	{config.label}
</span>
