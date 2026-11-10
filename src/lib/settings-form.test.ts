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
		stopOnFirstFailure: false
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
