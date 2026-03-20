<script lang="ts">
	let { user }: { user: { id: number; login: string; name: string | null; avatarUrl: string | null } } = $props();
	let menuOpen = $state(false);
</script>

<nav class="border-b border-border-subtle bg-surface-raised">
	<div class="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
		<!-- Logo -->
		<div class="flex items-center gap-6">
			<a href="/" class="flex items-center gap-2.5">
				<div class="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
					<svg class="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h12M4 18h8" />
					</svg>
				</div>
				<span class="text-sm font-semibold text-gray-900">Merge Queue</span>
			</a>

			<div class="hidden items-center gap-1 sm:flex">
				<a href="/" class="rounded-md px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-surface-sunken hover:text-gray-900">
					Dashboard
				</a>
				<a href="/settings" class="rounded-md px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-surface-sunken hover:text-gray-900">
					Settings
				</a>
			</div>
		</div>

		<!-- User Menu -->
		<div class="relative">
			<button
				onclick={() => (menuOpen = !menuOpen)}
				class="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-sunken"
			>
				{#if user.avatarUrl}
					<img src={user.avatarUrl} alt="" class="h-6 w-6 rounded-full" />
				{:else}
					<div class="flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-600">
						{user.login[0].toUpperCase()}
					</div>
				{/if}
				<span class="hidden text-sm text-gray-700 sm:block">{user.login}</span>
				<svg class="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
				</svg>
			</button>

			{#if menuOpen}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="fixed inset-0 z-40" onclick={() => (menuOpen = false)}></div>
				<div class="absolute right-0 z-50 mt-1 w-48 rounded-lg border border-border-subtle bg-surface-raised py-1 shadow-lg">
					<div class="border-b border-border-subtle px-3 py-2">
						<p class="text-sm font-medium text-gray-900">{user.name || user.login}</p>
						<p class="text-xs text-gray-500">@{user.login}</p>
					</div>
					<a
						href="https://github.com/{user.login}"
						target="_blank"
						rel="noopener"
						class="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-surface-sunken"
					>
						<svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
							<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
						</svg>
						GitHub Profile
					</a>
					<a
						href="/auth/logout"
						class="flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
						</svg>
						Sign Out
					</a>
				</div>
			{/if}
		</div>
	</div>
</nav>
