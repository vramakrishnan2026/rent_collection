import type { D1Database, Env } from './env';
import { buildLedger, monthLabel } from './rent.ts';
import { NotFoundError, ValidationError, getTenancy, recordRazorpayPayment } from './db.ts';

// Razorpay Payment Links over plain fetch (Razorpay's Node SDK doesn't run on Workers).
// The app creates a link for what the tenant owes; you send it from your phone with one tap
// (WhatsApp or SMS). When the tenant pays, Razorpay calls our webhook and the payment is
// recorded automatically. A daily check catches anything the webhook missed.

const API = 'https://api.razorpay.com/v1';
export const WEBHOOK_PATH = '/api/razorpay/webhook';
const PROPERTY = 'Challaghatta Home';

export function razorpayStatus(env: Env) {
  const configured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  return {
    configured,
    mode: env.RAZORPAY_KEY_ID?.startsWith('rzp_live_') ? 'live' : 'test',
    webhook: Boolean(env.RAZORPAY_WEBHOOK_SECRET),
  };
}

const isTest = (env: Env) => !env.RAZORPAY_KEY_ID?.startsWith('rzp_live_');

async function rzp(env: Env, path: string, init: RequestInit = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.description || `Razorpay error ${res.status}`);
  return data;
}

export interface LinkRow {
  id: string;
  tenancy_id: string;
  amount: number;
  description: string | null;
  short_url: string;
  status: string;
  test: number;
  sent_at: string | null;
  sent_via: string | null;
  created_at: string;
}

/** Epoch seconds → India date. */
const istDate = (epochSeconds: number) => new Date(epochSeconds * 1000 + 330 * 60_000).toISOString().slice(0, 10);

/** Asks Razorpay about one link and records any payment on it. */
export async function syncLink(env: Env, db: D1Database, link: LinkRow): Promise<string> {
  const data = await rzp(env, `/payment_links/${encodeURIComponent(link.id)}`);
  for (const p of data.payments || []) {
    if (p.status !== 'captured') continue;
    await recordRazorpayPayment(db, {
      tenancyId: link.tenancy_id,
      amount: Math.round(Number(p.amount) / 100),
      paidOn: istDate(Number(p.created_at) || Date.now() / 1000),
      paymentId: String(p.payment_id),
      linkId: link.id,
      test: Boolean(link.test),
    });
  }
  const status = String(data.status || link.status);
  if (status !== link.status) await db.prepare('UPDATE payment_links SET status = ? WHERE id = ?').bind(status, link.id).run();
  return status;
}

/** Checks every unpaid link from the last 60 days (run daily by the cron). */
export async function syncOpenLinks(env: Env, db: D1Database) {
  if (!razorpayStatus(env).configured) return { checked: 0 };
  const cutoff = new Date(Date.now() - 60 * 86400_000).toISOString();
  const links = (await db.prepare("SELECT * FROM payment_links WHERE status = 'created' AND created_at >= ?").bind(cutoff).all<LinkRow>()).results;
  let paid = 0;
  for (const l of links) {
    try {
      if ((await syncLink(env, db, l)) === 'paid') paid++;
    } catch (e) {
      console.error('Link check failed', l.id, e);
    }
  }
  return { checked: links.length, paid };
}

function describe(unit: string, periods: { due: string; status: string }[], nextDue: string | null) {
  const unpaid = periods.filter((p) => p.status !== 'paid');
  if (!unpaid.length) return `Rent ${unit} · ${nextDue ? monthLabel(nextDue) : 'advance'}`;
  const first = monthLabel(unpaid[0].due);
  const last = monthLabel(unpaid[unpaid.length - 1].due);
  return unpaid.length === 1 ? `Rent ${unit} · ${first}` : `Rent ${unit} · ${first} to ${last} (${unpaid.length} months)`;
}

export function messageFor(name: string, unit: string, amount: number, description: string, url: string) {
  const firstName = name.split(/\s+/)[0];
  return `Hello ${firstName}, this is your rent reminder for ${unit}, ${PROPERTY}.\n${description}: ₹${amount.toLocaleString('en-IN')}\nPay here: ${url}\nThank you.`;
}

export function shareLinks(whatsapp: string | null, phone: string | null, message: string) {
  return {
    whatsappUrl: whatsapp ? `https://wa.me/91${whatsapp}?text=${encodeURIComponent(message)}` : null,
    smsUrl: phone || whatsapp ? `sms:+91${phone || whatsapp}?body=${encodeURIComponent(message)}` : null,
  };
}

/**
 * The payment link for what this tenant owes right now (or next month's rent if nothing is due).
 * Reuses the last unpaid link if the amount hasn't changed; otherwise cancels it and makes a new one.
 */
export async function linkForTenancy(env: Env, db: D1Database, tenancyId: string, today: string) {
  if (!razorpayStatus(env).configured) {
    throw new ValidationError('Razorpay isn’t connected yet. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the Worker’s settings.');
  }
  const t = await getTenancy(db, tenancyId);
  if (!t.whatsapp && !t.phone) throw new ValidationError('Add the tenant’s WhatsApp or phone number first');

  // Catch any payment the webhook hasn't told us about before working out what's owed.
  const open = (await db.prepare("SELECT * FROM payment_links WHERE tenancy_id = ? AND status = 'created' ORDER BY created_at DESC").bind(t.id).all<LinkRow>()).results;
  for (const l of open) await syncLink(env, db, l).catch((e) => console.error('Link check failed', e));

  const paidRow = await db.prepare('SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE tenancy_id = ?').bind(t.id).first<{ paid: number }>();
  const ledger = buildLedger(t, paidRow?.paid || 0, today);
  const amount = ledger.outstanding > 0 ? ledger.outstanding : ledger.nextRent;
  if (!amount || amount <= 0) throw new ValidationError('Nothing to collect for this tenant');
  const description = describe(t.unit_code, ledger.periods, ledger.nextDueDate);
  const test = isTest(env);

  const stillOpen = (await db.prepare("SELECT * FROM payment_links WHERE tenancy_id = ? AND status = 'created' ORDER BY created_at DESC").bind(t.id).all<LinkRow>()).results;
  let link = stillOpen.find((l) => l.amount === amount && Boolean(l.test) === test) || null;
  for (const l of stillOpen) {
    if (l === link) continue;
    await rzp(env, `/payment_links/${encodeURIComponent(l.id)}/cancel`, { method: 'POST' }).catch((e) => console.error('Cancel failed', e));
    await db.prepare("UPDATE payment_links SET status = 'cancelled' WHERE id = ?").bind(l.id).run();
  }

  if (!link) {
    const contact = t.phone || t.whatsapp;
    const created = await rzp(env, '/payment_links', {
      method: 'POST',
      body: JSON.stringify({
        amount: amount * 100,
        currency: 'INR',
        accept_partial: false,
        description,
        customer: { name: t.contact_name, contact: `+91${contact}` },
        notify: { sms: false, email: false }, // you send it yourself on WhatsApp/SMS
        reminder_enable: false,
        reference_id: `${t.unit_code}-${today.replace(/-/g, '')}-${crypto.randomUUID().slice(0, 6)}`,
        notes: { tenancy_id: t.id, unit: t.unit_code, property: PROPERTY },
      }),
    });
    await db
      .prepare('INSERT INTO payment_links (id, tenancy_id, amount, description, short_url, status, test) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(created.id, t.id, amount, description, created.short_url, 'created', test ? 1 : 0)
      .run();
    link = (await db.prepare('SELECT * FROM payment_links WHERE id = ?').bind(created.id).first<LinkRow>())!;
  }

  const message = messageFor(t.contact_name, t.unit_code, amount, description, link.short_url);
  return { link, amount, description, message, test, ...shareLinks(t.whatsapp, t.phone, message) };
}

export async function markSent(db: D1Database, linkId: string, via: string) {
  const v = via === 'sms' ? 'sms' : 'whatsapp';
  const res = await db.prepare('UPDATE payment_links SET sent_at = ?, sent_via = ? WHERE id = ?').bind(new Date().toISOString(), v, linkId).run();
  if (!Number((res.meta as any)?.changes || 0)) throw new NotFoundError('Link not found');
}

export async function refreshLink(env: Env, db: D1Database, linkId: string) {
  const link = await db.prepare('SELECT * FROM payment_links WHERE id = ?').bind(linkId).first<LinkRow>();
  if (!link) throw new NotFoundError('Link not found');
  return { status: await syncLink(env, db, link) };
}

// ---------- webhook ----------

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function signatureFor(secret: string, body: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
}

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Razorpay → us. Only signed calls are accepted. */
export async function handleWebhook(request: Request, env: Env, db: D1Database): Promise<Response> {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return new Response('Webhook secret not set', { status: 503 });
  const body = await request.text();
  const given = request.headers.get('X-Razorpay-Signature') || '';
  if (!sameString(await signatureFor(env.RAZORPAY_WEBHOOK_SECRET, body), given)) {
    return new Response('Bad signature', { status: 401 });
  }
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  const linkEntity = event?.payload?.payment_link?.entity;
  if (!linkEntity?.id) return new Response('ok'); // not a payment-link event: ignore
  const link = await db.prepare('SELECT * FROM payment_links WHERE id = ?').bind(String(linkEntity.id)).first<LinkRow>();
  if (!link) return new Response('ok'); // a link made outside this app

  if (event.event === 'payment_link.paid') {
    const pay = event?.payload?.payment?.entity;
    if (pay?.id) {
      await recordRazorpayPayment(db, {
        tenancyId: link.tenancy_id,
        amount: Math.round(Number(pay.amount) / 100),
        paidOn: istDate(Number(pay.created_at) || Date.now() / 1000),
        paymentId: String(pay.id),
        linkId: link.id,
        test: Boolean(link.test),
      });
    }
    await db.prepare("UPDATE payment_links SET status = 'paid' WHERE id = ?").bind(link.id).run();
  } else if (event.event === 'payment_link.cancelled' || event.event === 'payment_link.expired') {
    await db.prepare('UPDATE payment_links SET status = ? WHERE id = ?').bind(event.event.split('.')[1], link.id).run();
  }
  return new Response('ok');
}
