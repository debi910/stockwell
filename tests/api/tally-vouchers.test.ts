// TallyPrime voucher types beyond the core eight: orders, rejections, stock journal, physical stock, delete.
import { beforeEach, describe, expect, it } from 'vitest';
import { seedDistributor, setup } from './helpers';

let ctx: Awaited<ReturnType<typeof setup>>;
let m: Awaited<ReturnType<typeof seedDistributor>>;
const stock = async (name: string) =>
  (await ctx.call<any[]>('GET', '/api/reports/stock-summary?asOf=2027-03-31')).find((s) => s.name === name).closing_qty;
const ledgerCount = () => (ctx.books.db.prepare(`SELECT COUNT(*) n FROM entries`).get() as { n: number }).n;

beforeEach(async () => {
  ctx = await setup();
  m = await seedDistributor(ctx.call);
  await ctx.call('POST', '/api/vouchers', { type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'SUP-1', lines: [{ itemId: m.ghee.id, qty: 100, rate: 50000 }] });
  await ctx.call('POST', '/api/vouchers', { type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'SUP-1B', lines: [{ itemId: m.curd.id, qty: 100, rate: 2000, batchNo: 'C1', expiryDate: '2027-06-30' }] });
});

describe('TallyPrime voucher types', () => {
  it('a Sales Order changes neither stock nor the books', async () => {
    const before = [await stock(m.ghee.name), ledgerCount()];
    const so = await ctx.call('POST', '/api/vouchers', { type: 'sales_order', date: '2026-10-02', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 500, rate: 60000 }] });
    expect(so.number).toMatch(/^SO\//);
    expect([await stock(m.ghee.name), ledgerCount()]).toEqual(before);
  });

  it('Rejection Out takes stock out with no ledger entry, and cannot take more than there is', async () => {
    const n = ledgerCount();
    const before0 = await stock(m.ghee.name);
    await ctx.call('POST', '/api/vouchers', { type: 'rejection_out', date: '2026-10-03', partyId: m.supplier.id, lines: [{ itemId: m.ghee.id, qty: 4, rate: 50000 }] });
    expect(await stock(m.ghee.name)).toBe(before0 - 4);
    expect(ledgerCount()).toBe(n);
    await expect(ctx.call('POST', '/api/vouchers', { type: 'rejection_out', date: '2026-10-03', partyId: m.supplier.id, lines: [{ itemId: m.ghee.id, qty: 100000, rate: 1 }] })).rejects.toThrow(/Not enough stock/);
  });

  it('Rejection In brings goods back into a batch', async () => {
    const start = await stock(m.ghee.name);
    const c0 = await stock(m.curd.name);
    await ctx.call('POST', '/api/vouchers', { type: 'rejection_in', date: '2026-10-04', partyId: m.ramesh.id, lines: [{ itemId: m.curd.id, qty: 2, rate: 2500, batchNo: 'C1' }] });
    expect(await stock(m.curd.name)).toBe(c0 + 2);
    expect(start).toBe(await stock(m.ghee.name));
  });

  it('a Stock Journal writes off damaged stock', async () => {
    const start = await stock(m.ghee.name);
    await ctx.call('POST', '/api/vouchers', { type: 'stock_journal', date: '2026-10-05', narration: 'Leaked tins', lines: [{ itemId: m.ghee.id, qty: 3, direction: 'out' }] });
    expect(await stock(m.ghee.name)).toBe(start - 3);
    await expect(ctx.call('POST', '/api/vouchers', { type: 'stock_journal', date: '2026-10-05', lines: [{ itemId: m.ghee.id, qty: 3 }] })).rejects.toThrow(/in or out/);
  });

  it('Physical Stock posts the difference between the count and the books', async () => {
    const batch = ctx.books.batches(m.curd.id).find((b) => b.batch_no === 'C1')!;
    const ps = await ctx.call('POST', '/api/vouchers', { type: 'physical_stock', date: '2026-10-06', lines: [{ itemId: m.curd.id, batchId: batch.id, qty: 90 }, { itemId: m.ghee.id, qty: 50 }] });
    expect(ps.number).toMatch(/^PS\//);
    expect(ctx.books.batches(m.curd.id).find((b) => b.batch_no === 'C1')!.qty).toBe(90);
    expect(await stock(m.ghee.name)).toBe(50);
    await expect(ctx.call('POST', '/api/vouchers', { type: 'physical_stock', date: '2026-10-06', lines: [{ itemId: m.curd.id, batchId: batch.id, qty: 90 }] })).rejects.toThrow(/nothing to post/);
  });

  it('Alt+D deletes a voucher, keeps a copy in the edit log, and GSTR-1 counts the gap as cancelled', async () => {
    const sale = (n: number) => ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-10', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: n, rate: 60000, freeQty: 0 }] });
    const a = await sale(1); const b = await sale(1); const c = await sale(1);
    await ctx.call('DELETE', `/api/vouchers/${b.id}`);
    const log = await ctx.call<any[]>('GET', '/api/audit');
    expect(log.some((r) => r.action === 'delete' && r.entity_id === b.id)).toBe(true);
    const g = (await ctx.call('GET', '/api/gst/gstr1?period=2026-10')).json;
    const docs = g.doc_issue.doc_det[0].docs[0];
    expect(docs).toMatchObject({ from: a.number, to: c.number, totnum: 3, cancel: 1, net_issue: 2 });
  });

  it('will not delete or cancel a purchase whose stock was already sold', async () => {
    const p2 = await ctx.call('POST', '/api/vouchers', { type: 'purchase', date: '2026-10-11', partyId: m.supplier.id, refNo: 'SUP-2', lines: [{ itemId: m.ghee.id, qty: 10, rate: 50000 }] });
    await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-12', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: await stock(m.ghee.name), rate: 60000, freeQty: 0 }] });
    await expect(ctx.call('DELETE', `/api/vouchers/${p2.id}`)).rejects.toThrow(/below zero/);
    await expect(ctx.call('POST', `/api/vouchers/${p2.id}/cancel`)).rejects.toThrow(/below zero/);
  });
});

describe('Trial Balance', () => {
  it('group totals add up to the same Grand Total on both sides', async () => {
    await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-10', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 3, rate: 60000, freeQty: 0 }] });
    await ctx.call('POST', '/api/vouchers', { type: 'receipt', date: '2026-10-11', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: 50000 }] });
    const tb = await ctx.call('GET', '/api/reports/trial-balance?asOf=2026-10-31');
    let dr = 0; let cr = 0;
    const add = (v: number) => { if (v > 0) dr += v; else cr -= v; };
    for (const g of tb.tree) add(g.balance);
    add(tb.profitLossAc); add(tb.openingStock); add(-tb.openingDiff);
    expect(dr).toBe(cr);
  });
});
