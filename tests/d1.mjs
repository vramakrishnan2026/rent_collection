// A small stand-in for Cloudflare D1, on Node's built-in SQLite, for tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

/** `empty: true` gives a database with no tables at all (like the demo database before first use). */
export function makeD1({ empty = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  if (!empty) for (const f of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));

  const fix = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p.map(fix)),
    async first() {
      return sqlite.prepare(sql).get(...params) ?? null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...params), success: true, meta: {} };
    },
    async run() {
      const r = sqlite.prepare(sql).run(...params);
      return { results: [], success: true, meta: { changes: Number(r.changes) } };
    },
    _exec() {
      const s = sqlite.prepare(sql);
      return /^\s*(select|with)/i.test(sql)
        ? { results: s.all(...params), success: true, meta: {} }
        : { results: [], success: true, meta: { changes: Number(s.run(...params).changes) } };
    },
  });
  return {
    sqlite,
    prepare: (sql) => stmt(sql),
    async batch(list) {
      sqlite.exec('BEGIN');
      try {
        const out = list.map((s) => s._exec());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
