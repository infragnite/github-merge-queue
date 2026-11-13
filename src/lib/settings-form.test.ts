import { expect, test } from 'vitest';
import { parseSettingsForm, shown, BATCH_FIELDS, ALL_FIELDS, SETTING_GROUPS } from './settings-form';

const form = (entries: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(entries)) f.set(k, v);
	return f;
};

test('a submitted form becomes the settings API body, durations in milliseconds and unchecked boxes off', () => {
	const body = parseSettingsForm(
		form({
			'config.maxBatch': '32',
			'config.depth': '2',
			'config.collectWindowMs': '10',
			'config.ciTimeoutMs': '1.5',
			'config.masterRunMinGapMs': '0',
			'config.retryFailed': 'on',
			'ci.workflow': ' ci.yml ',
			'ci.dispatchRef': ''
		})
	);
	expect(body.config).toEqual({
		maxBatch: 32,
		depth: 2,
		collectWindowMs: 600_000,
		ciTimeoutMs: 5_400_000,
		masterRunMinGapMs: 0,
		retryFailed: true,
		requireApproval: false,
		approvalOnHead: false,
		requirePRChecks: false,
		autoRebase: false,
		masterRun: false,
		stopOnFirstFailure: false,
		autoTry: false
	});
	expect(body.ci).toEqual({ workflow: 'ci.yml', dispatchRef: '' });
});

test('bad numbers are refused with the field name', () => {
	expect(() => parseSettingsForm(form({ 'config.maxBatch': '0' }))).toThrow('Batch size must be a number of at least 1');
	expect(() => parseSettingsForm(form({ 'config.maxBatch': '2.5' }))).toThrow('Batch size must be a whole number');
	expect(() => parseSettingsForm(form({ 'config.depth': '' }))).toThrow('Batches in flight must be a number of at least 1');
});

test('durations are shown in their unit', () => {
	const f = BATCH_FIELDS.find((x) => x.name === 'config.ciTimeoutMs')!;
	expect(shown(f, { config: { ciTimeoutMs: 12 * 3_600_000 }, ci: {} })).toBe(12);
});

test('with the current settings, only changed fields are sent, so a rounded duration is not written back', () => {
	const current = { config: { maxBatch: 8, collectWindowMs: 61_234, retryFailed: true }, ci: { workflow: 'ci.yml' } };
	const body = parseSettingsForm(form({ 'config.maxBatch': '32', 'config.collectWindowMs': '1.02', 'config.retryFailed': 'on', 'ci.workflow': 'ci.yml' }), current);
	expect(body.config.maxBatch).toBe(32);
	expect(body.config).not.toHaveProperty('collectWindowMs');
	expect(body.config).not.toHaveProperty('retryFailed');
	expect(body.ci).toEqual({});
});

test('the public page box is sent only when it changed', () => {
	const current = { config: {}, ci: {}, view: { publicView: false } };
	expect(parseSettingsForm(form({ 'view.publicView': 'on' }), current).publicView).toBe(true);
	expect(parseSettingsForm(form({}), current)).not.toHaveProperty('publicView');
	expect(parseSettingsForm(form({}), { ...current, view: { publicView: true } }).publicView).toBe(false);
});

test('the settings page shows every field exactly once (a boolean left off would be saved as off)', () => {
	const shownNames = SETTING_GROUPS.flatMap((g) => g.fields.map((f) => f.name));
	expect([...shownNames].sort()).toEqual(ALL_FIELDS.map((f) => f.name).sort());
});

test('how much the queue comments is a choice of all, only when action is needed, or none, all by default', () => {
	const f = ALL_FIELDS.find((x) => x.name === 'config.comments')!;
	expect(f.kind).toBe('choice');
	expect(f.options?.map((o) => o.value)).toEqual(['all', 'attention', 'none']);
	expect(shown(f, { config: { comments: 'all' }, ci: {} })).toBe('all');
	expect(parseSettingsForm(form({ 'config.comments': 'attention' })).config.comments).toBe('attention');
	expect(parseSettingsForm(form({ 'config.comments': 'none' }), { config: { comments: 'none' }, ci: {} }).config).not.toHaveProperty('comments');
	expect(() => parseSettingsForm(form({ 'config.comments': 'loud' }))).toThrow('PR comments must be one of: All, Only when action is needed, None');
});

test('urgent batches have no size setting of their own: they follow the batch size', () => {
	expect(ALL_FIELDS.map((f) => f.name)).not.toContain('config.expressMax');
	expect(SETTING_GROUPS.find((g) => g.id === 'failures')!.fields.map((f) => f.name)).toEqual(['config.bisectRuns', 'config.retryFailed', 'config.stopOnFirstFailure']);
});

test('automatic tries have their own section: on/off, how many at once, and the delay after a push in minutes', () => {
	const g = SETTING_GROUPS.find((x) => x.id === 'auto-try')!;
	expect(g.fields.map((f) => f.name)).toEqual(['config.autoTry', 'config.autoTryMax', 'config.autoTryDelayMs']);
	expect(g.help).toMatch(/no-auto-try/);
	const max = ALL_FIELDS.find((f) => f.name === 'config.autoTryMax')!;
	expect(max).toMatchObject({ kind: 'number', min: 1 });
	const delay = ALL_FIELDS.find((f) => f.name === 'config.autoTryDelayMs')!;
	expect(shown(delay, { config: { autoTryDelayMs: 120_000 }, ci: {} })).toBe(2);
	const body = parseSettingsForm(form({ 'config.autoTry': 'on', 'config.autoTryMax': '3', 'config.autoTryDelayMs': '5' }));
	expect(body.config).toMatchObject({ autoTry: true, autoTryMax: 3, autoTryDelayMs: 300_000 });
	expect(() => parseSettingsForm(form({ 'config.autoTryMax': '0' }))).toThrow(/at least 1/);
});
