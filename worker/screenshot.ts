import type { Env } from './env';
import { ValidationError, overview, recordPayment, str } from './db.ts';
import { ROOT, accessToken, ensureFolder, uploadFile } from './drive.ts';
import { bestMatch } from './ids.ts';
import { getUpi } from './razorpay.ts';

// UPI payment screenshots (owner only). The vision model reads amount, date, UTR/reference, payer and payee.
// The payment is recorded straight away only when everything checks out:
//   - the payment succeeded,
//   - the tenant is clear (the one chosen, or a unique name/amount match),
//   - the UTR hasn't been recorded before,
//   - it went to the owner's UPI ID (when that's set and the screenshot shows the payee),
//   - the date is sensible (not in the future, within the last 90 days).
// Otherwise the owner gets the Record payment form, pre-filled, with the reason.

const PRIMARY = '@cf/meta/llama-4-scout-17b-16e-instruct';
const FALLBACK = '@cf/meta/llama-3.2-11b-vision-instruct';
const MAX_BYTES = 10 * 1024 * 1024;
const SHOTS = 'Payment screenshots';

export interface ReadPayment {
  status: 'success' | 'failed' | 'pending' | null;
  amount: number | null;
  date: string | null; // YYYY-MM-DD
  utr: string | null;
  payer: string | null;
  payee: string | null; // UPI ID or name the money went to
}

const PROMPT = `This is a screenshot of a UPI / bank payment in India (Google Pay, PhonePe, Paytm, BHIM or a bank app).
Read it and reply with ONLY this JSON:
{"status":"success|failed|pending","amount":<rupees as a number>,"date":"YYYY-MM-DD","utr":"<UPI transaction ID / UTR / reference number>","payer":"<name of the person who paid>","payee":"<UPI ID it was paid to, or the payee name if no UPI ID is shown>"}
Use null for anything not shown. The UTR is usually a 12-digit number labelled UPI Ref No, UTR, UPI transaction ID or Reference.`;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');

/** Dates come back in many shapes: 2026-11-03, 03/11/2026, 3 Nov 2026, Nov 3, 2026. */
export function cleanDate(raw: unknown, today: string): string | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'null') return null;
  let y: number, m: number, d: number;
  let r = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])]; // Indian order: d/m/y
  else if ((r = s.match(/(\d{1,2})\s*([a-z]{3})[a-z]*,?\s*(\d{4})?/)) && MONTHS[r[2]]) [d, m, y] = [Number(r[1]), MONTHS[r[2]], Number(r[3] || today.slice(0, 4))];
  else if ((r = s.match(/([a-z]{3})[a-z]*\s+(\d{1,2}),?\s*(\d{4})?/)) && MONTHS[r[1]]) [m, d, y] = [MONTHS[r[1]], Number(r[2]), Number(r[3] || today.slice(0, 4))];
  else return null;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const out = `${y}-${pad(m)}-${pad(d)}`;
  return isNaN(Date.parse(out)) ? null : out;
}

export function cleanAmount(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/[₹,\s]|rs\.?|inr/gi, ''));
  return Number.isFinite(n) && n > 0 && n < 10_000_000 ? Math.round(n) : null;
}

export function cleanUtr(raw: unknown): string | null {
  const s = String(raw ?? '').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9]{8,35}$/.test(s) && /\d{6}/.test(s) ? s : null;
}

export function readFromReply(reply: any, today: string): ReadPayment | null {
  const out = typeof reply === 'string' ? reply : reply?.response ?? reply?.result?.response ?? reply;
  let o: any = out && typeof out === 'object' ? out : null;
  if (!o && typeof out === 'string') {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        o = JSON.parse(m[0]);
      } catch {
        o = null;
      }
    }
  }
  if (!o) return null;
  const st = String(o.status ?? '').toLowerCase();
  const name = (v: unknown) => {
    const t = String(v ?? '').trim();
    return t && t.toLowerCase() !== 'null' ? t.slice(0, 80) : null;
  };
  return {
    status: /success|paid|complete|debited|credited/.test(st) ? 'success' : /fail|declin/.test(st) ? 'failed' : /pend|process/.test(st) ? 'pending' : null,
    amount: cleanAmount(o.amount),
    date: cleanDate(o.date, today),
    utr: cleanUtr(o.utr),
    payer: name(o.payer),
    payee: name(o.payee),
  };
}

async function readScreenshot(env: Env, imageBase64: string, today: string): Promise<ReadPayment | null> {
  if (!env.AI) return null;
  const image = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
  try {
    const reply = await env.AI.run(PRIMARY, {
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: image } }] }],
      max_tokens: 300,
      temperature: 0,
    });
    const r = readFromReply(reply, today);
    if (r && (r.amount || r.utr)) return r;
  } catch (e) {
    console.error('Screenshot read failed (primary)', e);
  }
  try {
    const reply = await env.AI.run(FALLBACK, { messages: [{ role: 'user', content: PROMPT }], image, max_tokens: 300, temperature: 0 });
    return readFromReply(reply, today);
  } catch (e) {
    console.error('Screenshot read failed (fallback)', e);
    return null;
  }
}

const same = (a: string, b: string) => a.toLowerCase().replace(/\s+/g, '') === b.toLowerCase().replace(/\s+/g, '');

export async function handleScreenshot(request: Request, env: Env, email: string, today: string) {
  const form = await request.formData().catch(() => null);
  if (!form) throw new ValidationError('Send the screenshot as a form upload');
  const photo = form.get('photo');
  if (!photo || typeof photo === 'string') throw new ValidationError('No screenshot attached');
  const blob = photo as Blob;
  if (blob.size > MAX_BYTES) throw new ValidationError('That file is over 10 MB');
  const preview = String(form.get('preview') || '');
  if (preview.length < 100) throw new ValidationError('Use a photo or screenshot (PDFs can’t be read)');
  const chosen = str(form.get('tenancy_id'), 60) || null;

  const read = await readScreenshot(env, preview, today);
  const { units, former } = await overview(env.DB, today);
  const tenants = [...units.filter((u) => u.tenancy).map((u) => u.tenancy!), ...former];
  const people = (await env.DB.prepare('SELECT id, tenancy_id, name FROM people').all<{ id: string; tenancy_id: string; name: string }>()).results;

  // Which tenant? The one chosen; else a full-name match on the payer; else a unique amount match.
  let tenant = chosen ? tenants.find((t) => t.id === chosen) || null : null;
  if (!tenant && read?.payer) {
    const candidates = [
      ...tenants.map((t) => ({ id: t.id, name: t.contact_name })),
      ...people.filter((p) => tenants.some((t) => t.id === p.tenancy_id)).map((p) => ({ id: p.tenancy_id, name: p.name })),
    ];
    const ids = new Set(candidates.filter((c) => bestMatch(read.payer!, [c]) === c.id).map((c) => c.id));
    if (ids.size === 1) tenant = tenants.find((t) => t.id === [...ids][0]) || null;
  }
  if (!tenant && read?.amount) {
    const byAmount = tenants.filter((t) => t.collectable === read.amount || (t.outstanding > 0 && t.outstanding === read.amount) || t.owedThroughEnd === read.amount);
    if (byAmount.length === 1) tenant = byAmount[0];
  }

  // Keep the screenshot as proof (best effort: only if Google Drive is linked).
  let fileId: string | null = null;
  try {
    const token = await accessToken(env);
    const root = await ensureFolder(token, ROOT);
    const folder = await ensureFolder(token, SHOTS, root);
    const month = await ensureFolder(token, today.slice(0, 7), folder);
    const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
    const name = `${tenant ? tenant.unit_code + ' - ' : ''}${read?.date || today} - ₹${read?.amount ?? '?'}${read?.utr ? ' - ' + read.utr : ''}.${type === 'image/png' ? 'png' : 'jpg'}`;
    fileId = (await uploadFile(token, { name, mimeType: type, parents: [month] }, blob)).id;
  } catch (e) {
    console.log('Screenshot not saved to Drive', String(e));
  }

  // Every check that must pass before recording on its own.
  const upi = await getUpi(env.DB);
  const reasons: string[] = [];
  if (!read) reasons.push('The screenshot couldn’t be read.');
  else {
    if (read.status === 'failed') reasons.push('The screenshot shows a failed payment.');
    else if (read.status === 'pending') reasons.push('The payment is still pending.');
    else if (!read.status) reasons.push('It isn’t clear the payment succeeded.');
    if (!read.amount) reasons.push('The amount couldn’t be read.');
    if (!read.date) reasons.push('The date couldn’t be read.');
    else if (read.date > today) reasons.push('The date is in the future.');
    else if (Date.parse(today) - Date.parse(read.date) > 90 * 86_400_000) reasons.push('The payment is more than 90 days old.');
    if (!read.utr) reasons.push('The UTR / reference number couldn’t be read.');
    else {
      const dup = await env.DB.prepare('SELECT p.paid_on, t.unit_code FROM payments p JOIN tenancies t ON t.id = p.tenancy_id WHERE upper(p.reference) = ?').bind(read.utr).first<{ paid_on: string; unit_code: string }>();
      if (dup) reasons.push(`This UTR is already recorded (${dup.unit_code}, ${dup.paid_on}).`);
    }
    if (upi && read.payee && read.payee.includes('@') && !same(read.payee, upi.id)) reasons.push(`It was paid to ${read.payee}, not your UPI ID ${upi.id}.`);
  }
  if (!tenant) reasons.push('Which tenant paid isn’t clear.');

  if (!reasons.length && read && tenant) {
    const paymentId = await recordPayment(
      env.DB,
      { tenancy_id: tenant.id, amount: read.amount, paid_on: read.date, method: 'upi', reference: read.utr, note: 'From screenshot' },
      email,
      today
    );
    return { recorded: true, paymentId, unit: tenant.unit_code, name: tenant.contact_name, tenancyId: tenant.id, read, fileId };
  }
  return { recorded: false, reasons, unit: tenant?.unit_code ?? null, name: tenant?.contact_name ?? null, tenancyId: tenant?.id ?? null, read, fileId };
}

