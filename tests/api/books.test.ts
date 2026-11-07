import { beforeEach, describe, expect, it } from 'vitest';
import { seedDistributor, setup } from './helpers';

let ctx: Awaited<ReturnType<typeof setup>>;
let m: Awaited<ReturnType<typeof seedDistributor>>;

beforeEach(async () => {
  ctx = await setup();
  m = await seedDistributor(ctx.call);
});

async function purchaseStock() {
  return ctx.call('POST', '/api/vouchers', {
    type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'PMF/889',
    lines: [
      { itemId: m.ghee.id, qty: 50, rate: 55000 },
      { itemId: m.curd.id, qty: 100, rate: 4000, batchNo: 'D101', expiryDate: '2026-10-20' },
      { itemId: m.curd.id, qty: 100, rate: 4000, batchNo: 'D102', expiryDate: '2026-11-15' },
    ],
  });
}

describe('company and masters', () => {
  it('sets up the default chart of accounts', async () => {
    const groups = await ctx.call<any[]>('GET', '/api/groups');
    expect(groups.length).toBe(28);
    const ledgers = await ctx.call<any[]>('GET', '/api/ledgers');
    expect(ledgers.map((l) => l.name)).toEqual(expect.arrayContaining(['Cash', 'Sales', 'Purchase', 'CGST', 'SGST', 'IGST', 'Round Off']));
  });
  it('takes the state from the GSTIN and rejects a wrong GSTIN', async () => {
    expect(m.kolkata.state_code).toBe('19');
    await expect(ctx.call('POST', '/api/ledgers', { name: 'Bad', group_id: m.g('Sundry Debtors'), gstin: '21ABCDE1234F1ZZ' })).rejects.toThrow(/not valid/);
  });
  it('refuses duplicate ledger names', async () => {
    await expect(ctx.call('POST', '/api/ledgers', { name: 'ramesh stores', group_id: m.g('Sundry Debtors') })).rejects.toThrow(/already exists/);
  });
});

describe('vouchers', () => {
  it('posts a GST purchase with batches', async () => {
    const v = await purchaseStock();
    expect(v.number).toBe('P/2026-27/1');
    expect(v.intra).toBe(0); // Maharashtra supplier → IGST
    expect(v.igst).toBe(Math.round(50 * 55000 * 0.12) + Math.round(200 * 4000 * 0.05));
    const sum = v.entries.reduce((a: number, e: any) => a + e.amount, 0);
    expect(sum).toBe(0);
    const batches = await ctx.call<any[]>('GET', `/api/items/${m.curd.id}/batches`);
    expect(batches.map((b) => [b.batch_no, b.qty])).toEqual([['D101', 100], ['D102', 100]]);
  });

  it('bills a retailer inside Odisha with CGST+SGST, scheme free quantity and FEFO batch', async () => {
    await purchaseStock();
    const v = await ctx.call('POST', '/api/vouchers', {
      type: 'sales', date: '2026-10-05', partyId: m.ramesh.id,
      lines: [
        { itemId: m.ghee.id, qty: 20, rate: 60000, discountPct: 2 },
        { itemId: m.curd.id, qty: 30, rate: 4500 },
      ],
    });
    expect(v.number).toBe('S/2026-27/1');
    expect(v.intra).toBe(1);
    expect(v.lines[0].free_qty).toBe(2); // buy 10 get 1
    expect(v.lines[1].batch_no).toBe('D101'); // earliest expiry first
    expect(v.cgst).toBe(v.sgst);
    expect(v.total % 100).toBe(0);
    const stock = await ctx.call<any[]>('GET', '/api/reports/stock-summary?to=2026-10-31');
    const ghee = stock.find((s) => s.id === m.ghee.id);
    expect(ghee.closing_qty).toBe(50 - 22);
    expect(ghee.rate).toBe(55000);
    expect(ghee.value).toBe(28 * 55000);
  });

  it('charges IGST to an out-of-state buyer', async () => {
    await purchaseStock();
    const v = await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-06', partyId: m.kolkata.id, lines: [{ itemId: m.ghee.id, qty: 5, rate: 60000 }] });
    expect(v.intra).toBe(0);
    expect(v.igst).toBe(36000);
    expect(v.place_of_supply).toBe('19');
  });

  it('settles bills with a receipt and tracks what is still due', async () => {
    await purchaseStock();
    const s1 = await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 5, rate: 60000 }] });
    const s2 = await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-10', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 4, rate: 60000 }] });
    await ctx.call('POST', '/api/vouchers', {
      type: 'receipt', date: '2026-10-20', accountId: m.bank.id,
      entries: [{ ledgerId: m.ramesh.id, amount: s1.total + 10000, bills: [{ ref: s1.number, amount: s1.total }] }],
    });
    const pending = await ctx.call<any[]>('GET', `/api/reports/outstanding?asOf=2026-10-31`);
    const ramesh = pending.filter((b) => b.ledger_id === m.ramesh.id);
    expect(ramesh.map((b) => [b.ref, b.pending])).toEqual([[s2.number, s2.total]]);
    // The extra ₹100 sits as an on-account credit.
    const all = await ctx.call<any[]>('GET', `/api/reports/pending-bills/${m.ramesh.id}`);
    expect(all.some((b) => b.pending === -10000)).toBe(true);
  });

  it('refuses an unbalanced journal and accepts a balanced one', async () => {
    const cash = (await ctx.call<any[]>('GET', '/api/ledgers')).find((l) => l.name === 'Cash');
    await expect(ctx.call('POST', '/api/vouchers', { type: 'journal', date: '2026-10-01', entries: [{ ledgerId: cash.id, amount: 100 }, { ledgerId: m.bank.id, amount: -50 }] })).rejects.toThrow(/do not match/);
    const j = await ctx.call('POST', '/api/vouchers', { type: 'journal', date: '2026-10-01', entries: [{ ledgerId: cash.id, amount: 100000 }, { ledgerId: m.bank.id, amount: -100000 }] });
    expect(j.total).toBe(100000);
  });

  it('cancels a voucher and keeps its number', async () => {
    await purchaseStock();
    const s = await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
    await ctx.call('POST', `/api/vouchers/${s.id}/cancel`);
    const next = await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-06', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
    expect(next.number).toBe('S/2026-27/2');
    const tb = await ctx.call('GET', '/api/reports/trial-balance?to=2026-10-31');
    expect(tb.totalDr).toBe(tb.totalCr);
  });

  it('edits a voucher and keeps the books balanced', async () => {
    await purchaseStock();
    const s = await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
    const e = await ctx.call('PUT', `/api/vouchers/${s.id}`, { type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 3, rate: 60000 }] });
    expect(e.number).toBe(s.number);
    expect(e.taxable).toBe(180000);
  });
});

describe('statements', () => {
  it('balances the trial balance, P&L and balance sheet', async () => {
    await purchaseStock();
    await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000 }, { itemId: m.curd.id, qty: 50, rate: 4500 }] });
    await ctx.call('POST', '/api/vouchers', { type: 'payment', date: '2026-10-07', accountId: m.bank.id, entries: [{ ledgerId: m.supplier.id, amount: 100000 }] });
    const tb = await ctx.call('GET', '/api/reports/trial-balance?to=2026-10-31');
    expect(tb.totalDr).toBe(tb.totalCr);
    const pl = await ctx.call('GET', '/api/reports/profit-loss?from=2026-04-01&to=2026-10-31');
    // Sold 11 ghee (incl. 1 free) and 50 curd; profit = sales - cost of what left the shelf.
    const sales = 10 * 60000 + 50 * 4500;
    const cost = 11 * 55000 + 50 * 4000;
    expect(pl.grossProfit).toBe(sales - cost);
    const bs = await ctx.call('GET', '/api/reports/balance-sheet?to=2026-10-31');
    expect(bs.totalAssets).toBe(bs.totalLiabilities);
    expect(bs.openingDiff).toBe(0);
  });

  it('shows a ledger statement with running balance', async () => {
    await purchaseStock();
    const st = await ctx.call('GET', `/api/reports/ledger/${m.supplier.id}?from=2026-04-01&to=2026-10-31`);
    expect(st.lines).toHaveLength(1);
    expect(st.closing).toBeLessThan(0);
    expect(st.lines[0].particulars).toContain('Purchase');
  });
});

describe('alerts', () => {
  it('flags overdue bills, MSME interest, 43B(h) payables and expiring batches', async () => {
    await purchaseStock();
    const s = await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-01', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 5, rate: 60000 }] });
    const a = await ctx.call('GET', '/api/reports/alerts?asOf=2026-11-10');
    const od = a.overdue.find((b: any) => b.ref === s.number);
    expect(od.overdue_days).toBe(40 - 15);
    const msme = a.msmeReceivables.find((b: any) => b.ref === s.number);
    expect(msme.late_days).toBe(40 - 15);
    expect(msme.interest).toBeGreaterThan(0);
    // Bill from Parag on 1 Oct with 30 days credit → pay by 31 Oct.
    expect(a.msmePayables[0].pay_by).toBe('2026-10-31');
    expect(a.msmePayables[0].days_left).toBeLessThan(0);
    const exp = await ctx.call('GET', '/api/reports/alerts?asOf=2026-10-10');
    expect(exp.expiringBatches.map((b: any) => b.batch_no)).toEqual(['D101']);
  });

  it('writes WhatsApp bill and reminder messages', async () => {
    await purchaseStock();
    const s = await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-01', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 5, rate: 60000 }] });
    const msg = await ctx.call('GET', `/api/vouchers/${s.id}/whatsapp`);
    expect(msg.phone).toBe('919861012345');
    expect(msg.text).toContain(s.number);
    expect(msg.text).toContain('samal@upi');
    const rem = await ctx.call('GET', `/api/reports/reminder/${m.ramesh.id}`);
    expect(rem.text).toMatch(/overdue/);
  });

  it('prints an invoice with a UPI QR code', async () => {
    await purchaseStock();
    const s = await ctx.call('POST', '/api/vouchers', { type: 'sales', date: '2026-10-01', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 5, rate: 60000 }] });
    const res = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${s.id}/print` });
    expect(res.body).toContain('TAX INVOICE');
    expect(res.body).toContain('data:image/png;base64');
    expect(res.body).toContain('Rupees');
  });
});
