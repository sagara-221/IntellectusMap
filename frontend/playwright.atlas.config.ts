import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests',testMatch:['atlas-live.spec.ts','judge-login.spec.ts'],workers:1,timeout:60000,
  expect:{timeout:15000},
  use:{baseURL:process.env.TEST_BASE_URL || 'http://127.0.0.1:5174',headless:true,launchOptions:{channel:'msedge'},viewport:{width:1440,height:1000},trace:'retain-on-failure'},
  reporter:'list',
});
