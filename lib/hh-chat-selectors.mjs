/**
 * Селекторы после отклика: отправка формы, чат с работодателем, текст письма.
 * Вёрстка hh.ru меняется — при поломке правьте здесь (Playwright Codegen / DevTools).
 */

import { typeInField } from './hh-human-delay.mjs';

const CHAT_IFRAME_SEL = '.chatik-integration-iframe';

/**
 * @param {import('playwright').Page} page
 */
function vacancyResponseModal(page) {
  return page
    .locator('[data-qa="vacancy-response-popup-form"]')
    .or(page.locator('[role="dialog"]'))
    .first();
}

async function comboboxShowsResume(modal, patternsLower) {
  if (!patternsLower.length) return false;
  const trigger = modal.locator('[aria-haspopup="listbox"], [role="combobox"]').first();
  if (!(await trigger.isVisible({ timeout: 280 }).catch(() => false))) return false;
  const text = ((await trigger.innerText().catch(() => '')) || '').toLowerCase();
  return patternsLower.some((p) => text.includes(p));
}

async function closeResumeListbox(page) {
  const listbox = page.locator('[role="listbox"]');
  if (!(await listbox.first().isVisible({ timeout: 200 }).catch(() => false))) return;
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);
  if (await listbox.first().isVisible({ timeout: 200 }).catch(() => false)) {
    const modal = vacancyResponseModal(page);
    await modal.click({ position: { x: 24, y: 16 } }).catch(() => {});
    await page.waitForTimeout(200);
  }
}

/**
 * Мастер отклика: выбор резюме (по hhResumePickPatterns) и «Далее» / «Продолжить».
 * Второе «Откликнуться» в модалке — это всё ещё тот же отклик, не повтор.
 * @param {import('playwright').Page} page
 * @param {{ maxSteps?: number, resumePickPatterns?: string[] }} opts
 */
export async function prepareVacancyResponseModal(page, opts = {}) {
  const maxSteps = opts.maxSteps ?? 14;
  const patterns = (opts.resumePickPatterns || []).map((p) => String(p).toLowerCase()).filter(Boolean);
  const modal = vacancyResponseModal(page);
  let resumeCardClicked = await comboboxShowsResume(modal, patterns);

  for (let step = 0; step < maxSteps; step++) {
    await page.waitForTimeout(320);

    const warned = await confirmVacancyResponseWarnings(page);
    if (warned) continue;

    const listbox = page.locator('[role="listbox"]');
    const listOpen = await listbox.first().isVisible({ timeout: 280 }).catch(() => false);
    if (listOpen) {
      if (!resumeCardClicked) {
        const pickedOpt = await clickMatchingListboxOption(page, patterns);
        if (pickedOpt) {
          resumeCardClicked = true;
          console.log('[hh-chat] Резюме выбрано в списке:', pickedOpt);
        }
      }
      await closeResumeListbox(page);
      continue;
    }

    if (!resumeCardClicked && patterns.length) {
      if (await comboboxShowsResume(modal, patterns)) {
        resumeCardClicked = true;
        continue;
      }
      const trigger = modal.locator('[aria-haspopup="listbox"], [role="combobox"]').first();
      if (await trigger.isVisible({ timeout: 280 }).catch(() => false)) {
        await trigger.scrollIntoViewIfNeeded().catch(() => {});
        await trigger.click().catch(() => {});
        await page.waitForTimeout(350);
        continue;
      }
      const picked = await clickMatchingResumeInModal(modal, patterns);
      if (picked) {
        resumeCardClicked = true;
        console.log('[hh-chat] Резюме выбрано по шаблону:', picked);
        await page.waitForTimeout(400);
        continue;
      }
    }

    const allRadios = modal.locator('input[type="radio"]');
    const radioCount = await allRadios.count().catch(() => 0);
    let pickedRadio = false;
    for (let ri = 0; ri < radioCount; ri++) {
      const r = allRadios.nth(ri);
      if (!(await r.isVisible({ timeout: 200 }).catch(() => false))) continue;
      const rowText = await r.evaluate((el) => (el.closest('label, li, div')?.innerText || '')).catch(() => '');
      const low = String(rowText).toLowerCase();
      if (patterns.length && !patterns.some((p) => low.includes(p))) continue;
      const checked = await r.isChecked().catch(() => true);
      if (!checked) {
        await r.scrollIntoViewIfNeeded().catch(() => {});
        await r.click({ force: true }).catch(() => {});
        pickedRadio = true;
        resumeCardClicked = true;
        await page.waitForTimeout(400);
        break;
      }
    }
    if (pickedRadio) continue;

    const nextNames = [/^далее$/i, /продолжить/i, /сохранить и продолжить/i];
    let clickedNext = false;
    for (const nameRe of nextNames) {
      const btn = modal.getByRole('button', { name: nameRe }).first();
      if (await btn.isVisible({ timeout: 450 }).catch(() => false)) {
        const dis = await btn.isDisabled().catch(() => true);
        if (!dis) {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn.click();
          clickedNext = true;
          await page.waitForTimeout(480);
          break;
        }
      }
    }
    if (clickedNext) continue;

    if (!resumeCardClicked) {
      const resumePick = modal
        .locator(
          '[data-qa*="resume" i], [data-qa="resume-select-item"], [class*="ResumeItem"], [class*="resume-item"]'
        )
        .first();
      if (await resumePick.isVisible({ timeout: 400 }).catch(() => false)) {
        resumeCardClicked = true;
        await resumePick.scrollIntoViewIfNeeded().catch(() => {});
        await resumePick.click({ force: true }).catch(() => {});
        await page.waitForTimeout(400);
        continue;
      }
    }

    break;
  }
}

/**
 * Предупреждение «вакансия в другой стране» — для удалёнки жмём «Все равно откликнуться».
 * @param {import('playwright').Page} page
 * @returns {Promise<string|null>}
 */
export async function confirmVacancyResponseWarnings(page) {
  const anyway = page
    .getByRole('button', { name: /все равно откликнуться/i })
    .or(page.getByText(/^все равно откликнуться$/i));
  const el = anyway.first();
  if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click();
    await page.waitForTimeout(500);
    return 'все равно откликнуться';
  }
  return null;
}

/**
 * Отклик уводит на внешний сайт — на hh не отправляем.
 * @param {import('playwright').Page} page
 */
export async function vacancyResponseLooksExternal(page) {
  const t = page.getByText(
    /на вакансию на другом сайте|отклика на внешнем сайте|перенаправим вас на страницу отклика/i
  );
  return t.first().isVisible({ timeout: 700 }).catch(() => false);
}

/**
 * @param {import('playwright').Page} page
 * @param {string[]} patternsLower
 */
async function clickMatchingListboxOption(page, patternsLower) {
  const options = page.getByRole('option');
  const n = await options.count().catch(() => 0);
  let best = { score: 0, idx: -1, text: '' };
  for (let i = 0; i < n; i++) {
    const opt = options.nth(i);
    if (!(await opt.isVisible({ timeout: 200 }).catch(() => false))) continue;
    const text = ((await opt.innerText().catch(() => '')) || '').trim();
    if (!text) continue;
    const low = text.toLowerCase();
    let score = 0;
    for (const p of patternsLower) {
      if (low.includes(p)) {
        score +=
          p.includes('fullstack') || p.includes('backend') || p.includes('frontend') || p.includes('chief') || p.includes('cto')
            ? 3
            : 1;
      }
    }
    if (!patternsLower.length) score = 1;
    if (score > best.score) best = { score, idx: i, text: text.slice(0, 80) };
  }
  if (best.idx >= 0 && best.score > 0) {
    const el = options.nth(best.idx);
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ force: true }).catch(() => {});
    return best.text;
  }
  for (const p of patternsLower) {
    const el = page.locator('[role="listbox"]').getByText(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first();
    if (await el.isVisible({ timeout: 250 }).catch(() => false)) {
      await el.click({ force: true }).catch(() => {});
      return p;
    }
  }
  return null;
}

/**
 * @param {import('playwright').Locator} modal
 * @param {string[]} patternsLower
 * @returns {Promise<string|null>}
 */
async function clickMatchingResumeInModal(modal, patternsLower) {
  const items = modal.locator(
    '[data-qa*="resume" i], [data-qa="resume-select-item"], [class*="ResumeItem"], [class*="resume-item"], label'
  );
  const n = await items.count().catch(() => 0);
  let best = { score: 0, idx: -1, text: '' };
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    if (!(await item.isVisible({ timeout: 200 }).catch(() => false))) continue;
    const hasPopup = await item.getAttribute('aria-haspopup').catch(() => '');
    const role = await item.getAttribute('role').catch(() => '');
    if (hasPopup === 'listbox' || role === 'combobox') continue;
    const text = ((await item.innerText().catch(() => '')) || '').trim();
    if (!text) continue;
    const low = text.toLowerCase();
    let score = 0;
    for (const p of patternsLower) {
      if (low.includes(p)) {
        score +=
          p.includes('fullstack') || p.includes('backend') || p.includes('frontend') || p.includes('chief') || p.includes('cto')
            ? 3
            : 1;
      }
    }
    if (score > best.score) best = { score, idx: i, text: text.slice(0, 80) };
  }
  if (best.idx < 0 || best.score <= 0) return null;
  const el = items.nth(best.idx);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ force: true }).catch(() => {});
  return best.text;
}

/**
 * @param {import('playwright').Locator} locator
 * @param {string} label
 * @param {number} timeoutMs
 */
async function clickSubmitIfEnabled(locator, label, timeoutMs) {
  const el = locator.first();
  await el.waitFor({ state: 'visible', timeout: timeoutMs });
  if (await el.isDisabled().catch(() => false)) {
    throw new Error('submit disabled');
  }
  await el.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await el.click();
  } catch {
    await el.click({ force: true });
  }
  return label;
}

/**
 * Нажать отправку отклика в модалке.
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 * @returns {Promise<string|null>} метка найденного элемента или null если кнопки нет
 */
export async function submitVacancyResponseIfPresent(page, timeoutMs = 28_000) {
  const modal = vacancyResponseModal(page);
  const deadline = Date.now() + timeoutMs;
  const perTry = 2200;
  await closeResumeListbox(page);

  const attempts = [
    () =>
      clickSubmitIfEnabled(
        page.getByRole('button', { name: /все равно откликнуться/i }),
        'button Все равно откликнуться',
        perTry
      ),
    () =>
      clickSubmitIfEnabled(
        modal.getByRole('button', { name: /^откликнуться$/i }),
        'modal button Откликнуться',
        perTry
      ),
    () =>
      clickSubmitIfEnabled(
        modal.locator('button').filter({ hasText: /^откликнуться$/i }),
        'modal button hasText Откликнуться',
        perTry
      ),
    () =>
      clickSubmitIfEnabled(
        modal.getByRole('button', { name: /откликнуться/i }),
        'modal button ~Откликнуться',
        perTry
      ),
    () =>
      clickSubmitIfEnabled(
        modal.getByRole('button', { name: /отправить отклик/i }),
        'modal button Отправить отклик',
        perTry
      ),
    () =>
      clickSubmitIfEnabled(
        modal.getByRole('button', { name: /^отправить$/i }),
        'modal button Отправить',
        perTry
      ),
    () =>
      clickSubmitIfEnabled(
        page
          .locator('[data-qa="vacancy-response-popup-form"]')
          .first()
          .getByRole('button', { name: /отправить отклик|отправить/i }),
        'popup-form button Отправить',
        perTry
      ),
    () =>
      clickSubmitIfEnabled(
        page.getByRole('button', { name: /отправить отклик/i }),
        'page button Отправить отклик',
        perTry
      ),
    () =>
      clickSubmitIfEnabled(page.getByRole('button', { name: /^отправить$/i }), 'page button Отправить', perTry),
    () =>
      clickSubmitIfEnabled(
        page.locator('[data-qa="vacancy-response-submit-button"]'),
        'data-qa vacancy-response-submit',
        perTry
      ),
    () =>
      clickSubmitIfEnabled(
        page.locator('[data-qa*="submit" i][data-qa*="response" i]'),
        'data-qa *submit*response*',
        perTry
      ),
    () =>
      clickSubmitIfEnabled(
        page.locator('button[type="submit"]').filter({ hasText: /отправить/i }),
        'button[type=submit] Отправить',
        perTry
      ),
    () =>
      clickSubmitIfEnabled(
        modal.locator('button').filter({ hasText: /отправить отклик/i }),
        'modal button hasText Отправить отклик',
        perTry
      ),
  ];

  while (Date.now() < deadline) {
    await closeResumeListbox(page);
    for (const run of attempts) {
      try {
        return await run();
      } catch {
        /* next */
      }
    }
    await page.waitForTimeout(450);
  }
  return null;
}

/**
 * Уже откликались — повторно не жать.
 * @param {import('playwright').Page} page
 */
export async function vacancyResponseLooksSent(page) {
  const hints = [
    page.getByText(/вы откликнулись/i).first(),
    page.getByText(/резюме доставлено/i).first(),
    page.getByText(/отклик отправлен/i).first(),
    page.getByText(/отклик уже отправлен/i).first(),
    page.locator('[data-qa="vacancy-response-link-view-topic"]').first(),
  ];
  for (const loc of hints) {
    if (await loc.isVisible({ timeout: 700 }).catch(() => false)) return true;
  }
  const top = page.locator('[data-qa="vacancy-response-link-top"], [data-qa="vacancy-response-link"]').first();
  const label = ((await top.innerText().catch(() => '')) || '').toLowerCase();
  if (label && !/откликнуться/.test(label) && /отклик|доставлено/.test(label)) return true;
  return false;
}

/**
 * Перейти в чат/переписку с работодателем после отклика.
 * @param {import('playwright').Page} page
 * @param {{ vacancyId?: string }} ctx
 */
export async function openEmployerChatAfterResponse(page, ctx = {}, timeoutMs = 45_000) {
  await page.waitForTimeout(1200);

  const tryClick = async (locator, label) => {
    const el = locator.first();
    await el.waitFor({ state: 'visible', timeout: 12_000 });
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click();
    return label;
  };

  const urlRes = [
    /\/applicant\/negotiations/,
    /\/negotiation/,
    /\/chats?\//i,
    /\/messenger/i,
    /employer\/.*\/dialog/i,
  ];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const u = page.url();
    if (urlRes.some((re) => re.test(u))) {
      console.log('[hh-chat] Уже на URL чата:', u);
      return 'url-wait';
    }
    await page.waitForTimeout(400);
  }

  const clickAttempts = [
    () => tryClick(page.getByRole('link', { name: /перейти в чат|в чат|написать|открыть чат|переписка/i }), 'link чат'),
    () => tryClick(page.getByRole('button', { name: /перейти в чат|в чат|написать|открыть чат/i }), 'button чат'),
    () =>
      tryClick(
        page.locator('a[href*="/negotiation"]').or(page.locator('a[href*="/applicant/negotiations"]')),
        'a href negotiation'
      ),
    () => tryClick(page.locator('[data-qa*="chat" i]').or(page.locator('[data-qa*="negotiation" i]')), 'data-qa chat'),
  ];

  for (const run of clickAttempts) {
    try {
      const label = await run();
      await page.waitForTimeout(1500);
      console.log('[hh-chat] Переход в чат:', label);
      return label;
    } catch {
      /* next */
    }
  }

  const direct = 'https://hh.ru/applicant/negotiations';
  try {
    await page.goto(direct, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    console.log('[hh-chat] Открыт раздел переговоров (fallback URL)');
    return 'goto-negotiations-fallback';
  } catch {
    /* ignore */
  }

  throw new Error(
    'Не удалось открыть чат с работодателем. Запишите селекторы через Playwright Codegen и обновите lib/hh-chat-selectors.mjs (openEmployerChatAfterResponse).'
  );
}

async function chatIframeVisible(page) {
  return page.locator(CHAT_IFRAME_SEL).first().isVisible({ timeout: 3500 }).catch(() => false);
}

async function tryClickSendInRoot(root) {
  const senders = [
    () => root.getByRole('button', { name: /^отправить$/i }),
    () => root.getByRole('button', { name: /отправить сообщение/i }),
    () => root.getByRole('button', { name: 'Отправить', exact: true }),
    () => root.locator('[data-qa*="send" i]'),
    () => root.locator('button[type="submit"]').filter({ hasText: /отправить/i }),
  ];
  for (const run of senders) {
    try {
      const b = run().first();
      if (await b.isVisible({ timeout: 2500 }).catch(() => false)) {
        const dis = await b.isDisabled().catch(() => false);
        if (!dis) {
          await b.scrollIntoViewIfNeeded().catch(() => {});
          await b.click();
          console.log('[hh-chat] Нажата кнопка отправки в чате');
          return;
        }
      }
    } catch {
      /* next */
    }
  }
}

async function sendLetterInRoot(root, page, opts, timeoutMs, allowPageFallback = false) {
  const { text, tempFilePath, humanTyping = false } = opts;
  await page.waitForTimeout(800);

  const fileInputs = root.locator('input[type=file]');
  const fileCount = await fileInputs.count().catch(() => 0);
  for (let i = 0; i < fileCount; i++) {
    try {
      const inp = fileInputs.nth(i);
      await inp.setInputFiles(tempFilePath);
      console.log('[hh-chat] Прикреплён файл (input[type=file])');
      await tryClickSendInRoot(root);
      return 'file-attach';
    } catch {
      /* next input */
    }
  }

  const uploadBtn = root.getByRole('button', { name: /uploadFileButton/i });
  try {
    const ub = uploadBtn.first();
    if (await ub.isVisible({ timeout: 2200 }).catch(() => false)) {
      await ub.setInputFiles(tempFilePath);
      console.log('[hh-chat] Файл через кнопку uploadFileButton');
      await tryClickSendInRoot(root);
      return 'upload-btn-file';
    }
  } catch {
    /* next */
  }

  const tryFill = async (locator, label, stepMs = timeoutMs) => {
    const el = locator.first();
    try {
      await el.waitFor({ state: 'visible', timeout: stepMs });
    } catch (e) {
      await el.waitFor({ state: 'attached', timeout: Math.min(4000, stepMs) }).catch(() => {
        throw e;
      });
      if (!(await el.isVisible().catch(() => false))) throw e;
    }
    await typeInField(page, locator, text, { humanTyping });
    console.log('[hh-chat] Текст в чате:', label);
    await tryClickSendInRoot(root);
    return label;
  };

  const quick = Math.min(8000, timeoutMs);
  const fillAttempts = [
    () =>
      tryFill(
        root.getByPlaceholder(/сообщение|напишите|ваше сообщение|напишите сообщение/i),
        'placeholder сообщение',
        quick
      ),
    () => tryFill(root.locator('[data-qa*="message" i], [data-qa*="chat" i][data-qa*="input" i]').first(), 'data-qa message/chat input', quick),
    () => tryFill(root.locator('.ProseMirror[contenteditable="true"]').last(), 'ProseMirror contenteditable', quick),
    () => tryFill(root.getByRole('textbox').first(), 'textbox first', quick),
    () => tryFill(root.getByRole('textbox').last(), 'textbox last', quick),
    () => tryFill(root.locator('[contenteditable="true"]').last(), 'contenteditable', quick),
    () => tryFill(root.locator('textarea').last(), 'textarea last', timeoutMs),
  ];
  if (allowPageFallback) {
    fillAttempts.push(
      () =>
        tryFill(
          page.getByPlaceholder(/сообщение|напишите|ваше сообщение|напишите сообщение/i),
          'page placeholder сообщение',
          quick
        ),
      () => tryFill(page.locator('[role="dialog"] [contenteditable="true"]').last(), 'page dialog contenteditable', quick),
      () => tryFill(page.locator('[contenteditable="true"]').last(), 'page contenteditable', quick),
      () => tryFill(page.locator('textarea').last(), 'page textarea last', timeoutMs)
    );
  }

  let lastErr;
  for (const run of fillAttempts) {
    try {
      return await run();
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(
    `Не удалось вставить письмо в чат. Обновите lib/hh-chat-selectors.mjs (sendLetterInChat). ${lastErr?.message || lastErr}`
  );
}

/**
 * Вставить текст в чат: iframe chatik или страница; файл или поле ввода.
 * @param {import('playwright').Page} page
 * @param {{ text: string, tempFilePath: string, humanTyping?: boolean }} opts
 */
export async function sendLetterInChat(page, opts, timeoutMs = 25_000) {
  const humanTyping = opts.humanTyping === true;
  const inner = { ...opts, humanTyping };
  const iframeStepBudget = Math.max(timeoutMs, 38_000);

  await page.waitForTimeout(2000);

  if (await chatIframeVisible(page)) {
    try {
      const fl = page.frameLocator(CHAT_IFRAME_SEL);
      await fl.locator('body').waitFor({ state: 'attached', timeout: 18_000 });
      await page.waitForTimeout(1200);
      return await sendLetterInRoot(fl, page, inner, iframeStepBudget, false);
    } catch (e) {
      console.log('[hh-chat] iframe-чат: ошибка, пробуем страницу —', e.message);
    }
  }

  return await sendLetterInRoot(page, page, inner, timeoutMs, true);
}

