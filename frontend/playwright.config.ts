import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:5176',
    viewport: { width: 1440, height: 1000 },
    browserName: 'chromium',
    channel: 'msedge',
    reducedMotion: 'reduce',
    colorScheme: 'light',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5176 --strictPort',
    url: 'http://127.0.0.1:5176',
    reuseExistingServer: false,
  },
})
