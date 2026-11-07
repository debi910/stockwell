// Auditor 2 (accounting / GST correctness). Every test here asserts the CORRECT behaviour;
// a failing test is a reproduced defect. IDs (A2-xx) match the report.
import { beforeEach, describe, expect, it } from 'vitest';
import { gstin, seedDistributor, setup } from './helpers';
import { toPaise } from '../../src/core/money';
import { computeLine } from '../../src/core/gst';

let ctx: Awaited<ReturnType<typeof setup>>;
let m: Awaited<ReturnType<typeof seedDistributor>>;

beforeEach(async () => {
  ctx = await setup();
  m = await seedDistributor(ctx.call);
});

const post = (body: any) => ctx.call('POST', '/api/vouchers', body);
async function buyGhee(qty = 50, date = '2026-10-01', refNo = 'PMF/1') {
  return post({ type: 'purchase', date, partyId: m.supplier.id, refNo, lines: [{ itemId: m.ghee.id, qty, rate: 55000 }] });
}
async function buyCurd() {
  return post({
    type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'PMF/2',
    lines: [
      { itemId: m.curd.id, qty: 10, rate: 4000, batchNo: 'D101', expiryDate: '2026-10-20' },
      { itemId: m.curd.id, qty: 100, rate: 4000, batchNo: 'D102', expiryDate: '2026-12-15' },
    ],
  });
}

describe('core arithmetic', () => {
  it('A2-01 toPaise rounds ₹1.005 half-up to 101 paise', () => {
    expect(toPaise(1.005)).toBe(101);
    expect(toPaise('2.675')).toBe(268);
  });
  it('A2-02 (no defect) fractional qty × rate rounds half-up (2.675 kg × ₹1.00 = ₹2.68)', () => {
    expect(computeLine({ qty: 2.675, rate: 100, gstRate: 0 }, true).gross).toBe(268);
  });
  it('A2-03 rate with fractional paise is not truncated before multiplying (1000 × ₹42.3729)', async () => {
    await buyGhee(1000);
    const v = await post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1000, rate: 4237.29, freeQty: 0 }] });
    expect(v.taxable).toBe(4237290);
  });
});

describe('numbering', () => {
  it('A2-04 a manually typed number must not jam the automatic series', async () => {
    await buyGhee();
    await post({ type: 'sales', date: '2026-10-05', number: 'S/2026-27/3', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
    await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] }); // seq 2
    // seq 3 → "S/2026-27/3" clashes; every later attempt computes the same number again.
    await expect(post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] })).resolves.toBeTruthy();
  });
  it('A2-05 moving a voucher into the next FY by alteration renumbers it / keeps the new FY series at 1', async () => {
    await buyGhee();
    const s = await post({ type: 'sales', date: '2027-03-30', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
    await ctx.call('PUT', `/api/vouchers/${s.id}`, { date: '2027-04-02', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
    const next = await ctx.call('GET', '/api/vouchers/next-number?type=sales&date=2027-04-05');
    expect(next.number).toBe('S/2027-28/2'); // altered voucher should be S/2027-28/1, not keep S/2026-27/1 (seq 1 in new FY gives 2 here only if renumbered)
    const alt = await ctx.call('GET', `/api/vouchers/${s.id}`);
    expect(alt.number.startsWith('S/2027-28/')).toBe(true);
  });
});

describe('inventory', () => {
  it('A2-06 sales cannot drive stock negative silently', async () => {
    await buyGhee(5);
    await expect(post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 50, rate: 60000 }] })).rejects.toThrow();
  });
  it('A2-07 FEFO never auto-picks an expired batch', async () => {
    await buyCurd();
    const v = await post({ type: 'sales', date: '2026-10-25', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 5, rate: 4500 }] });
    expect(v.lines[0].batch_no).toBe('D102');
  });
  it('A2-08 FEFO does not overdraw a batch when the qty spans batches', async () => {
    await buyCurd();
    // D101 has 10, D102 has 100: 105 is in stock overall but no single batch has it.
    await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 105, rate: 4500 }] });
    const batches = await ctx.call<any[]>('GET', `/api/items/${m.curd.id}/batches`);
    for (const b of batches) expect(b.qty).toBeGreaterThanOrEqual(0);
  });
  it('A2-09 a batch id of another item is refused', async () => {
    await buyGhee();
    await buyCurd();
    const curdBatch = (await ctx.call<any[]>('GET', `/api/items/${m.curd.id}/batches`))[0];
    await expect(post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, batchId: curdBatch.id }] })).rejects.toThrow();
  });
  it('A2-10 altering a sale without changing it keeps its batch', async () => {
    await buyCurd();
    const s = await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 10, rate: 4500 }] });
    expect(s.lines[0].batch_no).toBe('D101');
    const a = await ctx.call('PUT', `/api/vouchers/${s.id}`, { date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.curd.id, qty: 10, rate: 4500 }] });
    expect(a.lines[0].batch_no).toBe('D101');
  });
  it('A2-11 purchase return (debit note) at a different rate is taken out of weighted-average cost', async () => {
    await buyGhee(10); // 10 @ 550
    await post({ type: 'purchase', date: '2026-10-02', partyId: m.supplier.id, refNo: 'PMF/9', lines: [{ itemId: m.ghee.id, qty: 10, rate: 45000 }] }); // 10 @ 450
    await post({ type: 'debit_note', date: '2026-10-03', partyId: m.supplier.id, againstRef: 'PMF/9', lines: [{ itemId: m.ghee.id, qty: 10, rate: 45000 }] });
    const st = (await ctx.call<any[]>('GET', '/api/reports/stock-summary?to=2026-10-31')).find((s) => s.id === m.ghee.id);
    expect(st.closing_qty).toBe(10);
    expect(st.value).toBe(10 * 55000); // only the ₹550 lot remains
  });
});

describe('bill-wise', () => {
  it('A2-12 cancelling an invoice that has a receipt against it is refused (or the receipt goes on account)', async () => {
    await buyGhee();
    const s = await post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    await post({ type: 'receipt', date: '2026-10-06', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: s.total, bills: [{ ref: s.number, amount: s.total }] }] });
    await expect(ctx.call('POST', `/api/vouchers/${s.id}/cancel`)).rejects.toThrow();
  });
  it('A2-13 a receipt cannot be allocated to a bill that does not exist / beyond its amount', async () => {
    await expect(post({ type: 'receipt', date: '2026-10-06', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: 100000, bills: [{ ref: 'NOPE', amount: 150000 }] }] })).rejects.toThrow();
  });
  it('A2-14 two supplier bills with the same supplier number in different FYs stay separate', async () => {
    await buyGhee(5, '2026-10-01', '101');
    await buyGhee(5, '2027-04-10', '101');
    const bills = await ctx.call<any[]>('GET', `/api/reports/pending-bills/${m.supplier.id}?asOf=2027-12-31`);
    expect(bills.length).toBe(2);
  });
});

describe('statements', () => {
  it('A2-15 balance sheet tallies when a P&L ledger carries an opening balance', async () => {
    // As in Tally, income and expense ledgers cannot carry an opening balance, so the BS cannot be thrown off that way.
    await expect(ctx.call('POST', '/api/ledgers', { name: 'Rent', group_id: m.g('Indirect Expenses'), opening: 100000 })).rejects.toThrow(/cannot have an opening/);
    const bs = await ctx.call('GET', '/api/reports/balance-sheet?to=2026-10-31');
    expect(bs.openingDiff).toBe(0);
    expect(bs.totalAssets).toBe(bs.totalLiabilities);
  });
  it('A2-16 trial balance of FY 2027-28 shows only that year\'s Sales (prior profit carried in P&L A/c)', async () => {
    await buyGhee();
    await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
    await post({ type: 'sales', date: '2027-05-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 70000 }] });
    const tb = await ctx.call('GET', '/api/reports/trial-balance?to=2028-03-31');
    const find = (nodes: any[]): any => { for (const n of nodes) { const l = n.ledgers.find((x: any) => x.name === 'Sales'); if (l) return l; const r = find(n.groups); if (r) return r; } };
    expect(find(tb.tree).balance).toBe(-70000);
  });
  it('A2-17 changing books_from after vouchers exist is refused', async () => {
    await buyGhee();
    await expect(ctx.call('PUT', '/api/company', { books_from: '2026-11-01' })).rejects.toThrow();
  });
});

describe('MSME / 43B(h)', () => {
  it('A2-18 interest is still shown for an MSME bill that was paid late (s.16 accrues until payment)', async () => {
    await buyGhee();
    const s = await post({ type: 'sales', date: '2026-06-01', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] }).catch(() => null);
    // date before purchase → use a later sale
    const s2 = s ?? await post({ type: 'sales', date: '2026-10-02', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] });
    await post({ type: 'receipt', date: '2026-12-31', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: s2.total, bills: [{ ref: s2.number, amount: s2.total }] }] });
    const al = await ctx.call('GET', '/api/reports/alerts?to=2027-01-05');
    expect(al.msmeReceivables.length).toBe(1);
  });
});

describe('GSTR-1 / 3B / EWB', () => {
  async function item0() {
    return ctx.call('POST', '/api/items', { name: 'Fresh Milk 500ml', unit_id: m.pcs, hsn: '0401', gst_rate: 0, opening_qty: 100, opening_value: 200000 });
  }
  it('A2-19 nil-rated sales go to the nil section, not b2b/b2cs with rt 0', async () => {
    const milk = await item0();
    await post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: milk.id, qty: 10, rate: 2500 }] });
    await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: milk.id, qty: 10, rate: 2500 }] });
    const r = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    expect(r.json.b2b).toBeUndefined();
    expect(r.json.b2cs).toBeUndefined();
    expect(r.json.nil).toBeDefined();
  });
  it('A2-20 credit note against a B2CL invoice is reported in cdnur (typ B2CL)', async () => {
    await buyGhee(200);
    const up = await ctx.call('POST', '/api/ledgers', { name: 'Ranchi Retail (URP)', group_id: m.g('Sundry Debtors'), state_code: '20' });
    const s = await post({ type: 'sales', date: '2026-10-05', partyId: up.id, lines: [{ itemId: m.ghee.id, qty: 170, rate: 60000, freeQty: 0 }] });
    expect(s.total).toBeGreaterThan(100000_00);
    await post({ type: 'credit_note', date: '2026-10-20', partyId: up.id, againstRef: s.number, lines: [{ itemId: m.ghee.id, qty: 2, rate: 60000 }] });
    const r = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    expect(r.json.cdnur?.[0]?.typ).toBe('B2CL');
    expect(r.json.b2cs).toBeUndefined();
  });
  it('A2-21 HSN with fewer than 4 digits (or blank) is refused for a GSTR-1 line', async () => {
    const x = await ctx.call('POST', '/api/items', { name: 'No HSN item', unit_id: m.pcs, hsn: '', gst_rate: 18, opening_qty: 10, opening_value: 1000 });
    await expect(post({ type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: x.id, qty: 1, rate: 1000 }] })).rejects.toThrow(/HSN/);
  });
  it('A2-22 GSTR-3B payable applies IGST credit across CGST/SGST (s.49/Rule 88A) — no negative heads', async () => {
    await buyGhee(50); // inter-state purchase → IGST ITC 3,30,000 paise
    await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 60000, freeQty: 0 }] });
    const r = await ctx.call('GET', '/api/gst/gstr3b?period=2026-10');
    expect(r.payable.igst).toBeGreaterThanOrEqual(0);
    expect(r.payable.cgst).toBe(0);
    expect(r.payable.sgst).toBe(0);
  });
  it('A2-23 purchase from an unregistered supplier does not create ITC', async () => {
    const urd = await ctx.call('POST', '/api/ledgers', { name: 'Local URD Supplier', group_id: m.g('Sundry Creditors') });
    await post({ type: 'purchase', date: '2026-10-01', partyId: urd.id, lines: [{ itemId: m.ghee.id, qty: 10, rate: 55000 }] });
    const r = await ctx.call('GET', '/api/gst/gstr3b?period=2026-10');
    expect(r.itc.cgst).toBe(0);
  });
  it('A2-24 GSTR-3B 3.1(a) taxable excludes nil-rated supplies', async () => {
    const milk = await item0();
    await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: milk.id, qty: 10, rate: 2500 }] });
    const r = await ctx.call('GET', '/api/gst/gstr3b?period=2026-10');
    expect(r.outward.taxable).toBe(0);
  });
  it('A2-25 e-Way Bill JSON is refused for a cancelled invoice', async () => {
    await buyGhee();
    const s = await post({ type: 'sales', date: '2026-10-05', partyId: m.kolkata.id, lines: [{ itemId: m.ghee.id, qty: 40, rate: 60000 }] });
    await ctx.call('POST', `/api/vouchers/${s.id}/cancel`);
    await expect(ctx.call('POST', '/api/gst/eway-json', { ids: [s.id] })).rejects.toThrow();
  });
  it('A2-26 e-Way candidates leave out invoices that already have an EWB number', async () => {
    await buyGhee(200);
    const s = await post({ type: 'sales', date: '2026-10-05', partyId: m.kolkata.id, lines: [{ itemId: m.ghee.id, qty: 100, rate: 60000 }] });
    await ctx.call('PUT', `/api/vouchers/${s.id}/ewb`, { ewbNo: '391000000001' });
    const c = await ctx.call<any[]>('GET', '/api/gst/eway-candidates?from=2026-10-01&to=2026-10-31');
    expect(c.length).toBe(0);
  });
  it('A2-27 GSTR-1 for a past month does not change when a party GSTIN is added later', async () => {
    await buyGhee();
    await post({ type: 'sales', date: '2026-10-05', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
    await ctx.call('PUT', `/api/ledgers/${m.kalpana.id}`, { gstin: gstin('21', 'KALPA1234K') });
    const r = await ctx.call('GET', '/api/gst/gstr1?period=2026-10');
    expect(r.json.b2b).toBeUndefined();
  });
});

describe('safe retries and backups', () => {
  it('a save sent twice with the same key makes only one voucher', async () => {
    const ctx = await setup();
    const m = await seedDistributor(ctx.call);
    const body = { type: 'receipt', date: '2026-10-05', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: 10000 }], clientKey: 'abc123' };
    const a = await ctx.call('POST', '/api/vouchers', body);
    const b = await ctx.call('POST', '/api/vouchers', body);
    expect(b.id).toBe(a.id);
    const n = ctx.books.db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE type='receipt'`).get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('checks each backup and can tell a real backup from another file', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { backupAll, checkBackupFile } = await import('../../src/server/app');
    const ctx = await setup();
    await seedDistributor(ctx.call);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-bk-'));
    const file = (await backupAll(ctx.books, dir)).local!;
    expect(checkBackupFile(file).company).toBe('Samal Distributors');
    expect(ctx.books.company().last_backup).not.toBe('');
    const junk = path.join(dir, 'junk.db');
    fs.writeFileSync(junk, 'not a database');
    expect(() => checkBackupFile(junk)).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('only fetches Tally from this PC or the office network', async () => {
    const { checkTallyUrl } = await import('../../src/server/tally');
    expect(checkTallyUrl('http://localhost:9000')).toContain('localhost');
    expect(checkTallyUrl('http://192.168.1.4:9000')).toContain('192.168');
    expect(() => checkTallyUrl('http://example.com:9000')).toThrow();
    expect(() => checkTallyUrl('file:///etc/passwd')).toThrow();
  });

  it('records e-Way Bill numbers in the edit log and refuses them on cancelled bills', async () => {
    const ctx = await setup();
    const m = await seedDistributor(ctx.call);
    const v = await ctx.call('POST', '/api/vouchers', { type: 'receipt', date: '2026-10-05', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: 10000 }] });
    await expect(ctx.call('PUT', `/api/vouchers/${v.id}/ewb`, { ewbNo: '12ab' })).rejects.toThrow(/12 digits/);
    await ctx.call('PUT', `/api/vouchers/${v.id}/ewb`, { ewbNo: '123456789012' });
    const log = await ctx.call<any[]>('GET', '/api/audit');
    expect(log.some((r) => r.action === 'ewb')).toBe(true);
    await ctx.call('POST', `/api/vouchers/${v.id}/cancel`);
    await expect(ctx.call('PUT', `/api/vouchers/${v.id}/ewb`, { ewbNo: '123456789013' })).rejects.toThrow(/cancelled/);
  });
});
