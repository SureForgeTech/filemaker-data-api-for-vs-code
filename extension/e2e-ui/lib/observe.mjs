// Observation helpers for the failure-mode journey: what the user sees (toasts and their buttons, status bar)
// and what the server saw (logins, requests) while an action ran.
import { answerPickers } from './flows.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const logins = async (mock) =>
  (await mock.log()).filter((l) => l.method === 'POST' && l.path === '/sessions');
export const failedLogins = async (mock) => (await logins(mock)).filter((l) => l.status !== 200);

export async function toastInfo(s) {
  const items = await s.page.locator('.notifications-toasts .notification-list-item').all();
  const out = [];
  for (const it of items) {
    const text = (
      await it
        .locator('.notification-list-item-message')
        .innerText()
        .catch(() => '')
    )
      .replace(/\s+/g, ' ')
      .trim();
    const buttons = (
      await it
        .locator('.monaco-button')
        .allInnerTexts()
        .catch(() => [])
    )
      .map((b) => b.trim())
      .filter(Boolean);
    const sev = await it
      .locator('.codicon-error, .codicon-warning, .codicon-info')
      .first()
      .getAttribute('class')
      .catch(() => '');
    out.push({
      text,
      buttons,
      severity: /error/.test(sev ?? '') ? 'error' : /warning/.test(sev ?? '') ? 'warning' : 'info'
    });
  }
  return out;
}

/** Run a command and wait until the toasts stop changing (or max ms). Returns what was seen. */
export async function observe(s, mock, action, { maxMs = 30000, settleMs = 3500 } = {}) {
  await s.dismissToasts().catch(() => {});
  const before = (await mock.log()).length;
  const t0 = Date.now();
  await action();
  let last = '';
  let stableSince = Date.now();
  let seen = [];
  const trail = [];
  while (Date.now() - t0 < maxMs) {
    seen = await toastInfo(s);
    const sb = await s.statusItem(/FileMaker:/);
    if (sb && trail[trail.length - 1] !== sb) trail.push(sb);
    const sig = JSON.stringify(seen);
    if (sig !== last) {
      last = sig;
      stableSince = Date.now();
    }
    if (seen.length && Date.now() - stableSince > settleMs) break;
    // Connect retries several independent per-request timeouts with backoff. Do not clear a
    // scenario's fault while that command is still running just because no toast has appeared yet.
    await sleep(400);
  }
  const requests = (await mock.log()).slice(before);
  const progress = await s.statusItem(/FileMaker:/);
  return {
    toasts: seen,
    ms: Date.now() - t0,
    statusBar: progress,
    statusTrail: trail,
    logins: requests.filter((l) => l.method === 'POST' && l.path === '/sessions').length,
    failedLogins: requests.filter(
      (l) => l.method === 'POST' && l.path === '/sessions' && l.status !== 200
    ).length,
    requests: requests.map(
      (l) =>
        `${l.method} ${l.path}${l.query ?? ''}->${l.status}${l.code && l.code !== '0' ? '/' + l.code : ''}`
    )
  };
}

export const summarise = (o) =>
  `toasts: ${o.toasts.map((t) => `[${t.severity}] "${t.text}" buttons(${t.buttons.join(' / ') || 'none'})`).join(' || ') || 'none'} | logins ${o.logins} (failed ${o.failedLogins}) | ${o.ms} ms | status bar trail: ${o.statusTrail.join(' > ')} | requests: ${o.requests.slice(0, 12).join(', ')}${o.requests.length > 12 ? ' ...' : ''}`;

export async function connectAction(s, name) {
  await s.cmd('FileMaker: Connect');
  await answerPickers(s, [name], { max: 1 });
}
