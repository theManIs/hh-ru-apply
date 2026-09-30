/**
 * Ставит или снимает hourly launchd (каждый час в :20 и :40, лимит откликов — preferences.hhApplyChatMaxPerHour).
 *
 *   node scripts/install-hourly-schedule.mjs
 *   node scripts/install-hourly-schedule.mjs --uninstall
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.hh-ru-apply.hourly';
const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const nodePath = fs.existsSync('/opt/homebrew/bin/node')
  ? '/opt/homebrew/bin/node'
  : '/usr/local/bin/node';
const cyclePath = path.join(ROOT, 'scripts/hourly-cycle.mjs');
const logPath = path.join(ROOT, 'data/hourly-cycle.log');
const uninstall = process.argv.includes('--uninstall');
const uid = String(process.getuid());
const domain = `gui/${uid}`;

function runLaunchctl(args) {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status ?? 1;
}

function bootout() {
  runLaunchctl(['bootout', `${domain}/${LABEL}`]);
}

if (uninstall) {
  bootout();
  try {
    fs.unlinkSync(plistPath);
    console.log('Удалено:', plistPath);
  } catch {
    console.log('Plist уже нет:', plistPath);
  }
  process.exit(0);
}

fs.mkdirSync(path.dirname(plistPath), { recursive: true });
fs.mkdirSync(path.dirname(logPath), { recursive: true });
if (!fs.existsSync(nodePath)) {
  console.error('Не найден node:', nodePath);
  process.exit(1);
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cyclePath}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Minute</key>
      <integer>20</integer>
    </dict>
    <dict>
      <key>Minute</key>
      <integer>40</integer>
    </dict>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HH_HEADLESS</key>
    <string>1</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>PLAYWRIGHT_BROWSERS_PATH</key>
    <string>${path.join(os.homedir(), 'Library/Caches/ms-playwright')}</string>
    <key>HOME</key>
    <string>${os.homedir()}</string>
  </dict>
</dict>
</plist>
`;

fs.writeFileSync(plistPath, plist, 'utf8');
bootout();
const code = runLaunchctl(['bootstrap', domain, plistPath]);
if (code !== 0) {
  console.error('launchctl bootstrap не удался');
  process.exit(code);
}
console.log('Планировщик включён:', LABEL);
console.log('Каждый час в :20 и :40: проверка сессии (окно) → harvest + отклики до лимита 8/ч.');
console.log('Сейчас вручную: npm run hourly');
console.log('Лог:', logPath);
console.log('Снять: npm run hourly:uninstall');
