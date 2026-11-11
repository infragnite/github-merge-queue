<script lang="ts">
	// One colour per meaning across the page: sky runs, violet bisects, red fails, green passed,
	// gray stopped. Amber is kept for waiting (runners, preparation).
	let { status, label = null }: { status: string; label?: string | null } = $props();

	const TONE: Record<string, string> = {
		testing: 'bg-sky-50 text-sky-700 ring-sky-200',
		retrying: 'bg-sky-50 text-sky-700 ring-sky-200',
		bisecting: 'bg-violet-50 text-violet-700 ring-violet-200',
		failing: 'bg-red-50 text-red-700 ring-red-200',
		failed: 'bg-red-50 text-red-700 ring-red-200',
		passed: 'bg-green-50 text-green-700 ring-green-200',
		landed: 'bg-green-50 text-green-700 ring-green-200',
		merged: 'bg-green-50 text-green-700 ring-green-200',
		preparing: 'bg-amber-50 text-amber-800 ring-amber-200',
		superseded: 'bg-gray-50 text-gray-600 ring-gray-200',
		cancelled: 'bg-gray-50 text-gray-600 ring-gray-200'
	};
	const TEXT: Record<string, string> = {
		testing: 'testing',
		retrying: 're-running failed jobs',
		bisecting: 'bisecting',
		failing: 'failing',
		failed: 'failed',
		passed: 'passed',
		landed: 'landed',
		merged: 'merged',
		preparing: 'preparing',
		superseded: 'rebuilt',
		cancelled: 'cancelled'
	};
</script>

<span class="inline-flex shrink-0 items-center rounded-full px-2 py-px text-[11px] font-medium ring-1 ring-inset {TONE[status] ?? 'bg-gray-50 text-gray-600 ring-gray-200'}">{label ?? TEXT[status] ?? status}</span>
