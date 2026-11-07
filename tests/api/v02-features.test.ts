// v0.2: the rest of TallyPrime's features, each checked against the books, stock and GST returns.
import { beforeEach, describe, expect, it } from 'vitest';
import { gstin, seedDistributor, setup } from './helpers';

let ctx: Awaited<ReturnType<typeof setup>>;
let m: Awaited<ReturnType<typeof seedDistributor>>;
const post = (body: Record<string, unknown>) => ctx.call('POST', '/api/vouchers', body);
const stock = async (name: string) =>
  (await ctx.call<any[]>('GET', '/api/reports/stock-summary?asOf=2027-03-31')).find((s) => s.name === name).closing_qty;
const balance = (ledgerId: number) => (ctx.books.db.prepare(`SELECT l.opening + COALESCE((SELECT SUM(e.amount) FROM entries e JOIN vouchers v ON v.id=e.voucher_id
  WHERE e.ledger_id=l.id AND v.cancelled=0 AND v.optional=0),0) b FROM ledgers l WHERE l.id=?`).get(ledgerId) as { b: number }).b;
const balanced = () => (ctx.books.db.prepare(`SELECT COALESCE(SUM(e.amount),0) s FROM entries e`).get() as { s: number }).s === 0;
const ledger = async (name: string, group: string, extra: Record<string, unknown> = {}) => ctx.call('POST', '/api/ledgers', { name, group_id: m.g(group), ...extra });

beforeEach(async () => {
  ctx = await setup();
  m = await seedDistributor(ctx.call);
  await post({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'SUP-1', lines: [{ itemId: m.ghee.id, qty: 100, rate: 50000 }] });
  await post({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'SUP-2', lines: [{ itemId: m.curd.id, qty: 100, rate: 2000, batchNo: 'C1', expiryDate: '2027-06-30' }] });
});

describe('credit and debit notes with no items (Ctrl+H, accounting mode)', () => {
  it('posts a rate-difference credit note with GST, against the bill, and reports it in GSTR-1 with the bill HSN', async () => {
    const sale = await post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000, freeQty: 0 }] });
    const disc = await ledger('Rate Difference Allowed', 'Indirect Expenses');
    const cn = await post({ type: 'credit_note', date: '2026-10-20', partyId: m.ramesh.id, mode: 'accounting', againstRef: sale.number, taxLines: [{ ledgerId: disc.id, amount: 100000, gstRate: 12 }] });
    expect(cn.mode).toBe('accounting');
    expect(cn.taxable).toBe(100000);
    expect(cn.cgst + cn.sgst).toBe(12000);
    expect(cn.total).toBe(112000);
    expect(cn.taxLines[0].hsn).toBe('0405');
    expect(balance(disc.id)).toBe(100000);
    expect(balanced()).toBe(true);
    const pending = await ctx.call<any[]>('GET', `/api/reports/pending-bills/${m.ramesh.id}?asOf=2026-10-31`);
    expect(pending.find((b) => b.ref === sale.number).pending).toBe(sale.total - 112000);
    const g = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    const nt = g.json.cdnr[0].nt[0];
    expect(nt.nt_num).toBe(cn.number);
    expect(nt.itms[0].itm_det.txval).toBe(1000);
    expect(g.json.hsn.hsn_b2b.filter((h: any) => h.hsn_sc === '0405').reduce((a: number, h: any) => a + h.txval, 0)).toBe(6000 - 1000);
    expect(g.json.hsn.hsn_b2b.find((h: any) => h.uqc === 'NA')).toMatchObject({ hsn_sc: '0405', qty: 0, txval: -1000 });
  });

  it('keeps a cash-discount credit note with no GST out of the GST returns', async () => {
    const sale = await post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    const cd = await ledger('Cash Discount', 'Indirect Expenses');
    const cn = await post({ type: 'credit_note', date: '2026-10-06', partyId: m.ramesh.id, mode: 'accounting', againstRef: sale.number, taxLines: [{ ledgerId: cd.id, amount: 1500 }] });
    expect(cn.total).toBe(1500);
    const g = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    expect(g.json.cdnr).toBeUndefined();
    expect(g.json.doc_issue.doc_det.find((d: any) => d.doc_num === 5)).toBeUndefined();
    const g3 = await ctx.call('GET', '/api/gst/gstr3b?period=2026-10');
    expect(g3.outward.taxable).toBe(60000);
  });

  it('refuses a GST line on a sales-side note without an HSN, and lines that use the GST ledgers', async () => {
    const svc = await ledger('Service Charges', 'Indirect Incomes');
    await expect(post({ type: 'credit_note', date: '2026-10-06', partyId: m.ramesh.id, mode: 'accounting', taxLines: [{ ledgerId: svc.id, amount: 1000, gstRate: 18 }] })).rejects.toThrow(/HSN/);
    const cgst = ctx.books.taxLedger('cgst');
    await expect(post({ type: 'sales', date: '2026-10-06', partyId: m.ramesh.id, mode: 'accounting', taxLines: [{ ledgerId: cgst.id, amount: 1000 }] })).rejects.toThrow(/calculated by Stockwell/);
    const s = await post({ type: 'sales', date: '2026-10-06', partyId: m.ramesh.id, mode: 'accounting', taxLines: [{ ledgerId: svc.id, amount: 100000, gstRate: 18, hsn: '998599' }] });
    expect(s.total).toBe(118000);
    expect(balanced()).toBe(true);
  });
});

describe('extra ledgers on a bill: freight, discount, TCS and round off', () => {
  it('spreads freight over the items, taxes it at each item rate, and keeps the books balanced', async () => {
    const freight = await ledger('Freight Outward', 'Indirect Incomes', { assessable: 1 });
    const s = await post({ type: 'sales', date: '2026-10-07', partyId: m.ramesh.id, lines: [
      { itemId: m.ghee.id, qty: 10, rate: 60000, freeQty: 0 }, // ₹6,000 at 12%
      { itemId: m.curd.id, qty: 40, rate: 5000 },             // ₹2,000 at 5%
    ], charges: [{ ledgerId: freight.id, amount: 40000 }] });  // ₹400 freight → ₹300 + ₹100
    expect(s.taxable).toBe(840000);
    expect(s.lines[0].taxable).toBe(630000);
    expect(s.lines[0].base_taxable).toBe(600000);
    expect(s.lines[1].taxable).toBe(210000);
    expect(s.cgst).toBe(Math.round(630000 * 0.06) + Math.round(210000 * 0.025));
    expect(balance(freight.id)).toBe(-40000);
    expect(s.charges[0].amount).toBe(40000);
    expect(balanced()).toBe(true);
    const g = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    expect(g.json.b2b[0].inv[0].itms.reduce((a: number, x: any) => a + x.itm_det.txval, 0)).toBe(8400);
  });

  it('takes a trade discount off the taxable value and adds TCS after tax', async () => {
    const disc = await ledger('Trade Discount', 'Indirect Expenses', { assessable: 1 });
    const tcs = await ledger('TCS Payable', 'Duties & Taxes', { tax_kind: 'tcs' });
    const s = await post({ type: 'sales', date: '2026-10-07', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000, freeQty: 0 }],
      charges: [{ ledgerId: disc.id, amount: -10000 }, { ledgerId: tcs.id, amount: 595 }] });
    expect(s.taxable).toBe(590000);
    expect(s.cgst).toBe(35400);
    expect(s.total).toBe(Math.round((590000 + 70800 + 595) / 100) * 100);
    expect(balance(tcs.id)).toBe(-595);
    expect(balance(disc.id)).toBe(10000);
    expect(balanced()).toBe(true);
    await expect(post({ type: 'sales', date: '2026-10-07', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }],
      charges: [{ ledgerId: disc.id, amount: -100000 }] })).rejects.toThrow(/discount is more/);
  });

  it('counts freight on a purchase into the cost of stock, and takes the supplier round off as typed', async () => {
    const carriage = await ledger('Carriage Inward', 'Direct Expenses', { assessable: 1 });
    const p = await post({ type: 'purchase', date: '2026-10-08', partyId: m.supplier.id, refNo: 'SUP-9', roundOff: -37,
      lines: [{ itemId: m.ghee.id, qty: 100, rate: 50000 }], charges: [{ ledgerId: carriage.id, amount: 100000 }] });
    expect(p.round_off).toBe(-37);
    expect(p.total).toBe(5100000 + Math.round(5100000 * 0.12) - 37);
    const ss = await ctx.call<any[]>('GET', '/api/reports/stock-summary?asOf=2026-10-31');
    expect(ss.find((r) => r.name === m.ghee.name).rate).toBe(Math.round((5000000 + 5100000) / 200));
    await expect(post({ type: 'purchase', date: '2026-10-08', partyId: m.supplier.id, refNo: 'SUP-10', roundOff: 5000, lines: [{ itemId: m.ghee.id, qty: 1, rate: 50000 }] })).rejects.toThrow(/₹10/);
    expect(balanced()).toBe(true);
  });
});

describe('alternate units and MRP', () => {
  it('bills 2 Case of 24 Pcs as 48 Pcs and remembers the cases', async () => {
    const units = await ctx.call<any[]>('GET', '/api/units');
    const cs = units.find((u) => u.symbol === 'Case') ?? await ctx.call('POST', '/api/units', { symbol: 'Case', name: 'Case', uqc: 'BOX' });
    await ctx.call('PUT', `/api/items/${m.ghee.id}`, { alt_unit_id: cs.id, alt_conv: 24, mrp: 65000 });
    await expect(ctx.call('PUT', `/api/items/${m.ghee.id}`, { alt_unit_id: units.find((u) => u.symbol === 'Pcs').id, alt_conv: 2 })).rejects.toThrow(/differ/);
    const before = await stock(m.ghee.name);
    const s = await post({ type: 'sales', date: '2026-10-09', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 2, unit: 'alt', rate: 24 * 60000, freeQty: 0 }] });
    expect(s.lines[0].qty).toBe(48);
    expect(s.lines[0].alt_qty).toBe(2);
    expect(s.lines[0].rate).toBe(60000);
    expect(s.lines[0].mrp).toBe(65000);
    expect(s.taxable).toBe(48 * 60000);
    expect(await stock(m.ghee.name)).toBe(before - 48);
    const html = (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${s.id}/print` })).body;
    expect(html).toContain('2 Case');
    expect(html).toContain('MRP');
  });

  it('keeps the MRP typed on a purchase batch', async () => {
    const p = await post({ type: 'purchase', date: '2026-10-09', partyId: m.supplier.id, refNo: 'SUP-11', lines: [{ itemId: m.curd.id, qty: 10, rate: 2000, batchNo: 'C9', expiryDate: '2027-01-31', mrp: 5500 }] });
    expect(p.lines[0].mrp).toBe(5500);
  });
});

describe('credit control', () => {
  it('stops a bill over the credit limit unless the owner says save anyway', async () => {
    await ctx.call('PUT', `/api/ledgers/${m.ramesh.id}`, { credit_limit: 1000000 });
    await post({ type: 'sales', date: '2026-10-10', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000, freeQty: 0 }] });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', payload: { type: 'sales', date: '2026-10-10', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000, freeQty: 0 }] } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'credit' });
    expect(JSON.parse(res.body).error).toMatch(/credit limit/);
    const ok = await post({ type: 'sales', date: '2026-10-10', partyId: m.ramesh.id, overrideCredit: true, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000, freeQty: 0 }] });
    expect(ok.id).toBeTruthy();
  });

  it('stops a bill to a party with overdue bills when the ledger says so', async () => {
    await ctx.call('PUT', `/api/ledgers/${m.kalpana.id}`, { block_overdue: 1 });
    await post({ type: 'sales', date: '2026-10-01', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 1, rate: 4500 }] });
    await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 1, rate: 4500 }] });
    await expect(post({ type: 'sales', date: '2026-10-20', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 1, rate: 4500 }] })).rejects.toThrow(/overdue/);
  });
});

describe('cheques: post-dated, bounce, bank reconciliation', () => {
  it('a post-dated receipt stays out of the balance until its date and shows in the PDC register', async () => {
    const sale = await post({ type: 'sales', date: '2026-10-01', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    const r = await post({ type: 'receipt', date: '2026-11-15', accountId: m.bank.id, pdc: true, chequeNo: '000123', chequeDate: '2026-11-15', bankName: 'SBI',
      entries: [{ ledgerId: m.ramesh.id, amount: sale.total, bills: [{ ref: sale.number, amount: sale.total }] }] });
    expect(r.pdc).toBe(1);
    const pdc = await ctx.call<any[]>('GET', '/api/reports/pdc?asOf=2026-10-31');
    expect(pdc[0]).toMatchObject({ number: r.number, upcoming: 1, cheque_no: '000123' });
    const due = await ctx.call<any[]>('GET', `/api/reports/pending-bills/${m.ramesh.id}?asOf=2026-10-31`);
    expect(due.find((b) => b.ref === sale.number).pending).toBe(sale.total);
  });

  it('a bounced cheque puts the bill back as pending and cannot be bounced twice', async () => {
    const sale = await post({ type: 'sales', date: '2026-10-01', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    const r = await post({ type: 'receipt', date: '2026-10-05', accountId: m.bank.id, chequeNo: '42', entries: [{ ledgerId: m.ramesh.id, amount: sale.total, bills: [{ ref: sale.number, amount: sale.total }] }] });
    const bankBefore = balance(m.bank.id);
    const j = await ctx.call('POST', `/api/vouchers/${r.id}/bounce`, { date: '2026-10-08' });
    expect(j.type).toBe('journal');
    expect(balance(m.bank.id)).toBe(bankBefore - sale.total);
    const due = await ctx.call<any[]>('GET', `/api/reports/pending-bills/${m.ramesh.id}?asOf=2026-10-31`);
    expect(due.find((b) => b.ref === sale.number).pending).toBe(sale.total);
    await expect(ctx.call('POST', `/api/vouchers/${r.id}/bounce`, {})).rejects.toThrow(/already/);
    await expect(ctx.call('DELETE', `/api/vouchers/${r.id}`)).rejects.toThrow(/bounced/);
    await ctx.call('DELETE', `/api/vouchers/${j.id}`);
    expect((await ctx.call('GET', `/api/vouchers/${r.id}`)).bounced_by).toBeNull();
    expect(balanced()).toBe(true);
  });

  it('bank reconciliation shows what the bank has not cleared', async () => {
    const p = await post({ type: 'payment', date: '2026-10-10', accountId: m.bank.id, chequeNo: '77', entries: [{ ledgerId: m.supplier.id, amount: 100000 }] });
    const before = await ctx.call('GET', `/api/reports/brs/${m.bank.id}?asOf=2026-10-31`);
    expect(before.notInBank).toBe(-100000);
    expect(before.bankBalance).toBe(before.booksBalance + 100000);
    await expect(ctx.call('PUT', `/api/vouchers/${p.id}/bank-date`, { date: '2026-10-01' })).rejects.toThrow(/before/);
    await ctx.call('PUT', `/api/vouchers/${p.id}/bank-date`, { date: '2026-10-12' });
    const after = await ctx.call('GET', `/api/reports/brs/${m.bank.id}?asOf=2026-10-31`);
    expect(after.notInBank).toBe(0);
    expect(after.bankBalance).toBe(after.booksBalance);
  });
});

describe('GST rate changes with an applicable-from date', () => {
  it('uses the old rate before the date and the new rate from it, for many items at once', async () => {
    await ctx.call('POST', '/api/items/gst-rate', { itemIds: [m.ghee.id, m.curd.id], rate: 5, from: '2026-11-01' });
    const oct = await post({ type: 'sales', date: '2026-10-31', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    const nov = await post({ type: 'sales', date: '2026-11-01', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    expect(oct.lines[0].gst_rate).toBe(12);
    expect(nov.lines[0].gst_rate).toBe(5);
    const items = await ctx.call<any[]>('GET', '/api/items');
    expect(items.find((i) => i.id === m.curd.id).rates).toEqual([{ from_date: '2026-11-01', gst_rate: 5 }]);
    await expect(ctx.call('POST', '/api/items/gst-rate', { itemIds: [m.ghee.id], rate: 55, from: '2026-11-01' })).rejects.toThrow(/between/);
  });
});

describe('godowns', () => {
  it('moves stock to a Damaged godown with a Stock Journal and does not sell from it', async () => {
    const dmg = await ctx.call('POST', '/api/godowns', { name: 'Damaged' });
    await expect(ctx.call('POST', '/api/godowns', { name: 'damaged' })).rejects.toThrow(/already/);
    await post({ type: 'stock_journal', date: '2026-10-02', lines: [
      { itemId: m.ghee.id, qty: 95, direction: 'out' }, { itemId: m.ghee.id, qty: 95, direction: 'in', godownId: dmg.id },
    ] });
    expect(await stock(m.ghee.name)).toBe(100);
    await expect(post({ type: 'sales', date: '2026-10-03', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000, freeQty: 0 }] })).rejects.toThrow(/Not enough stock/);
    await post({ type: 'sales', date: '2026-10-03', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 5, rate: 60000, freeQty: 0 }] });
    const gs = await ctx.call('GET', '/api/reports/godown-stock?asOf=2026-10-31');
    expect(gs.rows.find((r: any) => r.id === m.ghee.id).godowns).toEqual({ 1: 0, [dmg.id]: 95 });
    // Batches follow the godown too.
    const c1 = ctx.books.batches(m.curd.id).find((b) => b.batch_no === 'C1')!;
    await post({ type: 'stock_journal', date: '2026-10-02', lines: [{ itemId: m.curd.id, batchId: c1.id, qty: 100, direction: 'out' }, { itemId: m.curd.id, batchNo: 'C1', qty: 100, direction: 'in', godownId: dmg.id }] });
    await expect(post({ type: 'sales', date: '2026-10-03', partyId: m.ramesh.id, lines: [{ itemId: m.curd.id, qty: 1, rate: 4500 }] })).rejects.toThrow(/Not enough/);
    expect(ctx.books.batches(m.curd.id, '9999-12-31', 0, dmg.id).find((b) => b.batch_no === 'C1')!.qty).toBe(100);
  });
});

describe('schemes, price levels, registers and analysis', () => {
  it('counts free goods for the scheme claim at purchase cost', async () => {
    await post({ type: 'sales', date: '2026-10-04', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 20, rate: 60000 }] });
    const c = await ctx.call('GET', '/api/reports/scheme-claims?from=2026-10-01&to=2026-10-31');
    expect(c.rows[0]).toMatchObject({ name: m.ghee.name, free_qty: 2, stock_group: 'Patanjali' });
    expect(c.rows[0].value).toBe(2 * 50000);
    expect(c.byGroup).toEqual([{ name: 'Patanjali', value: 100000 }]);
  });

  it('keeps prices per level and refuses an unknown level', async () => {
    await ctx.call('PUT', '/api/company', { price_levels: 'Wholesale, Retail' });
    await ctx.call('PUT', `/api/items/${m.ghee.id}/prices`, { Wholesale: 58000, Retail: 62000 });
    await expect(ctx.call('PUT', `/api/items/${m.ghee.id}/prices`, { Super: 1 })).rejects.toThrow(/not a price level/);
    const items = await ctx.call<any[]>('GET', '/api/items');
    expect(items.find((i) => i.id === m.ghee.id).prices).toEqual({ Wholesale: 58000, Retail: 62000 });
    await ctx.call('PUT', `/api/ledgers/${m.ramesh.id}`, { price_level: 'Wholesale' });
    expect((await ctx.call('GET', `/api/ledgers/${m.ramesh.id}`)).price_level).toBe('Wholesale');
  });

  it('gives the sales register by month and sales by beat with what is still due', async () => {
    await post({ type: 'sales', date: '2026-10-04', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    await post({ type: 'sales', date: '2026-11-04', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 2, rate: 4500 }] });
    const reg = await ctx.call('GET', '/api/reports/register?type=sales&from=2026-04-01&to=2027-03-31');
    expect(reg.months.map((x: any) => x.month)).toEqual(['2026-10', '2026-11']);
    expect(reg.totals.count).toBe(2);
    const beats = await ctx.call('GET', '/api/reports/sales-by?by=beat&from=2026-04-01&to=2027-03-31');
    expect(beats.rows.find((r: any) => r.name === 'Saheed Nagar')).toMatchObject({ value: 60000, outstanding: 67200 });
    const items = await ctx.call('GET', '/api/reports/sales-by?by=stock_group&from=2026-04-01&to=2027-03-31');
    expect(items.rows.map((r: any) => r.name).sort()).toEqual(['Parag Milk Foods', 'Patanjali']);
  });

  it('lists TDS ledgers with what was booked and deducted', async () => {
    const rent = await ledger('Godown Rent', 'Indirect Expenses', { tds_section: '194I', tds_rate: 10 });
    const tds = await ledger('TDS Payable', 'Duties & Taxes', { tax_kind: 'tds' });
    const owner = await ledger('Landlord', 'Sundry Creditors');
    await post({ type: 'journal', date: '2026-10-31', entries: [{ ledgerId: rent.id, amount: 3000000 }, { ledgerId: owner.id, amount: -2700000 }, { ledgerId: tds.id, amount: -300000 }] });
    const r = await ctx.call<any[]>('GET', '/api/reports/tds?from=2026-04-01&to=2027-03-31');
    expect(r[0]).toMatchObject({ name: 'Godown Rent', tds_section: '194I', debited: 3000000, tds: 300000 });
    await expect(ledger('Bad Tax', 'Duties & Taxes', { tax_kind: 'cgst' })).rejects.toThrow(/TDS or TCS/);
  });
});

describe('delivery notes, orders and tracking', () => {
  it('moves stock once: on the Delivery Note, not again on the bill made against it', async () => {
    const so = await post({ type: 'sales_order', date: '2026-10-02', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000 }] });
    let pend = await ctx.call<any[]>('GET', '/api/reports/pending-orders?kind=sales');
    expect(pend[0].lines[0]).toMatchObject({ qty: 10, pending: 10 });
    const start = await stock(m.ghee.name);
    const dn = await post({ type: 'delivery_note', date: '2026-10-03', partyId: m.ramesh.id, againstId: so.id, lines: [{ itemId: m.ghee.id, qty: 6, rate: 60000, freeQty: 0 }] });
    expect(dn.number).toMatch(/^DL\//);
    expect(await stock(m.ghee.name)).toBe(start - 6);
    pend = await ctx.call<any[]>('GET', '/api/reports/pending-orders?kind=sales');
    expect(pend.find((p) => p.id === so.id).lines[0].pending).toBe(4);
    expect(pend.find((p) => p.id === dn.id)).toBeTruthy();
    const bill = await post({ type: 'sales', date: '2026-10-04', partyId: m.ramesh.id, againstId: dn.id, lines: [{ itemId: m.ghee.id, qty: 6, rate: 60000, freeQty: 0 }] });
    expect(await stock(m.ghee.name)).toBe(start - 6);
    expect(bill.total).toBe(Math.round(360000 * 1.12));
    expect((await ctx.call<any[]>('GET', '/api/reports/pending-orders?kind=sales')).find((p) => p.id === dn.id)).toBeUndefined();
    await expect(post({ type: 'sales', date: '2026-10-04', partyId: m.ramesh.id, againstId: dn.id, lines: [{ itemId: m.ghee.id, qty: 6, rate: 60000, freeQty: 0 }] })).rejects.toThrow(/already billed/);
    await expect(ctx.call('POST', `/api/vouchers/${dn.id}/cancel`)).rejects.toThrow(/made against/);
    await expect(post({ type: 'sales', date: '2026-10-04', partyId: m.kalpana.id, againstId: so.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] })).rejects.toThrow(/different party/);
    const g = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    expect(g.summary.invoices).toBe(1);
  });

  it('a Receipt Note brings stock in and the purchase against it does not add it again', async () => {
    const start = await stock(m.ghee.name);
    const grn = await post({ type: 'receipt_note', date: '2026-10-03', partyId: m.supplier.id, lines: [{ itemId: m.ghee.id, qty: 12, rate: 50000 }] });
    expect(await stock(m.ghee.name)).toBe(start + 12);
    await post({ type: 'purchase', date: '2026-10-05', partyId: m.supplier.id, refNo: 'SUP-77', againstId: grn.id, lines: [{ itemId: m.ghee.id, qty: 12, rate: 50000 }] });
    expect(await stock(m.ghee.name)).toBe(start + 12);
  });
});

describe('Optional (Ctrl+L), Memorandum and Reversing Journal', () => {
  it('an optional bill touches nothing until it is made regular, and then takes the next real number', async () => {
    const start = await stock(m.ghee.name);
    const before = balance(m.ramesh.id);
    const opt = await post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, optional: true, lines: [{ itemId: m.ghee.id, qty: 5, rate: 60000, freeQty: 0 }] });
    expect(opt.number).toMatch(/^OPT\//);
    expect(await stock(m.ghee.name)).toBe(start);
    expect(balance(m.ramesh.id)).toBe(before);
    expect((await ctx.call<any[]>('GET', `/api/reports/pending-bills/${m.ramesh.id}`)).length).toBe(0);
    const real = await post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    expect(real.number).toMatch(/\/1$/);
    const reg = await ctx.call('PUT', `/api/vouchers/${opt.id}`, { type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, optional: false, lines: [{ itemId: m.ghee.id, qty: 5, rate: 60000, freeQty: 0 }] });
    expect(reg.number).toMatch(/\/2$/);
    expect(await stock(m.ghee.name)).toBe(start - 6);
    const g = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    expect(g.json.doc_issue.doc_det[0].docs[0]).toMatchObject({ totnum: 2, cancel: 0 });
  });

  it('a Memorandum voucher and a Reversing Journal never reach the ledgers', async () => {
    const exp = await ledger('Staff Welfare', 'Indirect Expenses');
    const mv = await post({ type: 'memorandum', date: '2026-10-05', entries: [{ ledgerId: exp.id, amount: 50000 }, { ledgerId: m.bank.id, amount: -50000 }] });
    const rj = await post({ type: 'reversing_journal', date: '2026-10-05', refDate: '2026-10-31', entries: [{ ledgerId: exp.id, amount: 70000 }, { ledgerId: m.bank.id, amount: -70000 }] });
    expect(mv.number).toMatch(/^M\//);
    expect(rj.number).toMatch(/^RJ\//);
    expect(balance(exp.id)).toBe(0);
    const tb = await ctx.call('GET', '/api/reports/trial-balance?asOf=2026-10-31');
    expect(tb.totalDr).toBe(tb.totalCr);
  });
});

describe('GST returns: GSTR-2B matching and QRMP', () => {
  it('matches the 2B file against purchase bills by GSTIN and supplier invoice number', async () => {
    const supGstin = ctx.books.ledger(m.supplier.id).gstin;
    const other = gstin('21', 'OTHER1234Z');
    const json = { data: { gstin: 'x', rtnprd: '102026', docdata: { b2b: [
      { ctin: supGstin, trdnm: 'Parag', inv: [
        { inum: 'sup-001', dt: '01-10-2026', val: 56000, items: [{ rt: 12, txval: 50000, igst: 6000, cgst: 0, sgst: 0, cess: 0 }] },
        { inum: 'SUP-2', dt: '01-10-2026', val: 2100, items: [{ rt: 5, txval: 2000, igst: 90, cgst: 0, sgst: 0, cess: 0 }] },
      ] },
      { ctin: other, trdnm: 'Other', inv: [{ inum: 'Z1', dt: '05-10-2026', val: 118, items: [{ rt: 18, txval: 100, igst: 18 }] }] },
    ] } } };
    const r = await ctx.call('POST', '/api/gst/gstr2b', { json, period: '2026-10' });
    expect(r.summary).toMatchObject({ portalInvoices: 3, matched: 1, mismatched: 1, onlyIn2b: 1, onlyInBooks: 0 });
    expect(r.matched[0].voucher).toMatch(/^P\//);
    expect(r.mismatched[0].diffTax).toBe(9000 - 10000);
    await expect(ctx.call('POST', '/api/gst/gstr2b', { json: { hello: 1 }, period: '2026-10' })).rejects.toThrow(/not a GSTR-2B/);
  });

  it('builds a quarterly GSTR-1 for QRMP and an IFF with B2B only', async () => {
    await post({ type: 'sales', date: '2026-10-04', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    await post({ type: 'sales', date: '2026-11-04', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 2, rate: 4500 }] });
    await post({ type: 'sales', date: '2026-12-04', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    const q = await ctx.call('GET', '/api/gst/gstr1?period=2026-10&toPeriod=2026-12');
    expect(q.json.fp).toBe('122026');
    expect(q.json.b2b[0].inv.length).toBe(2);
    expect(q.json.b2cs.length).toBe(1);
    const iff = await ctx.call('GET', '/api/gst/gstr1?period=2026-10&iff=1');
    expect(iff.json.b2b).toBeTruthy();
    expect(iff.json.b2cs).toBeUndefined();
    expect(iff.json.hsn).toBeUndefined();
    await expect(ctx.call('GET', '/api/gst/gstr1?period=2026-12&toPeriod=2026-10')).rejects.toThrow(/before/);
  });
});

describe('helpers behind the Tally keys', () => {
  it('Ctrl+R gives the last narration of the type, Alt+R of the party; Alt+S gives the stock query', async () => {
    await post({ type: 'sales', date: '2026-10-04', partyId: m.ramesh.id, narration: 'Delivered by Raju', lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    await post({ type: 'sales', date: '2026-10-04', partyId: m.kalpana.id, narration: 'Cash sale', lines: [{ itemId: m.curd.id, qty: 1, rate: 4500 }] });
    expect((await ctx.call('GET', '/api/vouchers/last-narration?type=sales')).narration).toBe('Cash sale');
    expect((await ctx.call('GET', `/api/vouchers/last-narration?type=sales&partyId=${m.ramesh.id}`)).narration).toBe('Delivered by Raju');
    const q = await ctx.call('GET', `/api/items/${m.curd.id}/query?asOf=2026-10-31`);
    expect(q.stock).toBe(99);
    expect(q.batches[0].batch_no).toBe('C1');
    expect(q.purchases[0].rate).toBe(2000);
    expect(q.sales[0].rate).toBe(4500);
  });
});
