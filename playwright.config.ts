import { defineConfig } from '@playwright/test';
import { config } from 'dotenv';
config({path:['.env.local','.env'],quiet:true});
export default defineConfig({
  testDir:'./e2e',testMatch:'**/*.e2e.ts',fullyParallel:false,workers:1,
  timeout:60000,expect:{timeout:12000},retries:0,
  reporter:[['list'],['html',{outputFolder:'output/playwright/report',open:'never'}]],
  outputDir:'output/playwright/results',
  use:{baseURL:process.env.E2E_BASE_URL??'http://127.0.0.1:3000',browserName:'chromium',channel:'chrome',headless:true,screenshot:'only-on-failure',trace:'retain-on-failure'}
});
