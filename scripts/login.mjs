/**
 * Вход на hh.ru в обычном (не headless) Chromium с профилем data/session/chromium-profile.
 *
 * Если сессия уже жива — окно сразу закрывается.
 * Если логин или капча — окно остаётся, пока не войдёте (Enter в терминале не нужен).
 *
 *   node scripts/login.mjs
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from '../lib/load-env.mjs';
loadEnv();
import { withHhBrowserOptions } from '../lib/hh-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SESSION_DIR = process.env.HH_SESSION_DIR
  ? path.resolve(process.cwd(), process.env.HH_SESSION_DIR)
  : path.join(ROOT, 'data', 'session');
const PERSISTENT_PROFILE = path.join(SESSION_DIR, 'chromium-profile');
const WAIT_MS = Math.max(30_000, Number(process.env.HH_LOGIN_WAIT_MS) || 20 * 60 * 1000);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isBlockedUrl(url) {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('/account/login') ||
    u.includes('oauth.hh.ru') ||
    u.includes('/logon') ||
    u.includes('showcaptcha') ||
    u.includes('captcha')
  );
}

async function sessionLooksOk(page) {
  if (page.isClosed()) return false;
  const url = page.url();
  if (isBlockedUrl(url)) return false;
  const captcha = page.locator(
    'iframe[src*="captcha" i], iframe[src*="smartcaptcha" i], [class*="SmartCaptcha"]'
  );
  if ((await captcha.count()) > 0) {
    const visible = await captcha
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) return false;
  }
  return true;
}

async function main() {
  ensureDir(SESSION_DIR);
  const ctx = await chromium.launchPersistentContext(
    PERSISTENT_PROFILE,
    await withHhBrowserOptions({
      headless: false,
      viewport: { width: 1280, height: 800 },
      locale: 'ru-RU',
    })
  );
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto('https://hh.ru/applicant', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await sleep(2500);

    if (await sessionLooksOk(page)) {
      await sleep(1500);
      if (await sessionLooksOk(page)) {
        console.log('Сессия активна. Закрываю окно. URL:', page.url());
        return;
      }
    }

    console.log(
      'Нужен вход или капча. Окно Chromium открыто — войдите в hh.ru. Жду до',
      Math.round(WAIT_MS / 60000),
      'мин. URL:',
      page.url()
    );

    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (await sessionLooksOk(page)) {
        await sleep(800);
        if (await sessionLooksOk(page)) {
          console.log('Вход принят. Закрываю окно. URL:', page.url());
          return;
        }
      }
    }

    console.error('Вход не подтверждён за отведённое время. Выполните: npm run login');
    process.exitCode = 1;
  } finally {
    await ctx.close().catch(() => {});
    console.log('Профиль сохранён:', PERSISTENT_PROFILE);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
