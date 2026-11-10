// The queue settings as the repository page edits them: labels, units and help for each field,
// and turning a submitted form back into the body the settings API takes. Shared by the page
// (to render) and its action (to parse), so both agree on names and units.

export type FieldKind = 'number' | 'duration' | 'boolean' | 'text';

export interface SettingField {
	/** `config.<key>`, `ci.<key>` or `view.<key>`. */
	name: string;
	label: string;
	help: string;
	kind: FieldKind;
	/** Durations: milliseconds per unit shown. */
	unitMs?: number;
	unit?: string;
	min?: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export const BATCH_FIELDS: SettingField[] = [
	{ name: 'config.maxBatch', label: 'Batch size', help: 'Most PRs tested together in one batch.', kind: 'number', min: 1 },
	{ name: 'config.depth', label: 'Batches in flight', help: 'Batches tested at once, each built on the one before it.', kind: 'number', min: 1 },
	{ name: 'config.expressMax', label: 'Urgent batch size', help: 'Most urgent PRs in an express batch, tested on their own with the next batch built on top.', kind: 'number', min: 1 },
	{ name: 'config.bisectRuns', label: 'Bisection runs at once', help: 'Runs of a failed batch tested at the same time; the rest wait their turn. 2 runs both halves of a split side by side (one lands, the other keeps narrowing): about half the time for a few more runs, given runners to spare.', kind: 'number', min: 1 },
	{ name: 'config.collectWindowMs', label: 'Wait for a fuller batch', help: 'How long a partial batch waits for more PRs before it is tested.', kind: 'duration', unitMs: MIN, unit: 'min' },
	{ name: 'config.ciTimeoutMs', label: 'CI timeout', help: 'A batch with no CI result after this long pauses the queue.', kind: 'duration', unitMs: HOUR, unit: 'h' },
	{ name: 'config.retryFailed', label: 'Re-run failed jobs once', help: 'Before a failure counts, its failed jobs run again (for flaky tests).', kind: 'boolean' },
	{ name: 'config.stopOnFirstFailure', label: 'Stop a red run early', help: 'A run of several PRs counts as failed at its first failed job, and the rest of it is cancelled. A PR tested alone still runs to the end, so its author sees every failure.', kind: 'boolean' },
	{ name: 'config.requireApproval', label: 'Require approval', help: 'Only approved PRs enter a batch.', kind: 'boolean' },
	{ name: 'config.approvalOnHead', label: 'Approval on the current head', help: 'A push after the approval needs a new one.', kind: 'boolean' },
	{ name: 'config.requirePRChecks', label: "Hold PRs whose own checks failed", help: "A PR whose required check failed on its head waits for a fix. Checks still running never hold a PR: the batch's CI tests it.", kind: 'boolean' },
	{ name: 'config.autoRebase', label: 'Restack automatically', help: 'Rebase PRs whose parent was rebased or merged, when that needs no conflict resolution.', kind: 'boolean' },
	{ name: 'config.masterRun', label: 'Run CI on the default branch after landing', help: 'Saves caches and runs what the repo runs there.', kind: 'boolean' },
	{ name: 'config.masterRunMinGapMs', label: 'Least time between those runs', help: '0 runs one per landed batch.', kind: 'duration', unitMs: MIN, unit: 'min' }
];

export const CI_FIELDS: SettingField[] = [
	{ name: 'ci.workflow', label: 'Workflow', help: 'The workflow file the queue starts on its branches.', kind: 'text' },
	{ name: 'ci.requiredCheck', label: 'Deciding check', help: 'The check run whose result decides a batch.', kind: 'text' },
	{ name: 'ci.prStatus', label: 'PR status', help: 'The status the queue keeps on each PR; require it on the default branch.', kind: 'text' },
	{ name: 'ci.testedStatus', label: 'Tested status', help: 'The status set on the default branch when its tree was tested.', kind: 'text' },
	{ name: 'ci.dispatchRef', label: 'Ref for the default-branch run', help: 'Empty: the default branch.', kind: 'text' }
];

export const VIEW_FIELDS: SettingField[] = [
	{ name: 'view.publicView', label: 'Public read-only page', help: 'Anyone with the link sees this page without signing in, and can change nothing. Only for public repositories.', kind: 'boolean' }
];

export const ALL_FIELDS = [...BATCH_FIELDS, ...CI_FIELDS, ...VIEW_FIELDS];

type Shown = { config: object; ci: object; view?: object };

/** The value a field shows, from the stored settings. */
export function shown(f: SettingField, settings: Shown): string | number | boolean {
	const [group, key] = f.name.split('.') as ['config' | 'ci' | 'view', string];
	const v = ((settings[group] ?? {}) as Record<string, unknown>)[key];
	if (f.kind === 'duration') return Math.round(((v as number) / f.unitMs!) * 100) / 100;
	return v as string | number | boolean;
}

/**
 * The settings API body from a submitted form; throws with a message on a bad value. With
 * `current`, only what changed is sent: a duration shown rounded is not written back rounded.
 */
export function parseSettingsForm(
	form: FormData,
	current?: Shown
): { config: Record<string, unknown>; ci: Record<string, string>; publicView?: boolean } {
	const config: Record<string, unknown> = {};
	const ci: Record<string, string> = {};
	let publicView: boolean | undefined = form.get('view.publicView') === 'on';
	if (current && publicView === shown(VIEW_FIELDS[0], current)) publicView = undefined;
	for (const f of ALL_FIELDS) {
		const [group, key] = f.name.split('.');
		if (group === 'view') continue;
		const raw = form.get(f.name);
		if (f.kind === 'boolean') {
			config[key] = raw === 'on';
			continue;
		}
		if (raw === null) continue;
		const text = String(raw).trim();
		if (f.kind === 'text') {
			if (group === 'ci') ci[key] = text;
			continue;
		}
		const n = Number(text);
		if (text === '' || !Number.isFinite(n) || n < (f.min ?? 0)) throw new Error(`${f.label} must be a number of at least ${f.min ?? 0}`);
		if (f.kind === 'number' && !Number.isInteger(n)) throw new Error(`${f.label} must be a whole number`);
		if (current && n === shown(f, current)) continue;
		config[key] = f.kind === 'duration' ? Math.round(n * f.unitMs!) : n;
	}
	if (current) {
		for (const [k, v] of Object.entries(config)) if ((current.config as Record<string, unknown>)[k] === v) delete config[k];
		for (const [k, v] of Object.entries(ci)) if ((current.ci as Record<string, unknown>)[k] === v) delete ci[k];
	}
	return publicView === undefined ? { config, ci } : { config, ci, publicView };
}

/** The settings page's sections, in order: each a heading, an anchor and its fields. */
export const SETTING_GROUPS: { id: string; title: string; help: string; fields: SettingField[] }[] = [
	{ id: 'batching', title: 'Batches', help: 'How PRs are grouped and tested together.', fields: pick('config.maxBatch', 'config.depth', 'config.collectWindowMs') },
	{ id: 'failures', title: 'Urgent PRs and failures', help: 'Urgent PRs skip ahead; a failed batch is narrowed down to the PR that breaks it.', fields: pick('config.expressMax', 'config.bisectRuns', 'config.retryFailed', 'config.stopOnFirstFailure') },
	{ id: 'rules', title: 'Who can enter a batch', help: 'What a PR needs before the queue tests it.', fields: pick('config.requireApproval', 'config.approvalOnHead', 'config.requirePRChecks', 'config.autoRebase') },
	{ id: 'ci', title: 'CI', help: 'How the queue starts and reads CI.', fields: [...pick('config.ciTimeoutMs', 'config.masterRun', 'config.masterRunMinGapMs'), ...CI_FIELDS] },
	{ id: 'visibility', title: 'Visibility', help: 'Who can see the queue page.', fields: VIEW_FIELDS }
];

function pick(...names: string[]): SettingField[] {
	return names.map((n) => {
		const f = BATCH_FIELDS.find((x) => x.name === n);
		if (!f) throw new Error(`No setting ${n}`);
		return f;
	});
}
