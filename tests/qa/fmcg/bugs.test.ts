// QA FINDINGS. Every test here whose name starts with "BUG" reproduces a defect and is EXPECTED TO FAIL
// until the defect is fixed. The assertions state the correct behaviour.
import { beforeEach, describe, expect, it } from 'vitest';
import { gstin } from '../../api/helpers';
import { fresh, raw, stockOf, pendingOf, expectClean4xx, type Ctx, type Seed } from './qa-helpers';

let ctx: Ctx; let m: Seed;
const post = (b: Record<string, unknown>) => ctx.call('POST', '/api/vouchers', b);

beforeEach(async () => {
  ({ ctx, m } = await fresh());
  await post({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'SUP-1', lines: [{ itemId: m.ghee.id, qty: 100, rate: 50000 }] });
  await post({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'SUP-2', lines: [
    { itemId: m.curd.id, qty: 10, rate: 2000, batchNo: 'A', expiryDate: '2027-01-31' },
    { itemId: m.curd.id, qty: 100, rate: 2000, batchNo: 'B', expiryDate: '2027-06-30' }] });
});

describe('outstandings', () => {
  it('BUG critical: a new receipt cannot be set against an opening pending bill', async () => {
    await ctx.call('PUT', `/api/ledgers/${m.ramesh.id}`, { opening: 2500000 });
    expect(await pendingOf(ctx, m.ramesh.id, 'Opening')).toBe(2500000);
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'receipt', date: '2026-10-10', accountId: m.bank.id,
      entries: [{ ledgerId: m.ramesh.id, amount: 1000000, bills: [{ ref: 'Opening', amount: 1000000 }] }] });
    expect(r.body?.error).toBeUndefined(); // actual: "Bill Opening has only ₹0.00 pending"
    expect(await pendingOf(ctx, m.ramesh.id, 'Opening')).toBe(1500000);
  });

  it('BUG critical: bills brought in from Tally (opening bill-wise) cannot be settled either', async () => {
    ctx.books.setOpeningBills(m.ramesh.id, [{ ref: 'S/2025-26/880', date: '2026-03-10', amount: 900000 }]);
    await ctx.call('PUT', `/api/ledgers/${m.ramesh.id}`, { opening: 900000 });
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'receipt', date: '2026-10-10', accountId: m.bank.id,
      entries: [{ ledgerId: m.ramesh.id, amount: 900000, bills: [{ ref: 'S/2025-26/880', amount: 900000 }] }] });
    expect(r.body?.error).toBeUndefined(); // actual: "There is no bill S/2025-26/880 for Ramesh Stores."
  });

  it('BUG high: a credit note against an opening bill is refused', async () => {
    await ctx.call('PUT', `/api/ledgers/${m.ramesh.id}`, { opening: 2500000 });
    const rd = await ctx.call('POST', '/api/ledgers', { name: 'Rate Diff', group_id: m.g('Indirect Expenses') });
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'credit_note', date: '2026-10-10', partyId: m.ramesh.id, mode: 'accounting', againstRef: 'Opening', taxLines: [{ ledgerId: rd.id, amount: 10000 }] });
    expect(r.body?.error).toBeUndefined();
  });
});

describe('dates', () => {
  it('BUG high: an impossible date (31 Nov) is accepted and the bill drops out of GSTR-1/3B', async () => {
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'sales', date: '2026-11-31', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    expect(r.status).toBe(400); // actual: 200, saved with date 2026-11-31
    // If saved, it is in the register for the FY but in no month's GSTR-1:
    const g = await ctx.call('GET', '/api/gst/gstr1?period=2026-11');
    const reg = await ctx.call('GET', '/api/reports/register?type=sales&from=2026-04-01&to=2027-03-31');
    expect(g.summary.taxable).toBe(reg.totals.taxable);
  });
});

describe('stock', () => {
  it('BUG high: selling a chosen batch for more than it holds drives the batch negative', async () => {
    const a = ctx.books.batches(m.curd.id).find((b) => b.batch_no === 'A')!;
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, batchId: a.id, qty: 50, rate: 4500 }] });
    expect(r.status).toBe(400);
    expect(ctx.books.batches(m.curd.id).find((b) => b.batch_no === 'A')!.qty).toBeGreaterThanOrEqual(0); // actual: -40
  });

  it('BUG high: a bill against a Delivery Note can bill more (or other items) than was delivered; the extra never leaves stock', async () => {
    const dn = await post({ type: 'delivery_note', date: '2026-10-03', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 6, rate: 60000, freeQty: 0 }] });
    const before = await stockOf(ctx, m.ghee.name);
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'sales', date: '2026-10-04', partyId: m.ramesh.id, againstId: dn.id,
      lines: [{ itemId: m.ghee.id, qty: 60, rate: 60000, freeQty: 0 }, { itemId: m.curd.id, qty: 5, rate: 4500 }] });
    // Either refuse, or move the undelivered 54 ghee + 5 curd out of stock. Actual: saved, stock unchanged.
    if (r.status === 200) expect(await stockOf(ctx, m.ghee.name)).toBe(before - 54);
    else expect(r.status).toBe(400);
  });

  it('BUG medium: altering a billed Delivery Note leaves the bill and stock out of step', async () => {
    const dn = await post({ type: 'delivery_note', date: '2026-10-03', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 6, rate: 60000, freeQty: 0 }] });
    await post({ type: 'sales', date: '2026-10-04', partyId: m.ramesh.id, againstId: dn.id, lines: [{ itemId: m.ghee.id, qty: 6, rate: 60000, freeQty: 0 }] });
    const r = await raw(ctx, 'PUT', `/api/vouchers/${dn.id}`, { type: 'delivery_note', date: '2026-10-03', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    expect(r.status).toBe(400); // actual: 200 → 6 billed but only 1 left the stock
  });

  it('BUG medium: changing opening qty of a batch item does not change its opening batch (batch-wise stock ≠ item stock)', async () => {
    const it2 = await ctx.call('POST', '/api/items', { name: 'Parag Paneer 200g', unit_id: m.pcs, hsn: '0406', gst_rate: 5, track_batch: 1, opening_qty: 20, opening_value: 20 * 8000, opening_batch_no: 'OB1', opening_expiry: '2027-01-31' });
    await ctx.call('PUT', `/api/items/${it2.id}`, { opening_qty: 50, opening_value: 50 * 8000 });
    const total = await stockOf(ctx, 'Parag Paneer 200g');
    const batchSum = ctx.books.batches(it2.id).reduce((a, b) => a + b.qty, 0);
    expect(batchSum).toBe(total); // actual: 20 vs 50; 30 pcs can never be sold (FEFO says not enough stock)
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: it2.id, qty: 30, rate: 9000 }] });
    expect(r.status).toBe(200);
  });
});

describe('alternate units', () => {
  it('BUG medium: billing 1000 Case at ₹100.01 per Case gives ₹100,008 instead of ₹100,010', async () => {
    const units = await ctx.call<any[]>('GET', '/api/units');
    const cs = units.find((u) => u.symbol === 'Case') ?? await ctx.call('POST', '/api/units', { symbol: 'Case', name: 'Case', uqc: 'BOX' });
    const masala = await ctx.call('POST', '/api/items', { name: 'Sunrise Masala', unit_id: m.pcs, alt_unit_id: cs.id, alt_conv: 48, hsn: '0910', gst_rate: 5, opening_qty: 48000, opening_value: 48000 * 150 });
    const s = await post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: masala.id, qty: 1000, unit: 'alt', rate: 10001, freeQty: 0 }] });
    expect(s.taxable).toBe(1000 * 10001); // actual 10000800
  });
});

describe('bad input must give a clear 4xx, never a 500', () => {
  it('BUG medium: a number (not text) for a name or phone crashes with 500', async () => {
    await expectClean4xx(ctx, 'POST', '/api/ledgers', { name: 12345, group_id: m.g('Sundry Debtors') });
    await expectClean4xx(ctx, 'POST', '/api/ledgers', { name: 'Phone As Number', group_id: m.g('Sundry Debtors'), phone: 9437012345 });
    await expectClean4xx(ctx, 'POST', '/api/groups', { name: 7, parentId: m.g('Sundry Debtors') });
    await expectClean4xx(ctx, 'POST', '/api/stock-groups', { name: 42 });
    await expectClean4xx(ctx, 'POST', '/api/units', { symbol: 9 });
    await expectClean4xx(ctx, 'POST', '/api/items', { name: 99, unit_id: m.pcs });
  });

  it('BUG low: empty or malformed bodies crash with 500', async () => {
    await expectClean4xx(ctx, 'POST', '/api/groups');
    await expectClean4xx(ctx, 'POST', '/api/stock-groups');
    await expectClean4xx(ctx, 'POST', '/api/gst/eway-json', { ids: 'abc' });
    await expectClean4xx(ctx, 'POST', '/api/gst/eway-json');
  });

  it('BUG low: report dates are not checked (garbage asOf gives 500 or nonsense)', async () => {
    await expectClean4xx(ctx, 'GET', '/api/reports/trial-balance?asOf=garbage');
    await expectClean4xx(ctx, 'GET', '/api/reports/balance-sheet?asOf=2026-13-45');
    await expectClean4xx(ctx, 'GET', '/api/reports/stock-summary?asOf=yesterday');
  });
});

describe('stock goes negative through back-dated work (stock is checked on one date only)', () => {
  const minStock = (itemId: number) => Math.min(...['2026-10-01', '2026-10-05', '2026-10-10', '2026-10-20', '2026-10-31'].map((d) => ctx.books.stockOf(itemId, d)));
  let ghee2: any;
  beforeEach(async () => { ghee2 = await ctx.call('POST', '/api/items', { name: 'Patanjali Ghee 500ml', unit_id: m.pcs, hsn: '0405', gst_rate: 12 }); });

  it('BUG high: a back-dated sale is checked only on its own date, so later bills end up selling stock that is gone', async () => {
    await post({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'G1', lines: [{ itemId: ghee2.id, qty: 100, rate: 30000 }] });
    await post({ type: 'sales', date: '2026-10-10', partyId: m.kalpana.id, lines: [{ itemId: ghee2.id, qty: 100, rate: 33000, freeQty: 0 }] });
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: ghee2.id, qty: 50, rate: 33000, freeQty: 0 }] });
    expect(r.status).toBe(400); // actual 200; closing stock -50
    expect(ctx.books.stockOf(ghee2.id, '2026-10-31')).toBeGreaterThanOrEqual(0);
  });

  it('BUG high: deleting an earlier purchase is allowed when a later purchase covers the year-end total', async () => {
    const p1 = await post({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'G1', lines: [{ itemId: ghee2.id, qty: 100, rate: 30000 }] });
    await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: ghee2.id, qty: 50, rate: 33000, freeQty: 0 }] });
    await post({ type: 'purchase', date: '2026-10-20', partyId: m.supplier.id, refNo: 'G2', lines: [{ itemId: ghee2.id, qty: 100, rate: 30000 }] });
    const r = await raw(ctx, 'DELETE', `/api/vouchers/${p1.id}`);
    expect(r.status).toBe(400); // actual 200; stock on 5–19 Oct is -50
    expect(minStock(ghee2.id)).toBeGreaterThanOrEqual(0);
  });

  it('BUG high: altering a purchase (later date or lower qty) after its stock was sold is allowed', async () => {
    const p1 = await post({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'G1', lines: [{ itemId: ghee2.id, qty: 100, rate: 30000 }] });
    await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: ghee2.id, qty: 50, rate: 33000, freeQty: 0 }] });
    const r = await raw(ctx, 'PUT', `/api/vouchers/${p1.id}`, { type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'G1', lines: [{ itemId: ghee2.id, qty: 10, rate: 30000 }] });
    expect(r.status).toBe(400); // actual 200; stock -40
    expect(minStock(ghee2.id)).toBeGreaterThanOrEqual(0);
  });

  it('BUG medium: renaming the batch on a purchase after sales from it leaves the old batch negative', async () => {
    const p = await post({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'C9', lines: [{ itemId: m.curd.id, qty: 100, rate: 2000, batchNo: 'X', expiryDate: '2026-12-01' }] });
    await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 50, rate: 4500 }] }); // FEFO takes X
    await raw(ctx, 'PUT', `/api/vouchers/${p.id}`, { type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'C9', lines: [{ itemId: m.curd.id, qty: 100, rate: 2000, batchNo: 'Y', expiryDate: '2026-12-01' }] });
    for (const b of ctx.books.batches(m.curd.id)) expect(b.qty, `batch ${b.batch_no}`).toBeGreaterThanOrEqual(0); // actual X = -50
  });
});

describe('bill-wise and duplicates', () => {
  it('BUG medium: a sale can be altered below what was already received against it (bill goes negative silently)', async () => {
    const s = await post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000, freeQty: 0 }] });
    await post({ type: 'receipt', date: '2026-10-06', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: s.total, bills: [{ ref: s.number, amount: s.total }] }] });
    const r = await raw(ctx, 'PUT', `/api/vouchers/${s.id}`, { type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    expect(r.status).toBe(400); // actual 200; bill pending becomes -₹6,048
    expect(await pendingOf(ctx, m.ramesh.id, s.number)).toBeGreaterThanOrEqual(0);
  });

  it('BUG low: a receipt dated before the bill can be set against that bill', async () => {
    const s = await post({ type: 'sales', date: '2026-10-10', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    const r = await raw(ctx, 'POST', '/api/vouchers', { type: 'receipt', date: '2026-10-05', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: 1000, bills: [{ ref: s.number, amount: 1000 }] }] });
    expect(r.status).toBe(400); // actual 200; outstanding on 7 Oct shows S/…/1 at -₹10
  });

  it('BUG medium: invoice numbers and supplier bill numbers differing only in case are accepted as new (GST treats them as duplicates)', async () => {
    const s = await post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    expect((await raw(ctx, 'POST', '/api/vouchers', { type: 'sales', number: s.number.toLowerCase(), date: '2026-10-06', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] })).status).toBe(400);
    expect((await raw(ctx, 'POST', '/api/vouchers', { type: 'purchase', date: '2026-10-06', partyId: m.supplier.id, refNo: 'sup-1', lines: [{ itemId: m.ghee.id, qty: 1, rate: 50000 }] })).status).toBe(400); // SUP-1 exists → double ITC
  });
});

describe('GST returns', () => {
  it('BUG medium: changing HSN or unit on the item master rewrites already-filed GSTR-1 HSN summaries', async () => {
    await post({ type: 'sales', date: '2026-10-10', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000, freeQty: 0 }] });
    const before = (await ctx.call('GET', '/api/gst/gstr1?period=2026-10')).json.hsn;
    await ctx.call('PUT', `/api/items/${m.ghee.id}`, { hsn: '04059020' });
    const after = (await ctx.call('GET', '/api/gst/gstr1?period=2026-10')).json.hsn;
    expect(after).toEqual(before); // actual: hsn_sc 0405 → 04059020 for October
  });

  it('BUG medium: a ledger accepts state code 99 and GSTR-1 reports place of supply 99', async () => {
    const r = await raw(ctx, 'POST', '/api/ledgers', { name: 'Bad State', group_id: m.g('Sundry Debtors'), state_code: '99' });
    expect(r.status).toBe(400); // actual 200
  });

  it('BUG medium: a credit note on a B2C invoice goes to CDNR once the party later registers', async () => {
    const s = await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    await ctx.call('PUT', `/api/ledgers/${m.kalpana.id}`, { gstin: gstin('21', 'KALPA1234K') });
    await post({ type: 'credit_note', date: '2026-10-20', partyId: m.kalpana.id, againstRef: s.number, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
    const g = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    expect(g.json.cdnr).toBeUndefined(); // the original was B2CS; actual: CDNR against a GSTIN the invoice never had
  });
});

describe('masters accept impossible numbers and dates', () => {
  it('BUG medium: opening balance 1e300 and fractional paise are accepted (TB shows 1e+300)', async () => {
    expect((await raw(ctx, 'POST', '/api/ledgers', { name: 'Huge', group_id: m.g('Sundry Debtors'), opening: 1e300 })).status).toBe(400);
    expect((await raw(ctx, 'POST', '/api/items', { name: 'HugeItem', unit_id: m.pcs, opening_qty: 1e300, opening_value: 1e300 })).status).toBe(400);
    const it2 = await raw(ctx, 'POST', '/api/items', { name: 'FracItem', unit_id: m.pcs, opening_qty: 3, opening_value: 100.7 });
    expect(Number.isInteger(it2.body.opening_value)).toBe(true); // actual 100.7 paise stored
  });

  it('BUG low: books start date 2026-04-31 is accepted', async () => {
    expect((await raw(ctx, 'PUT', '/api/company', { books_from: '2026-04-31' })).status).toBe(400);
  });

  it('BUG low: a ledger can be given a price level that does not exist', async () => {
    await ctx.call('PUT', '/api/company', { price_levels: 'Wholesale, Retail' });
    expect((await raw(ctx, 'PUT', `/api/ledgers/${m.kalpana.id}`, { price_level: 'Bogus' })).status).toBe(400);
  });

  it('BUG low: /api/reports/pending-bills/abc returns every party\'s bills', async () => {
    await post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    const r = await raw(ctx, 'GET', '/api/reports/pending-bills/abc');
    expect(r.status).toBe(400);
  });
});
