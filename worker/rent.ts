// Rent rules, kept free of any database code so they are easy to test.
//
// - Rent is due on the move-in day every month (31st → last day of shorter months).
// - Every 11 months the rent goes up by 5%, on top of the last increase, rounded to the rupee:
//   months 1–11 base, months 12–22 base × 1.05, months 23–33 that × 1.05, and so on.
// - Payments clear the oldest month first. A month that is only partly paid still counts as pending.

export const ESCALATION_PERCENT = 5;
export const ESCALATION_EVERY_MONTHS = 11;

/** Days in a month (month is 1–12). */
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}

/** The date `k` months after `start`, keeping the same day (or the month's last day if shorter). */
export function addMonths(start: string, k: number): string {
  const [y, m, d] = start.split('-').map(Number);
  const total = y * 12 + (m - 1) + k;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysIn(ny, nm)))}`;
}

/** Rent for month number `k` (0 = the first month). */
export function rentForPeriod(baseRent: number, k: number): number {
  let rent = baseRent;
  const steps = Math.floor(k / ESCALATION_EVERY_MONTHS);
  for (let i = 0; i < steps; i++) rent = Math.round((rent * (100 + ESCALATION_PERCENT)) / 100);
  return rent;
}

export interface TenancyTerms {
  start_date: string;
  end_date: string | null;
  base_rent: number;
}

export interface Period {
  index: number;   // 0 = first month
  due: string;     // date it falls due
  rent: number;
  paid: number;    // how much of this month the payments have covered
  status: 'paid' | 'partial' | 'pending';
}

export interface Ledger {
  periods: Period[];     // months that have fallen due, oldest first
  totalDue: number;
  totalPaid: number;
  outstanding: number;   // > 0 owed, < 0 paid in advance
  pendingMonths: number; // months not fully paid
  currentRent: number;   // rent for the month running today (or the first month if not moved in yet)
  nextDueDate: string | null;
  nextRent: number | null;
  nextIncreaseOn: string | null;
  nextIncreaseRent: number | null;
}

/** Months that have fallen due on or before `today` (and before move-out, if any). */
export function duePeriods(t: TenancyTerms, today: string): { index: number; due: string; rent: number }[] {
  const out: { index: number; due: string; rent: number }[] = [];
  for (let k = 0; k < 1200; k++) {
    const due = addMonths(t.start_date, k);
    if (due > today) break;
    if (t.end_date && due >= t.end_date) break;
    out.push({ index: k, due, rent: rentForPeriod(t.base_rent, k) });
  }
  return out;
}

export function buildLedger(t: TenancyTerms, totalPaid: number, today: string): Ledger {
  const due = duePeriods(t, today);
  let left = totalPaid;
  const periods: Period[] = due.map((p) => {
    const paid = Math.max(0, Math.min(p.rent, left));
    left -= paid;
    return { ...p, paid, status: paid >= p.rent ? 'paid' : paid > 0 ? 'partial' : 'pending' };
  });
  const totalDue = due.reduce((s, p) => s + p.rent, 0);
  const curIndex = due.length ? due[due.length - 1].index : 0;
  const ended = Boolean(t.end_date && t.end_date <= today);

  const nextIndex = due.length;
  const nextDue = addMonths(t.start_date, nextIndex);
  const hasNext = !ended && !(t.end_date && nextDue >= t.end_date);

  const incIndex = (Math.floor(curIndex / ESCALATION_EVERY_MONTHS) + 1) * ESCALATION_EVERY_MONTHS;
  const incDate = addMonths(t.start_date, incIndex);
  const hasInc = !ended && !(t.end_date && incDate >= t.end_date);

  return {
    periods,
    totalDue,
    totalPaid,
    outstanding: totalDue - totalPaid,
    pendingMonths: periods.filter((p) => p.status !== 'paid').length,
    currentRent: rentForPeriod(t.base_rent, curIndex),
    nextDueDate: hasNext ? nextDue : null,
    nextRent: hasNext ? rentForPeriod(t.base_rent, nextIndex) : null,
    nextIncreaseOn: hasInc ? incDate : null,
    nextIncreaseRent: hasInc ? rentForPeriod(t.base_rent, incIndex) : null,
  };
}

/** Today's date in India (UTC+5:30). */
export function todayIST(now = Date.now()): string {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}

/** Indian financial year (April–March) containing `date`: [first day, last day]. */
export function financialYear(date: string): [string, string] {
  const [y, m] = date.split('-').map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return [`${startYear}-04-01`, `${startYear + 1}-03-31`];
}

/** "Nov 2026" style label for a 'YYYY-MM' or 'YYYY-MM-DD' string. */
export function monthLabel(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}
