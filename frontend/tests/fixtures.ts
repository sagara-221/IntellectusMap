import { test as base, expect } from '@playwright/test';
import crypto from 'crypto';

const expiresAt = Math.floor(Date.now() / 1000) + 604800 * 52;
const msg = `test_user:${expiresAt}`;
const sig = crypto.createHmac('sha256', 'kgm_test_secret_key_2026').update(msg).digest('hex');
const testToken = `test_${expiresAt}_${sig}`;

// Keep browser tests deterministic without sending billable Gemini requests.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript((token) => {
      localStorage.setItem('kgm_id_token', token);
    }, testToken);

    await page.route('**/api/health', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          status: 'ok',
          gemini_ready: true,
          gemini_backend: 'adk',
          gemini_configuration_error: null,
          database_backend: 'FirestoreSessionRepository',
        },
      });
    });
    await page.route('**/api/sessions', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const request = JSON.parse(route.request().postData() ?? '{}');
      await route.fallback({ postData: JSON.stringify({ ...request, mode: 'demo' }) });
    });
    await use(page);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
});

export { expect };
