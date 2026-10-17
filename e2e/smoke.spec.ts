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
  await page.route('**/api/matches**', async route => {
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

test('expired session clears the match inbox instead of leaving stale chats visible', async ({ page }) => {
  let matchRequests = 0;
  await page.route('**/api/matches**', async route => {
    matchRequests += 1;
    if (matchRequests === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          matches: [{
            id: 'e2e-match-id',
            partnerId: 'e2e-partner-id',
            displayName: 'Тестовый матч',
            age: 29,
            country: 'Грузия',
            city: 'Тбилиси',
            lastMessage: 'Привет!',
            lastMessageAt: new Date().toISOString()
          }]
        })
      });
      return;
    }
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) });
  });

  await page.goto('/');
  const chatsButton = page.locator('[data-testid="nav-chats"]:visible').first();
  await expect(chatsButton).toBeVisible();
  await chatsButton.click();
  await expect(page.getByTestId('server-match-item')).toContainText('Тестовый матч');

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => matchRequests).toBeGreaterThan(1);
  await expect(page.getByText(/sign in to see your matches|войдите, чтобы увидеть свои совпадения/i)).toBeVisible();
  await expect(page.getByTestId('server-match-item')).toHaveCount(0);
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


test('language selector changes locale and persists on a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');

  const languageSelector = page.locator('#app-language');
  await expect(languageSelector).toBeVisible();
  await languageSelector.selectOption('de');

  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(languageSelector).toHaveValue('de');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('vow-locale-preference-v1'))).toBe('de');

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  expect(
    dimensions.document,
    `language selector causes horizontal overflow at 320px: ${JSON.stringify(dimensions)}`
  ).toBeLessThanOrEqual(dimensions.viewport);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('#app-language')).toHaveValue('de');

  await page.locator('#app-language').selectOption('pt');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('vow-locale-preference-v1'))).toBe('pt');
});

test('common phone viewports have no document-level horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await expect(page.getByText('Vow', { exact: false }).first()).toBeVisible();

  for (const width of [320, 360, 375, 390, 414, 430]) {
    await page.setViewportSize({ width, height: 720 });
    const dimensions = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const overflowing = Array.from(document.querySelectorAll('body *'))
        .map(element => {
          const rect = element.getBoundingClientRect();
          return { tag: element.tagName, className: typeof element.className === 'string' ? element.className.slice(0, 120) : '', text: (element.textContent || '').trim().slice(0, 50), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
        })
        .filter(item => item.width > 0 && (item.left < -1 || item.right > viewport + 1))
        .sort((a, b) => b.right - a.right)
        .slice(0, 12);
      return { viewport, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, overflowing };
    });

    expect(
      dimensions.document,
      `document overflows at ${width}px: viewport=${dimensions.viewport}, document=${dimensions.document}, body=${dimensions.body}; elements=${JSON.stringify(dimensions.overflowing)}`
    ).toBeLessThanOrEqual(dimensions.viewport);
  }
});

test('reduced-motion preference disables decorative motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  const styles = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'vow-profile-card vow-motion-button';
    document.body.appendChild(probe);
    const card = getComputedStyle(probe);
    const button = getComputedStyle(probe);
    return {
      animationName: card.animationName,
      animationDuration: card.animationDuration,
      transitionDuration: button.transitionDuration,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
    };
  });

  expect(styles.reducedMotion).toBe(true);
  expect(styles.animationName).toBe('none');
  expect(styles.animationDuration.split(',').every(value => ['0s', '0.01ms'].includes(value.trim()))).toBe(true);
  expect(styles.transitionDuration.split(',').every(value => ['0s', '0.01ms'].includes(value.trim()))).toBe(true);
});

test('password reset token is removed from the address bar before the reset form is shown', async ({ page }) => {
  const token = 'e2e-sensitive-reset-token';
  await page.goto(`/?resetPassword=${token}`);

  // The account panel is mounted on the Tests tab; its effect consumes and scrubs the one-time token.
  await page.locator('[data-testid="nav-tests"]:visible, [data-testid="mobile-nav-tests"]:visible').first().click();
  await expect(page.locator('input[autocomplete="new-password"]')).toBeVisible();
  await expect.poll(() => page.url()).not.toContain(token);
  await expect(page.locator('input[autocomplete="new-password"]')).toHaveAttribute('minlength', '12');
});


test('RTL languages set document direction and remain usable on narrow phones', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');

  const languageSelector = page.locator('#app-language');
  await expect(languageSelector).toBeVisible();

  for (const locale of ['ar', 'fa', 'he', 'ur']) {
    await languageSelector.selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(languageSelector).toHaveValue(locale);

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth
    }));
    expect(
      dimensions.document,
      `RTL locale ${locale} causes horizontal overflow at 320px: ${JSON.stringify(dimensions)}`
    ).toBeLessThanOrEqual(dimensions.viewport);
  }

  // Exercise a real app screen under RTL, not only the root document attributes.
  const chatsButton = page.locator('[data-testid="nav-chats"]:visible, [data-testid="mobile-nav-chats"]:visible').first();
  await expect(chatsButton).toBeVisible();
  await chatsButton.click();
  await expect(page.getByTestId('server-matches-panel')).toBeVisible();
  await expect(page.getByTestId('server-matches-panel')).toHaveCSS('direction', 'rtl');

  await languageSelector.selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});
