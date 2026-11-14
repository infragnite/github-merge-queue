<script lang="ts">
	import { githubRefs } from '$lib/github-refs';
	let { text, owner, name, commits = [] }: { text: string; owner: string; name: string; commits?: string[] } = $props();
</script>

{#each githubRefs(text, owner, name, commits) as part}
	{#if part.href}<a href={part.href} target="_blank" rel="noopener" class="underline decoration-current/30 underline-offset-2 hover:text-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">{part.text}</a>{:else}{part.text}{/if}
{/each}
