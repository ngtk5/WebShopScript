import { chromium } from 'playwright';
import fs from 'node:fs';
import process from 'node:process';

const SHOP_URL = process.env.SHOP_URL ?? 'https://slvshop.netmarble.com/ja/item';
const STORAGE_STATE_PATH = process.env.STORAGE_STATE_PATH ?? 'storage/state.json';
const HEADLESS = process.env.HEADLESS !== 'false';
const DRY_RUN = process.env.DRY_RUN === 'true';

// Reward names can be passed by npm scripts, CLI args, or ITEM_NAMES for manual runs.
const items = parseItems(process.argv.slice(2));

if (items.length === 0) {
  console.error('No item specified. Use --item "毎日の魔法石ガチャ".');
  process.exit(2);
}

// Reuse the login session saved locally by scripts/save-login.js or restored in GitHub Actions.
if (!fs.existsSync(STORAGE_STATE_PATH)) {
  console.error(`Missing login state: ${STORAGE_STATE_PATH}`);
  console.error('Run `npm run login` locally, then add the base64 state to GitHub Secrets.');
  process.exit(2);
}

const browser = await chromium.launch({ headless: HEADLESS });
const context = await browser.newContext({
  // Match the shop locale and reset timing to Japan time.
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  storageState: STORAGE_STATE_PATH,
});
const page = await context.newPage();

try {
  page.setDefaultTimeout(20_000);
  await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded' });
  await dismissCommonPopups(page);
  await ensureLoggedIn(page);

  for (const itemName of items) {
    console.log(`\n== Claiming: ${itemName} ==`);
    await claimItem(page, itemName);
  }
} finally {
  await browser.close();
}

function parseItems(args) {
  // Support multiple --item flags so one run can claim daily and weekly rewards.
  const parsed = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--item' && args[index + 1]) {
      parsed.push(args[index + 1]);
      index += 1;
    }
  }

  if (process.env.ITEM_NAMES) {
    parsed.push(...process.env.ITEM_NAMES.split(',').map((item) => item.trim()).filter(Boolean));
  }

  return [...new Set(parsed)];
}

async function claimItem(page, itemName) {
  await page.goto(SHOP_URL, { waitUntil: 'networkidle' });
  await dismissCommonPopups(page);

  // Locate the visible item name first, then climb to the nearest clickable product area.
  const itemText = page.getByText(itemName, { exact: false }).first();
  await itemText.waitFor({ state: 'visible' });
  await itemText.scrollIntoViewIfNeeded();

  const card = itemText.locator(
    'xpath=ancestor::*[self::li or self::article or self::section or self::div][.//button or @role="button" or .//a][1]',
  );

  const cardText = normalize(await card.innerText().catch(() => ''));
  // Stop before clicking if the card does not clearly look like a free claim.
  assertFreeClaimSurface(itemName, cardText);

  const action = await findActionIn(card);
  if (!action) {
    throw new Error(`Could not find a free claim button for "${itemName}". Card text: ${cardText}`);
  }

  const actionText = normalize(await action.innerText().catch(() => ''));
  console.log(`Action: ${actionText || '<icon/button>'}`);

  if (DRY_RUN) {
    console.log('DRY_RUN=true, skipping click.');
    return;
  }

  await action.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await dismissCommonPopups(page);
  await confirmFreeFlow(page);
  await dismissCommonPopups(page);
  console.log(`Done: ${itemName}`);
}

function assertFreeClaimSurface(itemName, text) {
  // These signals are intentionally conservative to avoid clicking a paid product by mistake.
  const freeSignals = [
    '無料',
    '0円',
    '￥0',
    '¥0',
    'free',
    'claim',
    '受け取り',
    '獲得',
    'ガチャ',
  ];

  const paidPricePattern = /(?:￥|¥|\$|USD|JPY|円)\s*[1-9][0-9,.]*/i;
  if (paidPricePattern.test(text) && !/(無料|0円|￥0|¥0|free)/i.test(text)) {
    throw new Error(`Safety stop: "${itemName}" card contains a paid-looking price. Text: ${text}`);
  }

  if (!containsAny(text, freeSignals)) {
    throw new Error(`Safety stop: "${itemName}" does not look like a free claim. Text: ${text}`);
  }
}

async function findActionIn(root) {
  // Prefer accessible button/link names instead of brittle CSS classes from the shop UI.
  const actionLabels = [
    /受け取り/,
    /獲得/,
    /無料/,
    /ガチャ/,
    /引く/,
    /受領/,
    /claim/i,
    /free/i,
  ];

  for (const label of actionLabels) {
    const button = root.getByRole('button', { name: label }).first();
    if (await button.isVisible().catch(() => false)) return button;

    const link = root.getByRole('link', { name: label }).first();
    if (await link.isVisible().catch(() => false)) return link;
  }

  return null;
}

async function confirmFreeFlow(page) {
  // Some flows show one or more confirmation dialogs; advance only through free-looking prompts.
  const steps = [
    /無料/,
    /受け取り/,
    /獲得/,
    /確認/,
    /^OK$/i,
    /閉じる/,
  ];

  for (let index = 0; index < 5; index += 1) {
    const visibleText = normalize(await page.locator('body').innerText().catch(() => ''));
    if (/(完了|受け取りました|獲得しました|already|すでに|本日は|今週)/i.test(visibleText)) {
      console.log('Completion or already-claimed message detected.');
      return;
    }

    const paidPricePattern = /(?:￥|¥|\$|USD|JPY|円)\s*[1-9][0-9,.]*/i;
    if (paidPricePattern.test(visibleText) && !/(無料|0円|￥0|¥0|free)/i.test(visibleText)) {
      throw new Error(`Safety stop: confirmation page contains a paid-looking price. Text: ${visibleText}`);
    }

    const button = await firstVisibleButton(page, steps);
    if (!button) return;

    const buttonText = normalize(await button.innerText().catch(() => ''));
    console.log(`Confirm: ${buttonText || '<icon/button>'}`);
    await button.click();
    await page.waitForTimeout(1500);
  }
}

async function firstVisibleButton(page, labels) {
  for (const label of labels) {
    const button = page.getByRole('button', { name: label }).first();
    if (await button.isVisible().catch(() => false)) return button;

    const link = page.getByRole('link', { name: label }).first();
    if (await link.isVisible().catch(() => false)) return link;
  }

  return null;
}

async function dismissCommonPopups(page) {
  // Close common consent/notice dialogs that can block the item card or confirmation button.
  const labels = [/同意/, /許可/, /確認/, /^OK$/i, /閉じる/, /close/i, /accept/i];

  for (const label of labels) {
    const button = page.getByRole('button', { name: label }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

async function ensureLoggedIn(page) {
  // If the saved session expired, fail early so the GitHub Actions log explains the fix.
  const bodyText = normalize(await page.locator('body').innerText().catch(() => ''));
  if (/(ログイン|login|sign in)/i.test(bodyText) && !/(ログアウト|logout|sign out)/i.test(bodyText)) {
    throw new Error('Login state appears to be expired. Run `npm run login` and update the secret.');
  }
}

function containsAny(text, needles) {
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(String(needle).toLowerCase()));
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}
