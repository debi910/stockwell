// QA pharma: batch-wise stock (FEFO, overselling a batch, alterations, deletions, expiry).
// Tests whose name starts with "BUG" fail on purpose: they show a confirmed defect.
import { beforeEach, describe, expect, it } from 'vitest';
import { setup } from '../../api/helpers';
import { batchQty, checkInvariants, itemStock, post, raw, seedPharma, type Ctx, type Seed } from './seed';

let ctx: Ctx;
let m: Seed;

beforeEach(async () => {
  ctx = await setup();
  m = await seedPharma(ctx);
  // Two batches of paracetamol: P1 expires first.
  await post(ctx, { type: 'purchase', date: '2026-06-01', partyId: m.supplier.id, refNo: 'UPA/101', lines: [
    { itemId: m.para.id, qty: 100, rate: 2000, batchNo: 'P1', mfgDate: '2026-01-01', expiryDate: '2027-01-31', mrp: 3500 },
    { itemId: m.para.id, qty: 100, rate: 2000, batchNo: 'P2', mfgDate: '2026-03-01', expiryDate: '2027-12-31', mrp: 3600 },
  ] });
});

describe('FEFO picking (works)', () => {
  it('splits a sale over the soonest-expiring batches and keeps invariants', async () => {
    const s = await post(ctx, { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, qty: 150, rate: 2500 }] });
    expect(s.lines.map((l: any) => [l.batch_no, l.qty])).toEqual([['P1', 100], ['P2', 50]]);
    expect(s.taxable).toBe(150 * 2500);
    expect(s.cgst).toBe(Math.round(100 * 2500 * 0.06) + Math.round(50 * 2500 * 0.06));
    expect(await batchQty(ctx, m.para.id)).toEqual({ P1: 0, P2: 50 });
    await checkInvariants(ctx);
  });

  it('skips an expired batch and refuses a sale of an expired batch picked by hand', async () => {
    const s = await post(ctx, { type: 'sales', date: '2027-02-05', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, qty: 10, rate: 2500 }] });
    expect(s.lines[0].batch_no).toBe('P2');
    const p1 = ctx.books.batches(m.para.id).find((b) => b.batch_no === 'P1')!;
    await expect(post(ctx, { type: 'sales', date: '2027-02-05', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, batchId: p1.id, qty: 1, rate: 2500 }] })).rejects.toThrow(/expired/);
  });
});

describe('selling more than a batch holds', () => {
  it('BUG: a sale with a batch picked by hand can take more than that batch holds (batch goes negative)', async () => {
    const p1 = ctx.books.batches(m.para.id).find((b) => b.batch_no === 'P1')!;
    // P1 has 100; item has 200 in all, so the item-level check passes.
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, batchId: p1.id, qty: 150, rate: 2500 }] });
    expect(r.status, 'should refuse: batch P1 has only 100').toBe(400);
    expect(await batchQty(ctx, m.para.id)).toEqual({ P1: 100, P2: 100 });
  });

  it('BUG: a purchase return (debit note) of a picked batch can return more than the batch holds', async () => {
    const p1 = ctx.books.batches(m.para.id).find((b) => b.batch_no === 'P1')!;
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'debit_note', date: '2026-07-01', partyId: m.supplier.id, againstRef: 'UPA/101', lines: [{ itemId: m.para.id, batchId: p1.id, qty: 180, rate: 2000 }] });
    expect(r.status, 'should refuse: batch P1 has only 100').toBe(400);
  });
});

describe('batch stock after alterations and deletions', () => {
  it('BUG: altering a purchase down below what was already sold leaves negative stock', async () => {
    const pur = await post(ctx, { type: 'purchase', date: '2026-08-01', partyId: m.supplier.id, refNo: 'UPA/200', lines: [{ itemId: m.amox.id, qty: 50, rate: 15000, batchNo: 'A1', expiryDate: '2027-08-31' }] });
    await post(ctx, { type: 'sales', date: '2026-08-05', partyId: m.sahoo.id, lines: [{ itemId: m.amox.id, qty: 40, rate: 17000 }] });
    // Accountant corrects the purchase to 10 strips: 40 were already sold from it.
    const r = await raw(ctx, 'PUT', `/api/vouchers/${pur.id}`, { type: 'purchase', date: '2026-08-01', partyId: m.supplier.id, refNo: 'UPA/200', lines: [{ itemId: m.amox.id, qty: 10, rate: 15000, batchNo: 'A1', expiryDate: '2027-08-31' }] });
    expect(r.status, 'should refuse: stock of A1 would be -30').toBe(400);
    expect(await itemStock(ctx, m.amox.id)).toBe(10);
  });

  it('BUG: changing the batch number on a purchase after sales from it leaves the old batch negative', async () => {
    const pur = await post(ctx, { type: 'purchase', date: '2026-08-01', partyId: m.supplier.id, refNo: 'UPA/201', lines: [{ itemId: m.amox.id, qty: 50, rate: 15000, batchNo: 'A1', expiryDate: '2027-08-31' }] });
    await post(ctx, { type: 'sales', date: '2026-08-05', partyId: m.sahoo.id, lines: [{ itemId: m.amox.id, qty: 40, rate: 17000 }] });
    const r = await raw(ctx, 'PUT', `/api/vouchers/${pur.id}`, { type: 'purchase', date: '2026-08-01', partyId: m.supplier.id, refNo: 'UPA/201', lines: [{ itemId: m.amox.id, qty: 50, rate: 15000, batchNo: 'A1X', expiryDate: '2027-08-31' }] });
    expect(r.status, 'should refuse: batch A1 would be -40').toBe(400);
  });

  it('BUG: deleting a purchase passes the check when a LATER purchase restores the year-end stock, though stock went negative in between', async () => {
    const early = await post(ctx, { type: 'purchase', date: '2026-08-01', partyId: m.supplier.id, refNo: 'UPA/300', lines: [{ itemId: m.gloves.id, qty: 100, rate: 1500 }] });
    await post(ctx, { type: 'sales', date: '2026-08-10', partyId: m.sahoo.id, lines: [{ itemId: m.gloves.id, qty: 100, rate: 1800 }] });
    await post(ctx, { type: 'purchase', date: '2026-09-01', partyId: m.supplier.id, refNo: 'UPA/301', lines: [{ itemId: m.gloves.id, qty: 100, rate: 1500 }] });
    const r = await raw(ctx, 'DELETE', `/api/vouchers/${early.id}`);
    expect(r.status, 'should refuse: stock on 10-Aug would be -100').toBe(400);
  });

  it('BUG: a back-dated sale is checked only on its own date, so a later sale is left without stock', async () => {
    await post(ctx, { type: 'purchase', date: '2026-08-01', partyId: m.supplier.id, refNo: 'UPA/400', lines: [{ itemId: m.gloves.id, qty: 100, rate: 1500 }] });
    await post(ctx, { type: 'sales', date: '2026-08-20', partyId: m.sahoo.id, lines: [{ itemId: m.gloves.id, qty: 100, rate: 1800 }] });
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'sales', date: '2026-08-10', partyId: m.jena.id, lines: [{ itemId: m.gloves.id, qty: 50, rate: 1800 }] });
    expect(r.status, 'should refuse (or warn): closing stock would be -50').toBe(400);
    expect(await itemStock(ctx, m.gloves.id)).toBeGreaterThanOrEqual(0);
  });

  it('deleting a sale gives the batch back; deleting the only purchase of a batch removes the batch (works)', async () => {
    const s = await post(ctx, { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, qty: 120, rate: 2500 }] });
    await ctx.call('DELETE', `/api/vouchers/${s.id}`);
    expect(await batchQty(ctx, m.para.id)).toEqual({ P1: 100, P2: 100 });
    const p = await post(ctx, { type: 'purchase', date: '2026-08-01', partyId: m.supplier.id, refNo: 'UPA/500', lines: [{ itemId: m.ors.id, qty: 10, rate: 1400, batchNo: 'O1', expiryDate: '2027-05-31' }] });
    await ctx.call('DELETE', `/api/vouchers/${p.id}`);
    expect(await batchQty(ctx, m.ors.id)).toEqual({});
    await checkInvariants(ctx);
  });
});

describe('batch master data', () => {
  it('BUG: accepts a batch whose expiry is before the purchase date (and before its mfg date)', async () => {
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'purchase', date: '2026-08-01', partyId: m.supplier.id, refNo: 'UPA/600', lines: [
      { itemId: m.ors.id, qty: 10, rate: 1400, batchNo: 'OLD1', mfgDate: '2026-05-01', expiryDate: '2025-12-31' },
    ] });
    expect(r.status, 'expiry 2025-12-31 is before mfg 2026-05-01 and before the bill date').toBe(400);
  });

  it('QUESTIONABLE: a second purchase of the same batch number with a different expiry is silently kept at the first expiry', async () => {
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'purchase', date: '2026-08-01', partyId: m.supplier.id, refNo: 'UPA/700', lines: [{ itemId: m.para.id, qty: 10, rate: 2000, batchNo: 'P1', expiryDate: '2028-06-30' }] });
    const p1 = ctx.books.batches(m.para.id).find((b) => b.batch_no === 'P1')!;
    // Either refuse the mismatch or update; keeping 2027-01-31 silently is a data problem. Stockwell refuses it.
    expect(r.status === 400 || p1.expiry_date !== '2027-01-31').toBe(true);
  });
});

describe('invalid calendar dates', () => {
  it('BUG: a sales bill dated 2026-09-31 (no such day) is saved, and then falls out of both the September and October GSTR-1', async () => {
    await post(ctx, { type: 'purchase', date: '2026-08-01', partyId: m.supplier.id, refNo: 'UPA/800', lines: [{ itemId: m.gloves.id, qty: 10, rate: 1500 }] });
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'sales', date: '2026-09-31', partyId: m.sahoo.id, lines: [{ itemId: m.gloves.id, qty: 1, rate: 1800 }] });
    if (r.status === 200) {
      const sep = await ctx.call('GET', '/api/gst/gstr1?period=2026-09');
      const oct = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
      expect(sep.summary.invoices + oct.summary.invoices, 'the bill is in no return at all').toBe(1);
    }
    expect(r.status, 'should refuse the date 2026-09-31').toBe(400);
  });
});
