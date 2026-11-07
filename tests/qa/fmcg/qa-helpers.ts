// QA helpers for the FMCG-distributor scenarios. Raw request access (status codes) plus book invariants.
import { expect } from 'vitest';
import { setup, seedDistributor } from '../../api/helpers';

export type Ctx = Awaited<ReturnType<typeof setup>>;
export type Seed = Awaited<ReturnType<typeof seedDistributor>>;

export async function fresh() {
  const ctx = await setup();
  const m = await seedDistributor(ctx.call);
  return { ctx, m };
}

/** Raw request: returns status and parsed body, never throws. */
export async function raw(ctx: Ctx, method: string, url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method: method as never, url, payload: payload as never });
  let body: any = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
  return { status: res.statusCode, body };
}

/** Bad input must be a clean 4xx with an error message, never a 500. */
export async function expectClean4xx(ctx: Ctx, method: string, url: string, payload?: unknown) {
  const r = await raw(ctx, method, url, payload);
  expect(r.status, `${method} ${url} ${JSON.stringify(payload)?.slice(0, 200)} → ${r.status} ${JSON.stringify(r.body)}`).toBeGreaterThanOrEqual(400);
  expect(r.status, `${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(500);
  expect(typeof r.body?.error).toBe('string');
  return r;
}

/** Every voucher balances, every amount is integer paise, TB and BS tally. */
export async function invariants(ctx: Ctx, asOf = '2027-03-31') {
  const db = ctx.books.db;
  const unbalanced = db.prepare(`SELECT voucher_id, SUM(amount) s FROM entries GROUP BY voucher_id HAVING SUM(amount)<>0`).all();
  expect(unbalanced, 'vouchers whose entries do not sum to zero').toEqual([]);
  const nonInt = db.prepare(`SELECT * FROM entries WHERE amount<>CAST(amount AS INTEGER)`).all();
  expect(nonInt, 'non-integer paise in entries').toEqual([]);
  const nonIntV = db.prepare(`SELECT id, number, taxable, cgst, sgst, igst, total FROM vouchers WHERE total<>CAST(total AS INTEGER) OR taxable<>CAST(taxable AS INTEGER) OR cgst<>CAST(cgst AS INTEGER) OR igst<>CAST(igst AS INTEGER)`).all();
  expect(nonIntV, 'non-integer paise on vouchers').toEqual([]);
  const nonIntB = db.prepare(`SELECT * FROM bills WHERE amount<>CAST(amount AS INTEGER)`).all();
  expect(nonIntB, 'non-integer paise in bills').toEqual([]);
  const tb = await ctx.call('GET', `/api/reports/trial-balance?asOf=${asOf}`);
  expect(tb.totalDr - tb.totalCr, 'trial balance Dr - Cr = opening difference').toBe(tb.openingDiff ?? 0);
  const bs = await ctx.call('GET', `/api/reports/balance-sheet?asOf=${asOf}`);
  expect(bs.totalAssets, 'balance sheet tallies').toBe(bs.totalLiabilities);
  // Stock never negative unless allowed.
  const ss = await ctx.call<any[]>('GET', `/api/reports/stock-summary?asOf=${asOf}`);
  for (const s of ss) expect(s.closing_qty, `stock of ${s.name}`).toBeGreaterThanOrEqual(0);
  return { tb, bs, ss };
}

export const stockOf = async (ctx: Ctx, name: string, asOf = '2027-03-31') =>
  (await ctx.call<any[]>('GET', `/api/reports/stock-summary?asOf=${asOf}`)).find((s) => s.name === name)?.closing_qty;

export const pendingOf = async (ctx: Ctx, ledgerId: number, ref: string, asOf = '2027-03-31') =>
  (await ctx.call<any[]>('GET', `/api/reports/pending-bills/${ledgerId}?asOf=${asOf}`)).find((b) => b.ref === ref)?.pending ?? 0;

export const ledgerBal = (ctx: Ctx, id: number) => (ctx.books.db.prepare(`SELECT l.opening + COALESCE((SELECT SUM(e.amount) FROM entries e JOIN vouchers v ON v.id=e.voucher_id
  WHERE e.ledger_id=l.id AND v.cancelled=0 AND v.optional=0),0) b FROM ledgers l WHERE l.id=?`).get(id) as { b: number }).b;
