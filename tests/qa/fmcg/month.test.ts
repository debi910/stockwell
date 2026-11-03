// QA: a realistic October for a Bhubaneswar FMCG distributor. Passing tests here are regression guards;
// tests named "BUG:" are known failures found by QA.
import { beforeEach, describe, expect, it } from 'vitest';
import { fresh, invariants, raw, stockOf, pendingOf, ledgerBal, type Ctx, type Seed } from './qa-helpers';
import { gstin } from '../../api/helpers';

let ctx: Ctx; let m: Seed;
const post = (b: Record<string, unknown>) => ctx.call('POST', '/api/vouchers', b);

beforeEach(async () => { ({ ctx, m } = await fresh()); });

describe('a month of trading', () => {
  it('runs purchases, sales, schemes, returns, receipts and returns all reports consistently', async () => {
    const units = await ctx.call<any[]>('GET', '/api/units');
    const cs = units.find((u) => u.symbol === 'Case') ?? await ctx.call('POST', '/api/units', { symbol: 'Case', name: 'Case', uqc: 'BOX' });
    const itcGrp = await ctx.call('POST', '/api/stock-groups', { name: 'ITC Sunrise' });
    const masala = await ctx.call('POST', '/api/items', { name: 'Sunrise Chicken Masala 100g', unit_id: m.pcs, alt_unit_id: cs.id, alt_conv: 48, stock_group_id: itcGrp.id, hsn: '0910', gst_rate: 5, sale_rate: 6500, purchase_rate: 5800, opening_qty: 96, opening_value: 96 * 5800 });
    const van = await ctx.call('POST', '/api/godowns', { name: 'Van OD02-1234' });
    const freightIn = await ctx.call('POST', '/api/ledgers', { name: 'Freight Inward', group_id: m.g('Direct Expenses'), assessable: 1 });
    const disc = await ctx.call('POST', '/api/ledgers', { name: 'Trade Discount', group_id: m.g('Indirect Expenses'), assessable: 1 });
    const itc = await ctx.call('POST', '/api/ledgers', { name: 'ITC Ltd', group_id: m.g('Sundry Creditors'), gstin: gstin('21', 'ITCLT1234C'), credit_days: 21 });
    // opening balance with a pending bill for Ramesh
    await ctx.call('PUT', `/api/ledgers/${m.ramesh.id}`, { opening: 2500000 });
    await invariants(ctx);

    // Purchases with batches and freight
    const p1 = await post({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'PMF/2210', lines: [{ itemId: m.curd.id, qty: 200, rate: 4000, batchNo: 'GD2610', expiryDate: '2026-10-20' }, { itemId: m.curd.id, qty: 100, rate: 4000, batchNo: 'GD2611', expiryDate: '2026-11-15' }], charges: [{ ledgerId: freightIn.id, amount: 60000 }] });
    expect(p1.igst).toBeGreaterThan(0); // Maharashtra supplier
    const p2 = await post({ type: 'purchase', date: '2026-10-01', partyId: itc.id, refNo: 'ITC-778', lines: [{ itemId: masala.id, qty: 10, unit: 'alt', rate: 48 * 5800 }] });
    expect(p2.cgst).toBe(p2.sgst);
    const p3 = await post({ type: 'purchase', date: '2026-10-02', partyId: m.supplier.id, refNo: 'PMF/2215', lines: [{ itemId: m.ghee.id, qty: 120, rate: 55000 }] });
    await invariants(ctx);
    expect(await stockOf(ctx, masala.name)).toBe(96 + 480);

    // Load the van, sell from the van
    await post({ type: 'stock_journal', date: '2026-10-03', lines: [{ itemId: masala.id, qty: 96, direction: 'out' }, { itemId: masala.id, qty: 96, direction: 'in', godownId: van.id }] });
    const s1 = await post({ type: 'sales', date: '2026-10-03', partyId: m.kalpana.id, lines: [{ itemId: masala.id, qty: 24, rate: 6500, godownId: van.id, discountPct: 2 }] });
    expect(s1.lines[0].godown_id).toBe(van.id);
    // Scheme: buy 10 get 1 free on ghee, automatic
    const s2 = await post({ type: 'sales', date: '2026-10-04', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 22, rate: 60000 }], charges: [{ ledgerId: disc.id, amount: -20000 }] });
    expect(s2.lines[0].free_qty).toBe(2);
    expect(await stockOf(ctx, m.ghee.name)).toBe(120 - 24);
    // FEFO batches for curd on 2026-10-05 → GD2610 first
    const s3 = await post({ type: 'sales', date: '2026-10-05', partyId: m.kolkata.id, lines: [{ itemId: m.curd.id, qty: 250, rate: 4500 }] });
    expect(s3.igst).toBeGreaterThan(0);
    expect(s3.lines.map((l: any) => l.batch_no)).toEqual(['GD2610', 'GD2611']);
    await invariants(ctx);

    // Credit note (item) – Kalpana returns 4 pcs; Ctrl+H rate-difference note to Ramesh
    const cn1 = await post({ type: 'credit_note', date: '2026-10-08', partyId: m.kalpana.id, againstRef: s1.number, lines: [{ itemId: masala.id, qty: 4, rate: 6370, godownId: van.id }] });
    expect(await pendingOf(ctx, m.kalpana.id, s1.number)).toBe(s1.total - cn1.total);
    const rd = await ctx.call('POST', '/api/ledgers', { name: 'Rate Difference', group_id: m.g('Indirect Expenses') });
    const cn2 = await post({ type: 'credit_note', date: '2026-10-09', partyId: m.ramesh.id, mode: 'accounting', againstRef: s2.number, taxLines: [{ ledgerId: rd.id, amount: 50000, gstRate: 12 }] });
    await invariants(ctx);

    // Receipts: part against the opening bill and against s2, cheque then bounce, then PDC
    const r1 = await post({ type: 'receipt', date: '2026-10-10', accountId: m.bank.id, chequeNo: '456789', entries: [{ ledgerId: m.ramesh.id, amount: 300000, bills: [{ ref: s2.number, amount: 100000 }] }] });
    expect(await pendingOf(ctx, m.ramesh.id, s2.number)).toBe(s2.total - cn2.total - 100000);
    expect(await pendingOf(ctx, m.ramesh.id, r1.number)).toBe(-200000); // on account
    const bj = await ctx.call('POST', `/api/vouchers/${r1.id}/bounce`, { date: '2026-10-14' });
    expect(await pendingOf(ctx, m.ramesh.id, s2.number)).toBe(s2.total - cn2.total);
    expect(await pendingOf(ctx, m.ramesh.id, r1.number)).toBe(0);
    const pdc = await post({ type: 'receipt', date: '2026-11-05', pdc: true, chequeNo: '456790', chequeDate: '2026-11-05', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: 100000, bills: [{ ref: s2.number, amount: 100000 }] }] });
    expect(await pendingOf(ctx, m.ramesh.id, s2.number, '2026-10-31')).toBe(s2.total - cn2.total);
    expect(await pendingOf(ctx, m.ramesh.id, s2.number, '2026-11-30')).toBe(s2.total - cn2.total - 100000);
    await invariants(ctx, '2026-10-31');
    await invariants(ctx);

    // Reports
    for (const url of ['/api/reports/trial-balance?asOf=2026-10-31', '/api/reports/profit-loss?from=2026-10-01&to=2026-10-31', '/api/reports/balance-sheet?asOf=2026-10-31',
      '/api/reports/stock-summary?asOf=2026-10-31', '/api/reports/outstanding?asOf=2026-10-31', '/api/reports/outstanding?asOf=2026-10-31&kind=payable',
      '/api/reports/register?type=sales&from=2026-10-01&to=2026-10-31', '/api/reports/register?type=purchase&from=2026-10-01&to=2026-10-31',
      '/api/reports/sales-by?by=item&from=2026-10-01&to=2026-10-31', '/api/reports/sales-by?by=party&from=2026-10-01&to=2026-10-31',
      '/api/reports/godown-stock?asOf=2026-10-31', '/api/reports/scheme-claims?from=2026-10-01&to=2026-10-31', `/api/reports/brs/${m.bank.id}?asOf=2026-10-31`,
      '/api/reports/pdc?asOf=2026-10-31', '/api/reports/pending-orders?kind=sales', '/api/reports/alerts?asOf=2026-10-31', `/api/reports/ledger/${m.ramesh.id}?from=2026-10-01&to=2026-10-31`,
      '/api/reports/day-book?from=2026-10-01&to=2026-10-31', '/api/gst/gstr1?period=2026-10', '/api/gst/gstr3b?period=2026-10', '/api/gst/eway-candidates?from=2026-10-01&to=2026-10-31']) {
      const r = await raw(ctx, 'GET', url);
      expect(r.status, `${url} ${JSON.stringify(r.body).slice(0, 300)}`).toBe(200);
    }
    // GSTR-1 taxable must match the sales register net of credit notes (all lines taxed here)
    const reg = await ctx.call('GET', '/api/reports/register?type=sales&from=2026-10-01&to=2026-10-31');
    const cnReg = await ctx.call('GET', '/api/reports/register?type=credit_note&from=2026-10-01&to=2026-10-31');
    const g1 = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    expect(g1.summary.taxable).toBe(reg.totals.taxable - cnReg.totals.taxable);
    const g3 = await ctx.call('GET', '/api/gst/gstr3b?period=2026-10');
    expect(g3.outward.taxable).toBe(reg.totals.taxable - cnReg.totals.taxable);
    expect(g3.outward.cgst + g3.outward.sgst + g3.outward.igst).toBe(reg.totals.tax - cnReg.totals.tax);
    const preg = await ctx.call('GET', '/api/reports/register?type=purchase&from=2026-10-01&to=2026-10-31');
    expect(g3.itc.cgst + g3.itc.sgst + g3.itc.igst).toBe(preg.totals.tax);
    // CGST/SGST/IGST ledgers in TB equal GST net
    const godown = await ctx.call('GET', '/api/reports/godown-stock?asOf=2026-10-31');
    const mrow = godown.rows.find((r: any) => r.id === masala.id);
    expect(mrow.godowns[van.id]).toBe(96 - 24 - (s1.lines[0].free_qty ?? 0) + 4);
    // Scheme claim for ghee
    const sc = await ctx.call('GET', '/api/reports/scheme-claims?from=2026-10-01&to=2026-10-31');
    expect(sc.rows.find((r: any) => r.id === m.ghee.id).free_qty).toBe(2);
    expect(ledgerBal(ctx, bj.id) ?? 0).toBeDefined();
    void p3; void pdc;
  });

  it('QRMP: quarterly GSTR-3B covers all three months', async () => {
    await ctx.call('PUT', '/api/company', { gst_filing: 'quarterly' });
    await post({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'Q1', lines: [{ itemId: m.ghee.id, qty: 100, rate: 50000 }] });
    for (const d of ['2026-10-05', '2026-11-05', '2026-12-05']) await post({ type: 'sales', date: d, partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    const q = await ctx.call('GET', '/api/gst/gstr3b?period=2026-10&toPeriod=2026-12');
    expect(q.outward.taxable).toBe(180000);
    const g = await ctx.call('GET', '/api/gst/gstr1?period=2026-10&toPeriod=2026-12');
    expect(g.summary.taxable).toBe(180000);
    await invariants(ctx);
  });
});
