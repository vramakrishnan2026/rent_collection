import type { Env } from './env';
import { NotFoundError, ValidationError, getSetting, setSetting, str } from './db.ts';
import { b64url, cookie, esc, getCookie, redirect } from './auth.ts';

// Security phones without a Gmail login.
// The owner makes a one-time 6-digit code (24 hours). On the guard's phone, the code (typed on the
// sign-in page, or via the link) creates a device sign-in that lasts 400 days on that phone only.
// Only hashes are stored. Ten wrong codes in a row cancel every open code (stops guessing).

export const PAIR_PATH = '/auth/pair';
export const DEVICE_COOKIE = 'cr_device';
const DEVICE_DAYS = 400; // the longest a browser keeps a cookie
const CODE_HOURS = 24;
const MAX_FAILS = 10;
const FAILS_KEY = 'pair_failed_attempts';

const enc = new TextEncoder();
const sha256 = async (s: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));

export interface DeviceUser {
  id: string;
  label: string;
}

/** The paired phone making this request, if any (and not removed). */
export async function currentDevice(request: Request, env: Env): Promise<DeviceUser | null> {
  const token = getCookie(request, DEVICE_COOKIE);
  if (!token || token.length < 20) return null;
  const row = await env.DB
    .prepare('SELECT id, label, last_seen FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(await sha256(token))
    .first<{ id: string; label: string; last_seen: string | null }>();
  if (!row) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (!row.last_seen || row.last_seen.slice(0, 10) !== today) {
    await env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(new Date().toISOString(), row.id).run();
  }
  return { id: row.id, label: row.label };
}

// ---------- owner ----------

export async function createPairCode(env: Env, body: any, origin: string) {
  const label = str(body?.label, 40) || 'Security phone';
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  const code = String(n).padStart(6, '0');
  const expires = new Date(Date.now() + CODE_HOURS * 3600_000).toISOString();
  await env.DB.prepare('INSERT OR REPLACE INTO pair_codes (code_hash, label, expires_at) VALUES (?, ?, ?)').bind(await sha256(code), label, expires).run();
  await setSetting(env.DB, FAILS_KEY, '0');
  return { code, label, expiresAt: expires, link: `${origin}${PAIR_PATH}?code=${code}` };
}

export async function listDevices(env: Env) {
  const [devices, codes] = await env.DB.batch([
    env.DB.prepare('SELECT id, label, created_at, last_seen FROM devices WHERE revoked_at IS NULL ORDER BY created_at'),
    env.DB.prepare('SELECT label, expires_at FROM pair_codes WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at').bind(new Date().toISOString()),
  ]);
  return { devices: devices.results, openCodes: codes.results };
}

export async function removeDevice(env: Env, id: string) {
  const res = await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(new Date().toISOString(), id).run();
  if (!Number((res.meta as any)?.changes || 0)) throw new NotFoundError('Phone not found');
}

export async function cancelCodes(env: Env) {
  await env.DB.prepare('DELETE FROM pair_codes WHERE used_at IS NULL').run();
}

// ---------- the guard's phone ----------

function pairPage(code: string, message: { kind: 'error' | 'info'; text: string } | null, status = 200) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Security phone – Challaghatta Rent</title>
<meta name="theme-color" content="#0B1120">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" href="/icon-192.png">
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.25rem;background:#F8FAFC;color:#0F172A;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .card{width:100%;max-width:24rem;background:#fff;border:1px solid #F1F5F9;border-radius:2rem;padding:2.2rem 1.8rem;box-shadow:0 10px 25px -10px rgba(15,23,42,.12);text-align:center}
  .logo{width:4rem;height:4rem;border-radius:1.25rem;margin:0 auto 1.1rem;display:flex;align-items:center;justify-content:center;color:#FCD34D;font-size:2rem;font-weight:800;background:#0B1120}
  h1{font-size:1.35rem;margin:0 0 .3rem} p.sub{margin:0 0 1.4rem;color:#64748B;font-size:.9rem}
  input{width:100%;font-size:2rem;letter-spacing:.5rem;text-align:center;padding:.7rem;border:2px solid #E2E8F0;border-radius:1rem;font-weight:800;background:#fff;color:#0F172A}
  button{margin-top:1rem;width:100%;padding:1rem;border:0;border-radius:1rem;background:#16A34A;color:#fff;font-size:1.05rem;font-weight:800}
  .msg{margin:0 0 1rem;padding:.75rem 1rem;border-radius:.9rem;font-size:.85rem;text-align:left}
  .error{background:#FFF1F2;color:#BE123C} .info{background:#F0FDF4;color:#15803D}
  a{color:#64748B;font-size:.8rem}
  @media (prefers-color-scheme: dark){body{background:#0B1120;color:#F1F5F9}.card{background:#111827;border-color:#1F2937}input{background:#0B1120;color:#F1F5F9;border-color:#334155}}
</style></head>
<body><main class="card">
  <div class="logo">⌂</div>
  <h1>Security phone</h1>
  <p class="sub">Enter the 6-digit code from the owner.<br><span lang="ne">मालिकले दिएको ६ अंकको कोड लेख्नुहोस्।</span></p>
  ${message ? `<p class="msg ${message.kind}" role="alert">${esc(message.text)}</p>` : ''}
  <form method="post" action="${PAIR_PATH}">
    <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required value="${esc(code)}" aria-label="Code">
    <button type="submit">Continue</button>
  </form>
  <p style="margin-top:1.4rem"><a href="/auth/login">Owner sign-in</a></p>
</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function handlePair(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'GET') {
    if (await currentDevice(request, env)) return redirect('/');
    return pairPage((url.searchParams.get('code') || '').replace(/\D/g, '').slice(0, 6), null);
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return new Response('Not allowed', { status: 403 });

  const form = await request.formData().catch(() => null);
  const code = String(form?.get('code') || '').replace(/\D/g, '');
  const fails = Number((await getSetting(env.DB, FAILS_KEY)) || 0);
  const now = new Date().toISOString();
  const row =
    code.length === 6
      ? await env.DB
          .prepare('SELECT code_hash, label FROM pair_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
          .bind(await sha256(code), now)
          .first<{ code_hash: string; label: string }>()
      : null;

  if (!row) {
    if (fails + 1 >= MAX_FAILS) {
      await cancelCodes(env);
      await setSetting(env.DB, FAILS_KEY, '0');
      return pairPage('', { kind: 'error', text: 'Too many wrong codes. Ask the owner for a new code.' }, 429);
    }
    await setSetting(env.DB, FAILS_KEY, String(fails + 1));
    return pairPage('', { kind: 'error', text: 'That code is wrong or has expired. Check it, or ask the owner for a new one.' }, 400);
  }

  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare('UPDATE pair_codes SET used_at = ? WHERE code_hash = ?').bind(now, row.code_hash),
    env.DB.prepare('INSERT INTO devices (id, label, token_hash, last_seen) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), row.label, await sha256(token), now),
  ]);
  await setSetting(env.DB, FAILS_KEY, '0');
  return redirect('/#/security', [cookie(DEVICE_COOKIE, token, DEVICE_DAYS * 86400)]);
}

export function clearDeviceCookie() {
  return cookie(DEVICE_COOKIE, '', 0);
}
