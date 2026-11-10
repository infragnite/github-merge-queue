import { expect, test } from 'vitest';
import { parseSettingsForm, shown, BATCH_FIELDS } from './settings-form';

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
		masterRun: false
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
