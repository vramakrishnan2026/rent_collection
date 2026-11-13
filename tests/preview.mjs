// Local preview with made-up tenants. Nothing real is touched: the database is in memory and
// Google, Razorpay and the ID reader are faked. No packages needed (Node 22+).
//
//   npm run preview
//   then open http://localhost:8787/dev/login?as=owner   (or ?as=anita for her screens)
//
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { makeD1 } from './d1.mjs';
import worker from '../worker/index.ts';
import { makeSession } from '../worker/auth.ts';
import { addMonths, todayIST } from '../worker/rent.ts';

const PUB = new URL('../public', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8787);
const BASE = `http://localhost:${PORT}`;
const DB = makeD1();
const types = { js: 'text/javascript', css: 'text/css', html: 'text/html', png: 'image/png', webmanifest: 'application/manifest+json' };

const env = {
  DB,
  GOOGLE_CLIENT_ID: 'preview',
  GOOGLE_CLIENT_SECRET: 'preview',
  OWNER_EMAILS: 'owner@example.com',
  SECURITY_EMAILS: 'anita@example.com',
  RAZORPAY_KEY_ID: 'rzp_test_preview',
  RAZORPAY_KEY_SECRET: 'preview',
  ASSETS: {
    fetch: async (req) => {
      let p = new URL(req.url).pathname;
      if (p === '/' || !p.includes('.')) p = '/index.html';
      try {
        return new Response(await readFile(PUB + p), { headers: { 'Content-Type': types[p.split('.').pop()] || 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  },
  // Pretend ID reader: every photo reads as the same Aadhaar card.
  AI: {
    run: async (_m, i) =>
      i.prompt === 'agree'
        ? {}
        : { response: '{"cards":[{"type":"Aadhaar","name":"PRIYA SHETTY","address":"D/O Ramesh Shetty, #8, 1st Cross, Challaghatta, Bengaluru 560071"}]}' },
  },
};

// Pretend Google Drive and Razorpay.
const realFetch = globalThis.fetch;
let fileNo = 0;
globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'preview' });
  if (url.startsWith('https://www.googleapis.com/drive/v3/files?') && (init.method || 'GET') === 'GET') return Response.json({ files: [] });
  if (url.startsWith('https://www.googleapis.com/')) return Response.json({ id: 'file' + ++fileNo });
  if (url.startsWith('https://api.razorpay.com/')) {
    return url.endsWith('/payment_links')
      ? Response.json({ id: 'plink_' + Math.random().toString(36).slice(2, 8), short_url: 'https://rzp.io/rzp/preview', status: 'created' })
      : Response.json({ status: 'created', payments: [] });
  }
  return realFetch(u, init);
};
await DB.prepare("INSERT INTO settings (key, value) VALUES ('google_drive_refresh_token', 'preview')").run();

// ---------- made-up tenants ----------
const owner = 'cr_session=' + (await makeSession(env, 'owner@example.com'));
const call = (path, method = 'GET', body) =>
  worker.fetch(new Request(BASE + path, { method, headers: { Cookie: owner, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env).then((r) => r.json());

const today = todayIST();
await call('/api/units/T6', 'PUT', { rent_free: true, pin: '1234', note: 'Anita' });
await call('/api/tenancies', 'POST', { unit_code: 'T6', contact_name: 'Anita', start_date: addMonths(today, -20), base_rent: 0 });
const names = ['Ravi Kumar', 'Anitha Rao', 'Suresh Gowda', 'Priya Nair', 'Mohammed Irfan', 'Deepa Shetty', 'Karthik R', 'Lakshmi Devi', 'Arjun Menon', 'Fatima Begum', 'Vikram Singh', 'Meena Iyer', 'Rahul Jain', 'Sneha Patil', 'Naveen Babu', 'Kavya Hegde'];
const codes = ['G1', 'G2', 'G3', 'G5', 'G6', 'F1', 'F2', 'F3', 'F4', 'F6', 'S1', 'S2', 'S3', 'S4', 'T1', 'T2'];
for (let i = 0; i < codes.length; i++) {
  const start = addMonths(today, -(3 + ((i * 7) % 20))).slice(0, 8) + String(1 + ((i * 3) % 27)).padStart(2, '0');
  const rent = 9000 + (i % 5) * 1500;
  const { id } = await call('/api/tenancies', 'POST', {
    unit_code: codes[i], contact_name: names[i], whatsapp: '98450' + String(10000 + i * 37), start_date: start, base_rent: rent, deposit: rent * 3,
    people: [{ name: names[i], id_type: 'Aadhaar' }],
  });
  const unit = await call('/api/units/' + codes[i]);
  const behind = i % 6 === 0 ? 2 : i % 4 === 1 ? 1 : 0; // some tenants a month or two behind
  let toPay = unit.current.periods.filter((p) => p.isDue).slice(behind).reduce((a, p) => a + p.rent, 0);
  for (const p of unit.current.periods.filter((x) => x.isDue).reverse()) {
    if (toPay <= 0) break;
    const amount = Math.min(p.rent, toPay);
    toPay -= amount;
    const paidOn = p.due.slice(0, 8) + '05' > today ? today : p.due.slice(0, 8) + '05';
    await call('/api/payments', 'POST', { tenancy_id: id, amount, paid_on: paidOn, method: i % 3 ? 'upi' : 'razorpay' });
  }
}

// ---------- server ----------
http
  .createServer(async (req, res) => {
    // /dev/login?as=owner|anita: signs this browser in (preview only)
    if (req.url.startsWith('/dev/login')) {
      const who = new URL(req.url, BASE).searchParams.get('as') === 'anita' ? 'anita@example.com' : 'owner@example.com';
      res.writeHead(302, { Location: who.startsWith('anita') ? '/#/security' : '/', 'Set-Cookie': `cr_session=${await makeSession(env, who)}; Path=/; HttpOnly; SameSite=Lax` });
      return res.end();
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await worker.fetch(
      new Request(BASE + req.url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined, duplex: 'half', redirect: 'manual' }),
      env
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  })
  .listen(PORT, () => console.log(`Preview ready: ${BASE}/dev/login?as=owner  (or ?as=anita)`));
