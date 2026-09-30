/**
 * Часовой цикл: headed login-проверка → harvest → отклики (лимит hhApplyChatMaxPerHour).
 * Если сессия жива, окно логина сразу закрывается; если капча/логин — ждёт человека.
 * Harvest/отклики: HH_HEADLESS=1. Повторно на hhAppliedAt не ходит.
 *
 *   node scripts/hourly-cycle.mjs
 *   --skip-harvest  — только отклики из текущей очереди
 *   --skip-login    — не открывать окно проверки сессии
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadEnv } from '../lib/load-env.mjs';
loadEnv();

import { ROOT, DATA_DIR } from '../lib/paths.mjs';
import { loadQueue } from '../lib/store.mjs';
import { loadPreferences } from '../lib/preferences.mjs';
import { countApplyLaunchesLastHour } from '../lib/hh-apply-rate.mjs';
import { markBlockedTitles, waterfallTargets } from '../lib/hh-tracks.mjs';

process.env.HH_HEADLESS = process.env.HH_HEADLESS || '1';
process.env.PLAYWRIGHT_BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME || '', 'Library/Caches/ms-playwright');

const skipHarvest = process.argv.includes('--skip-harvest');
const skipLogin = process.argv.includes('--skip-login');
const LOCK = path.join(DATA_DIR, 'hourly-cycle.lock');
const LOG = path.join(DATA_DIR, 'hourly-cycle.log');

function log(msg) {
  const line = `[hourly ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(LOG, `${line}\n`, 'utf8');
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  if (fs.existsSync(LOCK)) {
    try {
      const prev = Number(fs.readFileSync(LOCK, 'utf8').trim());
      if (prev && isPidAlive(prev)) {
        log(`уже запущен pid=${prev} — выход`);
        return false;
      }
    } catch {
      /* stale */
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid), 'utf8');
  return true;
}

function runNode(scriptRel, args = [], timeoutMs = 20 * 60 * 1000) {
  const r = spawnSync(process.execPath, [path.join(ROOT, scriptRel), ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.stdout) fs.appendFileSync(LOG, r.stdout, 'utf8');
  if (r.stderr) fs.appendFileSync(LOG, r.stderr, 'utf8');
  return r.status ?? (r.error ? 1 : 0);
}

async function main() {
  if (!acquireLock()) process.exit(0);
  try {
    const prefs = loadPreferences();
    const maxPerHour = Math.max(1, Number(prefs.hhApplyChatMaxPerHour) || 8);
    const minScore = Number(prefs.hhHourlyMinScore ?? 50);

    log(`старт headless=${process.env.HH_HEADLESS} лимит=${maxPerHour}/ч minScore=${minScore}`);

    if (!skipLogin) {
      log('проверка сессии (окно Chromium)…');
      const loginCode = runNode('scripts/login.mjs', [], 22 * 60 * 1000);
      log(`login exit=${loginCode}`);
      if (loginCode !== 0) {
        log('сессия не подтверждена — harvest/отклики пропускаю');
        return;
      }
    }

    if (!skipHarvest) {
      log('harvest…');
      const code = runNode('scripts/harvest.mjs', [], 25 * 60 * 1000);
      log(`harvest exit=${code}`);
    }

    const used = countApplyLaunchesLastHour();
    let slots = Math.max(0, maxPerHour - used);
    log(`слотов отклика в этом часе: ${slots} (уже ${used})`);
    if (!slots) {
      log('лимит часа исчерпан');
      return;
    }

    const skippedTitles = markBlockedTitles(prefs);
    if (skippedTitles) log(`пропуск по заголовку: ${skippedTitles}`);

    const targets = waterfallTargets(loadQueue(), prefs, minScore);

    log(`в очереди без отклика (score≥${minScore}): ${targets.length} (водопад php → js → lead → pm)`);

    for (const rec of targets) {
      slots = maxPerHour - countApplyLaunchesLastHour();
      if (slots <= 0) {
        log('лимит часа достигнут');
        break;
      }
      log(`отклик [${rec.track || 'php'}] ${rec.title} (${rec.scoreOverall}) ${rec.url}`);
      const code = runNode(
        'scripts/hh-apply-chat-letter.mjs',
        [`--id=${rec.id}`, '--skip-chat'],
        5 * 60 * 1000
      );
      log(`отклик exit=${code} id=${rec.id}`);
    }

    log('цикл завершён');
  } finally {
    try {
      fs.unlinkSync(LOCK);
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  log(String(e?.stack || e));
  process.exit(1);
});
