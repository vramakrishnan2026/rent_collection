import type { D1Database, D1PreparedStatement, Env } from './env';
import { ValidationError, getSetting, setSetting } from './db.ts';
import { DEMO_COOKIE, DEMO_LOGIN_PATH, SESSION_COOKIE_NAME, cookie, esc, getCookie, readSigned, redirect, signValue, type User } from './auth.ts';

// Demo access, for someone who has to look inside the app without seeing real tenants
// (first use: Razorpay's website check during KYC).
//
// How it stays safe:
//   - The demo lives in its own database (DB_DEMO). A demo sign-in is handed that database
//     in place of the real one for the whole request, so no screen or API can reach real data.
//   - The owner turns it on in Settings with the PIN. That makes a fresh copy of the units,
//     tenancies, people and payments with made-up names and phone numbers, new record IDs,
//     and no notes, addresses, ID photos, payment references or rent links. Rents, deposits
//     and dates are kept so the screens look real.
//   - It signs in with a username and a random password (no Google), stops by itself after
//     30 days, and turning it off or on again signs every demo visitor out at once.
//   - Inside the demo: its own PIN, Razorpay test keys only (never live), no Google Drive,
//     and rent messages open WhatsApp/SMS without a number filled in.

export const DEMO_USERNAME = 'demo';
/** The PIN inside the demo. Never the owner's real PIN, so the demo can't be used to guess it. */
export const DEMO_PIN = '0000';
const SETTING = 'demo_access';
const ACCESS_DAYS = 30;
const SESSION_HOURS = 12;

interface Access {
  password: string;
  /** Changes every time demo access is turned on: older demo sign-ins stop working. */
  gen: string;
  created_at: string;
  expires_at: string;
}

async function readAccess(env: Env): Promise<Access | null> {
  if (!env.DB_DEMO) return null;
  const raw = await getSetting(env.DB, SETTING);
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as Access;
    if (!a || typeof a.password !== 'string' || a.password.length < 12 || typeof a.gen !== 'string') return null;
    if (typeof a.expires_at !== 'string' || a.expires_at <= new Date().toISOString()) return null;
    return a;
  } catch {
    return null;
  }
}

/** What Settings shows the owner. */
export async function demoStatus(env: Env, origin: string) {
  const a = await readAccess(env);
  return {
    available: Boolean(env.DB_DEMO),
    on: Boolean(a),
    url: origin + DEMO_LOGIN_PATH,
    username: DEMO_USERNAME,
    password: a?.password ?? null,
    pin: DEMO_PIN,
    createdAt: a?.created_at ?? null,
    expiresAt: a?.expires_at ?? null,
  };
}

/** A password that is easy to read out and type: 12 characters, no look-alikes (about 59 bits). */
function newPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // 31: no i, l, o, 0, 1
  let out = '';
  while (out.length < 12) {
    for (const b of crypto.getRandomValues(new Uint8Array(24))) {
      if (b < 248 && out.length < 12) out += alphabet[b % 31]; // 248 = 31 × 8: no bias
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** Makes a fresh demo copy and a new password. Any earlier demo sign-in stops working. */
export async function turnOnDemo(env: Env, origin: string) {
  if (!env.DB_DEMO) throw new ValidationError('The demo database isn’t set up yet (DB_DEMO in wrangler.jsonc).');
  const copied = await copyToDemo(env.DB, env.DB_DEMO);
  const now = Date.now();
  const access: Access = {
    password: newPassword(),
    gen: crypto.randomUUID(),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ACCESS_DAYS * 86400_000).toISOString(),
  };
  await setSetting(env.DB, SETTING, JSON.stringify(access));
  return {
    available: true,
    on: true,
    url: origin + DEMO_LOGIN_PATH,
    username: DEMO_USERNAME,
    password: access.password,
    pin: DEMO_PIN,
    createdAt: access.created_at,
    expiresAt: access.expires_at,
    copied,
  };
}

/** Signs every demo visitor out and empties the demo copy. */
export async function turnOffDemo(env: Env) {
  await setSetting(env.DB, SETTING, null);
  if (env.DB_DEMO) await emptyDemo(env.DB, env.DB_DEMO).catch((e) => console.error('Emptying the demo copy failed', e));
}

// ---------- the demo visitor ----------

/** The demo visitor making this request, if demo access is on and their sign-in is current. */
export async function demoUser(request: Request, env: Env): Promise<User | null> {
  if (!env.DB_DEMO) return null;
  const value = await readSigned(env, getCookie(request, DEMO_COOKIE));
  if (!value || typeof value.demo !== 'string' || typeof value.exp !== 'number' || value.exp < Date.now() / 1000) return null;
  const access = await readAccess(env);
  if (!access || access.gen !== value.demo) return null;
  return { email: 'Demo copy', role: 'owner', name: 'Demo', demo: true };
}

/**
 * What a demo request is allowed to touch: the demo database only, its own PIN, Razorpay test
 * keys only, and no Google. Everything after sign-in runs with this in place of the real settings.
 */
export function demoEnv(env: Env): Env {
  const testKeys = Boolean(env.RAZORPAY_KEY_ID?.startsWith('rzp_test_'));
  return {
    ...env,
    DB: env.DB_DEMO!,
    DB_DEMO: undefined,
    DEMO: true,
    OWNER_PIN: DEMO_PIN,
    RENT_FREE_PIN: undefined,
    OWNER_EMAILS: undefined,
    SECURITY_EMAILS: undefined,
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    SESSION_SECRET: undefined,
    RAZORPAY_KEY_ID: testKeys ? env.RAZORPAY_KEY_ID : undefined,
    RAZORPAY_KEY_SECRET: testKeys ? env.RAZORPAY_KEY_SECRET : undefined,
  };
}

const enc = new TextEncoder();
/** Compares two strings without giving away where they differ. */
async function sameSecret(a: string, b: string) {
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function demoLoginPage(message: { kind: 'error' | 'info'; text: string } | null, username = '', status = 200) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demo sign-in – Challaghatta Rent</title>
<meta name="theme-color" content="#0B1120">
<meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="/icon-192.png">
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.25rem;background:#F8FAFC;color:#0F172A;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .card{width:100%;max-width:24rem;background:#fff;border:1px solid #F1F5F9;border-radius:2rem;padding:2.2rem 1.8rem;box-shadow:0 10px 25px -10px rgba(15,23,42,.12);text-align:center}
  .logo{width:4rem;height:4rem;border-radius:1.25rem;margin:0 auto 1.1rem;display:flex;align-items:center;justify-content:center;color:#FCD34D;font-size:2rem;font-weight:800;background:#0B1120}
  h1{font-size:1.35rem;margin:0 0 .3rem} p.sub{margin:0 0 1.4rem;color:#64748B;font-size:.9rem;line-height:1.45}
  label{display:block;text-align:left;font-size:.8rem;font-weight:700;color:#475569;margin-top:.9rem}
  input{display:block;width:100%;margin-top:.3rem;font-size:1rem;padding:.8rem .9rem;border:2px solid #E2E8F0;border-radius:.9rem;background:#fff;color:#0F172A}
  button{margin-top:1.2rem;width:100%;padding:1rem;border:0;border-radius:1rem;background:#0B1120;color:#fff;font-size:1.05rem;font-weight:800}
  .msg{margin:0 0 1rem;padding:.75rem 1rem;border-radius:.9rem;font-size:.85rem;text-align:left}
  .error{background:#FFF1F2;color:#BE123C} .info{background:#F0FDF4;color:#15803D}
  footer{margin-top:1.4rem;font-size:.75rem} footer a{color:#94A3B8;margin:0 .4rem}
  @media (prefers-color-scheme: dark){body{background:#0B1120;color:#F1F5F9}.card{background:#111827;border-color:#1F2937}p.sub{color:#94A3B8}label{color:#CBD5E1}input{background:#0B1120;color:#F1F5F9;border-color:#334155}button{background:#FCD34D;color:#0B1120}}
</style></head>
<body><main class="card">
  <div class="logo">⌂</div>
  <h1>Challaghatta Home</h1>
  <p class="sub">Rent collection · demo sign-in.<br>A copy of the app with made-up tenant names and phone numbers.</p>
  ${message ? `<p class="msg ${message.kind}" role="alert">${esc(message.text)}</p>` : ''}
  <form method="post" action="${DEMO_LOGIN_PATH}">
    <label>Username <input name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required maxlength="40" value="${esc(username)}"></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" required maxlength="80"></label>
    <button type="submit">Sign in</button>
  </form>
  <footer><a href="/auth/login">Owner sign-in</a><a href="/privacy">Privacy policy</a></footer>
</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function handleDemoLogin(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'GET') {
    if (await demoUser(request, env)) return redirect('/');
    return demoLoginPage(url.searchParams.get('signed_out') ? { kind: 'info', text: 'You’ve been signed out.' } : null);
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return new Response('Not allowed', { status: 403 });

  const form = await request.formData().catch(() => null);
  const username = String(form?.get('username') || '').trim().slice(0, 40);
  const password = String(form?.get('password') || '').trim().toLowerCase().slice(0, 80);
  const access = await readAccess(env);
  if (!access) return demoLoginPage({ kind: 'error', text: 'Demo access is switched off. Please ask the owner for a new link.' }, username, 403);
  // Both are always checked, so a wrong username and a wrong password look the same.
  const okPassword = await sameSecret(password, access.password);
  const okUsername = await sameSecret(username.toLowerCase(), DEMO_USERNAME);
  if (!okPassword || !okUsername) return demoLoginPage({ kind: 'error', text: 'Wrong username or password.' }, username, 401);

  const session = await signValue(env, { demo: access.gen, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 });
  // Signing in to the demo signs this browser out of the real app, so the two are never mixed up.
  return redirect('/', [cookie(DEMO_COOKIE, session, SESSION_HOURS * 3600), cookie(SESSION_COOKIE_NAME, '', 0)]);
}

// ---------- making the demo copy ----------

/**
 * Exactly what reaches the demo copy, column by column. Anything not listed under `keep` or
 * `madeUp` is left empty. A test checks every column of these tables is listed here, so a new
 * column can't slip into the demo without someone deciding which list it belongs in.
 * Tables not named here (rent links, settings, ID uploads, phones, reminders) are never copied.
 */
export const DEMO_COLUMNS = {
  units: {
    keep: ['code', 'floor', 'sort', 'rent_free', 'created_at'],
    madeUp: [] as string[],
    blank: ['note'],
  },
  tenancies: {
    keep: ['unit_code', 'start_date', 'end_date', 'base_rent', 'deposit', 'deposit_refund', 'deposit_refunded_on', 'deposit_maintenance', 'bill_from', 'next_increase_on', 'created_at', 'updated_at'],
    madeUp: ['id', 'contact_name', 'phone', 'whatsapp'],
    blank: ['notes'],
  },
  people: {
    keep: ['id_type', 'created_at'],
    madeUp: ['id', 'tenancy_id', 'name'],
    blank: ['address', 'drive_file_id', 'drive_file_name', 'id_uploaded_at', 'back_file_id', 'back_file_name'],
  },
  payments: {
    keep: ['amount', 'paid_on', 'method', 'test', 'created_at'],
    madeUp: ['id', 'tenancy_id', 'created_by'],
    blank: ['reference', 'rzp_payment_id', 'note'],
  },
} as const;

const FIRST = ['Arun', 'Bhavna', 'Chetan', 'Divya', 'Eshwar', 'Farah', 'Girish', 'Harini', 'Imran', 'Jyothi', 'Kiran', 'Lavanya', 'Manoj', 'Nandini', 'Omkar', 'Pooja', 'Rakesh', 'Shalini', 'Tarun', 'Uma', 'Varun', 'Yamini', 'Zubair', 'Sanjay', 'Rekha'];
const LAST = ['Rao', 'Shetty', 'Nair', 'Gowda', 'Iyer', 'Reddy', 'Pillai', 'Hegde', 'Menon', 'Khan', 'Joshi', 'Bhat'];
/** The n-th made-up name. 25 first names × 12 surnames never repeat before 300. */
const madeUpName = (n: number) => `${FIRST[n % FIRST.length]} ${LAST[n % LAST.length]}${n >= 300 ? ` ${Math.floor(n / 300) + 1}` : ''}`;

type Row = Record<string, unknown>;
interface SchemaItem {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const internal = (name: string) => /^(sqlite_|_cf_|d1_)/i.test(name);

/** The app's own tables and indexes (not SQLite's or Cloudflare's). */
async function schemaOf(db: D1Database): Promise<SchemaItem[]> {
  const rows = (await db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL').all<SchemaItem>()).results;
  return rows
    .filter((r) => (r.type === 'table' || r.type === 'index') && !internal(r.name) && !internal(r.tbl_name))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'table' ? -1 : 1));
}

/** Tables ordered so that one is always emptied before the tables it points to. */
function childrenFirst(tables: SchemaItem[]): string[] {
  const names = new Set(tables.map((t) => t.name));
  const refs = new Map(
    tables.map((t) => [t.name, new Set([...t.sql.matchAll(/REFERENCES\s+["'`[]?(\w+)/gi)].map((m) => m[1]).filter((n) => n !== t.name && names.has(n)))])
  );
  const out: string[] = [];
  const left = new Set(names);
  while (left.size) {
    // Next: any table that nothing still waiting points to.
    const free = [...left].filter((n) => ![...left].some((other) => other !== n && refs.get(other)!.has(n)));
    for (const n of free.length ? free : [...left]) {
      out.push(n);
      left.delete(n);
    }
  }
  return out;
}

/** Rows go in as one JSON list per statement: D1 allows few statements and few bound values per call. */
function insertRows(db: D1Database, table: string, columns: readonly string[], rows: unknown[][]): D1PreparedStatement[] {
  const select = columns.map((_, i) => `json_extract(value, '$[${i}]')`).join(', ');
  const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) SELECT ${select} FROM json_each(?)`;
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 1000) out.push(db.prepare(sql).bind(JSON.stringify(rows.slice(i, i + 1000))));
  return out;
}

/**
 * Refuses to go on if DB_DEMO is really the live database (say the wrong Database ID was pasted
 * into wrangler.jsonc): making or emptying the "copy" would then wipe the real data.
 * The real database carries a random marker in its settings; the demo copy never has settings.
 */
const MARKER = 'database_marker';
async function assertSeparate(real: D1Database, demo: D1Database, demoSchema: SchemaItem[]) {
  if (real === demo) throw new ValidationError('DB_DEMO is the real database. Nothing was changed.');
  let marker = await getSetting(real, MARKER);
  if (!marker) {
    marker = crypto.randomUUID();
    await setSetting(real, MARKER, marker);
  }
  if (!demoSchema.some((s) => s.type === 'table' && s.name === 'settings')) return; // brand new: can't be the real one
  if ((await getSetting(demo, MARKER)) === marker) throw new ValidationError('DB_DEMO points at the real database. Nothing was changed: fix its Database ID in wrangler.jsonc.');
}

async function emptyDemo(real: D1Database, demo: D1Database) {
  const schema = await schemaOf(demo);
  await assertSeparate(real, demo, schema);
  const tables = schema.filter((s) => s.type === 'table');
  if (!tables.length) return;
  await demo.batch([demo.prepare('PRAGMA defer_foreign_keys = ON'), ...childrenFirst(tables).map((t) => demo.prepare(`DELETE FROM ${quote(t)}`))]);
}

/**
 * Rebuilds the demo database from the real one: same tables, and the rows listed in DEMO_COLUMNS
 * with made-up names, phone numbers and record IDs. Everything already in the demo is replaced.
 */
export async function copyToDemo(real: D1Database, demo: D1Database) {
  // D1's free plan allows 50 queries per request. This uses about 25 (about 40 right after a
  // migration, when the demo's tables are rebuilt), which is why rows go in as JSON lists.
  const [schema, old] = [await schemaOf(real), await schemaOf(demo)];
  await assertSeparate(real, demo, old);
  const tables = schema.filter((s) => s.type === 'table');
  for (const t of Object.keys(DEMO_COLUMNS)) if (!tables.some((s) => s.name === t)) throw new Error(`Table ${t} is missing`);

  const [units, tenancies, people, payments] = (
    await real.batch([
      real.prepare('SELECT * FROM units ORDER BY sort, code'),
      real.prepare('SELECT * FROM tenancies ORDER BY created_at, id'),
      real.prepare('SELECT * FROM people ORDER BY created_at, id'),
      real.prepare('SELECT * FROM payments ORDER BY paid_on, created_at, id'),
    ])
  ).map((r) => r.results as Row[]);

  // The same real person always gets the same made-up name, so a tenant and their entry under
  // "People" still match. Likewise phone numbers.
  // A made-up name is never one that a real tenant happens to have.
  const tidy = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const realNames = new Set([...tenancies.map((t) => tidy(t.contact_name)), ...people.map((p) => tidy(p.name))]);
  const names = new Map<string, string>();
  let next = 0;
  const nameFor = (real: unknown) => {
    const key = tidy(real);
    if (!names.has(key)) {
      let name = madeUpName(next++);
      while (realNames.has(tidy(name))) name = madeUpName(next++);
      names.set(key, name);
    }
    return names.get(key)!;
  };
  const phones = new Map<string, string>();
  const phoneFor = (real: unknown) => {
    const key = String(real ?? '').trim();
    if (!key) return null;
    if (!phones.has(key)) phones.set(key, `90000${String(10001 + phones.size)}`);
    return phones.get(key)!;
  };
  const tenancyIds = new Map<string, string>();

  const madeUp: Record<keyof typeof DEMO_COLUMNS, (row: Row) => Row> = {
    units: () => ({}),
    tenancies: (r) => {
      const id = crypto.randomUUID();
      tenancyIds.set(String(r.id), id);
      return { id, contact_name: nameFor(r.contact_name), phone: phoneFor(r.phone), whatsapp: phoneFor(r.whatsapp) };
    },
    people: (r) => ({ id: crypto.randomUUID(), tenancy_id: tenancyIds.get(String(r.tenancy_id)), name: nameFor(r.name) }),
    payments: (r) => ({ id: crypto.randomUUID(), tenancy_id: tenancyIds.get(String(r.tenancy_id)), created_by: 'demo' }),
  };
  const source = { units, tenancies, people, payments };

  const sameTables = JSON.stringify(schema.map((s) => [s.name, s.sql])) === JSON.stringify(old.map((s) => [s.name, s.sql]));
  const oldTables = childrenFirst(old.filter((s) => s.type === 'table'));
  const statements: D1PreparedStatement[] = [demo.prepare('PRAGMA defer_foreign_keys = ON')];
  if (sameTables) {
    for (const t of oldTables) statements.push(demo.prepare(`DELETE FROM ${quote(t)}`));
  } else {
    for (const t of oldTables) statements.push(demo.prepare(`DROP TABLE IF EXISTS ${quote(t)}`));
    for (const s of schema) statements.push(demo.prepare(s.sql));
  }
  for (const table of Object.keys(DEMO_COLUMNS) as (keyof typeof DEMO_COLUMNS)[]) {
    const { keep, madeUp: made } = DEMO_COLUMNS[table];
    const columns = [...keep, ...made];
    const rows = source[table].map((r) => {
      const fresh = madeUp[table](r);
      return columns.map((c) => ((made as readonly string[]).includes(c) ? fresh[c] : r[c]) ?? null);
    });
    statements.push(...insertRows(demo, table, columns, rows));
  }
  await demo.batch(statements);
  return { units: units.length, tenancies: tenancies.length, people: people.length, payments: payments.length };
}
