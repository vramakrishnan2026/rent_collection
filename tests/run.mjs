// Run: npm test   (Node 22+, no packages needed)
import assert from 'node:assert/strict';
import { makeD1 } from './d1.mjs';
import { addMonths, buildLedger, financialYear, rentForPeriod, todayIST } from '../worker/rent.ts';
import { makeSession } from '../worker/auth.ts';
import { signatureFor } from '../worker/razorpay.ts';
import worker from '../worker/index.ts';

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name);
    throw e;
  }
};

console.log('Rent rules');
await test('due day keeps the move-in day, or the month end', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonths('2027-12-05', 2), '2028-02-05');
  assert.equal(addMonths('2028-01-30', 1), '2028-02-29');
});
await test('5% every 11 months, compounding, rounded to the rupee', () => {
  assert.equal(rentForPeriod(10000, 0), 10000);
  assert.equal(rentForPeriod(10000, 10), 10000);
  assert.equal(rentForPeriod(10000, 11), 10500);
  assert.equal(rentForPeriod(10000, 21), 10500);
  assert.equal(rentForPeriod(10000, 22), 11025);
  assert.equal(rentForPeriod(10000, 33), 11576);
});
await test('payments clear the oldest month first; part-paid months stay pending', () => {
  const l = buildLedger({ start_date: '2026-01-10', end_date: null, base_rent: 10000 }, 95000, '2026-11-12');
  assert.equal(l.periods.length, 11);
  assert.equal(l.totalDue, 110000);
  assert.equal(l.outstanding, 15000);
  assert.equal(l.pendingMonths, 2);
  assert.equal(l.periods[9].status, 'partial');
  assert.equal(l.periods[10].status, 'pending');
  assert.equal(l.nextDueDate, '2026-12-10');
  assert.equal(l.nextRent, 10500);
  assert.equal(l.nextIncreaseOn, '2026-12-10');
});
await test('no rent after move-out; nothing due before move-in', () => {
  assert.equal(buildLedger({ start_date: '2026-01-10', end_date: '2026-06-10', base_rent: 8000 }, 0, '2026-11-12').periods.length, 5);
  const future = buildLedger({ start_date: '2026-12-01', end_date: null, base_rent: 8000 }, 0, '2026-11-12');
  assert.equal(future.periods.length, 0);
  assert.equal(future.nextDueDate, '2026-12-01');
});
await test('paying ahead shows as credit', () => {
  const l = buildLedger({ start_date: '2026-10-01', end_date: null, base_rent: 8000 }, 24000, '2026-11-12');
  assert.equal(l.outstanding, -8000);
  assert.equal(l.pendingMonths, 0);
});
await test('financial year runs April to March', () => {
  assert.deepEqual(financialYear('2026-11-12'), ['2026-04-01', '2027-03-31']);
  assert.deepEqual(financialYear('2027-02-01'), ['2026-04-01', '2027-03-31']);
});

console.log('App');
const DB = makeD1();
const env = {
  DB,
  ASSETS: { fetch: async () => new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } }) },
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'csecret',
  OWNER_EMAILS: 'owner@gmail.com',
  SECURITY_EMAILS: 'guard@gmail.com',
  RAZORPAY_KEY_ID: 'rzp_test_abc',
  RAZORPAY_KEY_SECRET: 'sek',
  RAZORPAY_WEBHOOK_SECRET: 'whsec',
};
const owner = `cr_session=${await makeSession(env, 'owner@gmail.com')}`;
const guard = `cr_session=${await makeSession(env, 'guard@gmail.com')}`;
const BASE = 'https://rent.example.workers.dev';
const call = async (path, { cookie = owner, method = 'GET', body, headers = {} } = {}) => {
  const res = await worker.fetch(
    new Request(BASE + path, {
      method,
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    }),
    env
  );
  const type = res.headers.get('Content-Type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), res };
};

const today = todayIST();
const start = addMonths(today, -3); // 4 months have fallen due by today

await test('signed-out visitors are sent to sign-in; API says 401', async () => {
  assert.equal((await call('/', { cookie: '' })).status, 302);
  assert.equal((await call('/api/dashboard', { cookie: '' })).status, 401);
});
await test('24 units to start with, G1 to T6', async () => {
  const { body } = await call('/api/units');
  assert.equal(body.units.length, 24);
  assert.deepEqual([body.units[0].code, body.units[6].code, body.units[23].code], ['G1', 'F1', 'T6']);
  assert.ok(body.units.every((u) => u.status === 'vacant'));
});
let tid;
await test('add a tenant with the people living there', async () => {
  const r = await call('/api/tenancies', {
    method: 'POST',
    body: { unit_code: 'G1', contact_name: 'Ravi Kumar', whatsapp: '+91 98450 12345', start_date: start, base_rent: 12000, deposit: 50000, people: [{ name: 'Ravi Kumar', id_type: 'Aadhaar' }, { name: 'Lata Kumar' }] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  tid = r.body.id;
  const again = await call('/api/tenancies', { method: 'POST', body: { unit_code: 'G1', contact_name: 'X', start_date: start, base_rent: 1 } });
  assert.equal(again.status, 400);
  const bad = await call('/api/tenancies', { method: 'POST', body: { unit_code: 'G2', contact_name: 'X', whatsapp: '12345', start_date: start, base_rent: 1 } });
  assert.match(bad.body.error, /10-digit/);
});
await test('unit page shows rent, months and people', async () => {
  const { body } = await call('/api/units/g1');
  assert.equal(body.current.whatsapp, '9845012345');
  assert.equal(body.current.phone, null);
  assert.equal(body.current.periods.length, 4);
  assert.equal(body.current.pendingMonths, 4);
  assert.equal(body.current.outstanding, 48000);
  assert.equal(body.current.people.length, 2);
});
await test('a part payment clears the oldest month first', async () => {
  const r = await call('/api/payments', { method: 'POST', body: { tenancy_id: tid, amount: 30000, paid_on: today, method: 'upi', reference: 'UTR123' } });
  assert.equal(r.status, 201);
  const { body } = await call('/api/units/G1');
  assert.equal(body.current.outstanding, 18000);
  assert.equal(body.current.pendingMonths, 2);
  const future = await call('/api/payments', { method: 'POST', body: { tenancy_id: tid, amount: 1, paid_on: addMonths(today, 1), method: 'cash' } });
  assert.equal(future.status, 400);
});
await test('security guard sees months pending, never amounts, and nothing else', async () => {
  const { body } = await call('/api/security', { cookie: guard });
  const g1 = body.units.find((u) => u.code === 'G1');
  assert.deepEqual({ status: g1.status, months: g1.months, action: g1.action }, { status: 'pending', months: 2, action: 'Remind tenant' });
  assert.ok(!JSON.stringify(body).includes('18000'));
  assert.equal((await call('/api/dashboard', { cookie: guard })).status, 403);
  assert.equal((await call('/api/units', { cookie: guard })).status, 403);
  assert.equal((await call('/api/payments', { cookie: guard, method: 'POST', body: {} })).status, 403);
});
await test('rent-free unit for the security guard', async () => {
  assert.equal((await call('/api/units/T6', { method: 'PUT', body: { rent_free: true, note: 'Security' } })).status, 200);
  const r = await call('/api/tenancies', { method: 'POST', body: { unit_code: 'T6', contact_name: 'Guard', start_date: start, base_rent: 9000 } });
  assert.equal(r.status, 201);
  const { body } = await call('/api/security', { cookie: guard });
  assert.equal(body.units.find((u) => u.code === 'T6').status, 'free');
});
await test('new units can be added', async () => {
  assert.equal((await call('/api/units', { method: 'POST', body: { code: 'g7', floor: 'Ground' } })).status, 201);
  assert.equal((await call('/api/units', { method: 'POST', body: { code: 'G7', floor: 'Ground' } })).status, 400);
  const { body } = await call('/api/units');
  assert.equal(body.units.length, 25);
  assert.equal(body.units[6].code, 'G7');
});
await test('dashboard: collected this month and year, pending, deposits', async () => {
  const { body } = await call('/api/dashboard');
  assert.equal(body.collected.mtd, 30000);
  assert.equal(body.collected.ytd, 30000);
  assert.equal(body.pendingTotal, 18000);
  assert.equal(body.pendingUnits, 1);
  assert.equal(body.depositsHeld, 50000);
  assert.equal(body.rentableUnits, 24);
  assert.equal(body.occupied, 1);
  assert.equal(body.pending[0].unit, 'G1');
  assert.equal(body.pending[0].months, 2);
});

// --- Razorpay, with its API faked
const realFetch = globalThis.fetch;
const rzCalls = [];
globalThis.fetch = async (input, init = {}) => {
  const u = String(input);
  if (!u.startsWith('https://api.razorpay.com/')) return realFetch(input, init);
  rzCalls.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  if (u.endsWith('/payment_links') && init.method === 'POST') {
    return Response.json({ id: `plink_${rzCalls.length}`, short_url: `https://rzp.io/rzp/x${rzCalls.length}`, status: 'created' });
  }
  return Response.json({ status: 'created', payments: [] });
};

let link;
await test('rent link for what is owed, ready for WhatsApp and SMS', async () => {
  const { status, body } = await call(`/api/tenancies/${tid}/link`, { method: 'POST', body: {} });
  assert.equal(status, 200, JSON.stringify(body));
  link = body.link;
  assert.equal(body.amount, 18000);
  const create = rzCalls.find((c) => c.method === 'POST');
  assert.equal(create.body.amount, 1800000);
  assert.equal(create.body.customer.contact, '+919845012345');
  assert.deepEqual(create.body.notify, { sms: false, email: false });
  assert.ok(body.whatsappUrl.startsWith('https://wa.me/919845012345?text='));
  assert.ok(decodeURIComponent(body.whatsappUrl).includes('₹18,000'));
  assert.ok(body.smsUrl.startsWith('sms:+919845012345?body='));
  assert.equal(body.test, true);
  const again = await call(`/api/tenancies/${tid}/link`, { method: 'POST', body: {} });
  assert.equal(again.body.link.id, link.id, 'same amount reuses the link');
  assert.equal((await call(`/api/links/${link.id}/sent`, { method: 'POST', body: { via: 'whatsapp' } })).status, 200);
});
await test('cross-site posts are refused', async () => {
  const r = await call(`/api/tenancies/${tid}/link`, { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

const webhook = async (payload, secret = env.RAZORPAY_WEBHOOK_SECRET) => {
  const raw = JSON.stringify(payload);
  return worker.fetch(
    new Request(BASE + '/api/razorpay/webhook', { method: 'POST', body: raw, headers: { 'X-Razorpay-Signature': await signatureFor(secret, raw) } }),
    env
  );
};
const paidEvent = () => ({
  event: 'payment_link.paid',
  payload: {
    payment_link: { entity: { id: link.id, status: 'paid' } },
    payment: { entity: { id: 'pay_TEST1', amount: 1800000, status: 'captured', created_at: Math.floor(Date.now() / 1000) } },
  },
});
await test('webhook: unsigned calls are refused', async () => {
  assert.equal((await webhook(paidEvent(), 'wrong')).status, 401);
});
await test('webhook: a paid link records the payment once', async () => {
  assert.equal((await webhook(paidEvent())).status, 200);
  assert.equal((await webhook(paidEvent())).status, 200);
  const { body } = await call('/api/units/G1');
  assert.equal(body.current.outstanding, 0);
  assert.equal(body.current.payments.filter((p) => p.method === 'razorpay').length, 1);
  assert.equal(body.current.links[0].status, 'paid');
  const sec = await call('/api/security', { cookie: guard });
  assert.equal(sec.body.units.find((u) => u.code === 'G1').status, 'paid');
});
await test('test payments can be cleared before going live', async () => {
  const r = await call('/api/payments/test', { method: 'DELETE' });
  assert.equal(r.body.deleted, 1);
  assert.equal((await call('/api/units/G1')).body.current.outstanding, 18000);
});
await test('move-out and deposit refund', async () => {
  assert.equal((await call(`/api/tenancies/${tid}/end`, { method: 'POST', body: { end_date: today } })).status, 200);
  assert.equal((await call(`/api/tenancies/${tid}/refund`, { method: 'POST', body: { amount: 60000, date: today } })).status, 400);
  assert.equal((await call(`/api/tenancies/${tid}/refund`, { method: 'POST', body: { amount: 32000, date: today } })).status, 200);
  const { body } = await call('/api/dashboard');
  assert.equal(body.depositsHeld, 0);
  assert.equal(body.pending[0].former, true, 'a former tenant who still owes stays on the pending list');
  const units = await call('/api/units');
  assert.equal(units.body.units.find((u) => u.code === 'G1').status, 'vacant');
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed`);
