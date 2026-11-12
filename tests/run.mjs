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
  assert.equal(body.pendingTotal, 2000);
  assert.equal(body.pendingUnits, 1);
  assert.equal(body.depositsHeld, 50000);
  assert.equal(body.rentableUnits, 24);
  assert.equal(body.occupied, 1);
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
  const r = await call('/api/payments/test', { method: 'DELETE' });
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
  assert.equal(d.depositsHeld, 0);
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
  aiCards = [{ type: 'Aadhaar', name: 'MOHAN RAO', address: null }];
  // Mohan already has an ID from earlier; the new front replaces it and the back adds the address
  assert.equal((await upload('G2')).body.matched, 1);
  aiCards = [{ type: 'Aadhaar', name: null, address: 'S/O Venkat Rao, 12 Lake Road, Bengaluru, Karnataka 560034' }];
  const back = await upload('G2');
  assert.equal(back.body.paired, true);
  const p = (await call('/api/units/G2')).body.current.people.find((x) => x.name === 'Mohan Rao');
  assert.equal(p.address, 'S/O Venkat Rao, 12 Lake Road, Bengaluru, Karnataka 560034');
  assert.equal(p.id_type, 'Aadhaar');
  assert.ok(!p.drive_file_name.includes('Back'), 'the front stays as the ID photo');
  assert.equal((await call('/api/units/G2')).body.waitingIds.length, 0);
  aiCards = null;
});
await test('when the model won’t answer in JSON, the printed lines are used', async () => {
  aiLines = 'Government of India\nAsha Rao\nYear of Birth : XXXX\nFemale\nXXXX XXXX XXXX';
  const r = await upload('G2');
  assert.deepEqual(r.body.names, ['Asha Rao']);
  assert.equal(r.body.matched, 1);
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
  assert.equal((await call(`/api/devices/${body.devices[0].id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/security', { cookie: phone })).status, 401);
});
await test('ten wrong codes cancel every open code', async () => {
  const { body } = await call('/api/devices/pair', { method: 'POST', body: {} });
  const wrong = body.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 9; i++) assert.equal((await pair(wrong)).status, 400);
  assert.equal((await pair(wrong)).status, 429);
  assert.equal((await pair(body.code)).status, 400, 'the real code no longer works');
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed`);
