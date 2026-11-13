import type { Env } from './env';

// "Sign in with Google" for the whole app (same approach as the Finance Tracker).
// Two lists decide who gets in (both are secrets in Cloudflare):
//   OWNER_EMAILS    - the whole app
//   SECURITY_EMAILS - the security guard: the read-only rent status screen
// After sign-in the Worker sets a signed session cookie that lasts 30 days.

export type Role = 'owner' | 'security';

/** The person who looks after the building (rent-status and Add ID screens). */
export const GUARD = 'Anita';
export interface User {
  email: string;
  role: Role;
  name?: string;
  /** Signed in as a paired security phone (no Gmail). */
  device?: boolean;
  /** Signed in with the demo username and password: sees the demo copy only, never real data. */
  demo?: boolean;
}

export const LOGIN_PATH = '/auth/login';
export const START_PATH = '/auth/start';
export const CALLBACK_PATH = '/auth/callback';
export const LOGOUT_PATH = '/auth/logout';

const SESSION_COOKIE = 'cr_session';
/** Cookie for the demo sign-in (worker/demo.ts). Kept apart from the real session on purpose. */
export const DEMO_COOKIE = 'cr_demo';
export const DEMO_LOGIN_PATH = '/auth/demo';
const STATE_COOKIE = 'cr_login_state';
const SESSION_DAYS = 30;

// Files that load without signing in. None of them contain data.
const PUBLIC_PATHS = new Set([
  LOGIN_PATH,
  START_PATH,
  CALLBACK_PATH,
  LOGOUT_PATH,
  '/privacy',
  '/privacy.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon.ico',
  '/sw.js', // service worker for reminders: code only, no data
]);

export const isPublicPath = (pathname: string) => PUBLIC_PATHS.has(pathname);

const emailList = (raw?: string) =>
  (raw || '')
    .split(/[,\s;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

/** Owner wins if an email is on both lists. */
export function roleFor(env: Env, email: string): Role | null {
  const e = email.toLowerCase();
  if (emailList(env.OWNER_EMAILS).includes(e)) return 'owner';
  if (emailList(env.SECURITY_EMAILS).includes(e)) return 'security';
  return null;
}

export function signInConfigured(env: Env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && emailList(env.OWNER_EMAILS).length);
}

// ---------- session cookie (HMAC-signed) ----------

const enc = new TextEncoder();
export const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

async function hmacKey(env: Env) {
  const secret = env.SESSION_SECRET || `cr-session:${env.GOOGLE_CLIENT_SECRET}`;
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function makeSession(env: Env, email: string, name?: string | null) {
  const payload = b64url(enc.encode(JSON.stringify({ email, ...(name ? { name } : {}), exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

/** Signs a small JSON value with the session key (used by the demo sign-in). */
export async function signValue(env: Env, value: Record<string, unknown>) {
  const payload = b64url(enc.encode(JSON.stringify(value)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

/** The value inside a signed cookie, or null if it was changed or isn't ours. */
export async function readSigned(env: Env, raw: string | null): Promise<Record<string, unknown> | null> {
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64url(sig), enc.encode(payload));
    if (!ok) return null;
    const value = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** The signed-in user, if the request has a valid session for someone still on a list. */
export async function currentUser(request: Request, env: Env): Promise<User | null> {
  if (!signInConfigured(env)) return null;
  const raw = getCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64url(sig), enc.encode(payload));
    if (!ok) return null;
    const { email, exp, name } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (typeof exp !== 'number' || exp < Date.now() / 1000) return null;
    if (typeof email !== 'string') return null;
    // Re-check the lists every time, so removing an email locks that person out straight away.
    const role = roleFor(env, email);
    if (!role) return null;
    return { email, role, ...(typeof name === 'string' && name ? { name } : {}) };
  } catch {
    return null;
  }
}

// ---------- helpers ----------

export function getCookie(request: Request, name: string) {
  const match = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export const cookie = (name: string, value: string, maxAge: number, path = '/') =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

export const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  cookies.forEach((c) => headers.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers });
};

const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : '/');

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- pages ----------

type LoginMessage = { kind: 'error' | 'info'; text: string } | null;

export function loginPage(env: Env, message: LoginMessage = null, next = '/', status = 200, cookies: string[] = []) {
  const configured = signInConfigured(env);
  const msg = !configured
    ? { kind: 'error' as const, text: 'Sign-in isn’t set up yet. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and OWNER_EMAILS in the Worker’s settings.' }
    : message;
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in – Challaghatta Rent</title>
<meta name="theme-color" content="#0B1120">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" href="/icon-192.png">
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.25rem;
       background:#F8FAFC;color:#0F172A;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .card{width:100%;max-width:24rem;background:#fff;border:1px solid #F1F5F9;border-radius:2rem;padding:2.5rem 2rem;
        box-shadow:0 10px 25px -10px rgba(15,23,42,.12);text-align:center}
  .logo{width:4rem;height:4rem;border-radius:1.25rem;margin:0 auto 1.25rem;display:flex;align-items:center;justify-content:center;
        color:#FCD34D;font-size:2rem;font-weight:800;background:#0B1120}
  h1{font-size:1.4rem;font-weight:800;letter-spacing:-.02em;margin:0 0 .35rem}
  p.sub{margin:0 0 1.75rem;color:#64748B;font-size:.9rem}
  .btn{display:flex;align-items:center;justify-content:center;gap:.75rem;width:100%;padding:.9rem 1rem;border-radius:1rem;
       border:1px solid #E2E8F0;background:#fff;color:#0F172A;font-weight:700;font-size:.95rem;text-decoration:none}
  .btn[aria-disabled=true]{opacity:.45;pointer-events:none}
  .msg{margin:0 0 1.25rem;padding:.75rem 1rem;border-radius:.9rem;font-size:.85rem;line-height:1.45;text-align:left}
  .error{background:#FFF1F2;color:#BE123C;border:1px solid #FFE4E6}
  .info{background:#F0FDF4;color:#15803D;border:1px solid #DCFCE7}
  footer{margin-top:1.75rem;font-size:.75rem;color:#94A3B8}
  footer a{color:#94A3B8}
  @media (prefers-color-scheme: dark){
    body{background:#0B1120;color:#F1F5F9}
    .card{background:#111827;border-color:#1F2937;box-shadow:none}
    p.sub{color:#94A3B8}
    .btn{background:#1F2937;border-color:#334155;color:#F1F5F9}
    .error{background:#4C0519;color:#FDA4AF;border-color:#881337}
    .info{background:#064E3B;color:#6EE7B7;border-color:#065F46}
  }
</style></head>
<body><main class="card">
  <div class="logo">⌂</div>
  <h1>Challaghatta Home</h1>
  <p class="sub">Rent collection. Private: sign in with an approved Google account.</p>
  ${msg ? `<p class="msg ${msg.kind}" role="alert">${esc(msg.text)}</p>` : ''}
  <a class="btn" href="${START_PATH}?next=${encodeURIComponent(next)}"${configured ? '' : ' aria-disabled="true"'}>
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
    Sign in with Google
  </a>
  <p style="margin:1.4rem 0 0;font-size:.9rem"><a href="/auth/pair" style="color:inherit;font-weight:700">${GUARD}? Enter your code</a></p>
  <footer><a href="/privacy">Privacy policy</a></footer>
</main></body></html>`;
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  cookies.forEach((c) => headers.append('Set-Cookie', c));
  return new Response(html, { status, headers });
}

// ---------- routes ----------

export async function handleAuth(request: Request, env: Env, url: URL): Promise<Response | null> {
  const { pathname } = url;

  if (pathname === LOGIN_PATH) {
    if (await currentUser(request, env)) return redirect(safeNext(url.searchParams.get('next')));
    const notice = url.searchParams.get('signed_out') ? { kind: 'info' as const, text: 'You’ve been signed out.' } : null;
    return loginPage(env, notice, safeNext(url.searchParams.get('next')));
  }

  if (pathname === START_PATH) {
    if (!signInConfigured(env)) return loginPage(env, null, '/', 503);
    const state = crypto.randomUUID();
    const next = safeNext(url.searchParams.get('next'));
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      redirect_uri: url.origin + CALLBACK_PATH,
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'select_account',
      state,
    });
    return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, [
      cookie(STATE_COOKIE, encodeURIComponent(`${state}|${next}`), 600, '/auth'),
    ]);
  }

  if (pathname === CALLBACK_PATH) {
    const clearState = cookie(STATE_COOKIE, '', 0, '/auth');
    if (!signInConfigured(env)) return loginPage(env, null, '/', 503, [clearState]);
    if (url.searchParams.get('error')) {
      return loginPage(env, { kind: 'error', text: 'Sign-in was cancelled.' }, '/', 400, [clearState]);
    }
    const [expected, next] = (getCookie(request, STATE_COOKIE) || '').split('|');
    const code = url.searchParams.get('code');
    if (!code || !expected || url.searchParams.get('state') !== expected) {
      return loginPage(env, { kind: 'error', text: 'That sign-in link expired. Please try again.' }, '/', 400, [clearState]);
    }

    let email: string;
    let firstName: string | null = null;
    try {
      ({ email, firstName } = await identityFromCode(env, url.origin, code));
    } catch (e) {
      console.error('Sign-in failed', e);
      return loginPage(env, { kind: 'error', text: 'Google sign-in failed. Please try again.' }, '/', 400, [clearState]);
    }

    if (!roleFor(env, email)) {
      return loginPage(env, { kind: 'error', text: `${email} doesn’t have access to this app. Sign in with an approved account.` }, '/', 403, [clearState]);
    }

    const session = await makeSession(env, email, firstName);
    return redirect(safeNext(next || '/'), [clearState, cookie(SESSION_COOKIE, session, SESSION_DAYS * 86400), cookie(DEMO_COOKIE, '', 0)]);
  }

  if (pathname === LOGOUT_PATH) {
    // A demo visitor goes back to the demo sign-in page, everyone else to Google sign-in.
    const back = getCookie(request, DEMO_COOKIE) && !getCookie(request, SESSION_COOKIE) ? DEMO_LOGIN_PATH : LOGIN_PATH;
    return redirect(`${back}?signed_out=1`, [cookie(SESSION_COOKIE, '', 0), cookie(DEMO_COOKIE, '', 0)]);
  }

  return null;
}

const tidyFirstName = (v: unknown) => {
  if (typeof v !== 'string') return null;
  const n = v.normalize('NFKC').replace(/[^\p{L}\p{M} .'-]/gu, '').trim().split(/\s+/)[0] || '';
  return n.length >= 1 && n.length <= 30 ? n : null;
};

/** Exchanges the Google sign-in code for the user's verified email address. */
async function identityFromCode(env: Env, origin: string, code: string): Promise<{ email: string; firstName: string | null }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: origin + CALLBACK_PATH,
      grant_type: 'authorization_code',
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new Error(data.error_description || data.error || `token error ${res.status}`);

  // The ID token came straight from Google's token endpoint over HTTPS in exchange for our
  // client secret, so it is trusted without a separate signature check (per Google's docs).
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(String(data.id_token).split('.')[1])));
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new Error('ID token audience mismatch');
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') throw new Error('Bad issuer');
  if (typeof claims.exp === 'number' && claims.exp < Date.now() / 1000) throw new Error('ID token expired');
  if (!claims.email || claims.email_verified !== true) throw new Error('Email not verified');
  return { email: String(claims.email), firstName: tidyFirstName(claims.given_name) ?? tidyFirstName(claims.name) };
}
