import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SHOP_URL = process.env.SHOP_URL ?? 'https://slvshop.netmarble.com/ja/item';
const STORAGE_STATE_PATH = process.env.STORAGE_STATE_PATH ?? 'storage/state.json';
const HEADLESS = process.env.HEADLESS !== 'false';
const DRY_RUN = process.env.DRY_RUN === 'true';
const SLOW_MO = Number(process.env.SLOW_MO ?? 0);
const PAUSE_AFTER_DONE = Number(process.env.PAUSE_AFTER_DONE ?? 0);
const NETMARBLE_EMAIL = process.env.NETMARBLE_EMAIL ?? '';
const NETMARBLE_PASSWORD = process.env.NETMARBLE_PASSWORD ?? '';

// Reward names can be passed by npm scripts, CLI args, or ITEM_NAMES for manual runs.
const items = parseItems(process.argv.slice(2));

if (items.length === 0) {
  console.error('No item specified. Use --item "毎日の魔法石ガチャ".');
  process.exit(2);
}

const hasSavedLoginState = fs.existsSync(STORAGE_STATE_PATH);
const hasLoginCredentials = Boolean(NETMARBLE_EMAIL && NETMARBLE_PASSWORD);

// Prefer a saved session, but allow fresh login from GitHub Secrets when the session is missing or expired.
if (!hasSavedLoginState && !hasLoginCredentials) {
  console.error(`Missing login state: ${STORAGE_STATE_PATH}`);
  console.error('Run `npm run login`, or set NETMARBLE_EMAIL and NETMARBLE_PASSWORD.');
  process.exit(2);
}

const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOW_MO });
const context = await browser.newContext({
  // Match the shop locale and reset timing to Japan time.
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  ...(hasSavedLoginState ? { storageState: STORAGE_STATE_PATH } : {}),
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
} catch (error) {
  console.error('\nClaim failed.');
  console.error(error?.stack || error);
  await logDebugState(page);
  process.exitCode = 1;
} finally {
  if (PAUSE_AFTER_DONE > 0) {
    console.log(`Waiting ${PAUSE_AFTER_DONE}ms before closing the browser...`);
    await page.waitForTimeout(PAUSE_AFTER_DONE).catch(() => {});
  }
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
  for (let attempt = 1; attempt <= 2; attempt += 1) {
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

    if (/(完了|獲得完了|受け取りました|獲得しました|already|すでに)/i.test(actionText)) {
      console.log(`Already completed: ${itemName}`);
      return;
    }

    if (DRY_RUN) {
      console.log('DRY_RUN=true, skipping click.');
      return;
    }

    await action.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await dismissCommonPopups(page);

    if (await pageShowsLoginRequired(page)) {
      if (attempt === 2) {
        throw new Error('Login is still required after automatic login.');
      }

      console.log('Login required. Trying automatic login...');
      await loginWithCredentials(page);
      continue;
    }

    await confirmFreeFlow(page);
    await dismissCommonPopups(page);
    console.log(`Done: ${itemName}`);
    return;
  }
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
  // Some flows show one or more confirmation dialogs; always handle the visible modal first.
  const steps = [
    /無料/,
    /受け取り/,
    /獲得/,
    /確認/,
    /^OK$/i,
    /閉じる/,
  ];

  for (let index = 0; index < 5; index += 1) {
    const modalText = await visibleModalText(page);
    if (/(ログイン後にご利用いただけます|ログインしてください|ログインが必要|please log in|sign in required)/i.test(modalText)) {
      throw new Error('Login state is not valid in this environment. Run `npm run login` locally and update the GitHub secret.');
    }

    const button = await firstVisibleModalButton(page, steps);
    if (button) {
      const buttonText = normalize(await button.innerText().catch(() => ''));
      if (/(完了|獲得完了|受け取りました|獲得しました|already|すでに)/i.test(buttonText)) {
        console.log(`Completion button/state detected: ${buttonText}`);
        return;
      }

      console.log(`Confirm: ${buttonText || '<icon/button>'}`);
      await button.click();
      await page.waitForTimeout(1500);
      continue;
    }

    const visibleText = normalize(await page.locator('body').innerText().catch(() => ''));
    if (/(完了|受け取りました|獲得しました|already|すでに|本日は|今週)/i.test(visibleText)) {
      console.log('Completion or already-claimed message detected.');
      return;
    }

    return;
  }
}

async function pageShowsLoginRequired(page) {
  const modalText = await visibleModalText(page);
  const bodyText = normalize(await page.locator('body').innerText().catch(() => ''));
  return /(ログイン後にご利用いただけます|ログインしてください|ログインが必要|please log in|sign in required)/i.test(
    `${modalText} ${bodyText}`,
  );
}

async function loginWithCredentials(page) {
  if (!hasLoginCredentials) {
    throw new Error('Login is required, but NETMARBLE_EMAIL and NETMARBLE_PASSWORD are not set.');
  }

  await closeLoginRequiredModal(page);
  await openLoginPage(page);
  await fillLoginForm(page);
  await waitForLoggedIn(page);
  fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE_PATH }).catch(() => {});
  console.log('Automatic login completed.');
}

async function closeLoginRequiredModal(page) {
  const topModal = page.locator('.modal.show.last, .modals .modal.show, [role="dialog"]').last();
  if (!(await topModal.isVisible().catch(() => false))) return;

  const closeButton = topModal
    .locator('button:visible, [role="button"]:visible')
    .filter({ hasText: /確認|OK|閉じる|close/i })
    .last();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
}

async function openLoginPage(page) {
  if (/signin|login|auth/i.test(page.url())) return;

  const loginControl = page
    .locator('button:visible, a:visible, [role="button"]:visible')
    .filter({ hasText: /ログイン|login|sign in/i })
    .first();

  if (!(await loginControl.isVisible().catch(() => false))) {
    throw new Error('Could not find the Netmarble login button.');
  }

  await loginControl.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);
}

async function fillLoginForm(page) {
  const emailInput = page
    .locator(
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="メール"], input[placeholder*="mail" i], input[placeholder*="email" i]',
    )
    .first();
  const passwordInput = page
    .locator(
      'input[type="password"], input[name*="password" i], input[id*="password" i], input[placeholder*="パスワード"], input[placeholder*="password" i]',
    )
    .first();

  await emailInput.waitFor({ state: 'visible', timeout: 30_000 });
  await passwordInput.waitFor({ state: 'visible', timeout: 30_000 });

  await emailInput.fill(NETMARBLE_EMAIL);
  await passwordInput.fill(NETMARBLE_PASSWORD);

  const submitButton = page
    .locator('button:visible, [role="button"]:visible, input[type="submit"]:visible')
    .filter({ hasText: /ログイン|login|sign in|確認|次へ|続ける/i })
    .last();

  if (await submitButton.isVisible().catch(() => false)) {
    await submitButton.click();
  } else {
    await passwordInput.press('Enter');
  }
}

async function waitForLoggedIn(page) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);

    const cookies = await page.context().cookies().catch(() => []);
    if (cookies.some((cookie) => cookie.name === 'NMsololvShopToken')) return;

    if (page.url().startsWith(SHOP_URL) && !(await pageShowsLoginRequired(page))) return;
  }

  throw new Error('Automatic login did not complete. The site may require CAPTCHA, email verification, or another manual step.');
}

async function firstVisibleModalButton(page, labels) {
  const topModal = page.locator('.modal.show.last, .modals .modal.show, [role="dialog"]').last();
  const buttonRoots = (await topModal.isVisible().catch(() => false))
    ? [topModal, page]
    : [page];

  for (const label of labels) {
    for (const root of buttonRoots) {
      const candidates = root
        .locator('button:visible, [role="button"]:visible')
        .filter({ hasText: label });
      const count = await candidates.count().catch(() => 0);

      for (let index = count - 1; index >= 0; index -= 1) {
        const modalButton = candidates.nth(index);
        const className = await modalButton.getAttribute('class').catch(() => '');

        if (className?.includes('disabled')) {
          const buttonText = normalize(await modalButton.innerText().catch(() => ''));
          if (/(完了|獲得完了|受け取りました|獲得しました)/i.test(buttonText)) {
            return modalButton;
          }

          continue;
        }

        if (await modalButton.isVisible().catch(() => false)) {
          return modalButton;
        }
      }
    }
  }

  return null;
}

async function visibleModalText(page) {
  return normalize(await page.locator('.modal.show.last, .modals .modal.show, [role="dialog"]').last().innerText().catch(() => ''));
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
  const url = page.url();
  const isLoginPage = /signin|login|auth/i.test(url);
  const asksForLogin = /(ログインしてください|ログインが必要|please log in|sign in required)/i.test(bodyText);

  if (isLoginPage || asksForLogin) {
    console.log('Login state appears to be expired. Trying automatic login...');
    await loginWithCredentials(page);
  }
}

async function logDebugState(page) {
  console.error('\nDebug state:');
  console.error(`URL: ${page.url()}`);
  console.error(`Title: ${await page.title().catch(() => '<unavailable>')}`);

  const modalText = normalize(
    await page.locator('.modals, .modal-window, [role="dialog"]').last().innerText().catch(() => ''),
  );
  if (modalText) {
    console.error(`Visible modal text: ${truncate(modalText, 1200)}`);
  }

  const buttonTexts = await page
    .locator('button:visible, [role="button"]:visible')
    .evaluateAll((buttons) => buttons.map((button) => button.innerText || button.textContent || '').filter(Boolean))
    .catch(() => []);

  if (buttonTexts.length > 0) {
    console.error('Visible buttons:');
    for (const text of buttonTexts.slice(0, 20)) {
      console.error(`- ${truncate(normalize(text), 200)}`);
    }
  }
}

function containsAny(text, needles) {
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(String(needle).toLowerCase()));
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}
