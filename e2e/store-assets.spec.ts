import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('store-assets/google-play/phone');
const clickNav = async (page: import('@playwright/test').Page, title: RegExp) => {
  const buttons = page.locator('button[title]');
  const count = await buttons.count();
  let target = buttons.nth(0);
  for (let i = 0; i < count; i += 1) {
    const candidate = buttons.nth(i);
    const value = await candidate.getAttribute('title');
    if (value && title.test(value)) { target = candidate; break; }
  }
  await expect(target).toBeVisible();
  await target.click({ force: true });
};

test('capture real Vow phone screens for store listing review', async ({ page }) => {
  await mkdir(output, { recursive: true });
  await page.setViewportSize({ width: 540, height: 960 });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText('Vow', { exact: false }).first()).toBeVisible();

  await page.screenshot({ path: path.join(output, '01-discover.png'), fullPage: false, animations: 'disabled' });

  await clickNav(page, /^values test$|^тест ценностей$/i);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(output, '02-compatibility.png'), fullPage: false, animations: 'disabled' });

  await clickNav(page, /^safety$|^безопасность$/i);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(output, '03-safety.png'), fullPage: false, animations: 'disabled' });

  await clickNav(page, /^chats$|^чаты$/i);
  await expect(page.getByText(/prototype conversations are hidden|демонстрационные переписки скрыты/i)).toBeVisible();
  await page.screenshot({ path: path.join(output, '04-chats-preview.png'), fullPage: false, animations: 'disabled' });
});
