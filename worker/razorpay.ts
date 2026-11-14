import type { D1Database, Env } from './env';
import { buildLedger, monthLabel } from './rent.ts';
import { NotFoundError, ValidationError, getSetting, getTenancy, recordRazorpayPayment } from './db.ts';

// Razorpay Payment Links over plain fetch (Razorpay's Node SDK doesn't run on Workers).
// The app creates a link for what the tenant owes; you send it from your phone with one tap
// (WhatsApp or SMS). When the tenant pays, Razorpay calls our webhook and the payment is
// recorded automatically. A daily check catches anything the webhook missed.
//
// Each link also gets a UPI QR code from Razorpay for the same amount (Razorpay › QR Codes),
// for a tenant who would rather scan than open a link. The link and the QR are two ways to pay
// the same rent: when one is paid the other is closed, so it can't be paid twice.
// QR codes have to be switched on by Razorpay for the account. Until then (or if making one
// fails for any reason) the link works exactly as before, just without a QR.

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
  qr_id: string | null;
  qr_image_url: string | null;
  qr_status: string | null;
}

// ---------- QR code that goes with a link ----------

/**
 * Makes the QR for a link if it doesn't have a working one. Never throws: a QR is an extra.
 * It is "multiple use, fixed amount" because Razorpay's one-time QR codes close after 2 hours
 * at most, and rent is often paid days after the message. We close it ourselves once paid.
 */
async function ensureQr(env: Env, db: D1Database, link: LinkRow, unit: string): Promise<{ qr: { imageUrl: string } | null; qrError: string | null }> {
  if (link.qr_id && link.qr_status === 'active' && link.qr_image_url) return { qr: { imageUrl: link.qr_image_url }, qrError: null };
  try {
    const made = await rzp(env, '/payments/qr_codes', {
      method: 'POST',
      body: JSON.stringify({
        type: 'upi_qr',
        name: `Rent ${unit}`.slice(0, 40),
        usage: 'multiple_use',
        fixed_amount: true,
        payment_amount: link.amount * 100,
        description: (link.description || `Rent ${unit}`).slice(0, 200),
        notes: { tenancy_id: link.tenancy_id, unit, link_id: link.id, property: PROPERTY },
      }),
    });
    if (!made?.id || !made?.image_url) throw new Error('Razorpay did not return a QR code');
    await db.prepare("UPDATE payment_links SET qr_id = ?, qr_image_url = ?, qr_status = 'active' WHERE id = ?").bind(String(made.id), String(made.image_url), link.id).run();
    link.qr_id = String(made.id);
    link.qr_image_url = String(made.image_url);
    link.qr_status = 'active';
    return { qr: { imageUrl: link.qr_image_url }, qrError: null };
  } catch (e: any) {
    console.error('QR code not made', link.id, e);
    return { qr: null, qrError: String(e?.message || 'Razorpay could not make a QR code').slice(0, 200) };
  }
}

/** Stops a link's QR from taking any (more) money. Safe to call for a link without one. */
async function closeQr(env: Env, db: D1Database, link: LinkRow) {
  if (!link.qr_id || link.qr_status !== 'active') return;
  await rzp(env, `/payments/qr_codes/${encodeURIComponent(link.qr_id)}/close`, { method: 'POST' }).catch((e) => console.error('QR close failed', link.qr_id, e));
  await db.prepare("UPDATE payment_links SET qr_status = 'closed' WHERE id = ?").bind(link.id).run();
  link.qr_status = 'closed';
}

/** Paid by QR: the payment link for the same rent must not be payable any more. */
async function cancelLinkAtRazorpay(env: Env, link: LinkRow) {
  await rzp(env, `/payment_links/${encodeURIComponent(link.id)}/cancel`, { method: 'POST' }).catch((e) => console.error('Cancel failed', link.id, e));
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
  let status = String(data.status || link.status);

  // Not paid through the link: was its QR code scanned and paid?
  if (status === 'created' && link.qr_id && link.qr_status === 'active') {
    const scans: any = await rzp(env, `/payments/qr_codes/${encodeURIComponent(link.qr_id)}/payments?count=10`).catch((e) => {
      console.error('QR check failed', link.qr_id, e);
      return null;
    });
    let paidByQr = false;
    for (const p of scans?.items || []) {
      if (p.status !== 'captured' || !p.id) continue;
      paidByQr = true;
      await recordRazorpayPayment(db, {
        tenancyId: link.tenancy_id,
        amount: Math.round(Number(p.amount) / 100),
        paidOn: istDate(Number(p.created_at) || Date.now() / 1000),
        paymentId: String(p.id),
        linkId: link.id,
        test: Boolean(link.test),
      });
    }
    if (paidByQr) {
      await cancelLinkAtRazorpay(env, link);
      status = 'paid';
    }
  }

  if (status !== link.status) await db.prepare('UPDATE payment_links SET status = ? WHERE id = ?').bind(status, link.id).run();
  if (status !== 'created') await closeQr(env, db, link); // paid, cancelled or expired: the QR goes too
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

function describe(unit: string, periods: { month: string; rent: number; paid: number; ended: boolean }[]) {
  const unpaid = periods.filter((p) => p.ended && p.paid < p.rent);
  const first = monthLabel(unpaid[0].month);
  const last = monthLabel(unpaid[unpaid.length - 1].month);
  return unpaid.length === 1 ? `Rent ${unit} · ${first}` : `Rent ${unit} · ${first} to ${last} (${unpaid.length} months)`;
}

export interface Upi {
  id: string;
  name: string | null;
}

/** The owner's own UPI ID for direct (fee-free) payments, set in Settings. */
export async function getUpi(db: D1Database): Promise<Upi | null> {
  const id = await getSetting(db, 'upi_id');
  return id ? { id, name: await getSetting(db, 'upi_name') } : null;
}

export function messageFor(name: string, unit: string, amount: number, description: string, url: string | null, upi: Upi | null = null) {
  const firstName = name.split(/\s+/)[0];
  const lines = [`Hello ${firstName}, this is your rent reminder for ${unit}, ${PROPERTY}.`, `${description}: ₹${amount.toLocaleString('en-IN')}`];
  if (url) lines.push(`Pay here: ${url}`);
  if (upi) lines.push(`${url ? 'Or pay' : 'Please pay'} by UPI to ${upi.id}${upi.name ? ` (${upi.name})` : ''} and send the screenshot.`);
  lines.push('Thank you.');
  return lines.join('\n');
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
  const rzpOn = razorpayStatus(env).configured;
  const upi = await getUpi(db);
  if (!rzpOn && !upi) {
    throw new ValidationError('Connect Razorpay, or add your UPI ID in Settings › Direct UPI payments, to send rent messages.');
  }
  const t = await getTenancy(db, tenancyId);
  if (!t.whatsapp && !t.phone) throw new ValidationError('Add the tenant’s WhatsApp or phone number first');

  // Catch any payment the webhook hasn't told us about before working out what's owed.
  if (rzpOn) {
    const open = (await db.prepare("SELECT * FROM payment_links WHERE tenancy_id = ? AND status = 'created' ORDER BY created_at DESC").bind(t.id).all<LinkRow>()).results;
    for (const l of open) await syncLink(env, db, l).catch((e) => console.error('Link check failed', e));
  }

  const paidRow = await db.prepare('SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE tenancy_id = ?').bind(t.id).first<{ paid: number }>();
  const ledger = buildLedger(t, paidRow?.paid || 0, today);
  // Post-paid: ask for every month that has ended and isn't fully paid (this month is collected after it ends).
  const amount = ledger.collectable;
  if (amount <= 0) {
    const running = ledger.periods.find((p) => !p.ended);
    throw new ValidationError(
      running ? `Nothing to collect yet. ${monthLabel(running.month)} rent can be collected once the month ends.` : 'Nothing to collect for this tenant'
    );
  }
  const description = describe(t.unit_code, ledger.periods);
  const test = isTest(env);

  // No Razorpay: a UPI-only message. A row is still kept so "sent" is tracked like any link.
  if (!rzpOn) {
    const id = `upi_${crypto.randomUUID()}`;
    await db
      .prepare("INSERT INTO payment_links (id, tenancy_id, amount, description, short_url, status, test) VALUES (?, ?, ?, ?, '', 'upi', 0)")
      .bind(id, t.id, amount, description)
      .run();
    const link = (await db.prepare('SELECT * FROM payment_links WHERE id = ?').bind(id).first<LinkRow>())!;
    const message = messageFor(t.contact_name, t.unit_code, amount, description, null, upi);
    return { link, amount, description, message, test: false, upiOnly: true, ...shareLinks(t.whatsapp, t.phone, message) };
  }

  const stillOpen = (await db.prepare("SELECT * FROM payment_links WHERE tenancy_id = ? AND status = 'created' ORDER BY created_at DESC").bind(t.id).all<LinkRow>()).results;
  let link = stillOpen.find((l) => l.amount === amount && Boolean(l.test) === test) || null;
  for (const l of stillOpen) {
    if (l === link) continue;
    await rzp(env, `/payment_links/${encodeURIComponent(l.id)}/cancel`, { method: 'POST' }).catch((e) => console.error('Cancel failed', e));
    await db.prepare("UPDATE payment_links SET status = 'cancelled' WHERE id = ?").bind(l.id).run();
    await closeQr(env, db, l);
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

  const { qr, qrError } = await ensureQr(env, db, link, t.unit_code);
  const message = messageFor(t.contact_name, t.unit_code, amount, description, link.short_url, upi);
  return { link, amount, description, message, test, upiOnly: false, qr, qrError, ...shareLinks(t.whatsapp, t.phone, message) };
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

  // A QR code that goes with one of our links was scanned and paid.
  const qrEntity = event?.payload?.qr_code?.entity;
  if (qrEntity?.id) {
    if (event.event !== 'qr_code.credited') return new Response('ok');
    const qrLink = await db.prepare('SELECT * FROM payment_links WHERE qr_id = ?').bind(String(qrEntity.id)).first<LinkRow>();
    const pay = event?.payload?.payment?.entity;
    if (!qrLink || !pay?.id) return new Response('ok'); // a QR made outside this app
    if (pay.status && pay.status !== 'captured') return new Response('ok');
    await recordRazorpayPayment(db, {
      tenancyId: qrLink.tenancy_id,
      amount: Math.round(Number(pay.amount) / 100),
      paidOn: istDate(Number(pay.created_at) || Date.now() / 1000),
      paymentId: String(pay.id),
      linkId: qrLink.id,
      test: Boolean(qrLink.test),
    });
    if (qrLink.status === 'created') {
      await db.prepare("UPDATE payment_links SET status = 'paid' WHERE id = ?").bind(qrLink.id).run();
      await cancelLinkAtRazorpay(env, qrLink);
    }
    await closeQr(env, db, qrLink);
    return new Response('ok');
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
    await closeQr(env, db, link); // paid by link: the QR for the same rent is closed
  } else if (event.event === 'payment_link.cancelled' || event.event === 'payment_link.expired') {
    // (When we cancel a link because its QR was paid, it is already 'paid' here: leave it.)
    if (link.status === 'created') await db.prepare('UPDATE payment_links SET status = ? WHERE id = ?').bind(event.event.split('.')[1], link.id).run();
    await closeQr(env, db, link);
  }
  return new Response('ok');
}
