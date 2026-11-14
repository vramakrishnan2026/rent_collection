// Run: npm test   (Node 22+, no packages needed)
import assert from 'node:assert/strict';
import { makeD1 } from './d1.mjs';
import { addMonths, buildLedger, financialYear, increaseDate, monthPeriods, rateOn } from '../worker/rent.ts';
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
  assert.equal(addMonths('2028-01-30', 1), '2028-02-29');
});
await test('5% from the 1st after 11 months, compounding, rounded to the rupee', () => {
  assert.equal(increaseDate('2026-11-12', 1), '2027-11-01'); // 11 months end 11 Oct 2027 → from 1 Nov 2027
  assert.equal(increaseDate('2026-11-01', 1), '2027-10-01');
  assert.equal(rateOn(10000, '2026-11-12', '2027-10-31'), 10000);
  assert.equal(rateOn(10000, '2026-11-12', '2027-11-01'), 10500);
  assert.equal(increaseDate('2026-11-12', 2), '2028-10-01');
  assert.equal(rateOn(10000, '2026-11-12', '2028-10-01'), 11025);
});
await test('calendar months, post-paid; part months are rent ÷ 30 × days', () => {
  const p = monthPeriods({ start_date: '2026-11-12', end_date: null, base_rent: 9000 }, '2027-02-20');
  assert.deepEqual(p.map((x) => [x.month, x.days, x.rent, x.due]), [
    ['2026-11', 19, 5700, '2026-12-10'],
    ['2026-12', 31, 9000, '2027-01-10'],
    ['2027-01', 31, 9000, '2027-02-10'],
    ['2027-02', 28, 9000, '2027-03-10'],
  ]);
  const feb = monthPeriods({ start_date: '2027-02-15', end_date: null, base_rent: 9000 }, '2027-02-20');
  assert.equal(feb[0].rent, 4200); // 14 days
  const out = monthPeriods({ start_date: '2026-01-10', end_date: '2026-06-15', base_rent: 10000 }, '2026-11-12');
  assert.deepEqual([out.length, out[5].days, out[5].rent], [6, 15, 5000]);
});
await test('a month is pending only after the 10th of the next month; oldest paid first', () => {
  const l = buildLedger({ start_date: '2026-01-10', end_date: null, base_rent: 10000 }, 95000, '2026-11-12');
  assert.equal(l.periods.length, 11); // Jan–Nov
  assert.equal(l.periods[0].rent, 7333); // 22 days of January
  assert.equal(l.totalDue, 97333); // Jan–Oct (October was due by 10 Nov)
  assert.equal(l.outstanding, 2333);
  assert.equal(l.pendingMonths, 1);
  assert.equal(l.periods[9].status, 'partial');
  assert.equal(l.periods[10].status, 'running'); // November
  assert.deepEqual([l.nextDueDate, l.nextRent], ['2026-12-10', 10000]);
  assert.deepEqual([l.nextIncreaseOn, l.nextIncreaseRent], ['2027-01-01', 10500]);
  const early = buildLedger({ start_date: '2026-01-10', end_date: null, base_rent: 10000 }, 87333, '2026-11-08');
  assert.equal(early.pendingMonths, 0, 'October is not late until after 10 Nov');
  assert.equal(early.collectable, 10000, 'but October can already be collected');
});
await test('before move-in nothing is due; paying ahead shows as credit', () => {
  const f = buildLedger({ start_date: '2026-12-01', end_date: null, base_rent: 8000 }, 0, '2026-11-12');
  assert.deepEqual([f.totalDue, f.nextDueDate, f.nextRent], [0, '2027-01-10', 8000]);
  const a = buildLedger({ start_date: '2026-10-01', end_date: null, base_rent: 8000 }, 24000, '2026-11-12');
  assert.equal(a.outstanding, -16000);
  assert.equal(a.pendingMonths, 0);
});
await test('existing tenant: backdated move-in, charged from the coming month, owner-set increase', () => {
  const t = { start_date: '2023-03-15', end_date: null, base_rent: 11000, bill_from: '2026-12-01', next_increase_on: '2027-04-01' };
  const now = buildLedger(t, 0, '2026-11-12');
  assert.deepEqual([now.periods.length, now.totalDue, now.pendingMonths], [1, 0, 0]); // only December, not yet due
  assert.deepEqual([now.nextDueDate, now.nextRent, now.currentRent], ['2027-01-10', 11000, 11000]);
  assert.deepEqual([now.nextIncreaseOn, now.nextIncreaseRent], ['2027-04-01', 11550]);
  const later = buildLedger(t, 0, '2027-05-15');
  assert.deepEqual(later.periods.map((p) => [p.month, p.rent]), [['2026-12', 11000], ['2027-01', 11000], ['2027-02', 11000], ['2027-03', 11000], ['2027-04', 11550], ['2027-05', 11550]]);
  assert.equal(later.nextIncreaseOn, '2028-03-01'); // then every 11 months
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
  TEST_TODAY: '2026-11-12',
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

const today = '2026-11-12';
const start = '2026-08-12'; // Aug (20 days), Sep and Oct are due by today; November is still running

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
  assert.deepEqual(body.current.periods.map((p) => [p.month, p.rent, p.status]), [
    ['2026-11', 12000, 'running'], ['2026-10', 12000, 'pending'], ['2026-09', 12000, 'pending'], ['2026-08', 8000, 'pending'],
  ]);
  assert.equal(body.current.pendingMonths, 3);
  assert.equal(body.current.outstanding, 32000);
  assert.equal(body.current.people.length, 2);
});
await test('a part payment clears the oldest month first', async () => {
  const r = await call('/api/payments', { method: 'POST', body: { tenancy_id: tid, amount: 30000, paid_on: today, method: 'upi', reference: 'UTR123' } });
  assert.equal(r.status, 201);
  const { body } = await call('/api/units/G1');
  assert.equal(body.current.outstanding, 2000);
  assert.equal(body.current.pendingMonths, 1);
  const future = await call('/api/payments', { method: 'POST', body: { tenancy_id: tid, amount: 1, paid_on: addMonths(today, 1), method: 'cash' } });
  assert.equal(future.status, 400);
});
await test('deleting a payment needs the PIN', async () => {
  const pid = (await call('/api/payments', { method: 'POST', body: { tenancy_id: tid, amount: 1, paid_on: today, method: 'cash' } })).body.id;
  assert.equal((await call(`/api/payments/${pid}`, { method: 'DELETE' })).status, 400);
  assert.equal((await call(`/api/payments/${pid}`, { method: 'DELETE', body: { pin: '9999' } })).status, 400);
  assert.equal((await call(`/api/payments/${pid}`, { method: 'DELETE', body: { pin: '1234' } })).status, 200);
});
await test('security guard sees months pending, never amounts, and nothing else', async () => {
  const { body } = await call('/api/security', { cookie: guard });
  const g1 = body.units.find((u) => u.code === 'G1');
  assert.deepEqual({ status: g1.status, months: g1.months, action: g1.action }, { status: 'pending', months: 1, action: 'Remind tenant' });
  assert.ok(!JSON.stringify(body).includes('2000'));
  assert.equal((await call('/api/dashboard', { cookie: guard })).status, 403);
  assert.equal((await call('/api/units', { cookie: guard })).status, 403);
  assert.equal((await call('/api/payments', { cookie: guard, method: 'POST', body: {} })).status, 403);
});
await test('rent-free unit for the security guard', async () => {
  assert.equal((await call('/api/units/T6', { method: 'PUT', body: { rent_free: true, note: 'Security' } })).status, 400, 'needs the PIN');
  assert.equal((await call('/api/units/T6', { method: 'PUT', body: { rent_free: true, pin: '0000' } })).status, 400, 'wrong PIN');
  assert.equal((await call('/api/units/T6', { method: 'PUT', body: { rent_free: true, pin: '1234', note: 'Security' } })).status, 200);
  const r = await call('/api/tenancies', { method: 'POST', body: { unit_code: 'T6', contact_name: 'Guard', start_date: start, base_rent: 9000 } });
  assert.equal(r.status, 201);
  const { body } = await call('/api/security', { cookie: guard });
  assert.equal(body.units.find((u) => u.code === 'T6').status, 'free');
});
await test('adding a tenant who was already living here', async () => {
  const r = await call('/api/tenancies', { method: 'POST', body: { unit_code: 'S5', contact_name: 'Old Tenant', start_date: '2023-03-15', base_rent: 11000, deposit: 30000, existing: true, bill_from: '2026-12-01', next_increase_on: '2027-04-01' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const { body } = await call('/api/units/S5');
  assert.deepEqual([body.current.start_date, body.current.bill_from, body.current.outstanding, body.current.periods.length], ['2023-03-15', '2026-12-01', 0, 1]);
  const sec = (await call('/api/security', { cookie: guard })).body.units.find((u) => u.code === 'S5');
  assert.equal(sec.status, 'paid');
  const bad = await call('/api/tenancies', { method: 'POST', body: { unit_code: 'S6', contact_name: 'X', start_date: '2023-03-15', base_rent: 1, existing: true, bill_from: '2026-12-01', next_increase_on: '2022-01-01' } });
  assert.equal(bad.status, 400);
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
  assert.equal(body.pendingTotal, 2000);
  assert.equal(body.pendingUnits, 1);
  assert.equal(body.depositsHeld, 80000); // G1 50,000 + S5 30,000
  assert.equal(body.rentableUnits, 24);
  assert.equal(body.occupied, 2);
  assert.equal(body.pending[0].unit, 'G1');
  assert.equal(body.pending[0].months, 1);
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
  assert.equal(body.amount, 2000);
  assert.equal(body.description, 'Rent G1 · Oct 2026');
  const create = rzCalls.find((c) => c.method === 'POST');
  assert.equal(create.body.amount, 200000);
  assert.equal(create.body.customer.contact, '+919845012345');
  assert.deepEqual(create.body.notify, { sms: false, email: false });
  assert.ok(body.whatsappUrl.startsWith('https://wa.me/919845012345?text='));
  assert.ok(decodeURIComponent(body.whatsappUrl).includes('₹2,000'));
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
    payment: { entity: { id: 'pay_TEST1', amount: 200000, status: 'captured', created_at: Math.floor(Date.parse('2026-11-12T06:00:00Z') / 1000) } },
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
  assert.equal((await call('/api/payments/test', { method: 'DELETE' })).status, 400, 'needs the PIN');
  const r = await call('/api/payments/test', { method: 'DELETE', body: { pin: '1234' } });
  assert.equal(r.body.deleted, 1);
  assert.equal((await call('/api/units/G1')).body.current.outstanding, 2000);
});
await test('move-out: last part month, one month kept for maintenance, rest refunded', async () => {
  assert.equal((await call(`/api/tenancies/${tid}/end`, { method: 'POST', body: { end_date: today } })).status, 200);
  // Owes October's 2,000 + 1–12 November (12 days = 4,800)
  let d = (await call('/api/dashboard')).body;
  assert.deepEqual([d.pending[0].unit, d.pending[0].former, d.pending[0].amount], ['G1', true, 6800]);
  const pre = (await call(`/api/tenancies/${tid}/settlement`)).body;
  assert.deepEqual([pre.deposit, pre.maintenance, pre.owed, pre.fromDeposit, pre.refund], [50000, 12000, 6800, 6800, 31200]);
  assert.equal((await call(`/api/tenancies/${tid}/settle`, { method: 'POST', body: { maintenance: 60000, date: today } })).status, 400);
  const r = await call(`/api/tenancies/${tid}/settle`, { method: 'POST', body: { maintenance: 12000, date: today } });
  assert.deepEqual([r.body.fromDeposit, r.body.refund], [6800, 31200]);
  d = (await call('/api/dashboard')).body;
  assert.equal(d.depositsHeld, 30000); // only S5's now
  assert.equal(d.pending.length, 0, 'the rent was taken from the deposit');
  assert.equal((await call(`/api/tenancies/${tid}/settle`, { method: 'POST', body: { maintenance: 0, date: today } })).status, 400);
  const units = await call('/api/units');
  assert.equal(units.body.units.find((u) => u.code === 'G1').status, 'vacant');
});

// --- ID photos from the security guard, with Google Drive and the AI faked
console.log('ID photos');
let aiNames = [];
let aiCards = null; // set to return full cards (type/name/address) instead of names
let aiLines = null; // set to make the JSON reply empty so the line-reading fallback is used
env.AI = {
  run: async (_m, input) => {
    if (input.prompt === 'agree') return {};
    if (JSON.stringify(input).includes('Transcribe every line')) return { response: aiLines || '' };
    if (aiLines) return { response: 'I can see an identity card.' };
    return { response: JSON.stringify({ cards: aiCards || aiNames.map((name) => ({ type: 'Aadhaar', name, address: null })) }) };
  },
};
let fileNo = 0;
const driveCalls = [];
globalThis.fetch = async (input, init = {}) => {
  const u = String(input);
  if (u.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'tok' });
  if (u.startsWith('https://www.googleapis.com/drive/v3/files?') && (init.method || 'GET') === 'GET') return Response.json({ files: [] });
  if (u.startsWith('https://www.googleapis.com/drive/v3/files')) return Response.json({ id: 'folder' });
  if (u.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
    driveCalls.push(u);
    return Response.json({ id: `file${++fileNo}` });
  }
  return realFetch(input, init);
};
const upload = async (unit, cookie = guard) => {
  const form = new FormData();
  form.append('unit', unit);
  form.append('photo', new Blob([new Uint8Array(5000)], { type: 'image/jpeg' }), 'id.jpg');
  form.append('preview', 'x'.repeat(500));
  form.append('takenAt', new Date().toISOString());
  const res = await worker.fetch(new Request(BASE + '/api/id-uploads', { method: 'POST', headers: { Cookie: cookie }, body: form }), env);
  return { status: res.status, body: await res.json() };
};

await test('names must match in full: a shared first name is not enough', async () => {
  const { bestMatch } = await import('../worker/ids.ts');
  const people = [{ id: 'a', name: 'Suresh Gowda' }, { id: 'b', name: 'Karthik R' }, { id: 'c', name: 'Asha Rao' }];
  assert.equal(bestMatch('Suresh Kumar', people), null);
  assert.equal(bestMatch('SURESH GOWDA', people), 'a');
  assert.equal(bestMatch('Karthik Ramesh', people), 'b');
  assert.equal(bestMatch('Asha Rao Shetty', people), 'c');
  assert.equal(bestMatch('Rao', [{ id: 'x', name: 'Asha Rao' }, { id: 'y', name: 'Mohan Rao' }]), null);
});
await test('reading ID cards: Aadhaar, PAN, DL, and ID numbers stripped', async () => {
  const { cardsFromReply, cardsFromLines, cleanAddress } = await import('../worker/idread.ts');
  // Aadhaar front, as lines (layout from a real card; numbers made up)
  let c = cardsFromLines('Government of India\nमिधिन एस\nMidhin S\nDOB:28/01/1989\nMale\n2751 6154 8073');
  assert.deepEqual([c[0].type, c[0].name], [null, 'Midhin S']);
  // Aadhaar back
  c = cardsFromLines('Unique Identification Authority of India\nAddress: S/O Rajender Pal Singh, C-57/A,\nSTREET NO 4, WEST VINOD NAGAR,\nEast Delhi, Delhi, 110092\n8463 0242 6474');
  assert.equal(c[0].type, 'Aadhaar');
  assert.equal(c[0].name, null);
  assert.equal(c[0].address, 'S/O Rajender Pal Singh, C-57/A, STREET NO 4, WEST VINOD NAGAR, East Delhi, Delhi, 110092');
  // PAN, new and old formats
  c = cardsFromLines('INCOME TAX DEPARTMENT\nGOVT. OF INDIA\nPermanent Account Number Card\nABCDE1234F\nName / नाम\nRAVI KUMAR\nFather\'s Name\nSURESH KUMAR');
  assert.deepEqual([c[0].type, c[0].name], ['PAN', 'Ravi Kumar']);
  c = cardsFromLines('INCOME TAX DEPARTMENT GOVT. OF INDIA\nANITHA RAO\nKRISHNA RAO\nXX/XX/XXXX\nPermanent Account Number');
  assert.deepEqual([c[0].type, c[0].name], ['PAN', 'Anitha Rao']);
  // Driving licence: Name, not S/D/W of; address kept, licence number and DOB removed
  c = cardsFromLines('Government of Karnataka\nDriving Licence\nDL No KA01 20190012345\nName: KARTHIK R\nS/D/W of: RAMESH K\nDOB: 01-02-1990\nAdd: #12, 3rd Cross, Koramangala, Bengaluru 560034');
  assert.deepEqual([c[0].type, c[0].name], ['Driving licence', 'Karthik R']);
  assert.ok(!/20190012345|1990/.test(JSON.stringify(c)));
  // Model JSON: numbers in the address are stripped (Aadhaar / PAN), house no. and PIN kept
  c = cardsFromReply('Here you go: {"cards":[{"type":"aadhaar card","name":"PRIYA NAIR","address":"Address: W/O Arun, 4th Floor, MG Road 1234 5678 9012, Bengaluru, Karnataka 560001"}]}');
  assert.deepEqual(c[0], { type: 'Aadhaar', name: 'Priya Nair', address: 'W/O Arun, 4th Floor, MG Road, Bengaluru, Karnataka 560001' });
  assert.equal(cardsFromReply('{"cards":[{"type":"PAN","name":"Government of India","address":null}]}').length, 0);
  assert.equal(cleanAddress('ABCDE1234F'), null);
});
await test('nothing uploads until Google Drive is linked', async () => {
  const r = await upload('G2');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'drive_not_linked');
});
await DB.prepare("INSERT INTO settings (key, value) VALUES ('google_drive_refresh_token', 'r')").run();
let g2;
await test('guard’s photo is attached to the matching person automatically', async () => {
  g2 = (await call('/api/tenancies', { method: 'POST', body: { unit_code: 'G2', contact_name: 'Asha Rao', whatsapp: '9876543210', start_date: start, base_rent: 10000, people: [{ name: 'Asha Rao' }, { name: 'Mohan Rao' }] } })).body.id;
  aiNames = ['ASHA RAO'];
  const r = await upload('G2');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.names, ['Asha Rao']);
  assert.equal(r.body.matched, 1);
  const { body } = await call('/api/units/G2');
  assert.equal(body.current.people.find((p) => p.name === 'Asha Rao').drive_file_id, 'file1');
  assert.equal(body.current.people.find((p) => p.name === 'Mohan Rao').drive_file_id, null);
  assert.equal(body.waitingIds.length, 0);
});
await test('an unknown name waits for the owner, who adds them as a new person', async () => {
  aiNames = ['Kiran Shetty'];
  assert.equal((await upload('G2')).body.matched, 0);
  const { body } = await call('/api/units/G2');
  assert.equal(body.waitingIds.length, 1);
  assert.deepEqual(body.waitingIds[0].names, ['Kiran Shetty']);
  assert.deepEqual((await call('/api/dashboard')).body.idsWaiting, [{ unit: 'G2', n: 1 }]);
  const r = await call(`/api/id-uploads/${body.waitingIds[0].id}/attach`, { method: 'POST', body: { name: 'Kiran Shetty' } });
  assert.equal(r.status, 200);
  const after = (await call('/api/units/G2')).body;
  assert.equal(after.waitingIds.length, 0);
  assert.equal(after.current.people.find((p) => p.name === 'Kiran Shetty').drive_file_id, 'file2');
});
await test('a photo whose name can’t be read can be attached to someone listed', async () => {
  aiNames = [];
  await upload('G2');
  const w = (await call('/api/units/G2')).body.waitingIds[0];
  assert.ok(w.file_name.includes('Name not read'));
  const mohan = (await call('/api/units/G2')).body.current.people.find((p) => p.name === 'Mohan Rao');
  assert.equal((await call(`/api/id-uploads/${w.id}/attach`, { method: 'POST', body: { person_id: mohan.id } })).status, 200);
  assert.equal((await call('/api/units/G2')).body.current.people.find((p) => p.name === 'Mohan Rao').drive_file_id, 'file3');
});
await test('IDs for an empty unit wait until the tenant is added; they can be dismissed', async () => {
  aiNames = ['New Person'];
  await upload('G3');
  const w = (await call('/api/units/G3')).body.waitingIds[0];
  assert.equal((await call(`/api/id-uploads/${w.id}/attach`, { method: 'POST', body: { name: 'New Person' } })).status, 400);
  assert.equal((await call(`/api/id-uploads/${w.id}/dismiss`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await call('/api/units/G3')).body.waitingIds.length, 0);
});
await test('owner can photograph an ID first; adding the tenant attaches it', async () => {
  aiNames = ['MEERA NAIR', 'Arun Nair'];
  const r = await upload('G4', owner);
  assert.deepEqual(r.body.names, ['Meera Nair', 'Arun Nair']);
  const add = await call('/api/tenancies', { method: 'POST', body: { unit_code: 'G4', contact_name: 'Meera Nair', start_date: start, base_rent: 9000, people: [{ name: 'Meera Nair' }, { name: 'Arun Nair' }] } });
  assert.equal(add.body.idsAttached, 2);
  const { body } = await call('/api/units/G4');
  assert.ok(body.current.people.every((p) => p.drive_file_id));
  assert.equal(body.waitingIds.length, 0);
});
await test('front then back of an Aadhaar: name from the front, address from the back', async () => {
  await call(`/api/tenancies/${g2}/people`, { method: 'POST', body: { name: 'Ravi Menon' } });
  aiCards = [{ type: 'Aadhaar', name: 'RAVI MENON', address: null }];
  assert.equal((await upload('G2')).body.matched, 1);
  aiCards = [{ type: 'Aadhaar', name: null, address: 'S/O Venkat Menon, 12 Lake Road, Bengaluru, Karnataka 560034' }];
  const back = await upload('G2');
  assert.equal(back.body.paired, true);
  const p = (await call('/api/units/G2')).body.current.people.find((x) => x.name === 'Ravi Menon');
  assert.equal(p.address, 'S/O Venkat Menon, 12 Lake Road, Bengaluru, Karnataka 560034');
  assert.equal(p.id_type, 'Aadhaar');
  assert.ok(!p.drive_file_name.includes('Back'), 'the front stays as the ID photo');
  assert.ok(p.back_file_id && p.back_file_name.includes('Back'), 'and the back is saved as the second photo');
  assert.equal((await call('/api/units/G2')).body.waitingIds.length, 0);
  aiCards = null;
});
await test('someone who already has an ID: both kept, the new one waits for review', async () => {
  const before = (await call('/api/units/G2')).body.current.people.find((x) => x.name === 'Mohan Rao');
  aiCards = [{ type: 'Aadhaar', name: 'MOHAN RAO', address: null }];
  const r = await upload('G2');
  assert.deepEqual([r.body.matched, r.body.review, r.body.status], [0, true, 'new']);
  let unit = (await call('/api/units/G2')).body;
  assert.equal(unit.current.people.find((x) => x.id === before.id).drive_file_id, before.drive_file_id, 'existing photo kept');
  const w = unit.waitingIds.find((x) => x.id === r.body.uploadId);
  assert.deepEqual([w.review_name, w.review_front], ['Mohan Rao', before.drive_file_id]);
  // Owner: "Use this one"
  assert.equal((await call(`/api/id-uploads/${w.id}/attach`, { method: 'POST', body: { person_id: before.id } })).status, 200);
  unit = (await call('/api/units/G2')).body;
  assert.notEqual(unit.current.people.find((x) => x.id === before.id).drive_file_id, before.drive_file_id);
  // Another copy: owner keeps the current one
  const r2 = await upload('G2');
  assert.equal(r2.body.review, true);
  assert.equal((await call(`/api/id-uploads/${r2.body.uploadId}/dismiss`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await call('/api/units/G2')).body.waitingIds.length, 0);
  aiCards = null;
});
await test('when the model won’t answer in JSON, the printed lines are used', async () => {
  aiLines = 'Government of India\nAsha Rao\nYear of Birth : XXXX\nFemale\nXXXX XXXX XXXX';
  const r = await upload('G2');
  assert.deepEqual(r.body.names, ['Asha Rao']);
  assert.equal(r.body.review, true, 'Asha already has an ID, so this one waits for review');
  await call(`/api/id-uploads/${r.body.uploadId}/dismiss`, { method: 'POST', body: {} });
  aiLines = null;
});
await test('owner: "Add ID" on a person attaches to that person, with type and address read', async () => {
  const kiran = (await call('/api/units/G2')).body.current.people.find((p) => p.name === 'Kiran Shetty');
  aiCards = [{ type: 'PAN', name: 'K SHETTY', address: null }];
  const form = new FormData();
  form.append('unit', 'G2');
  form.append('person_id', kiran.id);
  form.append('photo', new Blob([new Uint8Array(5000)], { type: 'image/jpeg' }), 'id.jpg');
  form.append('preview', 'x'.repeat(500));
  const res = await worker.fetch(new Request(BASE + '/api/id-uploads', { method: 'POST', headers: { Cookie: owner }, body: form }), env);
  assert.equal(res.status, 200);
  const p = (await call('/api/units/G2')).body.current.people.find((x) => x.id === kiran.id);
  assert.equal(p.id_type, 'PAN');
  assert.ok(p.drive_file_name.includes('K Shetty'));
  aiCards = null;
});
await test('owner: "Add back" saves a second photo on the same person', async () => {
  const lata0 = (await call('/api/units/G2')).body.current.people.find((p) => p.name === 'Kiran Shetty');
  const front = lata0.drive_file_id;
  aiCards = [{ type: 'Aadhaar', name: null, address: 'S/O Shetty, 5 Hill Road, Bengaluru 560001' }];
  const form = new FormData();
  form.append('unit', 'G2');
  form.append('person_id', lata0.id);
  form.append('side', 'back');
  form.append('photo', new Blob([new Uint8Array(5000)], { type: 'image/jpeg' }), 'id.jpg');
  form.append('preview', 'x'.repeat(500));
  const res = await worker.fetch(new Request(BASE + '/api/id-uploads', { method: 'POST', headers: { Cookie: owner }, body: form }), env);
  assert.equal(res.status, 200);
  const p = (await call('/api/units/G2')).body.current.people.find((x) => x.id === lata0.id);
  assert.equal(p.drive_file_id, front, 'front unchanged');
  assert.ok(p.back_file_id && p.back_file_id !== front);
  assert.equal(p.address, 'S/O Shetty, 5 Hill Road, Bengaluru 560001');
  aiCards = null;
});
await test('owner: a new person from an ID photo', async () => {
  aiCards = [{ type: 'Driving licence', name: 'LATA RAO', address: '12 Lake Road, Bengaluru 560034' }];
  const r = await upload('G2', owner);
  assert.equal(r.body.status, 'new');
  assert.equal((await call(`/api/id-uploads/${r.body.uploadId}/attach`, { method: 'POST', body: { name: 'Lata Rao' } })).status, 200);
  const p = (await call('/api/units/G2')).body.current.people.find((x) => x.name === 'Lata Rao');
  assert.deepEqual([p.id_type, p.address, Boolean(p.drive_file_id)], ['Driving licence', '12 Lake Road, Bengaluru 560034', true]);
  aiCards = null;
});
await test('a PDF sent without a file type is still accepted', async () => {
  const form = new FormData();
  form.append('unit', 'G2');
  form.append('photo', new Blob([new TextEncoder().encode('%PDF-1.4 ' + 'x'.repeat(3000))]), 'aadhaar.pdf');
  const res = await worker.fetch(new Request(BASE + '/api/id-uploads', { method: 'POST', headers: { Cookie: guard }, body: form }), env);
  assert.equal(res.status, 200, await res.clone().text());
  const w = (await call('/api/units/G2')).body.waitingIds.find((x) => x.is_pdf);
  assert.ok(w.file_name.endsWith('.pdf'));
  await call(`/api/id-uploads/${w.id}/dismiss`, { method: 'POST', body: {} });
});
await test('the guard can upload but not attach, dismiss or see IDs', async () => {
  assert.equal((await call('/api/units/G2', { cookie: guard })).status, 403);
  assert.equal((await call('/api/id-uploads/x/dismiss', { cookie: guard, method: 'POST', body: {} })).status, 403);
  assert.equal((await upload('ZZ9')).status, 400);
});

// --- "Send all" queue and reminders
console.log('Send all and reminders');
await test('the queue lists everyone owing for a finished month, and who has been sent a link', async () => {
  const id = (await call('/api/tenancies', { method: 'POST', body: { unit_code: 'S4', contact_name: 'Queue Test', whatsapp: '9876500099', start_date: '2026-09-01', base_rent: 10000 } })).body.id;
  let q = (await call('/api/collect')).body;
  assert.equal(q.forMonth, 'Oct 2026');
  let item = q.items.find((i) => i.unit === 'S4');
  assert.deepEqual([item.amount, item.sentThisMonth, item.hasWhatsapp], [20000, false, true]); // September + October
  assert.ok(!q.items.some((i) => i.unit === 'T6'), 'rent-free units are skipped');
  assert.ok(!q.items.some((i) => i.unit === 'S5'), 'tenants not charged yet are skipped');
  await DB.prepare("INSERT INTO payment_links (id, tenancy_id, amount, short_url, sent_at, sent_via) VALUES ('plink_q', ?, 20000, 'https://rzp.io/x', ?, 'whatsapp')").bind(id, '2026-11-12T05:00:00Z').run();
  q = (await call('/api/collect')).body;
  assert.equal(q.items.find((i) => i.unit === 'S4').sentThisMonth, true);
  assert.equal((await call('/api/collect', { cookie: guard })).status, 403);
});
await test('reminder on the 1st and, if any are left, on the 3rd', async () => {
  const { rentReminders } = await import('../worker/collect.ts');
  // A real browser-style subscription key, so the message is genuinely encrypted
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const b64u = (b) => Buffer.from(b).toString('base64url');
  await call('/api/push/subscribe', { method: 'POST', body: { endpoint: 'https://push.example/abc', keys: { p256dh: b64u(raw), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } } });
  const pushes = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (u, init) => (String(u).startsWith('https://push.example/') ? (pushes.push(init), new Response(null, { status: 201 })) : prev(u, init));
  assert.equal((await rentReminders(env, '2026-12-01')).sent, 1);
  assert.match(pushes[0].headers.Authorization, /^vapid t=/);
  assert.equal(pushes[0].headers['Content-Encoding'], 'aes128gcm');
  assert.deepEqual(await rentReminders(env, '2026-12-02'), { skipped: true });
  assert.equal((await rentReminders(env, '2026-12-03')).sent, 1, 'nobody was sent a link in December yet');
  globalThis.fetch = prev;
});

// --- security phones without Gmail
console.log('Security phones');
const pair = async (code) => {
  const form = new FormData();
  form.append('code', code);
  const res = await worker.fetch(new Request(BASE + '/auth/pair', { method: 'POST', body: form, redirect: 'manual' }), env);
  const set = res.headers.get('Set-Cookie') || '';
  return { status: res.status, cookie: (set.match(/cr_device=([^;]*)/) || [])[1], location: res.headers.get('Location') };
};
let phone;
await test('a one-time code pairs the phone, which then sees only the security screens', async () => {
  const { body } = await call('/api/devices/pair', { method: 'POST', body: { label: 'Anita' } });
  assert.match(body.code, /^\d{6}$/);
  assert.ok(body.link.endsWith(`/auth/pair?code=${body.code}`));
  const r = await pair(body.code);
  assert.equal(r.status, 302);
  assert.equal(r.location, '/#/security');
  phone = `cr_device=${r.cookie}`;
  const me = await call('/api/me', { cookie: phone });
  assert.deepEqual([me.body.role, me.body.device], ['security', true]);
  assert.equal((await call('/api/security', { cookie: phone })).status, 200);
  assert.equal((await call('/api/dashboard', { cookie: phone })).status, 403);
  assert.equal((await call('/', { cookie: phone })).status, 200);
  assert.equal((await pair(body.code)).status, 400, 'a code works only once');
});
await test('the paired phone can submit IDs, recorded under its name', async () => {
  aiNames = [];
  assert.equal((await upload('G2', phone)).status, 200);
  const w = (await call('/api/units/G2')).body.waitingIds[0];
  assert.equal(w.uploaded_by, 'Anita');
});
await test('removing the phone locks it out at once', async () => {
  const { body } = await call('/api/devices');
  assert.equal(body.devices.length, 1);
  assert.equal((await call(`/api/devices/${body.devices[0].id}`, { method: 'DELETE' })).status, 400, 'needs the PIN');
  assert.equal((await call(`/api/devices/${body.devices[0].id}`, { method: 'DELETE', body: { pin: '1234' } })).status, 200);
  assert.equal((await call('/api/security', { cookie: phone })).status, 401);
});
await test('ten wrong codes cancel every open code', async () => {
  const { body } = await call('/api/devices/pair', { method: 'POST', body: {} });
  const wrong = body.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 9; i++) assert.equal((await pair(wrong)).status, 400);
  assert.equal((await pair(wrong)).status, 429);
  assert.equal((await pair(body.code)).status, 400, 'the real code no longer works');
});

await test('Settings: Drive link/unlink and the backup need the PIN', async () => {
  assert.equal((await call('/api/drive/connect', { method: 'POST', body: {} })).status, 400);
  const c = await call('/api/drive/connect', { method: 'POST', body: { pin: '1234' } });
  assert.ok(c.body.url.startsWith('https://accounts.google.com/'));
  assert.match(c.res.headers.get('Set-Cookie'), /cr_drive_state=/);
  assert.equal((await call('/api/drive/disconnect', { method: 'POST', body: { pin: '0000' } })).status, 400);
  assert.equal((await call('/api/export', { method: 'POST', body: {} })).status, 400);
  const ex = await call('/api/export', { method: 'POST', body: { pin: '1234' } });
  assert.equal(ex.status, 200);
  assert.ok(Array.isArray(ex.body.tenancies));
  assert.equal((await call('/api/devices/pair', { method: 'POST', body: { label: 'Anita' } })).status, 200, 'adding a phone needs no PIN');
});

// --- UPI screenshots, direct UPI and Ask
console.log('Screenshots, UPI and Ask');
await test('reading payment screenshots: dates, amounts and UTRs in many shapes', async () => {
  const { readFromReply, cleanDate, cleanUtr } = await import('../worker/screenshot.ts');
  assert.equal(cleanDate('03/11/2026', today), '2026-11-03');
  assert.equal(cleanDate('3 Nov 2026, 9:12 am', today), '2026-11-03');
  assert.equal(cleanDate('Nov 3, 2026', today), '2026-11-03');
  assert.equal(cleanUtr('6312 4567 8901'), '631245678901');
  assert.equal(cleanUtr('N/A'), null);
  const r = readFromReply('Sure! {"status":"Payment Successful","amount":"₹12,000.00","date":"2026-11-05","utr":"631245678901","payer":"RAVI KUMAR","payee":"owner@okhdfcbank"}', today);
  assert.deepEqual(r, { status: 'success', amount: 12000, date: '2026-11-05', utr: '631245678901', payer: 'RAVI KUMAR', payee: 'owner@okhdfcbank' });
});
let aiShot = null;
let lastAsk = null;
const prevAI = env.AI.run;
env.AI.run = async (m, input) => {
  const text = JSON.stringify(input);
  if (text.includes('screenshot of a UPI')) return { response: JSON.stringify(aiShot) };
  if (text.includes('Challaghatta Home, a 24-unit building')) {
    lastAsk = input;
    return { response: 'G2 (Asha Rao) owes ₹10,000 for October 2026.' };
  }
  return prevAI(m, input);
};
const shot = async (extra = {}) => {
  const form = new FormData();
  form.append('photo', new Blob([new Uint8Array(4000)], { type: 'image/jpeg' }), 'shot.jpg');
  form.append('preview', 'x'.repeat(500));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const res = await worker.fetch(new Request(BASE + '/api/payments/screenshot', { method: 'POST', headers: { Cookie: owner }, body: form }), env);
  return { status: res.status, body: await res.json() };
};
await test('UPI ID is set from Settings, with the PIN', async () => {
  assert.equal((await call('/api/settings/upi', { method: 'PUT', body: { upi_id: 'owner@okhdfcbank' } })).status, 400);
  assert.equal((await call('/api/settings/upi', { method: 'PUT', body: { upi_id: 'not a upi', pin: '1234' } })).status, 400);
  const r = await call('/api/settings/upi', { method: 'PUT', body: { upi_id: 'owner@okhdfcbank', upi_name: 'Vinay', pin: '1234' } });
  assert.deepEqual(r.body.upi, { id: 'owner@okhdfcbank', name: 'Vinay' });
  assert.equal((await call('/api/settings')).body.upi.id, 'owner@okhdfcbank');
});
await test('a clear screenshot is recorded straight away; the same UTR twice is not', async () => {
  const g2 = (await call('/api/units/G2')).body.current;
  aiShot = { status: 'success', amount: 5000, date: '2026-11-10', utr: '631245678901', payer: 'Asha Rao', payee: 'owner@okhdfcbank' };
  const r = await shot();
  assert.equal(r.body.recorded, true, JSON.stringify(r.body));
  assert.equal(r.body.unit, 'G2');
  const after = (await call('/api/units/G2')).body.current;
  assert.equal(after.totalPaid - g2.totalPaid, 5000);
  const p = after.payments.find((x) => x.reference === '631245678901');
  assert.deepEqual([p.method, p.paid_on, p.note], ['upi', '2026-11-10', 'From screenshot']);
  const again = await shot();
  assert.equal(again.body.recorded, false);
  assert.match(again.body.reasons.join(' '), /already recorded/);
});
await test('anything doubtful opens the form instead, with the reason', async () => {
  aiShot = { status: 'success', amount: 5000, date: '2026-11-11', utr: '631245678902', payer: 'Asha Rao', payee: 'someoneelse@ybl' };
  let r = await shot();
  assert.deepEqual([r.body.recorded, r.body.unit], [false, 'G2']);
  assert.match(r.body.reasons[0], /not your UPI ID/);
  aiShot = { status: 'failed', amount: 5000, date: '2026-11-11', utr: '631245678903', payer: 'Asha Rao', payee: null };
  assert.match((await shot()).body.reasons.join(' '), /failed/);
  aiShot = { status: 'success', amount: 777, date: '2026-11-11', utr: '631245678904', payer: 'Unknown Person', payee: null };
  r = await shot();
  assert.match(r.body.reasons.join(' '), /tenant/);
  // …but choosing the tenant on their unit page settles it
  r = await shot({ tenancy_id: g2 });
  assert.equal(r.body.recorded, true);
});
await test('rent message includes the direct UPI option', async () => {
  const saved = [env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET];
  env.RAZORPAY_KEY_ID = env.RAZORPAY_KEY_SECRET = undefined; // UPI only
  const id = (await call('/api/units/S4')).body.current.id;
  const r = await call(`/api/tenancies/${id}/link`, { method: 'POST', body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.upiOnly, true);
  assert.match(r.body.message, /Please pay by UPI to owner@okhdfcbank \(Vinay\)/);
  assert.ok(r.body.whatsappUrl.startsWith('https://wa.me/91'));
  [env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET] = saved;
});
await test('Ask: answers from a read-only summary with figures worked out by the app', async () => {
  const r = await call('/api/ask', { method: 'POST', body: { question: 'Who owes rent?' } });
  assert.equal(r.status, 200);
  assert.match(r.body.answer, /G2/);
  const data = lastAsk.messages[0].content;
  assert.match(data, /"unit":"G2"/);
  assert.match(data, /overdueMonths/);
  assert.ok(!/9876543210|98450/.test(data), 'no phone numbers');
  assert.equal((await call('/api/ask', { method: 'POST', body: { question: 'x' }, cookie: guard })).status, 403);
  assert.match(data, /READ-ONLY/);
  const change = await call('/api/ask', { method: 'POST', body: { question: 'Update G1 rent to 12000 from Jan 1st' } });
  assert.match(change.body.answer, /^Note: this chat can only read your data; it can’t change anything\./);
});
env.AI.run = prevAI;

// --- A UPI QR code from Razorpay goes with each rent link, for the same amount
console.log('QR code with the rent link');
{
  const sql = (q, ...p) => DB.sqlite.prepare(q).all(...p);
  const qrFake = { fail: false, scans: {}, made: 0 };
  const before = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input);
    if (!u.startsWith('https://api.razorpay.com/')) return before(input, init);
    const method = init.method || 'GET';
    rzCalls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : null });
    const n = ++qrFake.made;
    if (u.endsWith('/payment_links') && method === 'POST') return Response.json({ id: `plink_q${n}`, short_url: `https://rzp.io/rzp/q${n}`, status: 'created' });
    if (u.endsWith('/payments/qr_codes') && method === 'POST') {
      return qrFake.fail
        ? Response.json({ error: { description: 'QR codes are not enabled for this account' } }, { status: 400 })
        : Response.json({ id: `qr_T${n}`, entity: 'qr_code', image_url: `https://rzp.io/i/qr${n}`, status: 'active' });
    }
    const scans = u.match(/\/payments\/qr_codes\/([^/]+)\/payments/);
    if (scans) return Response.json({ entity: 'collection', items: qrFake.scans[scans[1]] || [] });
    return Response.json({ status: 'created', payments: [] });
  };
  const calls = (method, re) => rzCalls.filter((c) => c.method === method && re.test(c.url));
  const newTenant = async (code, phone) => {
    assert.equal((await call('/api/units', { method: 'POST', body: { code, floor: 'QR' } })).status, 201);
    const r = await call('/api/tenancies', { method: 'POST', body: { unit_code: code, contact_name: `Scan ${code}`, phone, start_date: '2026-08-01', base_rent: 6000, deposit: 0 } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id;
  };
  const getLink = (id) => call(`/api/tenancies/${id}/link`, { method: 'POST', body: {} });
  const row = (id) => ({ ...sql('SELECT status, qr_id, qr_image_url, qr_status FROM payment_links WHERE id = ?', id)[0] });
  const credited = (qrId, payId, rupees) => ({
    event: 'qr_code.credited',
    payload: {
      payment: { entity: { id: payId, amount: rupees * 100, status: 'captured', method: 'upi', created_at: Math.floor(Date.parse('2026-11-12T06:00:00Z') / 1000) } },
      qr_code: { entity: { id: qrId, usage: 'multiple_use', type: 'upi_qr' } },
    },
  });
  const q1 = await newTenant('Q1', '9876511111');
  let first;

  await test('if Razorpay will not make a QR (not switched on), the link still works and says why', async () => {
    qrFake.fail = true;
    const r = await getLink(q1);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.link.short_url.startsWith('https://rzp.io/rzp/'));
    assert.deepEqual([r.body.qr, r.body.qrError], [null, 'QR codes are not enabled for this account']);
    assert.ok(r.body.whatsappUrl && r.body.amount > 0);
    assert.deepEqual(row(r.body.link.id), { status: 'created', qr_id: null, qr_image_url: null, qr_status: null });
    first = r.body;
    qrFake.fail = false;
  });
  await test('the QR is made for the same amount as the link, and reused with it', async () => {
    rzCalls.length = 0;
    const r = await getLink(q1);
    assert.equal(r.body.link.id, first.link.id, 'same link');
    assert.equal(calls('POST', /\/payment_links$/).length, 0);
    const made = calls('POST', /\/payments\/qr_codes$/);
    assert.equal(made.length, 1);
    assert.deepEqual(
      [made[0].body.type, made[0].body.usage, made[0].body.fixed_amount, made[0].body.payment_amount, made[0].body.notes.link_id, made[0].body.notes.unit],
      ['upi_qr', 'multiple_use', true, first.amount * 100, first.link.id, 'Q1']
    );
    assert.equal(made[0].body.close_by, undefined, 'no 2-hour limit: it stays until paid');
    assert.match(r.body.qr.imageUrl, /^https:\/\/rzp\.io\/i\/qr/);
    assert.equal(r.body.qrError, null);
    assert.equal(row(first.link.id).qr_status, 'active');
    assert.ok(!r.body.message.includes('rzp.io/i/'), 'the QR is shown in the app, not added to the message');
    rzCalls.length = 0;
    const again = await getLink(q1);
    assert.equal(again.body.qr.imageUrl, r.body.qr.imageUrl);
    assert.equal(calls('POST', /qr_codes|payment_links$/).length, 0, 'nothing new made');
    const unit = (await call('/api/units/Q1')).body;
    assert.deepEqual([unit.current.links[0].qr_status, unit.current.links[0].qr_image_url], ['active', r.body.qr.imageUrl]);
  });
  await test('when the amount owed changes, the old link and its QR are closed and new ones made', async () => {
    const old = row(first.link.id);
    assert.equal((await call('/api/payments', { method: 'POST', body: { tenancy_id: q1, amount: 1000, paid_on: today, method: 'cash' } })).status, 201);
    rzCalls.length = 0;
    const r = await getLink(q1);
    assert.equal(r.body.amount, first.amount - 1000);
    assert.notEqual(r.body.link.id, first.link.id);
    assert.equal(calls('POST', new RegExp(`/payment_links/${first.link.id}/cancel$`)).length, 1);
    assert.equal(calls('POST', new RegExp(`/payments/qr_codes/${old.qr_id}/close$`)).length, 1);
    assert.deepEqual([row(first.link.id).status, row(first.link.id).qr_status], ['cancelled', 'closed']);
    assert.equal(calls('POST', /\/payments\/qr_codes$/)[0].body.payment_amount, (first.amount - 1000) * 100);
    assert.notEqual(row(r.body.link.id).qr_id, old.qr_id);
    first = r.body;
  });
  await test('webhook: a scanned QR records the payment once, cancels the link and closes the QR', async () => {
    const qrId = row(first.link.id).qr_id;
    rzCalls.length = 0;
    const paidBefore = sql('SELECT COUNT(*) AS n FROM payments WHERE tenancy_id = ?', q1)[0].n;
    assert.equal((await webhook(credited(qrId, 'pay_QR1', first.amount), 'wrong')).status, 401, 'unsigned calls are refused');
    assert.equal((await webhook(credited(qrId, 'pay_QR1', first.amount))).status, 200);
    assert.equal((await webhook(credited(qrId, 'pay_QR1', first.amount))).status, 200, 'Razorpay may send it twice');
    const pays = sql("SELECT amount, method, paid_on, rzp_payment_id, reference FROM payments WHERE tenancy_id = ? AND method = 'razorpay'", q1);
    assert.deepEqual(pays.map((p) => ({ ...p })), [{ amount: first.amount, method: 'razorpay', paid_on: '2026-11-12', rzp_payment_id: 'pay_QR1', reference: first.link.id }]);
    assert.equal(sql('SELECT COUNT(*) AS n FROM payments WHERE tenancy_id = ?', q1)[0].n, paidBefore + 1);
    assert.deepEqual([row(first.link.id).status, row(first.link.id).qr_status], ['paid', 'closed']);
    assert.equal(calls('POST', new RegExp(`/payment_links/${first.link.id}/cancel$`)).length, 1, 'the link can no longer be paid as well');
    assert.equal(calls('POST', new RegExp(`/payments/qr_codes/${qrId}/close$`)).length, 1);
    const unit = (await call('/api/units/Q1')).body;
    assert.equal(unit.current.outstanding, 0);
    // Razorpay then tells us the link was cancelled: it stays "paid".
    assert.equal((await webhook({ event: 'payment_link.cancelled', payload: { payment_link: { entity: { id: first.link.id, status: 'cancelled' } } } })).status, 200);
    assert.equal(row(first.link.id).status, 'paid');
    assert.equal((await getLink(q1)).status, 400, 'nothing left to collect');
  });
  await test('webhook: a QR we did not make, or one that was only created or closed, is ignored', async () => {
    const n = sql('SELECT COUNT(*) AS n FROM payments')[0].n;
    assert.equal((await webhook(credited('qr_SOMEONE_ELSE', 'pay_QR9', 500))).status, 200);
    assert.equal((await webhook({ event: 'qr_code.created', payload: { qr_code: { entity: { id: 'qr_X' } } } })).status, 200);
    assert.equal((await webhook({ event: 'qr_code.closed', payload: { qr_code: { entity: { id: row(first.link.id).qr_id } } } })).status, 200);
    assert.equal(sql('SELECT COUNT(*) AS n FROM payments')[0].n, n);
  });
  await test('Check (and the daily check) finds a QR payment the webhook missed', async () => {
    const q2 = await newTenant('Q2', '9876522222');
    const r = (await getLink(q2)).body;
    const qrId = row(r.link.id).qr_id;
    let chk = await call(`/api/links/${r.link.id}/refresh`, { method: 'POST', body: {} });
    assert.equal(chk.body.status, 'created');
    assert.equal(row(r.link.id).qr_status, 'active');
    qrFake.scans[qrId] = [
      { id: 'pay_QR_FAILED', amount: r.amount * 100, status: 'failed', created_at: 1794400000 },
      { id: 'pay_QR2', amount: r.amount * 100, status: 'captured', created_at: Math.floor(Date.parse('2026-11-11T20:00:00Z') / 1000) },
    ];
    rzCalls.length = 0;
    chk = await call(`/api/links/${r.link.id}/refresh`, { method: 'POST', body: {} });
    assert.equal(chk.body.status, 'paid');
    assert.deepEqual(sql("SELECT amount, paid_on, rzp_payment_id FROM payments WHERE tenancy_id = ?", q2).map((p) => ({ ...p })), [{ amount: r.amount, paid_on: '2026-11-12', rzp_payment_id: 'pay_QR2' }]);
    assert.deepEqual([row(r.link.id).status, row(r.link.id).qr_status], ['paid', 'closed']);
    assert.equal(calls('POST', new RegExp(`/payment_links/${r.link.id}/cancel$`)).length, 1);
    assert.equal(calls('POST', new RegExp(`/payments/qr_codes/${qrId}/close$`)).length, 1);
    assert.equal((await webhook(credited(qrId, 'pay_QR2', r.amount))).status, 200);
    assert.equal(sql('SELECT COUNT(*) AS n FROM payments WHERE tenancy_id = ?', q2)[0].n, 1, 'the late webhook does not record it again');
  });
  await test('paid through the link instead: the QR for the same rent is closed', async () => {
    const q3 = await newTenant('Q3', '9876533333');
    const r = (await getLink(q3)).body;
    const qrId = row(r.link.id).qr_id;
    rzCalls.length = 0;
    const res = await webhook({
      event: 'payment_link.paid',
      payload: { payment_link: { entity: { id: r.link.id, status: 'paid' } }, payment: { entity: { id: 'pay_LINK3', amount: r.amount * 100, status: 'captured', created_at: 1794400000 } } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual([row(r.link.id).status, row(r.link.id).qr_status], ['paid', 'closed']);
    assert.equal(calls('POST', new RegExp(`/payments/qr_codes/${qrId}/close$`)).length, 1);
    assert.equal(sql('SELECT COUNT(*) AS n FROM payments WHERE tenancy_id = ?', q3)[0].n, 1);
    // A scan that slipped in before the QR closed is still recorded (money did arrive), not lost.
    assert.equal((await webhook(credited(qrId, 'pay_QR3_LATE', r.amount))).status, 200);
    assert.equal(sql('SELECT COUNT(*) AS n FROM payments WHERE tenancy_id = ?', q3)[0].n, 2);
  });
  globalThis.fetch = before;
  DB.sqlite.exec("DELETE FROM payments WHERE tenancy_id IN (SELECT id FROM tenancies WHERE unit_code IN ('Q1','Q2','Q3')); DELETE FROM payment_links WHERE tenancy_id IN (SELECT id FROM tenancies WHERE unit_code IN ('Q1','Q2','Q3')); DELETE FROM people WHERE tenancy_id IN (SELECT id FROM tenancies WHERE unit_code IN ('Q1','Q2','Q3')); DELETE FROM tenancies WHERE unit_code IN ('Q1','Q2','Q3'); DELETE FROM units WHERE code IN ('Q1','Q2','Q3')");
}

// --- Deleting a past tenant (a test entry or a mistake), with everything recorded for them
console.log('Deleting a past tenant');
await test('a past tenant can be deleted with the PIN: their payments, people and links go too, nothing else', async () => {
  const q = (sql, ...p) => DB.sqlite.prepare(sql).all(...p);
  assert.equal((await call('/api/units', { method: 'POST', body: { code: 'X1', floor: 'Test' } })).status, 201);
  const made = await call('/api/tenancies', { method: 'POST', body: { unit_code: 'X1', contact_name: 'Test Tenant', phone: '9876500001', start_date: '2026-08-01', base_rent: 7000, deposit: 10000 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id;
  assert.equal((await call(`/api/tenancies/${id}/people`, { method: 'POST', body: { name: 'Test Flatmate' } })).status, 201);
  for (const amount of [7000, 3000]) assert.equal((await call('/api/payments', { method: 'POST', body: { tenancy_id: id, amount, paid_on: '2026-09-05', method: 'cash' } })).status, 201);
  DB.sqlite.prepare("INSERT INTO payment_links (id, tenancy_id, amount, short_url, status) VALUES ('plink_x1', ?, 7000, 'https://rzp.io/x1', 'created')").run(id);
  DB.sqlite.prepare("INSERT INTO id_uploads (id, unit_code, tenancy_id, drive_file_id, file_name, taken_at, uploaded_by) VALUES ('up_x1', 'X1', ?, 'file_x1', 'x1.jpg', '2026-08-02T10:00:00Z', 'owner')").run(id);

  // Still living there: not this way.
  const current = await call(`/api/tenancies/${id}/remove`, { method: 'POST', body: { pin: '1234' } });
  assert.equal(current.status, 400);
  assert.match(current.body.error, /moved out/);
  assert.equal((await call(`/api/tenancies/${id}/end`, { method: 'POST', body: { end_date: '2026-10-15' } })).status, 200);
  assert.equal((await call(`/api/tenancies/${id}`, { method: 'DELETE' })).status, 400, 'the no-PIN delete still refuses a tenant with payments');

  const unit = (await call('/api/units/X1')).body;
  assert.equal(unit.current, null);
  assert.deepEqual([unit.past.length, unit.past[0].contact_name, unit.past[0].paidTotal], [1, 'Test Tenant', 10000]);

  // Needs the owner, and the PIN.
  assert.equal((await call(`/api/tenancies/${id}/remove`, { method: 'POST', body: {} })).status, 400);
  assert.equal((await call(`/api/tenancies/${id}/remove`, { method: 'POST', body: { pin: '0000' } })).status, 400);
  assert.equal((await call(`/api/tenancies/${id}/remove`, { method: 'POST', body: { pin: '1234' }, cookie: guard })).status, 403);
  assert.equal(q('SELECT COUNT(*) AS n FROM payments WHERE tenancy_id = ?', id)[0].n, 2);

  const others = () => JSON.stringify(['tenancies', 'people', 'payments', 'payment_links'].map((t) => q(`SELECT * FROM ${t} WHERE ${t === 'tenancies' ? 'id' : 'tenancy_id'} != ? ORDER BY 1`, id)));
  const before = others();
  const gone = await call(`/api/tenancies/${id}/remove`, { method: 'POST', body: { pin: '1234' } });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.deepEqual(gone.body.removed, { name: 'Test Tenant', unit: 'X1', payments: 2, paid: 10000 });
  assert.equal(q('SELECT COUNT(*) AS n FROM tenancies WHERE id = ?', id)[0].n, 0);
  for (const t of ['people', 'payments', 'payment_links']) assert.equal(q(`SELECT COUNT(*) AS n FROM ${t} WHERE tenancy_id = ?`, id)[0].n, 0, t);
  assert.deepEqual({ ...q("SELECT unit_code, tenancy_id FROM id_uploads WHERE id = 'up_x1'")[0] }, { unit_code: 'X1', tenancy_id: null }, 'an ID photo stays with the unit');
  assert.equal(others(), before, 'no other tenant was touched');
  assert.deepEqual((await call('/api/units/X1')).body.past, []);
  assert.equal((await call(`/api/tenancies/${id}/remove`, { method: 'POST', body: { pin: '1234' } })).status, 404);
  DB.sqlite.exec("DELETE FROM id_uploads WHERE id = 'up_x1'; DELETE FROM units WHERE code = 'X1'");
});

// --- PIN sign-in for a visitor (Razorpay's check): on the normal sign-in page, real data, view only
console.log('PIN sign-in');
const rows = (sql) => DB.sqlite.prepare(sql).all();
const page = async (path, cookie = '') => {
  const res = await worker.fetch(new Request(BASE + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' }), env);
  return { status: res.status, html: await res.text(), res };
};
const pinLogin = async (pin, headers = {}) => {
  const res = await worker.fetch(new Request(BASE + '/auth/pin', { method: 'POST', body: new URLSearchParams({ pin }), headers, redirect: 'manual' }), env);
  return { status: res.status, html: await res.text(), res };
};
const cookieFrom = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(name + '=')) || '').split(';')[0];
const wrongPin = (pin) => String((Number(pin) + 1) % 100_000_000).padStart(8, '0');
const clearFails = () => DB.sqlite.exec("DELETE FROM settings WHERE key = 'pin_signin_fails'");
let access;
let visitor;

await test('PIN sign-in is off by default: no PIN box on the sign-in page and no PIN gets in', async () => {
  const login = await page('/auth/login');
  assert.equal(login.status, 200);
  assert.ok(login.html.includes('Sign in with Google') && !login.html.includes('Sign in with PIN'));
  assert.deepEqual((await call('/api/settings')).body.pinSignIn, { on: false, url: BASE + '/auth/login', pin: null, createdAt: null, expiresAt: null });
  for (const pin of ['1234', '00000000', '12345678', '']) assert.equal((await pinLogin(pin)).status, 403);
  assert.equal(rows("SELECT COUNT(*) AS n FROM settings WHERE key = 'pin_signin_fails'")[0].n, 0);
});
await test('only the owner can turn it on, with their own PIN', async () => {
  assert.equal((await call('/api/pin-signin/on', { method: 'POST', body: {} })).status, 400);
  assert.equal((await call('/api/pin-signin/on', { method: 'POST', body: { pin: '9999' } })).status, 400);
  assert.equal((await call('/api/pin-signin/on', { method: 'POST', body: { pin: '1234' }, cookie: guard })).status, 403);
  assert.equal((await call('/api/pin-signin/on', { method: 'POST', body: { pin: '1234' }, cookie: '' })).status, 401);
  const r = await call('/api/pin-signin/on', { method: 'POST', body: { pin: '1234' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  access = r.body.pinSignIn;
  assert.match(access.pin, /^\d{8}$/);
  assert.equal(access.url, BASE + '/auth/login');
  const days = (Date.parse(access.expiresAt) - Date.now()) / 86400_000;
  assert.ok(days > 13.9 && days < 14.1);
  assert.equal((await call('/api/settings')).body.pinSignIn.pin, access.pin, 'the owner can look it up again');
});
await test('the sign-in page now has Google and a PIN box', async () => {
  const login = await page('/auth/login');
  assert.ok(login.html.includes('Sign in with Google') && login.html.includes('Sign in with PIN') && login.html.includes('action="/auth/pin"'));
  assert.ok(!login.html.includes(access.pin));
  assert.equal((await page('/')).res.headers.get('Location'), '/auth/login?next=%2F');
  assert.equal((await page('/auth/pin')).res.headers.get('Location'), '/auth/login');
});
await test('a wrong PIN is refused; the right one signs in', async () => {
  const bad = await pinLogin(wrongPin(access.pin));
  assert.equal(bad.status, 401);
  assert.ok(bad.html.includes('Wrong PIN.') && bad.html.includes('Sign in with PIN'));
  assert.equal(cookieFrom(bad.res, 'cr_visitor'), '');
  assert.equal((await pinLogin('1234')).status, 401, 'the owner’s own PIN is not the sign-in PIN');
  assert.equal((await pinLogin(access.pin, { Origin: 'https://evil.example' })).status, 403);
  const ok = await pinLogin(`${access.pin.slice(0, 4)} ${access.pin.slice(4)}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.res.headers.get('Location'), '/');
  visitor = cookieFrom(ok.res, 'cr_visitor');
  assert.ok(visitor.length > 40);
  assert.match(ok.res.headers.getSetCookie()[0], /Max-Age=43200; HttpOnly; Secure; SameSite=Lax/);
  assert.equal(rows("SELECT value FROM settings WHERE key = 'pin_signin_fails'")[0]?.value ?? null, null, 'a good sign-in clears the wrong tries');
  const me = (await call('/api/me', { cookie: visitor })).body;
  assert.deepEqual([me.role, me.viewOnly, me.device], ['owner', true, false]);
  assert.equal((await call('/api/me')).body.viewOnly, false);
  assert.equal((await page('/', visitor)).status, 200);
});
await test('a PIN sign-in is not a Google sign-in, and the other way round', async () => {
  assert.equal((await call('/api/me', { cookie: visitor.replace('cr_visitor=', 'cr_session=') })).status, 401);
  assert.equal((await call('/api/me', { cookie: owner.replace('cr_session=', 'cr_visitor=') })).status, 401);
  assert.equal((await call('/api/me', { cookie: visitor.slice(0, -2) + 'xx' })).status, 401, 'a changed cookie is refused');
  assert.equal((await call('/api/me', { cookie: `${owner}; ${visitor}` })).body.viewOnly, false, 'the owner’s own sign-in wins');
});
await test('the visitor sees the owner’s real screens', async () => {
  for (const path of ['/api/dashboard', '/api/units', '/api/units/G2', '/api/payments', '/api/collect', '/api/security', '/api/devices']) {
    const [v, o] = [await call(path, { cookie: visitor }), await call(path)];
    assert.equal(v.status, 200, path);
    assert.deepEqual(v.body, o.body, path);
  }
  const s = (await call('/api/settings', { cookie: visitor })).body;
  assert.equal(s.pinSignIn, null, 'but not the PIN sign-in card');
  assert.ok(!JSON.stringify(s).includes(access.pin));
});
await test('the visitor can change nothing: every POST, PUT and DELETE is refused', async () => {
  const snapshot = () => JSON.stringify(rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((t) => rows(`SELECT * FROM ${t.name} ORDER BY 1`)));
  const before = snapshot();
  const g2 = (await call('/api/units/G2')).body.current;
  const pay = rows('SELECT id FROM payments LIMIT 1')[0];
  const tries = [
    ['POST', '/api/payments', { tenancy_id: g2.id, amount: 500, paid_on: today, method: 'cash' }],
    ['DELETE', `/api/payments/${pay.id}`, { pin: '1234' }],
    ['DELETE', '/api/payments/test', { pin: '1234' }],
    ['PUT', `/api/tenancies/${g2.id}`, { contact_name: 'Changed', start_date: g2.start_date, base_rent: 1 }],
    ['DELETE', `/api/tenancies/${g2.id}`, {}],
    ['POST', `/api/tenancies/${g2.id}/end`, { end_date: today }],
    ['POST', `/api/tenancies/${g2.id}/link`, {}],
    ['POST', `/api/tenancies/${g2.id}/people`, { name: 'Extra Person' }],
    ['POST', '/api/tenancies', { unit_code: 'T5', contact_name: 'New Tenant', start_date: today, base_rent: 9000 }],
    ['POST', '/api/units', { code: 'Z9', floor: 'Z' }],
    ['PUT', '/api/units/G2', { rent_free: true, pin: '1234' }],
    ['POST', '/api/export', { pin: '1234' }],
    ['POST', '/api/ask', { question: 'Who owes rent?' }],
    ['PUT', '/api/settings/upi', { pin: '1234', upi_id: 'thief@okaxis' }],
    ['POST', '/api/devices/pair', { label: 'x' }],
    ['DELETE', '/api/devices/codes', {}],
    ['POST', '/api/push/subscribe', { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } }],
    ['POST', '/api/push/test', {}],
    ['POST', '/api/drive/connect', { pin: '1234' }],
    ['POST', '/api/drive/disconnect', { pin: '1234' }],
    ['POST', '/api/id-uploads', {}],
    ['POST', '/api/pin-signin/on', { pin: '1234' }],
    ['POST', '/api/pin-signin/off', {}],
  ];
  for (const [method, path, body] of tries) {
    const r = await call(path, { method, body, cookie: visitor });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.match(r.body.error, /View only/);
  }
  assert.equal((await call('/api/drive/callback?code=x&state=y', { cookie: visitor })).status, 403);
  assert.equal(snapshot(), before, 'nothing in the database changed');
  assert.equal((await call('/api/me', { cookie: visitor })).status, 200, 'and PIN sign-in is still on');
});
await test('five wrong PINs in a row pause PIN sign-in for 15 minutes, even for the right PIN', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await pinLogin(wrongPin(access.pin))).status, 401);
  const fifth = await pinLogin(wrongPin(access.pin));
  assert.equal(fifth.status, 429);
  assert.ok(fifth.html.includes('Try again in 15 minutes'));
  const right = await pinLogin(access.pin);
  assert.equal(right.status, 429);
  assert.equal(cookieFrom(right.res, 'cr_visitor'), '');
  assert.equal((await call('/api/me', { cookie: visitor })).status, 200, 'someone already signed in is not thrown out');
  assert.equal((await call('/api/me')).status, 200, 'and Google sign-in is unaffected');
  // 15 minutes later
  const until = JSON.parse(rows("SELECT value FROM settings WHERE key = 'pin_signin_fails'")[0].value).until;
  assert.ok(Math.abs(Date.parse(until) - Date.now() - 15 * 60_000) < 5000);
  DB.sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'pin_signin_fails'").run(JSON.stringify({ n: 0, until: new Date(Date.now() - 1000).toISOString() }));
  assert.equal((await pinLogin(access.pin)).status, 302);
  // four wrong, then right: the count starts again
  for (let i = 0; i < 4; i++) assert.equal((await pinLogin(wrongPin(access.pin))).status, 401);
  assert.equal((await pinLogin(access.pin)).status, 302);
  for (let i = 0; i < 4; i++) assert.equal((await pinLogin(wrongPin(access.pin))).status, 401);
  clearFails();
});
await test('signing out ends the PIN sign-in on that browser', async () => {
  const out = await page('/auth/logout', visitor);
  assert.equal(out.res.headers.get('Location'), '/auth/login?signed_out=1');
  assert.equal(cookieFrom(out.res, 'cr_visitor'), 'cr_visitor=');
});
await test('a new PIN replaces the old one and signs earlier visitors out', async () => {
  const r = await call('/api/pin-signin/on', { method: 'POST', body: { pin: '1234' } });
  assert.notEqual(r.body.pinSignIn.pin, access.pin);
  assert.equal((await call('/api/me', { cookie: visitor })).status, 401);
  assert.equal((await pinLogin(access.pin)).status, 401);
  access = r.body.pinSignIn;
  visitor = cookieFrom((await pinLogin(access.pin)).res, 'cr_visitor');
  assert.equal((await call('/api/me', { cookie: visitor })).status, 200);
  clearFails();
});
await test('it stops by itself after 14 days, and at once when turned off', async () => {
  const saved = rows("SELECT value FROM settings WHERE key = 'pin_signin'")[0].value;
  DB.sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'pin_signin'").run(JSON.stringify({ ...JSON.parse(saved), expires_at: new Date(Date.now() - 1000).toISOString() }));
  assert.equal((await call('/api/me', { cookie: visitor })).status, 401);
  assert.equal((await pinLogin(access.pin)).status, 403);
  assert.ok(!(await page('/auth/login')).html.includes('Sign in with PIN'));
  assert.equal((await call('/api/settings')).body.pinSignIn.on, false);
  DB.sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'pin_signin'").run(saved);
  assert.equal((await call('/api/me', { cookie: visitor })).status, 200);

  assert.equal((await call('/api/pin-signin/off', { method: 'POST', body: {}, cookie: guard })).status, 403);
  const off = await call('/api/pin-signin/off', { method: 'POST', body: {} });
  assert.deepEqual([off.status, off.body.pinSignIn.on, off.body.pinSignIn.pin], [200, false, null]);
  assert.equal((await call('/api/me', { cookie: visitor })).status, 401);
  assert.equal((await page('/', visitor)).status, 302);
  assert.equal((await pinLogin(access.pin)).status, 403);
  assert.ok(!(await page('/auth/login')).html.includes('Sign in with PIN'));
});
await test('the demo copy is gone: no demo sign-in page, routes or leftovers', async () => {
  assert.equal((await page('/auth/demo')).res.headers.get('Location'), '/auth/login?next=%2Fauth%2Fdemo');
  assert.equal((await call('/api/demo/on', { method: 'POST', body: { pin: '1234' } })).status, 404);
  assert.equal((await call('/api/settings')).body.demo, undefined);
  assert.equal(rows("SELECT COUNT(*) AS n FROM settings WHERE key IN ('demo_access', 'database_marker')")[0].n, 0);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed`);
