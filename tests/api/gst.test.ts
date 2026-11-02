import { beforeEach, describe, expect, it } from 'vitest';
import { seedDistributor, setup } from './helpers';

let ctx: Awaited<ReturnType<typeof setup>>;
let m: Awaited<ReturnType<typeof seedDistributor>>;

beforeEach(async () => {
  ctx = await setup();
  m = await seedDistributor(ctx.call);
  await ctx.call('POST', '/api/vouchers', {
    type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'PMF/1',
    lines: [{ itemId: m.ghee.id, qty: 500, rate: 55000 }, { itemId: m.curd.id, qty: 300, rate: 4000, batchNo: 'D1', expiryDate: '2026-12-31' }],
  });
});

describe('GSTR-1', () => {
  it('splits B2B, B2C and credit notes in portal format', async () => {
    const b2b = await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000 }, { itemId: m.curd.id, qty: 20, rate: 4500 }] });
    await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-06', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 10, rate: 4500 }] });
    await ctx.call('POST', '/api/vouchers', { type: 'credit_note', date: '2026-10-08', partyId: m.ramesh.id, againstRef: b2b.number, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
    const { json, summary } = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    expect(json.fp).toBe('102026');
    expect(json.b2b).toHaveLength(1);
    const inv = json.b2b[0].inv[0];
    expect(inv.inum).toBe(b2b.number);
    expect(inv.idt).toBe('05-10-2026');
    expect(inv.pos).toBe('21');
    expect(inv.itms.map((i: any) => i.itm_det.rt)).toEqual([5, 12]);
    expect(json.b2cs[0]).toMatchObject({ sply_ty: 'INTRA', pos: '21', rt: 5, txval: 450, camt: 11.25, samt: 11.25 });
    expect(json.cdnr[0].nt[0]).toMatchObject({ ntty: 'C', val: 672 });
    expect(json.hsn.hsn_b2b.find((h: any) => h.hsn_sc === '0405').qty).toBe(10 + 1 - 1); // includes 1 free, less 1 returned
    expect(json.doc_issue.doc_det[0].docs[0]).toMatchObject({ totnum: 2, cancel: 0 });
    expect(summary.invoices).toBe(2);
  });

  it('gives GSTR-3B figures net of input credit', async () => {
    await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000 }] });
    const r = await ctx.call('GET', '/api/gst/gstr3b?period=2026-10');
    expect(r.outward.cgst).toBe(36000);
    expect(r.itc.igst).toBe(500 * 55000 * 0.12 + 300 * 4000 * 0.05);
  });
});

describe('e-Way Bill', () => {
  it('lists bills over ₹50,000 and builds the bulk JSON', async () => {
    await ctx.call('PUT', `/api/ledgers/${m.ramesh.id}`, { city: 'Cuttack', pincode: '753001', address: 'Link Road' });
    const big = await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, vehicleNo: 'od 02 ab 1234', distanceKm: 28, lines: [{ itemId: m.ghee.id, qty: 100, rate: 60000 }] });
    await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 5, rate: 4500 }] });
    const list = await ctx.call<any[]>('GET', '/api/gst/eway-candidates?from=2026-10-01&to=2026-10-31');
    expect(list.map((x) => x.id)).toEqual([big.id]);
    const json = await ctx.call('POST', '/api/gst/eway-json', { ids: [big.id] });
    const b = json.billLists[0];
    expect(b).toMatchObject({ docNo: big.number, docDate: '05/10/2026', fromStateCode: 21, toStateCode: 21, toPincode: 753001, vehicleNo: 'OD02AB1234', transDistance: 28 });
    expect(b.cgstValue).toBe(3600);
    expect(b.itemList[0]).toMatchObject({ hsnCode: 405, cgstRate: 6, sgstRate: 6, igstRate: 0 });
  });
});
