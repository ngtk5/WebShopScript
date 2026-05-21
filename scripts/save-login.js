import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

const SHOP_URL = process.env.SHOP_URL ?? 'https://slvshop.netmarble.com/ja/item';
const STORAGE_STATE_PATH = process.env.STORAGE_STATE_PATH ?? 'storage/state.json';
const AUTO_SAVE = process.env.AUTO_SAVE === 'true';

// This script must be visible because the user completes Netmarble login manually.
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  // Save a session that behaves like the scheduled Japan-time GitHub Actions run.
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
});
const page = await context.newPage();

await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded' });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('Browser opened. Log in to Netmarble Shop manually.');
if (AUTO_SAVE) {
  console.log('AUTO_SAVE=true, waiting until the page looks logged in...');
  await waitForLogin(page);
} else {
  await rl.question('After login is complete, press Enter here to save the session...');
}
rl.close();

// Persist cookies/local storage, then print a base64 version suitable for GitHub Secrets.
fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
await context.storageState({ path: STORAGE_STATE_PATH });
await browser.close();

const encoded = fs.readFileSync(STORAGE_STATE_PATH, 'base64');
console.log(`Saved: ${STORAGE_STATE_PATH}`);
console.log('Add this value as the GitHub secret PLAYWRIGHT_STORAGE_STATE_BASE64:');
console.log(encoded);

async function waitForLogin(page) {
  const deadline = Date.now() + 5 * 60 * 1000;

  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/(ログアウト|logout|sign out)/i.test(bodyText) || !/(ログイン|login|sign in)/i.test(bodyText)) {
      return;
    }
  }

  throw new Error('Timed out while waiting for login.');
}
