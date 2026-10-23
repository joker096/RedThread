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

    // A one-pixel scrollWidth difference can result from fractional CSS layout
    // rounding; real overflowing elements are reported separately above.
    expect(
      dimensions.document,
      `document overflows at ${width}px: viewport=${dimensions.viewport}, document=${dimensions.document}, body=${dimensions.body}; elements=${JSON.stringify(dimensions.overflowing)}`
    ).toBeLessThanOrEqual(dimensions.viewport + 1);
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

test('RTL filter drawer keeps relationship options aligned to the logical start', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');

  await page.locator('#app-language').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  await page.getByTestId('open-demo-preview').click();
  await page.getByTestId('open-filters').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const options = page.getByTestId('relationship-intent-options');
  await expect(options).toBeVisible();
  const firstOption = options.getByRole('button').first();
  await expect(firstOption).toHaveCSS('text-align', 'start');
  await expect(dialog).toHaveCSS('direction', 'rtl');
});

test('profile editor reloads the active account after a session change', async ({ page }) => {
  let profileRequests = 0;
  await page.route('**/api/auth/me', async route => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) });
  });
  await page.route('**/api/profiles/me', async route => {
    profileRequests += 1;
    const displayName = profileRequests === 1 ? 'Первый аккаунт' : 'Новый аккаунт';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        profile: {
          id: profileRequests === 1 ? 'profile-first' : 'profile-next',
          displayName,
          age: 32,
          gender: 'female',
          country: 'Georgia',
          city: 'Tbilisi',
          bio: '',
          photoUrls: [],
          occupation: '',
          education: '',
          languages: [],
          relationshipIntent: 'marriage_family',
          familyFormat: 'open_to_both',
          hasChildren: false,
          wantsChildren: 'discuss',
          childrenLivingArrangement: 'not_applicable',
          isVisible: true
        }
      })
    });
  });
  await page.route('**/api/blocks', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ blocks: [] }) });
  });

  await page.goto('/');
  const testsButton = page.locator('[data-testid="nav-tests"]:visible, [data-testid="mobile-nav-tests"]:visible').first();
  await expect(testsButton).toBeVisible();
  await testsButton.click();

  const displayName = page.locator('input[name="profile-display-name"]');
  await expect(displayName).toHaveValue('Первый аккаунт');

  await page.evaluate(() => window.dispatchEvent(new Event('vow:session-changed')));
  await expect.poll(() => profileRequests).toBeGreaterThan(1);
  await expect(displayName).toHaveValue('Новый аккаунт');
});


test('profile editor clears private data when saving with an expired session', async ({ page }) => {
  await page.route('**/api/auth/me', async route => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) });
  });
  await page.route('**/api/profiles/me', async route => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        profile: {
          id: 'profile-expired-session',
          displayName: 'Приватное имя',
          age: 32,
          gender: 'female',
          country: 'Georgia',
          city: 'Tbilisi',
          bio: 'Приватное описание',
          photoUrls: [],
          occupation: '',
          education: '',
          languages: [],
          relationshipIntent: 'marriage_family',
          familyFormat: 'open_to_both',
          hasChildren: false,
          wantsChildren: 'discuss',
          childrenLivingArrangement: 'not_applicable',
          isVisible: true
        }
      })
    });
  });
  await page.route('**/api/blocks', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ blocks: [] }) });
  });

  await page.goto('/');
  const testsButton = page.locator('[data-testid="nav-tests"]:visible, [data-testid="mobile-nav-tests"]:visible').first();
  await expect(testsButton).toBeVisible();
  await testsButton.click();

  const displayName = page.locator('input[name="profile-display-name"]');
  await expect(displayName).toHaveValue('Приватное имя');
  await page.getByTestId('profile-save-button').click();

  await expect(displayName).toHaveCount(0);
  await expect(page.getByTestId('profile-login-button')).toBeVisible();
});

test('mobile profile card reveals details on upward swipe and restores photo on downward swipe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const card = page.locator('.vow-profile-card').first();
  const photo = card.locator('.vow-profile-photo');
  const details = card.locator('.vow-profile-details');
  await expect(card).toBeVisible();
  await expect(photo).toHaveClass(/h-72/);
  await expect(details).toBeVisible();

  const swipeDetails = async (fromY: number, toY: number) => {
    await page.evaluate(({ fromY, toY }) => {
      const target = document.querySelector('.vow-profile-card .vow-profile-details');
      if (!target) throw new Error('Profile details are not mounted');
      const makeTouch = (y: number) => new Touch({
        identifier: 7,
        target,
        clientX: 180,
        clientY: y,
        screenX: 180,
        screenY: y
      });
      const startTouch = makeTouch(fromY);
      target.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [startTouch],
        changedTouches: [startTouch]
      }));
      const endTouch = makeTouch(toY);
      target.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        touches: [],
        changedTouches: [endTouch]
      }));
    }, { fromY, toY });
  };

  await swipeDetails(240, 160);
  await expect(photo).toHaveClass(/h-16/);

  await swipeDetails(160, 240);
  await expect(photo).toHaveClass(/h-72/);
});


test('mobile horizontal photo swipe advances gallery without passing the profile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const card = page.locator('.vow-profile-card').first();
  const photo = card.locator('.vow-profile-photo');
  const nextPhoto = photo.getByTestId('profile-photo-next');
  await expect(nextPhoto).toBeVisible();
  await expect(nextPhoto).toBeEnabled();
  const before = await photo.locator('img').getAttribute('src');

  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="profile-photo-next"]');
    if (!target) throw new Error('Photo navigation target is not mounted');
    const makeTouch = (x: number) => new Touch({
      identifier: 9,
      target,
      clientX: x,
      clientY: 300,
      screenX: x,
      screenY: 300
    });
    const startTouch = makeTouch(300);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [startTouch],
      changedTouches: [startTouch]
    }));
    const endTouch = makeTouch(220);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [endTouch]
    }));
  });

  await expect(photo.locator('img')).not.toHaveAttribute('src', before ?? '');
  await expect(card).toBeVisible();
  await expect(photo).toHaveClass(/h-72/);
});

test('profile photo gallery supports keyboard navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const card = page.locator('.vow-profile-card').first();
  const photo = card.locator('.vow-profile-photo');
  const nextPhoto = photo.getByTestId('profile-photo-next');
  const previousPhoto = photo.getByTestId('profile-photo-prev');
  await expect(nextPhoto).toBeVisible();

  const firstSrc = await photo.locator('img').getAttribute('src');
  await nextPhoto.focus();
  await page.keyboard.press('ArrowRight');
  await expect(photo.locator('img')).not.toHaveAttribute('src', firstSrc ?? '');

  const secondSrc = await photo.locator('img').getAttribute('src');
  await page.keyboard.press('ArrowLeft');
  await expect(photo.locator('img')).toHaveAttribute('src', firstSrc ?? '');
  await page.keyboard.press('End');
  await expect(photo.locator('img')).not.toHaveAttribute('src', firstSrc ?? '');

  // End disables the next-photo button, so move focus to the still-enabled
  // previous-photo control before testing Home (keyboard events are scoped to controls).
  await previousPhoto.focus();
  await page.keyboard.press('Home');
  await expect(photo.locator('img')).toHaveAttribute('src', firstSrc ?? '');
  await expect(previousPhoto).toBeDisabled();
  await expect(card).toBeVisible();
});

test('mobile drags starting on profile controls do not trigger card swipes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const card = page.locator('.vow-profile-card').first();
  const photo = card.locator('.vow-profile-photo');
  const toggle = photo.locator('button').last();
  const profileName = await card.locator('h2').first().textContent();
  await expect(toggle).toBeVisible();
  await expect(photo).toHaveClass(/h-72/);

  await page.evaluate(() => {
    const target = document.querySelector('.vow-profile-photo button:last-of-type');
    if (!target) throw new Error('Photo toggle button is not mounted');
    const makeTouch = (x: number) => new Touch({
      identifier: 8,
      target,
      clientX: x,
      clientY: 300,
      screenX: x,
      screenY: 300
    });
    const startTouch = makeTouch(220);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [startTouch],
      changedTouches: [startTouch]
    }));
    const endTouch = makeTouch(120);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [endTouch]
    }));
  });

  await expect(photo).toHaveClass(/h-72/);
  await expect(card.locator('h2').first()).toHaveText(profileName ?? '');
});

test('server discovery swipe mode collapses and restores profile photos vertically', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/profiles/search**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        profiles: [{
          id: 'mobile-swipe-profile',
          displayName: 'Тестовый профиль',
          age: 31,
          gender: 'female',
          country: 'Georgia',
          city: 'Tbilisi',
          bio: 'Проверка жестов',
          photoUrls: ['/test-profile-photo.jpg'],
          occupation: 'Designer',
          education: 'University',
          languages: ['Russian'],
          relationshipIntent: 'marriage_family',
          familyFormat: 'marriage',
          hasChildren: false,
          wantsChildren: 'yes',
          childrenLivingArrangement: 'not_applicable',
          financialAlignment: 82,
          compatibilityScore: 90
        }]
      })
    });
  });

  await page.goto('/');
  const card = page.locator('.vow-profile-card').filter({ hasText: 'Тестовый профиль' }).first();
  await expect(card).toBeVisible();
  await page.getByTestId('server-discovery-swipe-mode').click();
  await expect(card).toHaveAttribute('aria-label', /Тестовый профиль/i);
  const photo = card.locator('img[alt*="Тестовый профиль"]');
  await expect(photo).toBeVisible();

  const swipeCard = async (fromY: number, toY: number) => {
    await page.evaluate(({ fromY, toY }) => {
      const target = document.querySelector('.vow-profile-card[aria-label*="Тестовый профиль"]');
      if (!target) throw new Error('Server profile card is not mounted');
      const makeTouch = (y: number) => new Touch({
        identifier: 9,
        target,
        clientX: 180,
        clientY: y,
        screenX: 180,
        screenY: y
      });
      const startTouch = makeTouch(fromY);
      target.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [startTouch],
        changedTouches: [startTouch]
      }));
      const endTouch = makeTouch(toY);
      target.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        touches: [],
        changedTouches: [endTouch]
      }));
    }, { fromY, toY });
  };

  await swipeCard(240, 160);
  await expect(photo).toHaveCount(0);
  await swipeCard(160, 240);
  await expect(photo).toBeVisible();
});


test('mobile profile touch cancellation clears pending swipe state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const card = page.locator('.vow-profile-card').first();
  const photo = card.locator('.vow-profile-photo');
  const initialName = await card.locator('h2').first().textContent();
  await expect(photo).toHaveClass(/h-72/);

  await page.evaluate(() => {
    const target = document.querySelector('.vow-profile-card');
    if (!target) throw new Error('Profile card is not mounted');
    const makeTouch = (y: number) => new Touch({
      identifier: 42,
      target,
      clientX: 180,
      clientY: y,
      screenX: 180,
      screenY: y
    });
    const startTouch = makeTouch(240);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [startTouch],
      changedTouches: [startTouch]
    }));
    target.dispatchEvent(new TouchEvent('touchcancel', {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [startTouch]
    }));
    // Some browsers emit a final touchend after cancellation. It must not
    // complete the cancelled gesture or trigger a card action.
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [makeTouch(150)]
    }));
  });

  await expect(photo).toHaveClass(/h-72/);
  await expect(card.locator('h2').first()).toHaveText(initialName ?? '');

  // Cancellation must not poison the next independent gesture.
  await page.evaluate(() => {
    const target = document.querySelector('.vow-profile-card .vow-profile-details');
    if (!target) throw new Error('Profile details are not mounted');
    const makeTouch = (y: number) => new Touch({
      identifier: 43,
      target,
      clientX: 180,
      clientY: y,
      screenX: 180,
      screenY: y
    });
    const startTouch = makeTouch(240);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [startTouch],
      changedTouches: [startTouch]
    }));
    const endTouch = makeTouch(160);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [endTouch]
    }));
  });
  await expect(photo).toHaveClass(/h-16/);
});


test('mobile photo swipe suppresses the synthetic click so the gallery advances once', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const nextPhoto = page.locator('.vow-profile-card').first().getByTestId('profile-photo-next');
  const image = page.locator('.vow-profile-card').first().locator('.vow-profile-photo img');
  await expect(nextPhoto).toBeVisible();
  const firstSrc = await image.getAttribute('src');
  await nextPhoto.click();
  const expectedSecondSrc = await image.getAttribute('src');
  expect(expectedSecondSrc).not.toBe(firstSrc);

  await page.reload();
  await page.getByTestId('open-demo-preview').click();
  const swipeButton = page.locator('.vow-profile-card').first().getByTestId('profile-photo-next');
  const swipeImage = page.locator('.vow-profile-card').first().locator('.vow-profile-photo img');
  await expect(swipeImage).toHaveAttribute('src', firstSrc ?? '');

  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="profile-photo-next"]');
    if (!target) throw new Error('Photo navigation target is not mounted');
    const makeTouch = (x: number) => new Touch({
      identifier: 21,
      target,
      clientX: x,
      clientY: 300,
      screenX: x,
      screenY: 300
    });
    const startTouch = makeTouch(300);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [startTouch],
      changedTouches: [startTouch]
    }));
    const endTouch = makeTouch(220);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [endTouch]
    }));
    // Mobile browsers synthesize a click after a completed touch gesture.
    target.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1
    }));
  });

  await expect(swipeImage).toHaveAttribute('src', expectedSecondSrc ?? '');
  await expect(swipeButton).toBeVisible();
});


test('mobile photo gallery ignores cancelled gestures and accepts the next swipe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const card = page.locator('.vow-profile-card').first();
  const photo = card.locator('.vow-profile-photo');
  const nextButton = photo.getByTestId('profile-photo-next');
  const image = photo.locator('img');
  const firstSrc = await image.getAttribute('src');
  await expect(nextButton).toBeVisible();

  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="profile-photo-next"]');
    if (!target) throw new Error('Photo navigation target is not mounted');
    const makeTouch = (x: number) => new Touch({
      identifier: 52,
      target,
      clientX: x,
      clientY: 300,
      screenX: x,
      screenY: 300
    });
    const start = makeTouch(300);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [start], changedTouches: [start]
    }));
    target.dispatchEvent(new TouchEvent('touchcancel', {
      bubbles: true, cancelable: true, touches: [], changedTouches: [start]
    }));
    // A late touchend after cancellation must not complete the abandoned gesture.
    const lateEnd = makeTouch(220);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true, touches: [], changedTouches: [lateEnd]
    }));
  });

  await expect(image).toHaveAttribute('src', firstSrc ?? '');

  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="profile-photo-next"]');
    if (!target) throw new Error('Photo navigation target is not mounted');
    const makeTouch = (x: number) => new Touch({
      identifier: 53,
      target,
      clientX: x,
      clientY: 300,
      screenX: x,
      screenY: 300
    });
    const start = makeTouch(300);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [start], changedTouches: [start]
    }));
    const end = makeTouch(220);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true, touches: [], changedTouches: [end]
    }));
  });

  await expect(image).not.toHaveAttribute('src', firstSrc ?? '');
  await expect(card).toBeVisible();
});


test('vertical swipe on photo navigation does not suppress the next gallery click', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const card = page.locator('.vow-profile-card').first();
  const photo = card.locator('.vow-profile-photo');
  const nextButton = photo.getByTestId('profile-photo-next');
  const image = photo.locator('img');
  const firstSrc = await image.getAttribute('src');
  await expect(nextButton).toBeVisible();

  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="profile-photo-next"]');
    if (!target) throw new Error('Photo navigation target is not mounted');
    const makeTouch = (y: number) => new Touch({
      identifier: 61,
      target,
      clientX: 300,
      clientY: y,
      screenX: 300,
      screenY: y
    });
    const start = makeTouch(260);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [start], changedTouches: [start]
    }));
    const end = makeTouch(180);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true, touches: [], changedTouches: [end]
    }));
  });
  await expect(photo).toHaveClass(/h-16/);

  await page.evaluate(() => {
    const target = document.querySelector('.vow-profile-photo img');
    if (!target) throw new Error('Collapsed profile photo is not mounted');
    const makeTouch = (y: number) => new Touch({
      identifier: 62,
      target,
      clientX: 180,
      clientY: y,
      screenX: 180,
      screenY: y
    });
    const start = makeTouch(180);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [start], changedTouches: [start]
    }));
    const end = makeTouch(260);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true, touches: [], changedTouches: [end]
    }));
  });
  await expect(photo).toHaveClass(/h-72/);

  await photo.getByTestId('profile-photo-next').click();
  await expect(image).not.toHaveAttribute('src', firstSrc ?? '');
  await expect(card).toBeVisible();
});


test('cancelled vertical photo swipe does not collapse the image and the next swipe works', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const photo = page.locator('.vow-profile-card').first().locator('.vow-profile-photo');
  const image = photo.locator('img');
  await expect(photo).toHaveClass(/h-72/);

  await page.evaluate(() => {
    const target = document.querySelector('.vow-profile-photo img');
    if (!target) throw new Error('Profile photo image is not mounted');
    const makeTouch = (y: number) => new Touch({
      identifier: 71,
      target,
      clientX: 180,
      clientY: y,
      screenX: 180,
      screenY: y
    });
    const start = makeTouch(260);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [start], changedTouches: [start]
    }));
    target.dispatchEvent(new TouchEvent('touchcancel', {
      bubbles: true, cancelable: true, touches: [], changedTouches: [start]
    }));
    const lateEnd = makeTouch(180);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true, touches: [], changedTouches: [lateEnd]
    }));
  });

  await expect(photo).toHaveClass(/h-72/);

  await page.evaluate(() => {
    const target = document.querySelector('.vow-profile-photo img');
    if (!target) throw new Error('Profile photo image is not mounted');
    const makeTouch = (y: number) => new Touch({
      identifier: 72,
      target,
      clientX: 180,
      clientY: y,
      screenX: 180,
      screenY: y
    });
    const start = makeTouch(260);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [start], changedTouches: [start]
    }));
    const end = makeTouch(180);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true, touches: [], changedTouches: [end]
    }));
  });

  await expect(photo).toHaveClass(/h-16/);
  await expect(image).toBeVisible();
});

test('horizontal swipe directly on the photo advances the gallery without passing the profile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const card = page.locator('.vow-profile-card').first();
  const photo = card.locator('.vow-profile-photo');
  const image = photo.locator('img');
  const initialName = await card.locator('h2').first().textContent();
  const firstSrc = await image.getAttribute('src');
  await expect(photo).toHaveClass(/h-72/);
  await expect(image).toBeVisible();

  await page.evaluate(() => {
    const target = document.querySelector('.vow-profile-photo img');
    if (!target) throw new Error('Profile photo image is not mounted');
    const makeTouch = (x: number) => new Touch({
      identifier: 81,
      target,
      clientX: x,
      clientY: 300,
      screenX: x,
      screenY: 300
    });
    const start = makeTouch(300);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [start],
      changedTouches: [start]
    }));
    const end = makeTouch(220);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [end]
    }));
  });

  await expect(image).not.toHaveAttribute('src', firstSrc ?? '');
  await expect(photo).toHaveClass(/h-72/);
  await expect(card.locator('h2').first()).toHaveText(initialName ?? '');
});

test('multi-touch photo gesture is ignored and the next single-finger swipe works', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const card = page.locator('.vow-profile-card').first();
  const photo = card.locator('.vow-profile-photo');
  const image = photo.locator('img');
  const firstSrc = await image.getAttribute('src');
  const profileName = await card.locator('h2').first().textContent();
  await expect(photo).toHaveClass(/h-72/);

  await page.evaluate(() => {
    const target = document.querySelector('.vow-profile-photo img');
    if (!target) throw new Error('Profile photo image is not mounted');
    const makeTouch = (identifier: number, x: number, y: number) => new Touch({
      identifier,
      target,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y
    });
    const first = makeTouch(91, 300, 300);
    const second = makeTouch(92, 280, 305);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [first, second],
      changedTouches: [first, second]
    }));
    const movedFirst = makeTouch(91, 220, 300);
    const movedSecond = makeTouch(92, 200, 305);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [movedFirst, movedSecond]
    }));
  });

  await expect(image).toHaveAttribute('src', firstSrc ?? '');
  await expect(photo).toHaveClass(/h-72/);
  await expect(card.locator('h2').first()).toHaveText(profileName ?? '');

  await page.evaluate(() => {
    const target = document.querySelector('.vow-profile-photo img');
    if (!target) throw new Error('Profile photo image is not mounted');
    const makeTouch = (x: number) => new Touch({
      identifier: 93,
      target,
      clientX: x,
      clientY: 300,
      screenX: x,
      screenY: 300
    });
    const start = makeTouch(300);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [start],
      changedTouches: [start]
    }));
    const end = makeTouch(220);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [end]
    }));
  });

  await expect(image).not.toHaveAttribute('src', firstSrc ?? '');
  await expect(photo).toHaveClass(/h-72/);
  await expect(card.locator('h2').first()).toHaveText(profileName ?? '');
});


test('adding a second finger cancels an in-progress photo swipe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const card = page.locator('.vow-profile-card').first();
  const photo = card.locator('.vow-profile-photo');
  const image = photo.locator('img');
  const firstSrc = await image.getAttribute('src');
  const profileName = await card.locator('h2').first().textContent();

  await page.evaluate(() => {
    const target = document.querySelector('.vow-profile-photo img');
    if (!target) throw new Error('Profile photo image is not mounted');
    const makeTouch = (identifier: number, x: number, y: number) => new Touch({
      identifier,
      target,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y
    });
    const first = makeTouch(101, 300, 300);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [first], changedTouches: [first]
    }));

    // A second finger joins after the gesture has already started.
    const second = makeTouch(102, 280, 305);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [first, second], changedTouches: [second]
    }));
    const movedFirst = makeTouch(101, 220, 300);
    const movedSecond = makeTouch(102, 200, 305);
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true, touches: [], changedTouches: [movedFirst, movedSecond]
    }));
  });

  await expect(image).toHaveAttribute('src', firstSrc ?? '');
  await expect(photo).toHaveClass(/h-72/);
  await expect(card.locator('h2').first()).toHaveText(profileName ?? '');

  // Cancelling the interrupted gesture must not poison the next valid swipe.
  await page.evaluate(() => {
    const target = document.querySelector('.vow-profile-photo img');
    if (!target) throw new Error('Profile photo image is not mounted');
    const start = new Touch({ identifier: 103, target, clientX: 300, clientY: 300, screenX: 300, screenY: 300 });
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [start], changedTouches: [start]
    }));
    const end = new Touch({ identifier: 103, target, clientX: 220, clientY: 300, screenX: 220, screenY: 300 });
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true, touches: [], changedTouches: [end]
    }));
  });

  await expect(image).not.toHaveAttribute('src', firstSrc ?? '');
  await expect(photo).toHaveClass(/h-72/);
  await expect(card.locator('h2').first()).toHaveText(profileName ?? '');
});


test('vertical swipes directly on the photo collapse and restore it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const card = page.locator('.vow-profile-card').first();
  const photo = card.locator('.vow-profile-photo');
  const image = photo.locator('img');
  const profileName = await card.locator('h2').first().textContent();
  await expect(photo).toHaveClass(/h-72/);

  const swipePhoto = async (fromY: number, toY: number, identifier: number) => {
    await page.evaluate(({ fromY, toY, identifier }) => {
      const target = document.querySelector('.vow-profile-photo img');
      if (!target) throw new Error('Profile photo image is not mounted');
      const makeTouch = (y: number) => new Touch({
        identifier,
        target,
        clientX: 180,
        clientY: y,
        screenX: 180,
        screenY: y
      });
      const start = makeTouch(fromY);
      target.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true, cancelable: true, touches: [start], changedTouches: [start]
      }));
      const end = makeTouch(toY);
      target.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true, cancelable: true, touches: [], changedTouches: [end]
      }));
    }, { fromY, toY, identifier });
  };

  // Upward swipe on the photo reveals the profile details.
  await swipePhoto(300, 220, 111);
  await expect(photo).toHaveClass(/h-16/);
  await expect(image).toBeVisible();
  await expect(card.locator('h2').first()).toHaveText(profileName ?? '');

  // Downward swipe on the same photo restores the full photo area.
  await swipePhoto(220, 300, 112);
  await expect(photo).toHaveClass(/h-72/);
  await expect(image).toBeVisible();
  await expect(card.locator('h2').first()).toHaveText(profileName ?? '');
});


test('photo collapse control exposes its expanded state to assistive technology', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const photo = page.locator('.vow-profile-card').first().locator('.vow-profile-photo');
  let toggle = photo.locator('button[aria-expanded="true"]');

  await expect(photo).toHaveClass(/h-72/);
  await expect(toggle).toBeVisible();

  await toggle.click();
  await expect(photo).toHaveClass(/h-16/);
  toggle = photo.locator('button[aria-expanded="false"]');
  await expect(toggle).toBeVisible();

  await toggle.click();
  await expect(photo).toHaveClass(/h-72/);
  await expect(photo.locator('button[aria-expanded="true"]')).toBeVisible();
});


test('mobile photo collapse control works with Enter and Space on the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const photo = page.locator('.vow-profile-card').first().locator('.vow-profile-photo');
  const toggle = photo.locator('button[aria-expanded="true"]');
  await expect(toggle).toBeVisible();
  await toggle.focus();
  await expect(toggle).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(photo).toHaveClass(/h-16/);
  const expandToggle = photo.locator('button[aria-expanded="false"]');
  await expect(expandToggle).toBeFocused();

  await page.keyboard.press('Space');
  await expect(photo).toHaveClass(/h-72/);
  await expect(photo.locator('button[aria-expanded="true"]')).toBeFocused();
});


test('mobile photo toggle keeps a 44px minimum touch target when expanded and collapsed', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await page.getByTestId('open-demo-preview').click();

  const photo = page.locator('.vow-profile-card').first().locator('.vow-profile-photo');
  const expandedToggle = photo.locator('button[aria-expanded="true"]');
  await expect(expandedToggle).toBeVisible();

  await expect.poll(async () => (await expandedToggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect.poll(async () => (await expandedToggle.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
  const expandedSize = await expandedToggle.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(expandedSize.height, 'expanded toggle height should meet the 44px touch target guideline').toBeGreaterThanOrEqual(44);
  expect(expandedSize.width, 'expanded toggle width should meet the 44px touch target guideline').toBeGreaterThanOrEqual(44);

  await expandedToggle.click();
  await expect(photo).toHaveClass(/h-16/);
  const collapsedToggle = photo.locator('button[aria-expanded="false"]');
  await expect(collapsedToggle).toBeVisible();

  await expect.poll(async () => (await collapsedToggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect.poll(async () => (await collapsedToggle.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
  const collapsedSize = await collapsedToggle.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(collapsedSize.height, 'collapsed toggle height should meet the 44px touch target guideline').toBeGreaterThanOrEqual(44);
  expect(collapsedSize.width, 'collapsed toggle width should meet the 44px touch target guideline').toBeGreaterThanOrEqual(44);
});


test('mobile photo toggle and verification badge keep separate touch areas', async ({ page }) => {
  for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByTestId('open-demo-preview').click();

    const photo = page.locator('.vow-profile-card').first().locator('.vow-profile-photo');
    const toggle = photo.locator('button[aria-expanded="true"]');
    const verificationBadge = photo.locator('button[title]').filter({ has: page.locator('svg.lucide-shield-check') });

    await expect(toggle).toBeVisible();
    await expect(verificationBadge).toBeVisible();
    await expect.poll(async () => {
      const toggleBox = await toggle.boundingBox();
      const badgeBox = await verificationBadge.boundingBox();
      if (!toggleBox || !badgeBox) return -1;
      const overlapWidth = Math.max(0, Math.min(toggleBox.x + toggleBox.width, badgeBox.x + badgeBox.width) - Math.max(toggleBox.x, badgeBox.x));
      const overlapHeight = Math.max(0, Math.min(toggleBox.y + toggleBox.height, badgeBox.y + badgeBox.height) - Math.max(toggleBox.y, badgeBox.y));
      return overlapWidth * overlapHeight;
    }).toBe(0);
  }
});


test('mobile voice intro and verification badge keep separate touch areas', async ({ page }) => {
  for (const viewport of [{ width: 320, height: 720 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByTestId('open-demo-preview').click();

    const photo = page.locator('.vow-profile-card').first().locator('.vow-profile-photo');
    const voiceIntro = photo.locator('button[aria-pressed]');
    const verificationBadge = photo.locator('button').filter({ has: page.locator('svg.lucide-shield-check') });

    if (await voiceIntro.count() === 0) continue;
    await expect(voiceIntro).toBeVisible();
    await expect(verificationBadge).toBeVisible();

    await expect.poll(async () => {
      const voiceBox = await voiceIntro.boundingBox();
      const badgeBox = await verificationBadge.boundingBox();
      if (!voiceBox || !badgeBox) return -1;
      const overlapWidth = Math.max(0, Math.min(voiceBox.x + voiceBox.width, badgeBox.x + badgeBox.width) - Math.max(voiceBox.x, badgeBox.x));
      const overlapHeight = Math.max(0, Math.min(voiceBox.y + voiceBox.height, badgeBox.y + badgeBox.height) - Math.max(voiceBox.y, badgeBox.y));
      return overlapWidth * overlapHeight;
    }).toBe(0);
  }
});
