import { defineConfig } from '@playwright/test';

// Uses the Edge that ships with Windows, so no browser download is needed.
// On other systems set PW_CHANNEL=chrome (or install Playwright's Chromium).
export default defineConfig({
	testDir: './specs',
	fullyParallel: false,
	workers: 1,
	reporter: [['list'], ['html', { open: 'never' }]],
	timeout: 30_000,
	use: {
		baseURL: 'http://localhost:8091',
		channel: process.env.PW_CHANNEL || 'msedge',
		trace: 'retain-on-failure',
	},
	webServer: {
		// Fresh data directory for every run.
		command: 'node -e "require(\'fs\').rmSync(\'.data/8091\',{recursive:true,force:true})" && node dev-server.mjs',
		url: 'http://localhost:8091/sb/',
		env: { PORT: '8091' },
		reuseExistingServer: false,
		timeout: 60_000,
	},
});
