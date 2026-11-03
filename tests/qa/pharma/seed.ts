// QA (pharma wholesaler, Cuttack): shared seed and invariant checks. Not a test file itself.
import { expect } from 'vitest';
import { gstin, setup } from '../../api/helpers';

export type Ctx = Awaited<ReturnType<typeof setup>>;

/** Calls the API and returns status + body without throwing, so bad input can be checked for 4xx vs 500. */
export async function raw(ctx: Ctx, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await ctx.app.inject({ method: method as never, url, payload: payload as never, headers });
  let body: any = res.body;
  try { body = res.body ? JSON.parse(res.body) : null; } catch { /* html */ }
  return { status: res.statusCode, body };
}

/** Odisha pharma wholesaler with chemists, a hospital in Andhra, an unregistered chemist in Bengal and two suppliers. */
export async function seedPharma(ctx: Ctx) {
  const call = ctx.call;
  await call('PUT', '/api/company', {
    name: 'Maa Tarini Pharma Distributors', address: 'Link Road', city: 'Cuttack', pincode: '753012',
    gstin: gstin('21', 'MTPDA1234C'), phone: '9437111111', books_from: '2026-04-01',
  });
  const groups = await call<any[]>('GET', '/api/groups');
  const g = (n: string) => groups.find((x) => x.name === n).id;
  const units = await call<any[]>('GET', '/api/units');
  const box = units.find((u) => u.symbol === 'Box').id;
  const strip = (await call('POST', '/api/units', { symbol: 'Strip', name: 'Strip', uqc: 'OTH' })).id;
  const pcs = units.find((u) => u.symbol === 'Pcs').id;
  const L = (body: Record<string, unknown>) => call('POST', '/api/ledgers', body);
  const sahoo = await L({ name: 'Sahoo Medical Stores', group_id: g('Sundry Debtors'), gstin: gstin('21', 'SAHOO1234M'), credit_days: 30 });
  const jena = await L({ name: 'Jena Chemist', group_id: g('Sundry Debtors'), state_code: '21', credit_days: 15 });
  const vizag = await L({ name: 'Vizag Care Hospital', group_id: g('Sundry Debtors'), gstin: gstin('37', 'VIZAG1234H'), credit_days: 45 });
  const kolkata = await L({ name: 'Howrah Medicos', group_id: g('Sundry Debtors'), state_code: '19' });
  const supplier = await L({ name: 'Utkal Pharma Agencies', group_id: g('Sundry Creditors'), gstin: gstin('21', 'UTKAL1234P'), credit_days: 30 });
  const wbSupplier = await L({ name: 'Bengal Drug House', group_id: g('Sundry Creditors'), gstin: gstin('19', 'BENGA1234D'), credit_days: 30 });
  const bank = await L({ name: 'SBI Cuttack CA', group_id: g('Bank Accounts'), opening: 100000000 });
  await L({ name: 'Capital', group_id: g('Capital Account'), opening: -100000000 });
  const I = (body: Record<string, unknown>) => call('POST', '/api/items', body);
  // Paracetamol: strips, 10 strips in a box, batch-wise, MRP ₹35 a strip.
  const para = await I({ name: 'Paracip 500 Tab', unit_id: strip, hsn: '30049099', gst_rate: 12, mrp: 3500, sale_rate: 2500, purchase_rate: 2000, track_batch: 1, alt_unit_id: box, alt_conv: 10 });
  const amox = await I({ name: 'Moxikind CV 625', unit_id: strip, hsn: '30042019', gst_rate: 12, mrp: 22000, sale_rate: 17000, purchase_rate: 15000, track_batch: 1 });
  const ors = await I({ name: 'Electral ORS', unit_id: pcs, hsn: '30049011', gst_rate: 5, mrp: 2100, sale_rate: 1600, purchase_rate: 1400, track_batch: 1 });
  const gloves = await I({ name: 'Surgical Gloves 7.5', unit_id: pcs, hsn: '40151100', gst_rate: 12, mrp: 2500, sale_rate: 1800, purchase_rate: 1500 });
  return { g, box, strip, pcs, sahoo, jena, vizag, kolkata, supplier, wbSupplier, bank, para, amox, ors, gloves };
}

export type Seed = Awaited<ReturnType<typeof seedPharma>>;

export const post = (ctx: Ctx, body: Record<string, unknown>) => ctx.call('POST', '/api/vouchers', body);

/** Batch quantities by batch number, from the server. */
export async function batchQty(ctx: Ctx, itemId: number, asOf = '2027-03-31') {
  const list = await ctx.call<any[]>('GET', `/api/items/${itemId}/batches?asOf=${asOf}`);
  return Object.fromEntries(list.map((b) => [b.batch_no, b.qty]));
}

export async function itemStock(ctx: Ctx, itemId: number, asOf = '2027-03-31') {
  return (await ctx.call<any[]>('GET', `/api/reports/stock-summary?asOf=${asOf}`)).find((s) => s.id === itemId).closing_qty;
}

/** Invariants that must hold after every step. */
export async function checkInvariants(ctx: Ctx, asOf = '2027-03-31') {
  const db = ctx.books.db;
  const bad = db.prepare(`SELECT voucher_id, SUM(amount) s FROM entries GROUP BY voucher_id HAVING SUM(amount)<>0`).all();
  expect(bad, 'every voucher balances').toEqual([]);
  const tb = await ctx.call('GET', `/api/reports/trial-balance?asOf=${asOf}`);
  // Opening balances brought in that do not match show as Tally's 'difference in opening balances'.
  expect(tb.totalDr - tb.totalCr, 'trial balance').toBe(tb.openingDiff);
  // Batch stock adds up to item stock and no batch goes below zero.
  const items = db.prepare(`SELECT id, name FROM items WHERE track_batch=1`).all() as { id: number; name: string }[];
  for (const it of items) {
    const batches = ctx.books.batches(it.id, asOf);
    const sum = Math.round(batches.reduce((a, b) => a + b.qty, 0) * 1000) / 1000;
    const unbatched = (db.prepare(`SELECT COALESCE(SUM(iv.direction*(iv.qty+iv.free_qty)),0) q FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id
      WHERE iv.item_id=? AND iv.batch_id IS NULL AND v.cancelled=0 AND v.optional=0 AND v.date<=?`).get(it.id, asOf) as { q: number }).q;
    expect(sum + unbatched, `batches of ${it.name} add up to its stock`).toBe(ctx.books.stockOf(it.id, asOf));
    for (const b of batches) expect(b.qty, `batch ${b.batch_no} of ${it.name} not negative`).toBeGreaterThanOrEqual(0);
  }
}
