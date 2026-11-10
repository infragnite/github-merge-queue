<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import Navbar from '$lib/components/Navbar.svelte';

	let { data, children } = $props();
	// A repository page opened signed out, because the repository made it public.
	const publicView = $derived(!data.user && page.data.anonymous === true);
</script>

{#if data.user}
	<div class="min-h-screen bg-surface">
		<Navbar user={data.user} />
		<main class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
			{@render children()}
		</main>
	</div>
{:else if publicView}
	<div class="min-h-screen bg-surface">
		<nav class="border-b border-border-subtle bg-surface-raised">
			<div class="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
				<span class="flex items-center gap-2.5">
					<span class="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
						<svg class="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
							<path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h12M4 18h8" />
						</svg>
					</span>
					<span class="text-sm font-semibold text-gray-900">Merge Queue</span>
				</span>
				<span class="flex items-center gap-3 text-sm">
					<span class="text-gray-500">Viewing read-only</span>
					<a href="/login?next={encodeURIComponent(page.url.pathname)}" class="rounded-md border border-border-subtle px-3 py-1.5 text-gray-700 hover:bg-surface-sunken">Sign in</a>
				</span>
			</div>
		</nav>
		<main class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
			{@render children()}
		</main>
	</div>
{:else}
	<div class="min-h-screen bg-surface">
		{@render children()}
	</div>
{/if}
