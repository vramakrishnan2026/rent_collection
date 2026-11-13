import type { Env } from './env';
import { ValidationError, dashboard, overview, str } from './db.ts';
import { buildLedger, financialYear, monthLabel } from './rent.ts';

// "Ask your data" (owner only). The app works out every figure itself, using the same rules as the
// screens, and hands the model a compact, read-only summary. The model only finds and phrases the
// answer; it never sees the raw database, can't change anything, and is told to say when the
// summary doesn't hold the answer. Phone numbers, addresses and IDs are left out.

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const FALLBACK = '@cf/meta/llama-4-scout-17b-16e-instruct';

const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

export async function snapshot(env: Env, today: string) {
  const db = env.DB;
  const [fyStart, fyEnd] = financialYear(today);
  const monthStart = today.slice(0, 8) + '01';
  const [{ units, former, state }, dash] = await Promise.all([overview(db, today), dashboard(db, today)]);

  const pays = (
    await db
      .prepare(
        `SELECT p.amount, p.paid_on, p.method, p.tenancy_id, t.unit_code, u.floor FROM payments p
         JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.code = t.unit_code WHERE p.paid_on >= ? AND p.paid_on <= ?`
      )
      .bind(fyStart, fyEnd)
      .all<{ amount: number; paid_on: string; method: string; tenancy_id: string; unit_code: string; floor: string }>()
  ).results;

  const byFloor: Record<string, { thisYear: number; thisMonth: number }> = {};
  const byTenancyYear: Record<string, number> = {};
  for (const p of pays) {
    const f = (byFloor[p.floor] ||= { thisYear: 0, thisMonth: 0 });
    f.thisYear += p.amount;
    if (p.paid_on >= monthStart) f.thisMonth += p.amount;
    byTenancyYear[p.tenancy_id] = (byTenancyYear[p.tenancy_id] || 0) + p.amount;
  }
  const lastPaid: Record<string, string> = {};
  for (const r of (await db.prepare('SELECT tenancy_id, MAX(paid_on) AS d FROM payments GROUP BY tenancy_id').all<{ tenancy_id: string; d: string }>()).results) lastPaid[r.tenancy_id] = r.d;

  const tenant = (t: any) => {
    const row = state.tenancies.find((x) => x.id === t.id)!;
    const ledger = buildLedger(row, state.paidBy.get(t.id) || 0, today);
    return {
      tenant: t.contact_name,
      movedIn: t.start_date,
      chargedFrom: t.bill_from || t.start_date,
      movedOut: t.end_date,
      rentNow: inr(t.currentRent),
      overdue: t.outstanding > 0 ? inr(t.outstanding) : 'nothing',
      overdueMonths: ledger.periods.filter((p) => p.isDue && p.paid < p.rent).map((p) => `${monthLabel(p.month)} (${inr(p.rent - p.paid)} unpaid)`),
      collectableNow: t.collectable > 0 ? inr(t.collectable) : 'nothing',
      nextDue: t.nextDueDate ? `${inr(t.nextRent)} by ${t.nextDueDate}` : null,
      next5pcIncrease: t.nextIncreaseOn ? `${t.nextIncreaseOn}, to ${inr(t.nextIncreaseRent)}` : null,
      deposit: inr(t.deposit),
      paidThisFinancialYear: inr(byTenancyYear[t.id] || 0),
      lastPayment: lastPaid[t.id] || 'never',
      people: t.peopleCount,
      idPhotosMissing: t.idsMissing,
    };
  };

  return {
    today,
    financialYear: `${fyStart} to ${fyEnd} (April–March)`,
    rules:
      'Rent is post-paid per calendar month, due by the 10th of the next month (overdue from the 11th). Part months = rent ÷ 30 × days. ' +
      '5% increase from the 1st after every 11 months. One month’s rent is kept from the deposit for maintenance at move-out.',
    totals: {
      collectedThisMonth: inr(dash.collected.mtd),
      collectedThisFinancialYear: inr(dash.collected.ytd),
      overdueTotal: inr(dash.pendingTotal),
      tenantsBehind: dash.pendingUnits,
      depositsHeld: inr(dash.depositsHeld),
      occupied: `${dash.occupied} of ${dash.rentableUnits} rentable units`,
      vacantUnits: dash.vacant,
      monthlyRentRoll: inr(dash.monthlyRentRoll),
      byMonth: dash.months.map((m) => ({ month: monthLabel(m.month), fellDue: inr(m.due), collected: inr(m.collected) })),
    },
    byFloor: Object.fromEntries(Object.entries(byFloor).map(([f, v]) => [f, { collectedThisYear: inr(v.thisYear), collectedThisMonth: inr(v.thisMonth) }])),
    units: units.map((u) => ({ unit: u.code, floor: u.floor, status: u.status, rentFree: u.rent_free || undefined, ...(u.tenancy ? tenant(u.tenancy) : {}) })),
    formerTenantsStillOwing: former.map((t) => ({ unit: t.unit_code, tenant: t.contact_name, movedOut: t.end_date, owes: inr(t.owedThroughEnd) })),
  };
}

const SYSTEM = (data: unknown) =>
  `You answer the owner's questions about the rent of Challaghatta Home, a 24-unit building in Bengaluru.
Answer ONLY from the DATA below, which the app worked out with its own rules. Never invent tenants, amounts or dates.
You are READ-ONLY: you cannot change anything (rents, payments, tenants, dates). If asked to change, update, add or delete
something, say clearly that you can't make changes, and tell the owner where to do it in the app instead
(rent, name, phone, deposit: open the unit › Edit details; payments: Record payment; moving out: Move out).
Never say or suggest that something has been changed.
If the DATA doesn't contain the answer, say so briefly. Be short and direct: a sentence or a short list.
Write rupees like ₹12,000 (Indian commas). Use unit codes (G1, F3…) and tenant names. Dates like 10 Dec 2026.
DATA:
${JSON.stringify(data)}`;

export async function ask(env: Env, body: any, today: string) {
  const question = str(body?.question, 500);
  if (!question) throw new ValidationError('Type a question');
  if (!env.AI) throw new ValidationError('Cloudflare Workers AI isn’t connected');
  const history = (Array.isArray(body?.history) ? body.history : [])
    .slice(-6)
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string')
    .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 1500) }));
  // Belt and braces: a request to change something always gets the same clear notice, whatever the model says.
  const wantsChange = /\b(update|change|set|increase|decrease|raise|reduce|modify|edit|add|delete|remove|record|mark)\b/i.test(question);
  const notice = wantsChange ? 'Note: this chat can only read your data; it can’t change anything. ' : '';
  const messages = [{ role: 'system', content: SYSTEM(await snapshot(env, today)) }, ...history, { role: 'user', content: question }];
  for (const model of [MODEL, FALLBACK]) {
    try {
      const reply = await env.AI.run(model, { messages, max_tokens: 600, temperature: 0.1 });
      const text = typeof reply === 'string' ? reply : reply?.response ?? reply?.result?.response;
      if (typeof text === 'string' && text.trim()) return { answer: notice + text.trim(), readOnly: true };
    } catch (e) {
      console.error('Ask failed', model, e);
    }
  }
  throw new ValidationError('Couldn’t get an answer right now. Try again in a minute.');
}
