<script lang="ts">
	import '../app.css';
	import Navbar from '$lib/components/Navbar.svelte';

	let { data, children } = $props();
</script>

{#if data.user}
	<div class="min-h-screen bg-surface">
		<Navbar user={data.user} />
		<main class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
			{@render children()}
		</main>
	</div>
{:else}
	<div class="min-h-screen bg-surface">
		{@render children()}
	</div>
{/if}
