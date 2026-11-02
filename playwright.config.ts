import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium-desktop',
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1365, height: 900 } }
    },
    {
      name: 'chromium-mobile',
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices['Pixel 7'], viewport: { width: 540, height: 960 }, deviceScaleFactor: 1 }
    },
    {
      name: 'store-assets-phone',
      testMatch: /store-assets\.spec\.ts/,
      use: { browserName: 'chromium', viewport: { width: 540, height: 960 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    }
  ],
  // Start the real API against the migrated PostgreSQL test database before
  // starting the web preview. The readiness URL fails until DB connectivity works.
  webServer: [
    {
      command: 'npm run start:api',
      url: 'http://127.0.0.1:3001/api/ready',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000
    },
    {
      command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000
    }
  ]
});
