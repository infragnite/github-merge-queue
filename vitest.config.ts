import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: {
			'$env/dynamic/private': fileURLToPath(new URL('./src/lib/server/testing/env.ts', import.meta.url)),
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node',
		// The queue logs a line per event; tests that check logs capture them with setLogSink.
		env: { LOG_LEVEL: 'silent' }
	}
});
