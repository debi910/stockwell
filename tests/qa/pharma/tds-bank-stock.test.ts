// QA pharma: TDS register, bank reconciliation, physical stock and stock journal with batches.
// Tests whose name starts with "BUG" fail on purpose: they show a confirmed defect.
import { beforeEach, describe, expect, it } from 'vitest';
import { setup } from '../../api/helpers';
import { batchQty, checkInvariants, itemStock, post, raw, seedPharma, type Ctx, type Seed } from './seed';

let ctx: Ctx;
let m: Seed;
const ledger = (name: string, group: string, extra: Record<string, unknown> = {}) => ctx.call('POST', '/api/ledgers', { name, group_id: m.g(group), ...extra });

beforeEach(async () => {
  ctx = await setup();
  m = await seedPharma(ctx);
});

describe('TDS on rent and professional fees', () => {
  it('BUG: one journal booking rent (194-I) and CA fees (194-J) shows the whole TDS of the voucher against each section', async () => {
    const rent = await ledger('Godown Rent', 'Indirect Expenses', { tds_section: '194I', tds_rate: 10 });
    const fees = await ledger('Audit Fees', 'Indirect Expenses', { tds_section: '194J', tds_rate: 10 });
    const tds = await ledger('TDS Payable', 'Duties & Taxes', { tax_kind: 'tds' });
    const landlord = await ledger('Mohanty Properties', 'Sundry Creditors');
    const ca = await ledger('Das & Co CA', 'Sundry Creditors');
    // Month-end provision in one journal: rent ₹30,000 (TDS ₹3,000), audit fees ₹50,000 (TDS ₹5,000).
    await post(ctx, { type: 'journal', date: '2026-09-30', entries: [
      { ledgerId: rent.id, amount: 3000000 }, { ledgerId: landlord.id, amount: -2700000 },
      { ledgerId: fees.id, amount: 5000000 }, { ledgerId: ca.id, amount: -4500000 },
      { ledgerId: tds.id, amount: -800000 },
    ] });
    const r = await ctx.call<any[]>('GET', '/api/reports/tds?from=2026-04-01&to=2027-03-31');
    const total = r.reduce((a, x) => a + x.tds, 0);
    expect(total, 'TDS deducted in all was ₹8,000').toBe(800000);
    expect(r.find((x) => x.tds_section === '194I').tds).toBe(300000);
  });

  it('BUG: paying the TDS to the government in the same voucher as rent cancels it out in the register', async () => {
    const rent = await ledger('Shop Rent', 'Indirect Expenses', { tds_section: '194I', tds_rate: 10 });
    const tds = await ledger('TDS on Rent', 'Duties & Taxes', { tax_kind: 'tds' });
    // Rent paid from bank with TDS deducted: Dr Rent 30,000; Cr TDS 3,000; Cr Bank 27,000. (works)
    await post(ctx, { type: 'journal', date: '2026-10-05', entries: [{ ledgerId: rent.id, amount: 3000000 }, { ledgerId: tds.id, amount: -300000 }, { ledgerId: m.bank.id, amount: -2700000 }] });
    let r = await ctx.call<any[]>('GET', '/api/reports/tds?from=2026-04-01&to=2027-03-31');
    expect(r[0].tds).toBe(300000);
    // Next month's journal also deposits last month's TDS (Dr TDS, Cr Bank) along with the new rent.
    await post(ctx, { type: 'journal', date: '2026-11-05', entries: [
      { ledgerId: rent.id, amount: 3000000 }, { ledgerId: tds.id, amount: -300000 }, { ledgerId: m.bank.id, amount: -2700000 },
      { ledgerId: tds.id, amount: 300000 }, { ledgerId: m.bank.id, amount: -300000 },
    ] });
    r = await ctx.call<any[]>('GET', '/api/reports/tds?from=2026-04-01&to=2027-03-31');
    expect(r[0].tds, 'TDS deducted on rent: ₹3,000 + ₹3,000').toBe(600000);
  });
});

describe('bank reconciliation', () => {
  it('uses bank dates and keeps cancelled/foreign vouchers out (works for the basics)', async () => {
    const r1 = await post(ctx, { type: 'receipt', date: '2026-09-28', accountId: m.bank.id, chequeNo: '112233', entries: [{ ledgerId: m.sahoo.id, amount: 5000000 }] });
    const p1 = await post(ctx, { type: 'payment', date: '2026-09-29', accountId: m.bank.id, chequeNo: '000501', entries: [{ ledgerId: m.supplier.id, amount: 2000000 }] });
    let brs = await ctx.call('GET', `/api/reports/brs/${m.bank.id}?asOf=2026-09-30`);
    expect(brs.notInBank).toBe(3000000);
    expect(brs.bankBalance).toBe(100000000);
    await ctx.call('PUT', `/api/vouchers/${r1.id}/bank-date`, { date: '2026-10-01' });
    await ctx.call('PUT', `/api/vouchers/${p1.id}/bank-date`, { date: '2026-09-30' });
    brs = await ctx.call('GET', `/api/reports/brs/${m.bank.id}?asOf=2026-09-30`);
    expect(brs.notInBank).toBe(5000000);
    expect(brs.bankBalance).toBe(100000000 - 2000000);
    brs = await ctx.call('GET', `/api/reports/brs/${m.bank.id}?asOf=2026-10-31`);
    expect(brs.notInBank).toBe(0);
    await checkInvariants(ctx);
  });

  it('BUG: a bank date can be set on a voucher that never touched the bank (a cash receipt / a sales bill)', async () => {
    const cash = ctx.books.ledgerByName('Cash')!;
    const r = await post(ctx, { type: 'receipt', date: '2026-09-28', accountId: cash.id, entries: [{ ledgerId: m.sahoo.id, amount: 100000 }] });
    const res = await raw(ctx, 'PUT', `/api/vouchers/${r.id}/bank-date`, { date: '2026-09-29' });
    expect(res.status, 'a cash receipt has no bank date').toBe(400);
  });

  it('QUESTIONABLE: a bank date far in the future (typo 2062 for 2026) is accepted', async () => {
    const r = await post(ctx, { type: 'payment', date: '2026-09-29', accountId: m.bank.id, entries: [{ ledgerId: m.supplier.id, amount: 100000 }] });
    const res = await raw(ctx, 'PUT', `/api/vouchers/${r.id}/bank-date`, { date: '2062-09-30' });
    expect(res.status).toBe(400);
  });
});

describe('physical stock and stock journal with batches', () => {
  beforeEach(async () => {
    await post(ctx, { type: 'purchase', date: '2026-06-01', partyId: m.supplier.id, refNo: 'UPA/101', lines: [
      { itemId: m.para.id, qty: 100, rate: 2000, batchNo: 'P1', expiryDate: '2026-09-30' },
      { itemId: m.para.id, qty: 100, rate: 2000, batchNo: 'P2', expiryDate: '2027-12-31' },
      { itemId: m.gloves.id, qty: 50, rate: 1500 },
    ] });
  });

  it('writes off an expired batch with a stock journal and counts a batch with physical stock (works)', async () => {
    const p1 = ctx.books.batches(m.para.id).find((b) => b.batch_no === 'P1')!;
    await post(ctx, { type: 'stock_journal', date: '2026-10-05', narration: 'Expired P1 destroyed', lines: [{ itemId: m.para.id, batchId: p1.id, qty: 100, direction: 'out' }] });
    expect(await batchQty(ctx, m.para.id)).toEqual({ P1: 0, P2: 100 });
    const p2 = ctx.books.batches(m.para.id).find((b) => b.batch_no === 'P2')!;
    const ps = await post(ctx, { type: 'physical_stock', date: '2026-10-31', lines: [{ itemId: m.para.id, batchId: p2.id, qty: 97 }, { itemId: m.gloves.id, qty: 52 }] });
    expect(ps.lines.map((l: any) => [l.qty, l.direction])).toEqual([[3, -1], [2, 1]]);
    expect(await batchQty(ctx, m.para.id)).toEqual({ P1: 0, P2: 97 });
    expect(await itemStock(ctx, m.gloves.id)).toBe(52);
    await checkInvariants(ctx);
  });

  it('BUG: a stock journal can take more out of a picked batch than it holds', async () => {
    const p1 = ctx.books.batches(m.para.id).find((b) => b.batch_no === 'P1')!;
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'stock_journal', date: '2026-10-05', lines: [{ itemId: m.para.id, batchId: p1.id, qty: 150, direction: 'out' }] });
    expect(r.status, 'P1 holds 100').toBe(400);
  });

  it('BUG: a physical stock count dated before later sales is not re-checked, leaving the batch negative', async () => {
    await post(ctx, { type: 'sales', date: '2026-10-20', partyId: m.sahoo.id, lines: [{ itemId: m.gloves.id, qty: 50, rate: 1800 }] });
    // Count on 10-Oct found only 10 pairs (40 damaged). The 20-Oct sale of 50 is now short by 40.
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'physical_stock', date: '2026-10-10', lines: [{ itemId: m.gloves.id, qty: 10 }] });
    expect(r.status === 400 || (await itemStock(ctx, m.gloves.id)) >= 0, 'stock after 20-Oct must not be negative').toBe(true);
  });
});
