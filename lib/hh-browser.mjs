/**
 * Chromium для hh через прокси. OpenRouter остаётся на системном VPN.
 * SOCKS5 с логином Chromium не умеет — локальный HTTP без auth (proxy-chain).
 * HH_PROXY=socks5://user:pass@host:port
 */

import { SocksClient } from 'socks';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';

let localProxyUrl = null;

function hhProxyRaw() {
  return String(process.env.HH_PROXY || '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

function redactProxy(raw) {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return '(proxy)';
  }
}

async function preflightSocks(raw) {
  const u = new URL(raw);
  if (!u.protocol.startsWith('socks')) return;
  const proxy = {
    host: u.hostname,
    port: Number(u.port || 1080),
    type: 5,
    userId: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  };
  try {
    const { socket } = await SocksClient.createConnection({
      proxy,
      command: 'connect',
      destination: { host: 'hh.ru', port: 443 },
      timeout: 12000,
    });
    socket.destroy();
    console.log('[hh] SOCKS5 до hh.ru:443 ок', redactProxy(raw));
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[hh] SOCKS5 не открыл туннель до hh.ru:', msg);
    console.error('[hh] Частая причина: Sirius режет путь до прокси, либо прокси не пускает не-РФ IP.');
    throw new Error(`SOCKS5 до hh.ru не работает (${msg})`);
  }
}

export async function withHhBrowserOptions(opts = {}) {
  const out = { ...opts };
  const raw = hhProxyRaw();
  if (!raw) return out;

  if (!localProxyUrl) {
    await preflightSocks(raw);
    localProxyUrl = await anonymizeProxy(raw);
    console.log('[hh] Chromium через локальный прокси', localProxyUrl);
    const stop = async () => {
      if (!localProxyUrl) return;
      const u = localProxyUrl;
      localProxyUrl = null;
      await closeAnonymizedProxy(u, true).catch(() => {});
    };
    process.once('SIGINT', () => {
      stop().finally(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
      stop().finally(() => process.exit(0));
    });
  }

  out.proxy = { server: localProxyUrl };
  return out;
}
