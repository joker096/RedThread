import { expect, test } from '@playwright/test';

const lightThemeToggle = /switch to light theme|включить светлую тему/i;
const darkThemeToggle = /switch to dark theme|включить тёмную тему|включить темную тему/i;
const showDemoChats = /show demo conversations|показать демо-переписки/i;
const hideDemoChats = /hide demo conversations|скрыть демо-переписки/i;

test('theme toggle changes scheme and persists after reload', async ({ page }) => {
  await page.goto('/');
  const lightToggle = page.getByRole('button', { name: lightThemeToggle }).first();
  await expect(lightToggle).toBeVisible();
  await lightToggle.click({ force: true });

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: darkThemeToggle }).first()).toBeVisible();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: darkThemeToggle }).first()).toBeVisible();
});

test('real match inbox refreshes when the app window regains focus', async ({ page }) => {
  let matchRequests = 0;
  await page.route('**/api/matches', async route => {
    matchRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ matches: [] })
    });
  });

  await page.goto('/');
  const chatsButton = page.locator('[data-testid="nav-chats"]:visible').first();
  await expect(chatsButton).toBeVisible();
  await chatsButton.click();
  await expect(page.getByTestId('server-matches-panel')).toBeVisible();
  await expect.poll(() => matchRequests).toBeGreaterThan(0);

  const initialRequests = matchRequests;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => matchRequests).toBeGreaterThan(initialRequests);
});

test('demo conversations stay hidden until explicitly opened', async ({ page }) => {
  await page.goto('/');
  // Use a stable test id so the test does not depend on locale-specific labels.
  const chatsButton = page.locator('[data-testid="nav-chats"]:visible').first();
  await expect(chatsButton).toBeVisible();
  await chatsButton.click();

  // The chats screen must expose the real, server-backed match inbox separately from opt-in demo data.
  await expect(page.getByTestId('server-matches-panel')).toBeVisible();
  await expect(page.getByText(/prototype conversations are hidden|демонстрационные переписки скрыты/i)).toBeVisible();
  await expect(page.getByRole('button', { name: showDemoChats })).toBeVisible();

  await page.getByRole('button', { name: showDemoChats }).click();
  await expect(page.getByText(/local prototype data|локальные демонстрационные данные/i)).toBeVisible();
  await expect(page.getByRole('button', { name: hideDemoChats })).toBeVisible();

  await page.getByRole('button', { name: hideDemoChats }).click();
  await expect(page.getByRole('button', { name: showDemoChats })).toBeVisible();
});
