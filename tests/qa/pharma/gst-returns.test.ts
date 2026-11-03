// QA pharma: GST math, dated rate changes, IGST vs CGST/SGST, B2B/B2C/B2CL, HSN summary, rejections and notes, MRP print, alt units.
// Tests whose name starts with "BUG" fail on purpose: they show a confirmed defect.
import { beforeEach, describe, expect, it } from 'vitest';
import { setup } from '../../api/helpers';
import { batchQty, checkInvariants, post, raw, seedPharma, type Ctx, type Seed } from './seed';

let ctx: Ctx;
let m: Seed;

beforeEach(async () => {
  ctx = await setup();
  m = await seedPharma(ctx);
  await post(ctx, { type: 'purchase', date: '2026-06-01', partyId: m.supplier.id, refNo: 'UPA/101', lines: [
    { itemId: m.para.id, qty: 5000, rate: 2000, batchNo: 'P1', expiryDate: '2027-01-31', mrp: 3500 },
    { itemId: m.amox.id, qty: 500, rate: 15000, batchNo: 'A1', expiryDate: '2027-06-30', mrp: 22000 },
    { itemId: m.ors.id, qty: 1000, rate: 1400, batchNo: 'O1', expiryDate: '2026-12-31', mrp: 2100 },
    { itemId: m.gloves.id, qty: 1000, rate: 1500 },
  ] });
});

describe('intra vs inter-state, B2B vs B2C (works)', () => {
  it('charges CGST+SGST in Odisha and IGST to Andhra, and files each in the right table', async () => {
    const local = await post(ctx, { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.amox.id, qty: 7, rate: 16999, discountPct: 2.5 }] });
    const gross = 7 * 16999; const taxable = gross - Math.round(gross * 0.025);
    expect(local.taxable).toBe(taxable);
    expect(local.cgst).toBe(Math.round(taxable * 0.06));
    expect(local.sgst).toBe(local.cgst);
    expect(local.igst).toBe(0);
    const ap = await post(ctx, { type: 'sales', date: '2026-07-02', partyId: m.vizag.id, lines: [{ itemId: m.amox.id, qty: 10, rate: 17000 }, { itemId: m.ors.id, qty: 30, rate: 1600 }] });
    expect(ap.igst).toBe(Math.round(170000 * 0.12) + Math.round(48000 * 0.05));
    expect(ap.cgst + ap.sgst).toBe(0);
    const wbSmall = await post(ctx, { type: 'sales', date: '2026-07-03', partyId: m.kolkata.id, lines: [{ itemId: m.ors.id, qty: 10, rate: 1600 }] });
    expect(wbSmall.igst).toBe(800);
    const wbLarge = await post(ctx, { type: 'sales', date: '2026-07-04', partyId: m.kolkata.id, lines: [{ itemId: m.amox.id, qty: 480, rate: 25000 }] });
    const jena = await post(ctx, { type: 'sales', date: '2026-07-05', partyId: m.jena.id, lines: [{ itemId: m.para.id, qty: 20, rate: 2500 }] });
    const g = await ctx.call('GET', '/api/gst/gstr1?period=2026-07');
    expect(g.json.b2b.map((x: any) => x.ctin).sort()).toEqual([ctx.books.ledger(m.sahoo.id).gstin, ctx.books.ledger(m.vizag.id).gstin].sort());
    expect(g.json.b2b.find((x: any) => x.ctin.startsWith('37')).inv[0].pos).toBe('37');
    expect(g.json.b2cl[0].pos).toBe('19');
    expect(g.json.b2cl[0].inv[0].inum).toBe(wbLarge.number);
    expect(g.json.b2cs.find((x: any) => x.pos === '19')).toMatchObject({ sply_ty: 'INTER', rt: 5, txval: 160, iamt: 8 });
    expect(g.json.b2cs.find((x: any) => x.pos === '21')).toMatchObject({ sply_ty: 'INTRA', rt: 12, txval: 500, camt: 30, samt: 30 });
    const g3 = await ctx.call('GET', '/api/gst/gstr3b?period=2026-07');
    expect(g3).toBeTruthy();
    expect(jena.party_gstin).toBe('');
    await checkInvariants(ctx);
  });
});

describe('dated GST rate change (works)', () => {
  it('old bills keep 12%, new bills use 5%, alteration of an old bill keeps 12%, and a credit note on the old bill keeps 12%', async () => {
    const old = await post(ctx, { type: 'sales', date: '2026-09-30', partyId: m.sahoo.id, lines: [{ itemId: m.gloves.id, qty: 10, rate: 1800 }] });
    await ctx.call('POST', '/api/items/gst-rate', { itemIds: [m.gloves.id], rate: 5, from: '2026-10-01' });
    const nw = await post(ctx, { type: 'sales', date: '2026-10-01', partyId: m.sahoo.id, lines: [{ itemId: m.gloves.id, qty: 10, rate: 1800 }] });
    expect(nw.lines[0].gst_rate).toBe(5);
    const altered = await ctx.call('PUT', `/api/vouchers/${old.id}`, { type: 'sales', date: '2026-09-30', partyId: m.sahoo.id, lines: [{ itemId: m.gloves.id, qty: 12, rate: 1800 }] });
    expect(altered.lines[0].gst_rate).toBe(12);
    const cn = await post(ctx, { type: 'credit_note', date: '2026-10-10', partyId: m.sahoo.id, againstRef: old.number, lines: [{ itemId: m.gloves.id, qty: 2, rate: 1800 }] });
    expect(cn.lines[0].gst_rate).toBe(12);
    expect(cn.cgst).toBe(Math.round(3600 * 0.06));
    const g = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    const hsn = g.json.hsn.hsn_b2b;
    expect(hsn.find((h: any) => h.rt === 5)).toMatchObject({ qty: 10, txval: 180 });
    expect(hsn.find((h: any) => h.rt === 12)).toMatchObject({ qty: -2, txval: -36 });
    await checkInvariants(ctx);
  });
});

describe('rejection in / out and the notes made against them', () => {
  it('Rejection In then Credit Note against it moves stock once (works)', async () => {
    const s = await post(ctx, { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.amox.id, qty: 20, rate: 17000 }] });
    const before = await batchQty(ctx, m.amox.id);
    const ri = await post(ctx, { type: 'rejection_in', date: '2026-07-10', partyId: m.sahoo.id, lines: [{ itemId: m.amox.id, qty: 5, rate: 17000, batchNo: 'A1' }] });
    expect((await batchQty(ctx, m.amox.id)).A1).toBe(before.A1 + 5);
    const cn = await post(ctx, { type: 'credit_note', date: '2026-07-12', partyId: m.sahoo.id, againstId: ri.id, againstRef: s.number, lines: [{ itemId: m.amox.id, qty: 5, rate: 17000 }] });
    expect((await batchQty(ctx, m.amox.id)).A1).toBe(before.A1 + 5);
    expect(cn.cgst).toBe(Math.round(85000 * 0.06));
    const due = await ctx.call<any[]>('GET', `/api/reports/pending-bills/${m.sahoo.id}?asOf=2026-07-31`);
    expect(due.find((b) => b.ref === s.number).pending).toBe(s.total - cn.total);
    await expect(ctx.call('POST', `/api/vouchers/${ri.id}/cancel`)).rejects.toThrow(/made against/);
    await checkInvariants(ctx);
  });

  it('Rejection Out of a near-expiry batch then a Debit Note against it moves stock once (works)', async () => {
    const o1 = ctx.books.batches(m.ors.id).find((b) => b.batch_no === 'O1')!;
    const ro = await post(ctx, { type: 'rejection_out', date: '2026-11-01', partyId: m.supplier.id, lines: [{ itemId: m.ors.id, batchId: o1.id, qty: 400, rate: 1400 }] });
    expect((await batchQty(ctx, m.ors.id)).O1).toBe(600);
    const dn = await post(ctx, { type: 'debit_note', date: '2026-11-02', partyId: m.supplier.id, againstId: ro.id, againstRef: 'UPA/101', lines: [{ itemId: m.ors.id, qty: 400, rate: 1400 }] });
    expect((await batchQty(ctx, m.ors.id)).O1).toBe(600);
    expect(dn.cgst).toBe(Math.round(560000 * 0.025));
    await checkInvariants(ctx);
  });

  it('BUG: a Credit Note made against a Rejection In may be for a different item or more quantity than came back', async () => {
    const s = await post(ctx, { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.amox.id, qty: 20, rate: 17000 }] });
    const ri = await post(ctx, { type: 'rejection_in', date: '2026-07-10', partyId: m.sahoo.id, lines: [{ itemId: m.amox.id, qty: 2, rate: 17000, batchNo: 'A1' }] });
    // 2 strips came back, but the note credits 20 strips of a different item; stock is not touched at all.
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'credit_note', date: '2026-07-12', partyId: m.sahoo.id, againstId: ri.id, againstRef: s.number, lines: [{ itemId: m.para.id, qty: 20, rate: 2500 }] });
    expect(r.status, 'note should match the goods that came back').toBe(400);
  });

  it('QUESTIONABLE: an expired batch cannot be returned to the supplier by a plain debit note unless the batch is picked by hand', async () => {
    // ORS batch O1 expires 2026-12-31; returning it in January after expiry.
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'debit_note', date: '2027-01-10', partyId: m.supplier.id, againstRef: 'UPA/101', lines: [{ itemId: m.ors.id, qty: 100, rate: 1400 }] });
    expect(r.status).toBe(200);
  });
});

describe('alternate units (strip / box)', () => {
  it('BUG: selling boxes whose rate does not divide by the strips per box gets the taxable value wrong by paise', async () => {
    // Moxikind packed 15 strips to a box, ₹1,000 a box: 300 boxes must be ₹3,00,000.00 exactly.
    await ctx.call('PUT', `/api/items/${m.amox.id}`, { alt_unit_id: m.box, alt_conv: 15 });
    await post(ctx, { type: 'purchase', date: '2026-06-02', partyId: m.supplier.id, refNo: 'UPA/103', lines: [{ itemId: m.amox.id, qty: 5000, rate: 15000, batchNo: 'A2', expiryDate: '2027-09-30' }] });
    const s = await post(ctx, { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.amox.id, qty: 300, unit: 'alt', rate: 100000 }] });
    expect(s.lines.reduce((a: number, l: any) => a + l.qty, 0)).toBe(4500);
    expect(s.taxable, '300 boxes × ₹1,000').toBe(300 * 100000);
  });

  it('BUG: a box sale split over two batches loses the box quantity on the bill', async () => {
    await post(ctx, { type: 'purchase', date: '2026-06-02', partyId: m.supplier.id, refNo: 'UPA/102', lines: [{ itemId: m.para.id, qty: 100, rate: 2000, batchNo: 'P0', expiryDate: '2026-12-31' }] });
    const s = await post(ctx, { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, qty: 15, unit: 'alt', rate: 25000 }] });
    expect(s.lines.length).toBe(2);
    const boxes = s.lines.reduce((a: number, l: any) => a + (l.alt_qty ?? 0), 0);
    expect(boxes, 'the bill should still say 15 Box (10 + 5)').toBe(15);
  });
});

describe('MRP on the printed bill', () => {
  it('prints the batch MRP (works)', async () => {
    const s = await post(ctx, { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.amox.id, qty: 1, rate: 17000 }] });
    const html = (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${s.id}/print` })).body;
    expect(html).toContain('220.00');
    expect(html).toContain('Batch A1');
  });

  it('BUG: reprinting an old bill shows a NEW MRP after a later purchase of the same batch changes it', async () => {
    const s = await post(ctx, { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.amox.id, qty: 1, rate: 17000 }] });
    await post(ctx, { type: 'purchase', date: '2026-08-01', partyId: m.supplier.id, refNo: 'UPA/900', lines: [{ itemId: m.amox.id, qty: 10, rate: 15000, batchNo: 'A1', mrp: 24500 }] });
    const v = await ctx.call('GET', `/api/vouchers/${s.id}`);
    expect(v.lines[0].mrp, 'the July bill was printed with MRP ₹220').toBe(22000);
    const html = (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${s.id}/print` })).body;
    expect(html).not.toContain('245.00');
  });
});

describe('B2C credit notes and HSN summary', () => {
  it('a credit note to an unregistered inter-state chemist reduces B2CS for that state (works)', async () => {
    const s = await post(ctx, { type: 'sales', date: '2026-07-03', partyId: m.kolkata.id, lines: [{ itemId: m.ors.id, qty: 100, rate: 1600 }] });
    await post(ctx, { type: 'credit_note', date: '2026-07-20', partyId: m.kolkata.id, againstRef: s.number, lines: [{ itemId: m.ors.id, qty: 10, rate: 1600, batchNo: 'O1' }] });
    const g = await ctx.call('GET', '/api/gst/gstr1?period=2026-07');
    expect(g.json.b2cs).toEqual([expect.objectContaining({ sply_ty: 'INTER', pos: '19', rt: 5, txval: 1440, iamt: 72 })]);
    expect(g.json.hsn.hsn_b2c[0]).toMatchObject({ hsn_sc: '30049011', qty: 90, txval: 1440, iamt: 72 });
  });
});
