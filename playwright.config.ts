import { defineConfig } from '@playwright/test';
/** LM_E2E_BASE_URL targets an already running server (e.g. the authoring job); otherwise a dev server is started. */
const external = process.env.LM_E2E_BASE_URL;
export default defineConfig({
  testDir: './tests/browser',
  use: {
    baseURL: external ?? 'http://127.0.0.1:3000',
    headless: true,
    // Opt-in egress proxy for checking a deployed site from a restricted network.
    ...(process.env.LM_E2E_PROXY ? { proxy: { server: process.env.LM_E2E_PROXY } } : {}),
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}
  },
  ...(external ? {} : { webServer: { command: 'pnpm dev --hostname 127.0.0.1', url: 'http://127.0.0.1:3000', reuseExistingServer: !process.env.CI, timeout: 120000 } })
});
