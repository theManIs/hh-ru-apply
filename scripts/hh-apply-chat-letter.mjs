/**
 * Вакансия → «Откликнуться» → мастер модалки → при наличии текста письмо в форму отклика → отправить → чат → письмо в чате.
 *
 * Автоматическая отправка отклика и сообщения может противоречить правилам hh.ru — используйте осознанно.
 *
 *   node scripts/hh-apply-chat-letter.mjs --id=<uuid>
 *   --stay-open    — ждать Enter перед закрытием браузера
 *   --dry-run      — открыть чат, но не вставлять письмо
 *   --no-submit    — только открыть форму отклика, не нажимать «Отправить»
 *   --skip-letter  — только отклик (резюме), без сопроводительного и без сообщения в чат
 *   --skip-chat    — не писать в чат после отправки формы (письмо только в модалке)
 *
 * HH_HEADLESS=1 — headless (для отладки обычно без headless).
 * HH_FAST=1 — быстрый режим (без «человеческих» пауз и посимвольного ввода).
 * HH_PLAYWRIGHT_CHANNEL=chrome — системный Chrome вместо bundled Chromium (опционально).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { chromium } from 'playwright';
import { loadEnv } from '../lib/load-env.mjs';
loadEnv();

import { withHhBrowserOptions } from '../lib/hh-browser.mjs';

import { sessionProfilePath, DATA_DIR, ROOT } from '../lib/paths.mjs';
import { getVacancyRecord, updateVacancyRecord } from '../lib/store.mjs';
import { loadPreferences } from '../lib/preferences.mjs';
import { resumePatternsForRecord, recordPassesPrefs } from '../lib/hh-tracks.mjs';
import {
  clickVacancyResponseButton,
  expandCoverLetterSectionIfPresent,
  fillCoverLetterFieldIfPresent,
  vacancyPageSkipReason,
} from '../lib/hh-response-selectors.mjs';
import { recordApplyLaunch } from '../lib/hh-apply-rate.mjs';
import { vacancyIdFromUrl } from '../lib/vacancy-parse.mjs';
import { betweenMajorSteps } from '../lib/hh-human-delay.mjs';
import {
  prepareVacancyResponseModal,
  submitVacancyResponseIfPresent,
  vacancyResponseLooksSent,
  vacancyResponseLooksExternal,
  confirmVacancyResponseWarnings,
  openEmployerChatAfterResponse,
  sendLetterInChat,
} from '../lib/hh-chat-selectors.mjs';

const headless = process.env.HH_HEADLESS === '1';
const stayOpen = process.argv.includes('--stay-open');
const dryRun = process.argv.includes('--dry-run');
const noSubmit = process.argv.includes('--no-submit');
const skipLetter = process.argv.includes('--skip-letter');
const skipChat = process.argv.includes('--skip-chat');

function parseArgs() {
  let id = null;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--id=')) id = a.slice(5).trim();
  }
  return { id };
}

function waitEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function looksLikeLoginUrl(url) {
  const u = url.toLowerCase();
  return u.includes('/account/login') || u.includes('oauth.hh.ru') || u.includes('/logon');
}

async function saveErrorScreenshot(page, err) {
  try {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const shot = path.join(DATA_DIR, `hh-apply-chat-error-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.error('[hh-apply-chat] Скриншот ошибки:', shot, err?.message || err);
  } catch {
    /* ignore */
  }
}

async function main() {
  const { id } = parseArgs();
  if (!id) {
    console.error('Укажите --id=<uuid записи из data/vacancies-queue.json>');
    process.exit(1);
  }

  const rec = getVacancyRecord(id);
  if (!rec) {
    console.error('Запись не найдена:', id);
    process.exit(1);
  }
  const fromQueue = skipLetter ? '' : String(rec.coverLetter?.approvedText || '').trim();
  const fromTemplate = (() => {
    try {
      return fs.readFileSync(path.join(ROOT, 'config', 'cover-letter.txt'), 'utf8').trim();
    } catch {
      return '';
    }
  })();
  const letter = skipLetter ? '' : fromQueue || fromTemplate;
  if (!letter && !dryRun && !skipLetter) {
    console.error(
      'Нет утверждённого письма и нет config/cover-letter.txt. Утвердите в дашборде, передайте --skip-letter, либо --dry-run.'
    );
    process.exit(1);
  }
  if (!rec.url) {
    console.error('У записи нет url');
    process.exit(1);
  }

  const prefsEarly = loadPreferences();
  const titleBlock = recordPassesPrefs(rec, prefsEarly);
  if (!titleBlock.pass) {
    const reason = String(titleBlock.reason || '').startsWith('Текст:') ? 'blocked_content' : 'blocked_title';
    updateVacancyRecord(id, { hhApplySkipReason: reason, hhApplySkipNote: titleBlock.reason });
    console.log('[hh-apply-chat] SKIP:', titleBlock.reason);
    return;
  }

  const profile = sessionProfilePath();
  if (!fs.existsSync(profile)) {
    console.error('Профиль не найден. Сначала: npm run login\n', profile);
    process.exit(1);
  }

  const vacancyId = rec.vacancyId || vacancyIdFromUrl(rec.url) || '';

  let tmpDir = null;
  let tmpFile = null;
  if (letter && !dryRun) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-letter-'));
    tmpFile = path.join(tmpDir, 'cover-letter.txt');
    fs.writeFileSync(tmpFile, letter, 'utf8');
  }

  const launchOpts = await withHhBrowserOptions({
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'ru-RU',
  });
  const ch = String(process.env.HH_PLAYWRIGHT_CHANNEL || '').trim();
  if (ch) launchOpts.channel = ch;
  const ctx = await chromium.launchPersistentContext(profile, launchOpts);
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    const humanTyping = process.env.HH_FAST !== '1';
    const humanClicks = process.env.HH_FAST !== '1';

    const step = (name) => console.log(`[hh-apply-chat] step=${name}`);

    step(`start recordId=${id} url=${rec.url}`);
    console.log('[hh-apply-chat] Открываю вакансию:', rec.url);
    await page.goto(rec.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await betweenMajorSteps(page);
    step('open_vacancy');

    const dead = await vacancyPageSkipReason(page);
    if (dead) {
      updateVacancyRecord(id, { hhApplySkipReason: dead.reason, hhApplySkipNote: dead.note });
      console.log('[hh-apply-chat] SKIP:', dead.note);
      step(`skip_${dead.reason}`);
      return;
    }

    if (looksLikeLoginUrl(page.url())) {
      throw new Error('Редирект на логин. Выполните: npm run login');
    }

    if (rec.hhAppliedAt || (await vacancyResponseLooksSent(page))) {
      console.log('[hh-apply-chat] Уже откликались — повторно не жму.');
      if (!rec.hhAppliedAt) {
        updateVacancyRecord(id, { hhAppliedAt: new Date().toISOString() });
      }
      step('already_applied');
      return;
    }

    const prefs = loadPreferences();
    const resumePickPatterns = resumePatternsForRecord(rec, prefs);

    let btn;
    try {
      btn = await clickVacancyResponseButton(page, 12_000, { humanClicks });
    } catch (e) {
      const deadAfter = await vacancyPageSkipReason(page);
      if (deadAfter) {
        updateVacancyRecord(id, {
          hhApplySkipReason: deadAfter.reason,
          hhApplySkipNote: deadAfter.note,
        });
        console.log('[hh-apply-chat] SKIP:', deadAfter.note);
        step(`skip_${deadAfter.reason}`);
        return;
      }
      throw e;
    }
    console.log('[hh-apply-chat] Клик 1 (карточка вакансии):', btn);
    step('click_response');
    await betweenMajorSteps(page);

    if (await vacancyResponseLooksExternal(page)) {
      console.log('[hh-apply-chat] Отклик на внешнем сайте — пропускаю, на hh не жму.');
      updateVacancyRecord(id, { hhApplySkipReason: 'external_site' });
      step('skip_external');
      if (stayOpen) await waitEnter('Enter — закрыть браузер: ');
      return;
    }

    const warned = await confirmVacancyResponseWarnings(page);
    if (warned) console.log('[hh-apply-chat] Подтверждение:', warned);

    if (noSubmit) {
      console.log('[hh-apply-chat] --no-submit: форма открыта, отправку и чат не трогаем.');
      if (stayOpen) await waitEnter('Enter — закрыть браузер: ');
      return;
    }

    await prepareVacancyResponseModal(page, { resumePickPatterns });
    await betweenMajorSteps(page);
    step('modal_prepare_1');

    if (letter) {
      await expandCoverLetterSectionIfPresent(page);
      const filled = await fillCoverLetterFieldIfPresent(page, letter, 20_000, { humanTyping });
      if (filled) console.log('[hh-apply-chat] Письмо в форме отклика:', filled);
      else console.log('[hh-apply-chat] Поля письма нет — отклик без сопроводительного.');
      step('fill_letter');
      await prepareVacancyResponseModal(page, { resumePickPatterns });
      await betweenMajorSteps(page);
      step('modal_prepare_2');
    }

    const submitted = await submitVacancyResponseIfPresent(page);
    if (submitted) {
      console.log('[hh-apply-chat] Клик 2 (форма отклика):', submitted);
    } else if (await vacancyResponseLooksSent(page)) {
      console.log('[hh-apply-chat] Отклик уже отмечен на странице.');
    } else if (await vacancyResponseLooksExternal(page)) {
      console.log('[hh-apply-chat] Отклик на внешнем сайте — пропускаю.');
      updateVacancyRecord(id, { hhApplySkipReason: 'external_site' });
      step('skip_external');
      if (stayOpen) await waitEnter('Enter — закрыть браузер: ');
      return;
    } else {
      throw new Error(
        'Не найдена кнопка отправки отклика. Обновите submitVacancyResponseIfPresent в lib/hh-chat-selectors.mjs (Playwright Codegen).'
      );
    }
    recordApplyLaunch();
    updateVacancyRecord(id, { hhAppliedAt: new Date().toISOString(), hhApplySkipReason: null });
    step('submit_response');
    await betweenMajorSteps(page);

    if (skipLetter || skipChat || !letter) {
      console.log(
        skipChat || letter
          ? '[hh-apply-chat] SUCCESS: отклик из формы отправлен (чат не трогаем).'
          : '[hh-apply-chat] SUCCESS: отклик отправлен, письмо и чат пропущены.'
      );
      step('done_form_only');
      if (stayOpen) await waitEnter('Enter — закрыть браузер: ');
      return;
    }

    await openEmployerChatAfterResponse(page, { vacancyId });
    step('open_chat');
    await betweenMajorSteps(page);

    if (dryRun) {
      console.log('[hh-apply-chat] --dry-run: письмо в чат не вставлялось.');
      step('done_dry_run');
      if (stayOpen) await waitEnter('Enter — закрыть браузер: ');
      return;
    }

    await sendLetterInChat(page, { text: letter, tempFilePath: tmpFile, humanTyping });
    console.log('[hh-apply-chat] Готово: письмо отправлено в чат (проверьте в браузере).');
    console.log('[hh-apply-chat] SUCCESS: сценарий завершён без исключений (exit 0).');
    step('send_chat_done');

    if (stayOpen) {
      await waitEnter('Enter — закрыть браузер: ');
    }
  } catch (e) {
    await saveErrorScreenshot(page, e);
    throw e;
  } finally {
    await ctx.close();
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
