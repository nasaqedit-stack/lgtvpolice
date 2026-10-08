/**
 * A small in-memory PostgREST/Supabase fake for route-level tests.
 *
 * It implements exactly the query-builder surface the application uses (select/insert/update/
 * delete with eq/in/is/lt/or filters, order/limit, single/maybeSingle, head-counts, thenable
 * builders, unique-key violations as 23505, and db.rpc handlers). State is inspectable so tests
 * can assert on rows and audit events directly.
 */

import { randomUUID } from 'node:crypto';

export type Row = Record<string, any>;

export function createFakeDb(seed: Record<string, Row[]> = {}) {
  const state: Record<string, Row[]> = {
    submissions: [],
    submission_events: [],
    submission_links: [],
    submission_uploads: [],
    media: [],
    profiles: [],
  };
  for (const [table, rows] of Object.entries(seed)) state[table] = rows.map(row => ({ ...row }));
  const rpcHandlers: Record<string, (args: any) => unknown> = {};
  const defaults: Record<string, Row> = {
    submissions: { state: 'DRAFT', version: 1, processing_status: 'pending', processing_attempts: 0, description: '' },
    submission_events: {},
    submission_links: { active: true },
    submission_uploads: { status: 'uploading' },
    media: { metadata: {} },
    profiles: {},
  };
  const uniqueKeys: Record<string, string[]> = { media: ['sha256'], submission_links: ['token_hash'] };

  function checkUnique(table: string, row: Row) {
    for (const key of uniqueKeys[table] ?? []) {
      if (row[key] != null && (state[table] ?? []).some(existing => existing[key] === row[key])) {
        return { code: '23505', message: `duplicate key value violates unique constraint "${table}_${key}_key"` };
      }
    }
    return null;
  }

  const db = {
    state,
    rpcHandlers,
    setRpc(name: string, handler: (args: any) => unknown) { rpcHandlers[name] = handler; },
    rpc: async (name: string, args: any) => {
      const handler = rpcHandlers[name];
      if (!handler) return { data: null, error: { message: `rpc ${name} not mocked` } };
      return { data: handler(args), error: null };
    },
    from(table: string) {
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Row[] = [];
      const filters: Array<(row: Row) => boolean> = [];
      const orders: Array<{ col: string; asc: boolean }> = [];
      let limitN: number | null = null;
      let mode: 'all' | 'single' | 'maybe' = 'all';
      let headCount = false;

      const finish = (list: Row[]): { data: any; error: any; count?: number } => {
        if (mode === 'single') return list.length ? { data: list[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'Results contain 0 rows' } };
        if (mode === 'maybe') return { data: list[0] ?? null, error: null };
        return { data: list, error: null };
      };

      const run = (): { data: any; error: any; count?: number } => {
        const rows = state[table] ?? (state[table] = []);
        if (op === 'insert') {
          const inserted: Row[] = [];
          for (const p of payload) {
            const duplicate = checkUnique(table, p);
            if (duplicate) return { data: null, error: duplicate };
            const row = { ...(defaults[table] ?? {}), ...p, id: p.id ?? randomUUID(), created_at: p.created_at ?? new Date().toISOString() };
            rows.push(row);
            inserted.push(row);
          }
          return finish(inserted);
        }
        if (op === 'update') {
          const found = rows.filter(row => filters.every(filter => filter(row)));
          for (const row of found) Object.assign(row, payload[0]);
          return finish(found);
        }
        if (op === 'delete') {
          const found = rows.filter(row => filters.every(filter => filter(row)));
          state[table] = rows.filter(row => !found.includes(row));
          return { data: null, error: null };
        }
        let found = rows.filter(row => filters.every(filter => filter(row)));
        for (const { col, asc } of [...orders].reverse()) {
          found = [...found].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
        }
        if (limitN != null) found = found.slice(0, limitN);
        if (headCount) return { data: null, error: null, count: found.length };
        return finish(found);
      };

      const builder: any = {
        select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) headCount = true;
          return builder;
        },
        insert: (row: Row | Row[]) => { op = 'insert'; payload = Array.isArray(row) ? row : [row]; return builder; },
        update: (row: Row) => { op = 'update'; payload = [row]; return builder; },
        delete: () => { op = 'delete'; return builder; },
        eq: (col: string, value: unknown) => { filters.push(row => row[col] === value); return builder; },
        in: (col: string, values: unknown[]) => { filters.push(row => values.map(String).includes(String(row[col]))); return builder; },
        is: (col: string, value: unknown) => { filters.push(row => (row[col] ?? null) === (value ?? null)); return builder; },
        lt: (col: string, value: unknown) => { filters.push(row => new Date(row[col]).getTime() < new Date(String(value)).getTime()); return builder; },
        or: (expr: string) => {
          const clauses = expr.split(',').map(clause => {
            const match = /^(\w+)\.ilike\.%(.*)%$/.exec(clause.trim());
            if (!match) return () => false;
            const [, col, needle] = match;
            return (row: Row) => String(row[col] ?? '').toLowerCase().includes(needle.toLowerCase());
          });
          filters.push(row => clauses.some(clause => clause(row)));
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => { orders.push({ col, asc: opts?.ascending !== false }); return builder; },
        limit: (n: number) => { limitN = n; return builder; },
        single: () => { mode = 'single'; return run(); },
        maybeSingle: () => { mode = 'maybe'; return run(); },
        then: (resolve: (value: any) => void, reject: (reason: any) => void) => {
          try { resolve(run()); } catch (error) { reject(error); }
        },
      };
      return builder;
    },
  };
  return db;
}
