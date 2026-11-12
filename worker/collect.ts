import type { Env } from './env';
import { overview, ValidationError } from './db.ts';
import { getVapidKeys, sendPush, type Subscription } from './webpush.ts';
import { monthLabel } from './rent.ts';

// "Send all": the tenants who owe rent for a month that has ended, in unit order, with whether
// their link has been sent since the 1st. Plus phone reminders on the 1st and the 3rd.

export async function collectQueue(env: Env, today: string) {
  const { units } = await overview(env.DB, today);
  const since = today.slice(0, 8) + '01';
  const items = units
    .filter((u) => u.tenancy && !u.rent_free && u.tenancy.collectable > 0)
    .map((u) => {
      const t = u.tenancy!;
      return {
        tenancyId: t.id,
        unit: u.code,
        name: t.contact_name,
        amount: t.collectable,
        overdueMonths: t.pendingMonths,
        hasWhatsapp: Boolean(t.whatsapp),
        hasPhone: Boolean(t.phone || t.whatsapp),
        sentThisMonth: Boolean(t.lastSentAt && t.lastSentAt.slice(0, 10) >= since),
        lastSentAt: t.lastSentAt,
      };
    });
  const [y, m] = today.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return { today, forMonth: monthLabel(prev), items, toSend: items.filter((i) => !i.sentThisMonth).length };
}

// ---------- push subscriptions ----------

export async function pushKey(env: Env) {
  return { publicKey: (await getVapidKeys(env.DB)).publicKey };
}

export async function subscribe(env: Env, email: string, body: any) {
  const endpoint = String(body?.endpoint || '');
  const p256dh = String(body?.keys?.p256dh || '');
  const auth = String(body?.keys?.auth || '');
  if (!endpoint.startsWith('https://') || !p256dh || !auth) throw new ValidationError('That browser subscription is incomplete');
  await env.DB
    .prepare('INSERT INTO push_subscriptions (endpoint, p256dh, auth, email) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, email = excluded.email')
    .bind(endpoint, p256dh, auth, email)
    .run();
}

export async function unsubscribe(env: Env, body: any) {
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(String(body?.endpoint || '')).run();
}

export async function notifyOwners(env: Env, message: { title: string; body: string; url?: string; tag?: string }, origin?: string) {
  const subs = (await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all<Subscription>()).results;
  if (!subs.length) return { sent: 0 };
  const keys = await getVapidKeys(env.DB);
  const subject = origin ? origin : 'mailto:owner@example.com';
  let sent = 0;
  for (const sub of subs) {
    const r = await sendPush(sub, message, keys, subject);
    if (r === 'gone') await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).run();
    if (r === 'ok') {
      sent++;
      await env.DB.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?').bind(new Date().toISOString(), sub.endpoint).run();
    }
  }
  return { sent };
}

/** Runs every morning; sends a reminder on the 1st and (if any are left) on the 3rd. */
export async function rentReminders(env: Env, today: string) {
  const day = Number(today.slice(8));
  if (day !== 1 && day !== 3) return { skipped: true };
  const q = await collectQueue(env, today);
  if (day === 1 && q.items.length) {
    return notifyOwners(env, {
      title: `Rent links ready: ${q.items.length} tenant${q.items.length === 1 ? '' : 's'}`,
      body: `${q.forMonth} rent can be collected. Tap to send the links on WhatsApp.`,
      url: '/#/send',
      tag: 'rent-links',
    });
  }
  const left = q.items.filter((i) => !i.sentThisMonth);
  if (day === 3 && left.length) {
    return notifyOwners(env, {
      title: `Still to send: ${left.length} rent link${left.length === 1 ? '' : 's'}`,
      body: left.map((i) => i.unit).join(', '),
      url: '/#/send',
      tag: 'rent-links',
    });
  }
  return { sent: 0 };
}
