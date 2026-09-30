/**
 * Сбор вакансий: PHP → JS → лид (техдир) → IT project manager, поиск → парсинг → фильтры → оценка OpenRouter → data/vacancies-queue.json.
 *
 * Перед запуском: npm run login, в secrets — OpenRouter_API_KEY.
 * Флаги: --skip-llm | --skip-gemini — без LLM; Laravel/Node и соседний стек всё равно получают fallback-оценку.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadEnv } from '../lib/load-env.mjs';
loadEnv();

import { sessionProfilePath, SKIPPED_FILE, DATA_DIR, CV_DIR } from '../lib/paths.mjs';
import { loadPreferences } from '../lib/preferences.mjs';
import { parseVacancyPage, vacancyIdFromUrl } from '../lib/vacancy-parse.mjs';
import { runHardFilters } from '../lib/filters.mjs';
import { loadCvBundle } from '../lib/cv-load.mjs';
import { loadTracks, keywordsForTrack } from '../lib/hh-tracks.mjs';
import {
  getOpenRouterApiKey,
  scoreVacancyWithOpenRouter,
} from '../lib/openrouter-score.mjs';
import { addVacancyRecord, knownVacancyIds, loadQueue, updateVacancyRecord } from '../lib/store.mjs';
import { withHhBrowserOptions } from '../lib/hh-browser.mjs';
import { fallbackScores, inferTrackId, isLlmScoreError, patchFromLlm, titleFitsTrack } from '../lib/stack-score.mjs';

const headless = process.env.HH_HEADLESS === '1';
const skipLlm =
  process.argv.includes('--skip-llm') || process.argv.includes('--skip-gemini');
const sessionLimit = Math.min(40, Math.max(1, Number(process.env.HH_SESSION_LIMIT ?? process.env.HH_MAX_TOTAL ?? 20) || 20));
const perKeyLimit = Math.min(40, Math.max(1, Number(process.env.HH_PER_KEYWORD_LIMIT || 3) || 3));
const searchPages = Math.min(10, Math.max(1, Number(process.env.HH_SEARCH_PAGES || 6) || 6));
const rescoreLimit = Math.min(40, Math.max(0, Number(process.env.HH_RESCORE_LIMIT || 20) || 20));

const openDelayMin = Math.max(0, Number(process.env.HH_OPEN_DELAY_MIN_MS || 3000) || 3000);
const openDelayMax = Math.max(openDelayMin, Number(process.env.HH_OPEN_DELAY_MAX_MS || 5000) || 5000);
const searchJitterMin = Math.max(0, Number(process.env.HH_SEARCH_JITTER_MIN_MS || 1000) || 1000);
const searchJitterMax = Math.max(searchJitterMin, Number(process.env.HH_SEARCH_JITTER_MAX_MS || 2000) || 2000);

function randomIntInclusive(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function looksLikeLoginUrl(url) {
  const u = url.toLowerCase();
  return u.includes('/account/login') || u.includes('oauth.hh.ru') || u.includes('/logon');
}

function buildSearchUrl(text, page = 0) {
  const params = new URLSearchParams();
  params.set('text', text);
  params.set('work_format', 'REMOTE');
  params.set('schedule', 'remote');
  params.set('order_by', 'publication_time');
  params.set('search_period', process.env.HH_SEARCH_PERIOD || '7');
  params.set('items_on_page', '50');
  params.set('ored_clusters', 'true');
  if (page > 0) params.set('page', String(page));
  const area = (process.env.HH_AREA || '').trim();
  if (area) params.set('area', area);
  return `https://hh.ru/search/vacancy?${params.toString()}`;
}

async function collectVacancyUrls(page) {
  await page.waitForTimeout(2000);
  return page.evaluate(() => {
    const seen = new Set();
    const out = [];
    const push = (href) => {
      const m = String(href || '').match(/\/vacancy\/(\d+)/);
      if (!m) return;
      if (/response|similar|recommend/i.test(href)) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);
      out.push(`https://hh.ru/vacancy/${id}`);
    };
    const titleLinks = document.querySelectorAll(
      'a[data-qa="serp-item__title"], a[data-qa="serp-item__title-text"], h2 a[href*="/vacancy/"]'
    );
    for (const a of titleLinks) push(a.href);
    if (out.length) return out;
    for (const a of document.querySelectorAll('a[href*="/vacancy/"]')) push(a.href);
    return out;
  });
}

function loadSkippedVacancyIds() {
  if (!fs.existsSync(SKIPPED_FILE)) return new Set();
  const ids = new Set();
  for (const line of fs.readFileSync(SKIPPED_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j.vacancyId) ids.add(String(j.vacancyId));
    } catch {
      /* ignore */
    }
  }
  return ids;
}

function logSkipped(payload) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(SKIPPED_FILE, `${JSON.stringify({ ...payload, at: new Date().toISOString() })}\n`, 'utf8');
}

async function scoreParsed(parsed, url, trackId, cvBundle, prefs) {
  if (skipLlm) {
    if (titleFitsTrack(parsed.title, trackId)) {
      return fallbackScores('(LLM отключён — оценка по стеку в заголовке)');
    }
    return null;
  }
  try {
    return await scoreVacancyWithOpenRouter(
      {
        title: parsed.title,
        company: parsed.company,
        salaryRaw: parsed.salaryRaw,
        description: parsed.description,
        url,
      },
      cvBundle,
      prefs
    );
  } catch (e) {
    console.error('  OpenRouter error:', e.message);
    if (titleFitsTrack(parsed.title, trackId)) {
      console.log('  fallback по стеку');
      return fallbackScores(`Ошибка OpenRouter, оценка по стеку: ${e.message}`);
    }
    return null;
  }
}

async function rescoreFailedPending(prefs, cvByTrack) {
  const pri = /laravel|node|nest|php|react|vue|typescript|devops|unity|voip|asterisk|fullstack|backend|frontend/i;
  const pending = loadQueue()
    .filter(
      (r) =>
        isLlmScoreError(r) &&
        (r.scoreOverall ?? 0) === 0 &&
        !r.hhAppliedAt &&
        !r.hhApplySkipReason
    )
    .sort((a, b) => Number(pri.test(b.title || '')) - Number(pri.test(a.title || '')))
    .slice(0, rescoreLimit);
  let n = 0;
  for (const rec of pending) {
    const inferred = inferTrackId(rec.title) || rec.track || 'php';
    const cv = cvByTrack[inferred] || cvByTrack[rec.track || 'php'];
    if (!cv) continue;
    const parsed = {
      title: rec.title,
      company: rec.company,
      salaryRaw: rec.salaryRaw,
      description: rec.descriptionForLlm || rec.descriptionPreview || '',
    };
    const llm = await scoreParsed(parsed, rec.url, inferred, cv, prefs);
    if (!llm) continue;
    updateVacancyRecord(rec.id, { ...patchFromLlm(llm), track: inferred });
    n++;
    console.log(`  rescore ${llm.scoreOverall} [${inferred}] ${rec.title}`);
  }
  if (n) console.log(`Переоценка нулей после сбоя OpenRouter: ${n}`);
  return n;
}

async function main() {
  const prefs = loadPreferences();

  if (!skipLlm && !getOpenRouterApiKey()) {
    console.error('Нужен OpenRouter_API_KEY (или OPENROUTER_API_KEY) в .env / .env.local / config/secrets.local.env');
    console.error('Шаблон: config/secrets.example.env  |  Либо: npm run harvest -- --skip-llm');
    process.exit(1);
  }

  const tracks = loadTracks(prefs);
  const cvByTrack = {};
  for (const tr of tracks) {
    const cvDir = tr.cvSubdir ? path.join(CV_DIR, tr.cvSubdir) : CV_DIR;
    const bundle = await loadCvBundle(cvDir);
    for (const w of bundle.warnings) console.warn(`[CV ${tr.id}]`, w);
    if (!bundle.text.trim()) {
      console.error(`Нет CV для трека ${tr.id} — ${cvDir}`);
      process.exit(1);
    }
    cvByTrack[tr.id] = bundle;
  }

  await rescoreFailedPending(prefs, cvByTrack);

  const profile = sessionProfilePath();
  if (!fs.existsSync(profile)) {
    console.error('Нет профиля Chromium. Сначала: npm run login');
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(
    profile,
    await withHhBrowserOptions({
      headless,
      viewport: { width: 1280, height: 800 },
      locale: 'ru-RU',
    })
  );
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto('https://hh.ru/applicant', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1500);
    if (looksLikeLoginUrl(page.url())) {
      console.error('Сессия не активна. Выполните: npm run login');
      process.exit(1);
    }

    const seenIds = knownVacancyIds();
    const skippedIds = loadSkippedVacancyIds();
    const urls = [];
    const globalSeen = new Set();
    const perKeyCount = new Map();
    const keyLists = tracks.map((track) => ({ track, keywords: keywordsForTrack(track) }));
    const maxKeys = Math.max(0, ...keyLists.map((x) => x.keywords.length));

    outer:
    for (let pageIdx = 0; pageIdx < searchPages; pageIdx++) {
      for (let ki = 0; ki < maxKeys; ki++) {
        for (const { track, keywords } of keyLists) {
          if (urls.length >= sessionLimit) break outer;
          const key = keywords[ki];
          if (!key) continue;
          const pk = `${track.id}\0${key}`;
          if ((perKeyCount.get(pk) || 0) >= perKeyLimit) continue;
          await page.goto(buildSearchUrl(key, pageIdx), { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await sleepMs(randomIntInclusive(searchJitterMin, searchJitterMax));
          const found = await collectVacancyUrls(page);
          if (!found.length) continue;
          let n = 0;
          for (const u of found) {
            if (urls.length >= sessionLimit) break;
            if ((perKeyCount.get(pk) || 0) >= perKeyLimit) break;
            const id = vacancyIdFromUrl(u);
            if (!id || globalSeen.has(id) || seenIds.has(id) || skippedIds.has(id)) continue;
            globalSeen.add(id);
            urls.push({ url: u, query: key, trackId: track.id, blockLanguages: track.blockLanguages || [] });
            perKeyCount.set(pk, (perKeyCount.get(pk) || 0) + 1);
            n++;
          }
          if (n) console.log(`Трек ${track.id} «${key}» стр.${pageIdx + 1}: +${n} (обход ${urls.length})`);
        }
      }
    }

    if (!urls.length) {
      console.log('Нет новых ссылок (все уже в очереди или пустая выдача).');
      return;
    }

    let added = 0;
    for (let i = 0; i < urls.length; i++) {
      if (i > 0) {
        const pause = randomIntInclusive(openDelayMin, openDelayMax);
        console.log(`Пауза ${pause} мс…`);
        await sleepMs(pause);
      }

      const { url, query, trackId, blockLanguages } = urls[i];
      const vacancyId = vacancyIdFromUrl(url);
      console.log(`Парсинг ${i + 1}/${urls.length} [${trackId}]`, url);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const parsed = await parseVacancyPage(page);

      const filter = runHardFilters(parsed, prefs, {
        remoteFromSearch: true,
        blockLanguages,
      });
      if (!filter.pass) {
        console.log(`  SKIP [${filter.stage}]: ${filter.reason}`);
        logSkipped({
          vacancyId,
          url,
          query,
          track: trackId,
          stage: filter.stage,
          reason: filter.reason,
          title: parsed.title,
        });
        continue;
      }

      const inferred = inferTrackId(parsed.title) || trackId;
      const llm = await scoreParsed(
        parsed,
        url,
        inferred,
        cvByTrack[inferred] || cvByTrack[trackId],
        prefs
      );
      if (!llm) {
        console.log('  SKIP: нет оценки LLM и заголовок не из стека — в очередь не пишу');
        continue;
      }
      console.log(
        `  оценка ${llm.scoreOverall} (вакансия ${llm.scoreVacancy}, CV ${llm.scoreCvMatch}) — ${llm.providerModel || '?'}`
      );

      const record = {
        id: crypto.randomUUID(),
        vacancyId,
        url,
        searchQuery: query,
        track: inferred,
        title: parsed.title,
        company: parsed.company,
        salaryRaw: parsed.salaryRaw,
        salaryEstimate: filter.salaryEstimate,
        remoteNote: filter.remoteReason,
        salaryNote: filter.salaryReason,
        descriptionPreview: parsed.description.slice(0, 600),
        descriptionForLlm: parsed.description.slice(0, 6000),
        llmProvider: llm.providerModel === 'fallback-stack' ? 'fallback-stack' : 'openrouter',
        openRouterModel: llm.providerModel || null,
        scoreVacancy: llm.scoreVacancy,
        scoreCvMatch: llm.scoreCvMatch,
        scoreOverall: llm.scoreOverall,
        geminiScore: llm.scoreOverall ?? llm.score,
        geminiSummary: llm.summary,
        geminiRisks: llm.risks,
        geminiMatchCv: llm.matchCv,
        geminiTags: llm.tags,
        status: 'pending',
        feedbackReason: '',
        createdAt: new Date().toISOString(),
        updatedAt: null,
      };

      if (addVacancyRecord(record)) {
        added++;
        console.log('  → В очередь дашборда');
      } else {
        console.log('  → Уже была в очереди, пропуск');
      }
    }

    console.log(`\nГотово. Новых записей в очереди: ${added}. Запустите: npm run dashboard`);
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
