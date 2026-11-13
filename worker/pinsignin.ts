import type { Env } from './env';
import { getSetting, setSetting } from './db.ts';
import { LOGIN_PATH, VISITOR_COOKIE, cookie, getCookie, loginPage, readSigned, redirect, signValue, type User } from './auth.ts';

// PIN sign-in for a visitor, on the same sign-in page as Google.
// First use: Razorpay's check during KYC, which wants to sign in to the real app and look inside.
//
// The owner chose that the PIN opens the REAL app (real tenants), not a demo copy. So it is kept tight:
//   - Off until the owner turns it on in Settings, with the owner's PIN. The box only appears on
//     the sign-in page while it is on.
//   - The visitor PIN is 8 random digits. It is never the owner's PIN for locked actions.
//   - A PIN sign-in is VIEW ONLY: it sees the owner's screens but every change is refused on the
//     server (index.ts), so it can't record, edit, delete, send or export anything.
//   - Five wrong PINs in a row pause PIN sign-in for 15 minutes (stops guessing).
//   - It stops by itself after 14 days. Turning it off, or on again (a new PIN), ends every
//     PIN sign-in at once. A PIN sign-in lasts 12 hours on that browser.

const SETTING = 'pin_signin';
const FAILS = 'pin_signin_fails';
const ACCESS_DAYS = 14;
const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

interface Access {
  pin: string;
  /** Changes every time PIN sign-in is turned on: older PIN sign-ins stop working. */
  gen: string;
  created_at: string;
  expires_at: string;
}

async function readAccess(env: Env): Promise<Access | null> {
  const raw = await getSetting(env.DB, SETTING);
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as Access;
    if (!a || typeof a.pin !== 'string' || !/^\d{8}$/.test(a.pin) || typeof a.gen !== 'string') return null;
    if (typeof a.expires_at !== 'string' || a.expires_at <= new Date().toISOString()) return null;
    return a;
  } catch {
    return null;
  }
}

/** Whether the sign-in page should show the PIN box. */
export const pinSignInOn = async (env: Env) => Boolean(await readAccess(env));

const status = (a: Access | null, origin: string) => ({
  on: Boolean(a),
  url: origin + LOGIN_PATH,
  pin: a?.pin ?? null,
  createdAt: a?.created_at ?? null,
  expiresAt: a?.expires_at ?? null,
});

/** What Settings shows the owner. */
export const pinSignInStatus = async (env: Env, origin: string) => status(await readAccess(env), origin);

/** Eight random digits, every value equally likely. */
function newPin() {
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    if (n < 4_200_000_000) return String(n % 100_000_000).padStart(8, '0'); // 42 × 10^8: no bias
  }
}

/** Turns PIN sign-in on with a new PIN. Any earlier PIN and PIN sign-in stop working. */
export async function turnOnPinSignIn(env: Env, origin: string) {
  const now = Date.now();
  const access: Access = {
    pin: newPin(),
    gen: crypto.randomUUID(),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ACCESS_DAYS * 86400_000).toISOString(),
  };
  await setSetting(env.DB, SETTING, JSON.stringify(access));
  await setSetting(env.DB, FAILS, null);
  return status(access, origin);
}

export async function turnOffPinSignIn(env: Env, origin: string) {
  await setSetting(env.DB, SETTING, null);
  await setSetting(env.DB, FAILS, null);
  return status(null, origin);
}

/** The PIN visitor making this request, if PIN sign-in is still on and their sign-in is current. */
export async function visitorUser(request: Request, env: Env): Promise<User | null> {
  const value = await readSigned(env, getCookie(request, VISITOR_COOKIE));
  if (!value || typeof value.visitor !== 'string' || typeof value.exp !== 'number' || value.exp < Date.now() / 1000) return null;
  const access = await readAccess(env);
  if (!access || access.gen !== value.visitor) return null;
  return { email: 'PIN sign-in (view only)', role: 'owner', name: 'Visitor', viewOnly: true };
}

const enc = new TextEncoder();
/** Compares two strings without giving away where they differ. */
async function sameSecret(a: string, b: string) {
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** POST /auth/pin from the sign-in page. */
export async function handlePinSignIn(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return redirect(LOGIN_PATH);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return new Response('Not allowed', { status: 403 });

  const access = await readAccess(env);
  if (!access) return loginPage(env, { kind: 'error', text: 'PIN sign-in is switched off. Please ask the owner.' }, '/', 403);
  const page = (text: string, code: number) => loginPage(env, { kind: 'error', text }, '/', code, [], true);

  let fails: { n: number; until?: string } = { n: 0 };
  try {
    fails = JSON.parse((await getSetting(env.DB, FAILS)) || '{"n":0}');
  } catch {
    /* start again from zero */
  }
  const now = Date.now();
  if (fails.until && Date.parse(fails.until) > now) {
    // While paused nothing is checked, so even the right PIN gives nothing away.
    const minutes = Math.ceil((Date.parse(fails.until) - now) / 60_000);
    return page(`Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 429);
  }

  const form = await request.formData().catch(() => null);
  const pin = String(form?.get('pin') || '').replace(/\D/g, '').slice(0, 20);
  if (!(await sameSecret(pin, access.pin))) {
    const n = (Number(fails.n) || 0) + 1;
    const locked = n >= MAX_FAILS;
    await setSetting(env.DB, FAILS, JSON.stringify(locked ? { n: 0, until: new Date(now + LOCK_MINUTES * 60_000).toISOString() } : { n }));
    return locked ? page(`Too many wrong PINs. Try again in ${LOCK_MINUTES} minutes.`, 429) : page('Wrong PIN.', 401);
  }

  if (fails.n || fails.until) await setSetting(env.DB, FAILS, null);
  const session = await signValue(env, { visitor: access.gen, exp: Math.floor(now / 1000) + SESSION_HOURS * 3600 });
  return redirect('/', [cookie(VISITOR_COOKIE, session, SESSION_HOURS * 3600)]);
}
