import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

const SHOP_URL = process.env.SHOP_URL ?? 'https://slvshop.netmarble.com/ja/item';
const STORAGE_STATE_PATH = process.env.STORAGE_STATE_PATH ?? 'storage/state.json';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
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
await rl.question('After login is complete, press Enter here to save the session...');
rl.close();

fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
await context.storageState({ path: STORAGE_STATE_PATH });
await browser.close();

const encoded = fs.readFileSync(STORAGE_STATE_PATH, 'base64');
console.log(`Saved: ${STORAGE_STATE_PATH}`);
console.log('Add this value as the GitHub secret PLAYWRIGHT_STORAGE_STATE_BASE64:');
console.log(encoded);
