// Rent rules, kept free of any database code so they are easy to test.
//
// - Rent is POST-PAID and by CALENDAR MONTH (1st to the month's last day).
// - A part month (the move-in month, the move-out month) is charged for the days stayed:
//   monthly rent ÷ 30 × days, rounded to the rupee (never more than the full month).
// - A month's rent is due by the 10th of the next month; unpaid after that it is pending.
// - Every 11 months the rent goes up 5% on top of the last increase, rounded to the rupee.
//   The new rent applies from the 1st after the 11 months complete:
//   moved in 12 Nov 2026 → 11 months end 11 Oct 2027 → new rent from 1 Nov 2027.
// - Payments clear the oldest month first. A part-paid month counts as pending once it's due.
// - At move-out, one month's rent is kept from the deposit for maintenance.

export const ESCALATION_PERCENT = 5;
export const ESCALATION_EVERY_MONTHS = 11;
export const DUE_DAY = 10;
export const DAY_DIVISOR = 30;

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');
const toDays = (d: string) => Date.parse(d + 'T00:00:00Z') / 86_400_000;

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

const firstOf = (d: string) => d.slice(0, 8) + '01';
const lastOf = (d: string) => {
  const [y, m] = d.split('-').map(Number);
  return `${d.slice(0, 8)}${pad(daysIn(y, m))}`;
};
const firstOnOrAfter = (d: string) => (d.endsWith('-01') ? d : addMonths(firstOf(d), 1));

/** The date the n-th 5% increase starts (n = 1, 2, ...). */
export function increaseDate(start: string, n: number): string {
  return firstOnOrAfter(addMonths(start, ESCALATION_EVERY_MONTHS * n));
}

/** Monthly rent in force on a given date. */
export function rateOn(baseRent: number, start: string, date: string): number {
  let rent = baseRent;
  for (let n = 1; n < 200 && increaseDate(start, n) <= date; n++) rent = Math.round((rent * (100 + ESCALATION_PERCENT)) / 100);
  return rent;
}

/** Kept for older callers: rent for the k-th 11-month block. */
export function rentForPeriod(baseRent: number, k: number): number {
  let rent = baseRent;
  for (let i = 0; i < Math.floor(k / ESCALATION_EVERY_MONTHS); i++) rent = Math.round((rent * (100 + ESCALATION_PERCENT)) / 100);
  return rent;
}

export interface TenancyTerms {
  start_date: string;
  end_date: string | null; // last day stayed (inclusive)
  base_rent: number;
}

export interface Period {
  month: string;   // 'YYYY-MM'
  from: string;    // first day charged
  to: string;      // last day charged (month end, or move-out date)
  days: number;
  full: boolean;
  rate: number;    // monthly rent in force that month
  rent: number;    // amount for this month
  due: string;     // due by (10th of next month)
  ended: boolean;  // the month (or stay) is over, so it can be collected
  isDue: boolean;  // past the due date
  paid: number;
  status: 'paid' | 'partial' | 'pending' | 'running' | 'to-collect';
}

export interface Ledger {
  periods: Period[];       // from the move-in month to this month (or the move-out month), oldest first
  totalDue: number;        // rent past its due date
  totalPaid: number;
  outstanding: number;     // overdue rent not paid (< 0 = paid ahead)
  pendingMonths: number;   // overdue months not fully paid
  collectable: number;     // unpaid rent for months that have ended (what a rent link asks for now)
  owedThroughEnd: number;  // unpaid rent for every month up to move-out (for the deposit settlement)
  currentRent: number;     // monthly rent in force today (or at move-out)
  nextDueDate: string | null;
  nextRent: number | null;
  nextIncreaseOn: string | null;
  nextIncreaseRent: number | null;
}

/** Calendar-month periods from the move-in month up to `untilMonth` (inclusive) or the move-out month. */
export function monthPeriods(t: TenancyTerms, untilDate: string) {
  const out: Omit<Period, 'ended' | 'isDue' | 'paid' | 'status'>[] = [];
  const lastDate = t.end_date && t.end_date < lastOf(untilDate) ? t.end_date : lastOf(untilDate);
  for (let first = firstOf(t.start_date), i = 0; first <= lastDate && i < 1200; first = addMonths(first, 1), i++) {
    const from = t.start_date > first ? t.start_date : first;
    const monthLast = lastOf(first);
    const to = t.end_date && t.end_date < monthLast ? t.end_date : monthLast;
    if (to < from) break;
    const days = toDays(to) - toDays(from) + 1;
    const full = from === first && to === monthLast;
    const rate = rateOn(t.base_rent, t.start_date, first);
    const rent = full ? rate : Math.min(rate, Math.round((rate * days) / DAY_DIVISOR));
    out.push({ month: first.slice(0, 7), from, to, days, full, rate, rent, due: `${addMonths(first, 1).slice(0, 8)}${pad(DUE_DAY)}` });
  }
  return out;
}

export function buildLedger(t: TenancyTerms, totalPaid: number, today: string): Ledger {
  const ended = Boolean(t.end_date && t.end_date < today);
  // Up to this month while living there; the move-out month once they've left; the first month if not moved in yet.
  const until = t.start_date > today ? t.start_date : ended ? t.end_date! : today;
  let left = totalPaid;
  const periods: Period[] = monthPeriods(t, until).map((p) => {
    const paid = Math.max(0, Math.min(p.rent, left));
    left -= paid;
    const isDue = today > p.due;
    const over = p.to < today;
    const status: Period['status'] =
      paid >= p.rent ? 'paid' : isDue ? (paid > 0 ? 'partial' : 'pending') : over ? 'to-collect' : 'running';
    return { ...p, ended: over, isDue, paid, status };
  });
  const totalDue = periods.filter((p) => p.isDue).reduce((s, p) => s + p.rent, 0);
  const unpaid = (p: Period) => p.rent - p.paid;
  const next = periods.find((p) => !p.isDue && unpaid(p) > 0) || null;

  let nextIncreaseOn: string | null = null;
  for (let n = 1; n < 200; n++) {
    const d = increaseDate(t.start_date, n);
    if (d > today) {
      nextIncreaseOn = d;
      break;
    }
  }
  if (ended || (nextIncreaseOn && t.end_date && nextIncreaseOn > t.end_date)) nextIncreaseOn = null;
  const rateDate = ended ? t.end_date! : today < t.start_date ? t.start_date : today;

  return {
    periods,
    totalDue,
    totalPaid,
    outstanding: totalDue - totalPaid,
    pendingMonths: periods.filter((p) => p.isDue && p.paid < p.rent).length,
    collectable: periods.filter((p) => p.ended).reduce((s, p) => s + unpaid(p), 0),
    owedThroughEnd: periods.reduce((s, p) => s + unpaid(p), 0) - Math.max(0, left),
    currentRent: rateOn(t.base_rent, t.start_date, rateDate),
    nextDueDate: next ? next.due : null,
    nextRent: next ? unpaid(next) : null,
    nextIncreaseOn,
    nextIncreaseRent: nextIncreaseOn ? rateOn(t.base_rent, t.start_date, nextIncreaseOn) : null,
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
