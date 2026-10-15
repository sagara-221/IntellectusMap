import { defineConfig } from '@playwright/test';
import crypto from 'crypto';

const expiresAt = Math.floor(Date.now() / 1000) + 604800 * 52; // 1年有効
const msg = `test_user:${expiresAt}`;
const sig = crypto.createHmac('sha256', 'kgm_test_secret_key_2026').update(msg).digest('hex');
const testToken = `test_${expiresAt}_${sig}`;

export default defineConfig({
  testDir: './tests',
  // Atlas tests use the isolated API described in playwright.atlas.config.ts.
  testIgnore: 'atlas-live.spec.ts',
  expect: {
    timeout: 15000,
  },
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:5173',
    headless: true,
    extraHTTPHeaders: {
      Authorization: `Bearer ${testToken}`,
    },
  },
  reporter: 'list',
  timeout: 60000,
});
