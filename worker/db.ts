import type { D1Database } from './env';
import { addMonths, buildLedger, duePeriods, financialYear, isValidDate, type Ledger } from './rent.ts';

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

// ---------- input helpers ----------

export const str = (v: unknown, max = 200): string => (v === null || v === undefined ? '' : String(v)).trim().slice(0, max);

export function rupees(v: unknown, field: string, { min = 0 } = {}): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[,₹\s]/g, ''));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new ValidationError(`${field} must be a whole number of rupees${min > 0 ? ` above ${min - 1}` : ''}`);
  }
  if (n > 100_000_000) throw new ValidationError(`${field} is too large`);
  return n;
}

export function date(v: unknown, field: string): string {
  const s = str(v, 10);
  if (!isValidDate(s)) throw new ValidationError(`${field} must be a date (YYYY-MM-DD)`);
  return s;
}

/** Indian mobile number → 10 digits, or null when empty. */
export function mobile(v: unknown, field: string): string | null {
  let d = str(v, 30).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) throw new ValidationError(`${field} must be a 10-digit Indian mobile number`);
  return d;
}

export const ID_TYPES = ['Aadhaar', 'PAN', 'Passport', 'Driving licence', 'Voter ID', 'Other'];
export const METHODS = ['razorpay', 'upi', 'cash', 'bank', 'other'] as const;

const newId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// ---------- settings ----------

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string | null) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

// ---------- rows ----------

export interface UnitRow {
  code: string;
  floor: string;
  sort: number;
  rent_free: number;
  note: string | null;
}

export interface TenancyRow {
  id: string;
  unit_code: string;
  contact_name: string;
  phone: string | null;
  whatsapp: string | null;
  start_date: string;
  end_date: string | null;
  base_rent: number;
  deposit: number;
  deposit_refund: number | null;
  deposit_refunded_on: string | null;
  notes: string | null;
  created_at: string;
}

export interface PersonRow {
  id: string;
  tenancy_id: string;
  name: string;
  id_type: string | null;
  drive_file_id: string | null;
  drive_file_name: string | null;
  id_uploaded_at: string | null;
}

export interface PaymentRow {
  id: string;
  tenancy_id: string;
  amount: number;
  paid_on: string;
  method: string;
  reference: string | null;
  rzp_payment_id: string | null;
  test: number;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

// ---------- loading everything (24-ish units: small enough to compute in memory) ----------

interface State {
  units: UnitRow[];
  tenancies: TenancyRow[];
  paidBy: Map<string, number>;
  people: Map<string, PersonRow[]>;
  lastSent: Map<string, string>;
}

async function loadState(db: D1Database): Promise<State> {
  const [units, tenancies, sums, people, sent] = await db.batch([
    db.prepare('SELECT code, floor, sort, rent_free, note FROM units ORDER BY sort, code'),
    db.prepare('SELECT * FROM tenancies ORDER BY start_date'),
    db.prepare('SELECT tenancy_id, SUM(amount) AS paid FROM payments GROUP BY tenancy_id'),
    db.prepare('SELECT * FROM people ORDER BY created_at'),
    db.prepare("SELECT tenancy_id, MAX(sent_at) AS sent_at FROM payment_links WHERE sent_at IS NOT NULL GROUP BY tenancy_id"),
  ]);
  const paidBy = new Map<string, number>();
  for (const r of sums.results as any[]) paidBy.set(r.tenancy_id, Number(r.paid) || 0);
  const peopleBy = new Map<string, PersonRow[]>();
  for (const p of people.results as unknown as PersonRow[]) {
    if (!peopleBy.has(p.tenancy_id)) peopleBy.set(p.tenancy_id, []);
    peopleBy.get(p.tenancy_id)!.push(p);
  }
  const lastSent = new Map<string, string>();
  for (const r of sent.results as any[]) lastSent.set(r.tenancy_id, r.sent_at);
  return {
    units: units.results as unknown as UnitRow[],
    tenancies: tenancies.results as unknown as TenancyRow[],
    paidBy,
    people: peopleBy,
    lastSent,
  };
}

const isOpen = (t: TenancyRow, today: string) => !t.end_date || t.end_date > today;

export type UnitStatus = 'paid' | 'pending' | 'vacant' | 'free' | 'upcoming';

function tenancySummary(t: TenancyRow, s: State, today: string) {
  const ledger = buildLedger(t, s.paidBy.get(t.id) || 0, today);
  const people = s.people.get(t.id) || [];
  return {
    id: t.id,
    unit_code: t.unit_code,
    contact_name: t.contact_name,
    phone: t.phone,
    whatsapp: t.whatsapp,
    start_date: t.start_date,
    end_date: t.end_date,
    base_rent: t.base_rent,
    deposit: t.deposit,
    deposit_refund: t.deposit_refund,
    deposit_refunded_on: t.deposit_refunded_on,
    notes: t.notes,
    currentRent: ledger.currentRent,
    outstanding: ledger.outstanding,
    pendingMonths: ledger.pendingMonths,
    nextDueDate: ledger.nextDueDate,
    nextRent: ledger.nextRent,
    nextIncreaseOn: ledger.nextIncreaseOn,
    nextIncreaseRent: ledger.nextIncreaseRent,
    peopleCount: people.length,
    idsMissing: people.filter((p) => !p.drive_file_id).length,
    lastSentAt: s.lastSent.get(t.id) || null,
  };
}

function unitStatus(u: UnitRow, t: ReturnType<typeof tenancySummary> | null, today: string): UnitStatus {
  if (u.rent_free) return 'free';
  if (!t) return 'vacant';
  if (t.start_date > today) return 'upcoming';
  return t.outstanding > 0 ? 'pending' : 'paid';
}

/** Every unit with its current tenancy, plus former tenants who still owe money. */
export async function overview(db: D1Database, today: string) {
  const s = await loadState(db);
  const units = s.units.map((u) => {
    const open = s.tenancies.filter((t) => t.unit_code === u.code && isOpen(t, today));
    const t = open.length ? tenancySummary(open[open.length - 1], s, today) : null;
    return { ...u, rent_free: Boolean(u.rent_free), tenancy: t, status: unitStatus(u, t, today) };
  });
  const former = s.tenancies
    .filter((t) => !isOpen(t, today))
    .map((t) => tenancySummary(t, s, today))
    .filter((t) => t.outstanding > 0);
  return { today, units, former, state: s };
}

// ---------- dashboard ----------

export async function dashboard(db: D1Database, today: string) {
  const { units, former, state } = await overview(db, today);
  const monthStart = today.slice(0, 8) + '01';
  const [fyStart, fyEnd] = financialYear(today);

  const pays = (
    await db.prepare('SELECT amount, paid_on, test FROM payments WHERE paid_on >= ? AND paid_on <= ?').bind(fyStart, fyEnd).all<{ amount: number; paid_on: string; test: number }>()
  ).results;

  const mtd = pays.filter((p) => p.paid_on >= monthStart && p.paid_on <= today).reduce((a, p) => a + p.amount, 0);
  const ytd = pays.filter((p) => p.paid_on <= today).reduce((a, p) => a + p.amount, 0);
  const testTotal = pays.filter((p) => p.test).reduce((a, p) => a + p.amount, 0);

  // Rent that fell due in each month of this financial year, and what was collected.
  const months: { month: string; due: number; collected: number }[] = [];
  for (let m = fyStart.slice(0, 7); m <= today.slice(0, 7); m = addMonths(m + '-01', 1).slice(0, 7)) {
    months.push({ month: m, due: 0, collected: 0 });
  }
  const byMonth = new Map(months.map((m) => [m.month, m]));
  for (const t of state.tenancies) {
    for (const p of duePeriods(t, today)) {
      const row = byMonth.get(p.due.slice(0, 7));
      if (row) row.due += p.rent;
    }
  }
  for (const p of pays) {
    const row = byMonth.get(p.paid_on.slice(0, 7));
    if (row) row.collected += p.amount;
  }

  const current = units.filter((u) => u.tenancy && u.status !== 'free');
  const pending = [
    ...units.filter((u) => u.status === 'pending').map((u) => ({ ...pendingItem(u.tenancy!), unit: u.code, former: false })),
    ...former.map((t) => ({ ...pendingItem(t), unit: t.unit_code, former: true })),
  ].sort((a, b) => b.months - a.months || b.amount - a.amount);

  const rentable = units.filter((u) => !u.rent_free);
  return {
    today,
    financialYear: { start: fyStart, end: fyEnd },
    collected: { mtd, ytd, testTotal },
    dueThisMonth: byMonth.get(today.slice(0, 7))?.due ?? 0,
    pendingTotal: pending.reduce((a, p) => a + p.amount, 0),
    pendingUnits: pending.length,
    depositsHeld: state.tenancies.filter((t) => !t.deposit_refunded_on).reduce((a, t) => a + t.deposit, 0),
    occupied: current.filter((u) => u.status !== 'upcoming').length,
    rentableUnits: rentable.length,
    vacant: rentable.filter((u) => u.status === 'vacant').map((u) => u.code),
    monthlyRentRoll: current.reduce((a, u) => a + (u.tenancy?.currentRent || 0), 0),
    months,
    pending,
  };
}

function pendingItem(t: ReturnType<typeof tenancySummary>) {
  return {
    tenancyId: t.id,
    name: t.contact_name,
    months: t.pendingMonths,
    amount: t.outstanding,
    lastSentAt: t.lastSentAt,
    hasPhone: Boolean(t.whatsapp || t.phone),
  };
}

// ---------- security guard's screen: months only, no amounts ----------

export async function securityView(db: D1Database, today: string) {
  const { units } = await overview(db, today);
  return {
    today,
    units: units.map((u) => ({
      code: u.code,
      floor: u.floor,
      status: u.status,
      months: u.status === 'pending' ? u.tenancy!.pendingMonths : 0,
      name: u.tenancy?.contact_name ?? null,
      action: u.status === 'pending' ? 'Remind tenant' : null,
    })),
  };
}

// ---------- units ----------

export async function addUnit(db: D1Database, body: any) {
  const code = str(body?.code, 12).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(code)) throw new ValidationError('Unit code must be letters and numbers, e.g. G7');
  const floor = str(body?.floor, 30) || 'Other';
  const exists = await db.prepare('SELECT 1 FROM units WHERE code = ?').bind(code).first();
  if (exists) throw new ValidationError(`Unit ${code} already exists`);
  const max = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM units WHERE floor = ?').bind(floor).first<{ m: number }>();
  const maxAll = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM units').first<{ m: number }>();
  const sort = max && max.m ? max.m + 1 : Math.ceil(((maxAll?.m || 0) + 1) / 100) * 100 + 1;
  await db.prepare('INSERT INTO units (code, floor, sort) VALUES (?, ?, ?)').bind(code, floor, sort).run();
  return code;
}

export async function updateUnit(db: D1Database, code: string, body: any) {
  const unit = await db.prepare('SELECT * FROM units WHERE code = ?').bind(code).first<UnitRow>();
  if (!unit) throw new NotFoundError('Unit not found');
  const rentFree = body?.rent_free === undefined ? unit.rent_free : body.rent_free ? 1 : 0;
  const note = body?.note === undefined ? unit.note : str(body.note, 300) || null;
  await db.prepare('UPDATE units SET rent_free = ?, note = ? WHERE code = ?').bind(rentFree, note, code).run();
  if (rentFree) {
    // A rent-free unit (the security guard's) charges nothing, from the start of the stay.
    await db.prepare('UPDATE tenancies SET base_rent = 0, updated_at = ? WHERE unit_code = ? AND end_date IS NULL').bind(nowIso(), code).run();
  }
}

export async function unitDetail(db: D1Database, code: string, today: string) {
  const unit = await db.prepare('SELECT * FROM units WHERE code = ?').bind(code).first<UnitRow>();
  if (!unit) throw new NotFoundError('Unit not found');
  const s = await loadState(db);
  const all = s.tenancies.filter((t) => t.unit_code === code);
  const openRow = [...all].reverse().find((t) => isOpen(t, today)) || null;

  let current: any = null;
  if (openRow) {
    const ledger: Ledger = buildLedger(openRow, s.paidBy.get(openRow.id) || 0, today);
    const [payments, links] = await db.batch([
      db.prepare('SELECT * FROM payments WHERE tenancy_id = ? ORDER BY paid_on DESC, created_at DESC').bind(openRow.id),
      db.prepare("SELECT * FROM payment_links WHERE tenancy_id = ? ORDER BY created_at DESC LIMIT 5").bind(openRow.id),
    ]);
    current = {
      ...tenancySummary(openRow, s, today),
      periods: [...ledger.periods].reverse(),
      totalDue: ledger.totalDue,
      totalPaid: ledger.totalPaid,
      people: s.people.get(openRow.id) || [],
      payments: payments.results,
      links: links.results,
    };
  }
  const past = all
    .filter((t) => t !== openRow)
    .reverse()
    .map((t) => ({ ...tenancySummary(t, s, today), people: s.people.get(t.id) || [] }));
  return { unit: { ...unit, rent_free: Boolean(unit.rent_free) }, current, past, today };
}

// ---------- tenancies ----------

function tenancyFields(body: any, rentFree: boolean) {
  const contact_name = str(body?.contact_name, 80);
  if (!contact_name) throw new ValidationError('Tenant name is required');
  const phone = mobile(body?.phone, 'Phone');
  const whatsapp = mobile(body?.whatsapp, 'WhatsApp number') ?? phone;
  return {
    contact_name,
    phone,
    whatsapp,
    start_date: date(body?.start_date, 'Move-in date'),
    base_rent: rentFree ? 0 : rupees(body?.base_rent, 'Rent', { min: 1 }),
    deposit: rupees(body?.deposit ?? 0, 'Deposit'),
    notes: str(body?.notes, 500) || null,
  };
}

export async function createTenancy(db: D1Database, body: any) {
  const code = str(body?.unit_code, 12).toUpperCase();
  const unit = await db.prepare('SELECT * FROM units WHERE code = ?').bind(code).first<UnitRow>();
  if (!unit) throw new NotFoundError('Unit not found');
  const open = await db.prepare('SELECT id FROM tenancies WHERE unit_code = ? AND end_date IS NULL').bind(code).first();
  if (open) throw new ValidationError(`${code} already has a tenant. Record their move-out first.`);
  const f = tenancyFields(body, Boolean(unit.rent_free));
  const id = newId();
  const stmts = [
    db
      .prepare(
        'INSERT INTO tenancies (id, unit_code, contact_name, phone, whatsapp, start_date, base_rent, deposit, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(id, code, f.contact_name, f.phone, f.whatsapp, f.start_date, f.base_rent, f.deposit, f.notes),
  ];
  const people: any[] = Array.isArray(body?.people) && body.people.length ? body.people : [{ name: f.contact_name }];
  for (const p of people.slice(0, 12)) {
    const name = str(p?.name, 80);
    if (!name) continue;
    stmts.push(db.prepare('INSERT INTO people (id, tenancy_id, name, id_type) VALUES (?, ?, ?, ?)').bind(newId(), id, name, idType(p?.id_type)));
  }
  await db.batch(stmts);
  return id;
}

const idType = (v: unknown) => {
  const s = str(v, 30);
  return ID_TYPES.includes(s) ? s : null;
};

async function getTenancy(db: D1Database, id: string) {
  const t = await db.prepare('SELECT * FROM tenancies WHERE id = ?').bind(id).first<TenancyRow>();
  if (!t) throw new NotFoundError('Tenancy not found');
  return t;
}

export async function updateTenancy(db: D1Database, id: string, body: any) {
  const t = await getTenancy(db, id);
  const unit = await db.prepare('SELECT rent_free FROM units WHERE code = ?').bind(t.unit_code).first<{ rent_free: number }>();
  const f = tenancyFields({ ...t, ...body }, Boolean(unit?.rent_free));
  if (t.end_date && f.start_date >= t.end_date) throw new ValidationError('Move-in date must be before the move-out date');
  await db
    .prepare(
      'UPDATE tenancies SET contact_name = ?, phone = ?, whatsapp = ?, start_date = ?, base_rent = ?, deposit = ?, notes = ?, updated_at = ? WHERE id = ?'
    )
    .bind(f.contact_name, f.phone, f.whatsapp, f.start_date, f.base_rent, f.deposit, f.notes, nowIso(), id)
    .run();
}

export async function endTenancy(db: D1Database, id: string, body: any) {
  const t = await getTenancy(db, id);
  const end = date(body?.end_date, 'Move-out date');
  if (end <= t.start_date) throw new ValidationError('Move-out date must be after the move-in date');
  await db.prepare('UPDATE tenancies SET end_date = ?, updated_at = ? WHERE id = ?').bind(end, nowIso(), id).run();
}

export async function refundDeposit(db: D1Database, id: string, body: any) {
  const t = await getTenancy(db, id);
  const amount = rupees(body?.amount, 'Refund amount');
  if (amount > t.deposit) throw new ValidationError('Refund can’t be more than the deposit');
  const on = date(body?.date, 'Refund date');
  await db.prepare('UPDATE tenancies SET deposit_refund = ?, deposit_refunded_on = ?, updated_at = ? WHERE id = ?').bind(amount, on, nowIso(), id).run();
}

export async function deleteTenancy(db: D1Database, id: string) {
  await getTenancy(db, id);
  const pays = await db.prepare('SELECT COUNT(*) AS n FROM payments WHERE tenancy_id = ?').bind(id).first<{ n: number }>();
  if (pays && pays.n > 0) throw new ValidationError('This tenancy has payments. Record a move-out instead of deleting it.');
  await db.batch([
    db.prepare('DELETE FROM people WHERE tenancy_id = ?').bind(id),
    db.prepare('DELETE FROM payment_links WHERE tenancy_id = ?').bind(id),
    db.prepare('DELETE FROM tenancies WHERE id = ?').bind(id),
  ]);
}

// ---------- people ----------

export async function addPerson(db: D1Database, tenancyId: string, body: any) {
  await getTenancy(db, tenancyId);
  const name = str(body?.name, 80);
  if (!name) throw new ValidationError('Name is required');
  const id = newId();
  await db.prepare('INSERT INTO people (id, tenancy_id, name, id_type) VALUES (?, ?, ?, ?)').bind(id, tenancyId, name, idType(body?.id_type)).run();
  return id;
}

export async function getPerson(db: D1Database, id: string) {
  const p = await db
    .prepare('SELECT p.*, t.unit_code FROM people p JOIN tenancies t ON t.id = p.tenancy_id WHERE p.id = ?')
    .bind(id)
    .first<PersonRow & { unit_code: string }>();
  if (!p) throw new NotFoundError('Person not found');
  return p;
}

export async function updatePerson(db: D1Database, id: string, body: any) {
  const p = await getPerson(db, id);
  const name = body?.name === undefined ? p.name : str(body.name, 80);
  if (!name) throw new ValidationError('Name is required');
  const type = body?.id_type === undefined ? p.id_type : idType(body.id_type);
  await db.prepare('UPDATE people SET name = ?, id_type = ? WHERE id = ?').bind(name, type, id).run();
}

export async function setPersonIdFile(db: D1Database, id: string, fileId: string, fileName: string) {
  await db.prepare('UPDATE people SET drive_file_id = ?, drive_file_name = ?, id_uploaded_at = ? WHERE id = ?').bind(fileId, fileName, nowIso(), id).run();
}

export async function deletePerson(db: D1Database, id: string) {
  await getPerson(db, id);
  await db.prepare('DELETE FROM people WHERE id = ?').bind(id).run();
}

// ---------- payments ----------

export async function recordPayment(db: D1Database, body: any, by: string, today: string) {
  const t = await getTenancy(db, str(body?.tenancy_id, 60));
  const amount = rupees(body?.amount, 'Amount', { min: 1 });
  const paid_on = date(body?.paid_on, 'Payment date');
  if (paid_on > today) throw new ValidationError('Payment date can’t be in the future');
  const method = str(body?.method, 20);
  if (!(METHODS as readonly string[]).includes(method)) throw new ValidationError('Choose how it was paid');
  const id = newId();
  await db
    .prepare('INSERT INTO payments (id, tenancy_id, amount, paid_on, method, reference, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, t.id, amount, paid_on, method, str(body?.reference, 80) || null, str(body?.note, 300) || null, by)
    .run();
  return id;
}

/** Records a Razorpay payment once (the payment id is unique). Returns true if it was new. */
export async function recordRazorpayPayment(
  db: D1Database,
  p: { tenancyId: string; amount: number; paidOn: string; paymentId: string; linkId: string; test: boolean }
) {
  const res = await db
    .prepare(
      "INSERT OR IGNORE INTO payments (id, tenancy_id, amount, paid_on, method, reference, rzp_payment_id, test, created_by) VALUES (?, ?, ?, ?, 'razorpay', ?, ?, ?, 'razorpay')"
    )
    .bind(newId(), p.tenancyId, p.amount, p.paidOn, p.linkId, p.paymentId, p.test ? 1 : 0)
    .run();
  return Number((res.meta as any)?.changes || 0) > 0;
}

export async function listPayments(db: D1Database, from: string, to: string) {
  return (
    await db
      .prepare(
        `SELECT p.*, t.unit_code, t.contact_name FROM payments p JOIN tenancies t ON t.id = p.tenancy_id
         WHERE p.paid_on >= ? AND p.paid_on <= ? ORDER BY p.paid_on DESC, p.created_at DESC`
      )
      .bind(from, to)
      .all()
  ).results;
}

export async function deletePayment(db: D1Database, id: string) {
  const res = await db.prepare('DELETE FROM payments WHERE id = ?').bind(id).run();
  if (!Number((res.meta as any)?.changes || 0)) throw new NotFoundError('Payment not found');
}

export async function deleteTestPayments(db: D1Database) {
  const res = await db.prepare('DELETE FROM payments WHERE test = 1').run();
  return Number((res.meta as any)?.changes || 0);
}

// ---------- export ----------

export async function exportAll(db: D1Database) {
  const tables = ['units', 'tenancies', 'people', 'payments', 'payment_links'];
  const results = await db.batch(tables.map((t) => db.prepare(`SELECT * FROM ${t}`)));
  return {
    app: 'challaghatta-rent',
    exported_at: nowIso(),
    ...Object.fromEntries(tables.map((t, i) => [t, results[i].results])),
  };
}

export { getTenancy };
