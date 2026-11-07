// QA pharma: Tally XML import with batches and bills, Owner vs Billing operator, and bad input (must be 4xx, never 500).
// Tests whose name starts with "BUG" fail on purpose: they show a confirmed defect.
import { beforeEach, describe, expect, it } from 'vitest';
import { gstin, setup } from '../../api/helpers';
import { todayISO } from '../../../src/core/dates';
import { batchQty, checkInvariants, post, raw, seedPharma, type Ctx, type Seed } from './seed';

let ctx: Ctx;
let m: Seed;

beforeEach(async () => {
  ctx = await setup();
  m = await seedPharma(ctx);
});

const tallyXml = (extra = '') => `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE><UNIT NAME="Strp"><NAME>Strp</NAME></UNIT></TALLYMESSAGE>
<TALLYMESSAGE><STOCKGROUP NAME="Sun Pharma"><NAME>Sun Pharma</NAME></STOCKGROUP></TALLYMESSAGE>
<TALLYMESSAGE><STOCKITEM NAME="Pantocid 40 Tab">
  <PARENT>Sun Pharma</PARENT><BASEUNITS>Strp</BASEUNITS>
  <GSTDETAILS.LIST><HSNCODE>30049099</HSNCODE><STATEWISEDETAILS.LIST>
    <RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE> 12</GSTRATE></RATEDETAILS.LIST>
  </STATEWISEDETAILS.LIST></GSTDETAILS.LIST>
  <OPENINGBALANCE> 150 Strp</OPENINGBALANCE><OPENINGVALUE>-15000.00</OPENINGVALUE>
  <BATCHALLOCATIONS.LIST><BATCHNAME>PT101</BATCHNAME><GODOWNNAME>Main Location</GODOWNNAME><MFDON>1-Jan-2026</MFDON><EXPIRYPERIOD JD="1" P="31-Dec-2027">31-Dec-2027</EXPIRYPERIOD><OPENINGBALANCE> 100 Strp</OPENINGBALANCE><OPENINGVALUE>-10000.00</OPENINGVALUE></BATCHALLOCATIONS.LIST>
  <BATCHALLOCATIONS.LIST><BATCHNAME>PT099</BATCHNAME><GODOWNNAME>Main Location</GODOWNNAME><EXPIRYPERIOD>31-Mar-2027</EXPIRYPERIOD><OPENINGBALANCE> 50 Strp</OPENINGBALANCE><OPENINGVALUE>-5000.00</OPENINGVALUE></BATCHALLOCATIONS.LIST>
</STOCKITEM></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Mishra Medical Hall"><PARENT>Sundry Debtors</PARENT><PARTYGSTIN>${gstin('21', 'MISHR1234A')}</PARTYGSTIN>
  <LEDSTATENAME>Odisha</LEDSTATENAME><OPENINGBALANCE>-25000.00</OPENINGBALANCE><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>
  <BILLALLOCATIONS.LIST><NAME>MTP/25-26/880</NAME><BILLDATE>20260210</BILLDATE><OPENINGBALANCE>-15000.00</OPENINGBALANCE></BILLALLOCATIONS.LIST>
  <BILLALLOCATIONS.LIST><NAME>MTP/25-26/912</NAME><BILLDATE>20260305</BILLDATE><OPENINGBALANCE>-10000.00</OPENINGBALANCE></BILLALLOCATIONS.LIST>
</LEDGER></TALLYMESSAGE>
${extra}
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

describe('Tally XML import', () => {
  it('brings in batches with expiry, the opening stock and the party bills, and FEFO sells from them (works)', async () => {
    const r = await ctx.call('POST', '/api/import/tally', { xml: tallyXml() });
    expect(r).toMatchObject({ items: 1, ledgers: 1, bills: 2, batches: 2 });
    const item = (await ctx.call<any[]>('GET', '/api/items')).find((i) => i.name === 'Pantocid 40 Tab');
    expect(item).toMatchObject({ hsn: '30049099', gst_rate: 12, track_batch: 1, opening_qty: 150, opening_value: 1500000 });
    expect(await batchQty(ctx, item.id)).toEqual({ PT099: 50, PT101: 100 });
    const pt101 = ctx.books.batches(item.id).find((b) => b.batch_no === 'PT101')!;
    expect(pt101.expiry_date).toBe('2027-12-31');
    const mishra = ctx.books.ledgerByName('Mishra Medical Hall')!;
    expect(mishra.opening).toBe(2500000);
    const bills = await ctx.call<any[]>('GET', `/api/reports/pending-bills/${mishra.id}?asOf=2026-04-30`);
    expect(bills.map((b) => [b.ref, b.pending]).sort()).toEqual([['MTP/25-26/880', 1500000], ['MTP/25-26/912', 1000000]]);
    const s = await post(ctx, { type: 'sales', date: '2026-04-10', partyId: mishra.id, lines: [{ itemId: item.id, qty: 60, rate: 12000 }] });
    expect(s.lines.map((l: any) => [l.batch_no, l.qty])).toEqual([['PT099', 50], ['PT101', 10]]);
    // Importing the same file again adds nothing.
    expect(await ctx.call('POST', '/api/import/tally', { xml: tallyXml() })).toMatchObject({ items: 0, ledgers: 0, bills: 0, batches: 0 });
    await checkInvariants(ctx);
  });

  it('BUG: an item quantity written with a thousands separator ("1,200 Strp") comes in as 1', async () => {
    const xml = `<ENVELOPE><BODY><DATA><TALLYMESSAGE><STOCKITEM NAME="Dolo 650"><BASEUNITS>Strp</BASEUNITS>
      <OPENINGBALANCE> 1,200 Strp</OPENINGBALANCE><OPENINGVALUE>-36,000.00</OPENINGVALUE></STOCKITEM></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
    await ctx.call('POST', '/api/import/tally', { xml });
    const item = (await ctx.call<any[]>('GET', '/api/items')).find((i) => i.name === 'Dolo 650');
    expect(item.opening_value).toBe(3600000);
    expect(item.opening_qty, '1,200 strips').toBe(1200);
  });

  it('BUG: a batch with an expiry before its manufacturing date is imported without a word', async () => {
    const xml = `<ENVELOPE><BODY><DATA><TALLYMESSAGE><STOCKITEM NAME="Azee 500"><BASEUNITS>Strp</BASEUNITS><OPENINGBALANCE>10 Strp</OPENINGBALANCE>
      <BATCHALLOCATIONS.LIST><BATCHNAME>AZ1</BATCHNAME><MFDON>1-Jun-2026</MFDON><EXPIRYPERIOD>31-Dec-2025</EXPIRYPERIOD><OPENINGBALANCE>10 Strp</OPENINGBALANCE></BATCHALLOCATIONS.LIST>
      </STOCKITEM></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
    const r = await raw(ctx, 'POST', '/api/import/tally', { xml });
    expect(r.status === 400 || (r.body.skipped ?? []).length > 0, 'should refuse or list it as skipped').toBe(true);
  });

  it('BUG: batches kept in another Tally godown (Cold Room) are all put in the Main Location', async () => {
    const xml = `<ENVELOPE><BODY><DATA>
      <TALLYMESSAGE><GODOWN NAME="Cold Room"><NAME>Cold Room</NAME></GODOWN></TALLYMESSAGE>
      <TALLYMESSAGE><STOCKITEM NAME="Insulin Glargine Pen"><BASEUNITS>Pcs</BASEUNITS><OPENINGBALANCE>20 Pcs</OPENINGBALANCE>
      <BATCHALLOCATIONS.LIST><BATCHNAME>IG7</BATCHNAME><GODOWNNAME>Cold Room</GODOWNNAME><EXPIRYPERIOD>30-Jun-2027</EXPIRYPERIOD><OPENINGBALANCE>20 Pcs</OPENINGBALANCE></BATCHALLOCATIONS.LIST>
      </STOCKITEM></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
    await ctx.call('POST', '/api/import/tally', { xml });
    const cold = (await ctx.call<any[]>('GET', '/api/godowns')).find((g) => g.name === 'Cold Room');
    const item = (await ctx.call<any[]>('GET', '/api/items')).find((i) => i.name === 'Insulin Glargine Pen');
    const q = await ctx.call('GET', `/api/items/${item.id}/query?asOf=2026-04-30`);
    expect(q.godowns.find((g: any) => g.id === cold.id)?.qty ?? 0, 'the 20 pens are in the Cold Room').toBe(20);
  });

  it('BUG: batch quantities that do not add up to the item opening make a NEGATIVE "Opening" batch', async () => {
    const xml = `<ENVELOPE><STOCKITEM NAME="Cough Syrup 100ml"><BASEUNITS>Pcs</BASEUNITS>
      <BATCHALLOCATIONS.LIST><BATCHNAME>CS1</BATCHNAME><EXPIRYPERIOD>31-Mar-2027</EXPIRYPERIOD><OPENINGBALANCE>5 Pcs</OPENINGBALANCE></BATCHALLOCATIONS.LIST></STOCKITEM></ENVELOPE>`;
    await ctx.call('POST', '/api/import/tally', { xml });
    const item = (await ctx.call<any[]>('GET', '/api/items')).find((i) => i.name === 'Cough Syrup 100ml');
    const b = await batchQty(ctx, item.id);
    for (const [no, qty] of Object.entries(b)) expect(qty as number, `batch ${no}`).toBeGreaterThanOrEqual(0);
  });

  it('BUG: garbage XML ("not xml at all <<<") gives a 500 instead of a clear error', async () => {
    for (const body of [{ xml: 'not xml at all <<<' }, { xml: 42 }, { xml: '' }, { xml: '<ENVELOPE><LEDGER/></ENVELOPE>' }]) {
      const r = await raw(ctx, 'POST', '/api/import/tally', body);
      expect(r.status, JSON.stringify(body)).toBeLessThan(500);
    }
  });
});

describe('Owner vs Billing operator', () => {
  let owner: string;
  let op: string;
  const as = (t: string, method: string, url: string, body?: unknown) => raw(ctx, method, url, body, { 'x-stockwell-token': t });
  beforeEach(async () => {
    await ctx.call('POST', '/api/users', { name: 'Owner', role: 'owner', password: 'owner123' });
    owner = (await ctx.call('POST', '/api/login', { name: 'Owner', password: 'owner123' })).token;
    await as(owner, 'POST', '/api/users', { name: 'Billing', role: 'operator', password: 'bill1234' });
    op = (await ctx.call('POST', '/api/login', { name: 'Billing', password: 'bill1234' })).token;
    await as(owner, 'POST', '/api/vouchers', { type: 'purchase', date: '2026-06-01', partyId: m.supplier.id, refNo: 'UPA/1', lines: [{ itemId: m.gloves.id, qty: 100, rate: 1500 }] });
  });

  it('blocks the owner-only routes (works)', async () => {
    const pay = await as(owner, 'POST', '/api/vouchers', { type: 'payment', date: '2026-06-02', accountId: m.bank.id, entries: [{ ledgerId: m.supplier.id, amount: 10000 }] });
    for (const [method, url, body] of [
      ['POST', '/api/items/gst-rate', { itemIds: [m.gloves.id], rate: 5, from: '2026-10-01' }],
      ['DELETE', `/api/items/${m.gloves.id}/gst-rate?from=2026-10-01`],
      ['PUT', `/api/vouchers/${pay.body.id}/bank-date`, { date: '2026-06-03' }],
      ['GET', '/api/reports/tds'], ['GET', `/api/reports/brs/${m.bank.id}`], ['POST', '/api/import/tally', { xml: '<A/>' }], ['POST', '/api/backup'],
      ['PUT', '/api/godowns/1', { name: 'X' }],
    ] as [string, string, unknown?][]) {
      expect((await as(op, method, url, body)).status, `${method} ${url}`).toBe(403);
    }
  });

  it('QUESTIONABLE: a Billing operator can post back-dated bills, journals and physical-stock counts on any date', async () => {
    const old = await as(op, 'POST', '/api/vouchers', { type: 'sales', date: '2026-06-05', partyId: m.sahoo.id, lines: [{ itemId: m.gloves.id, qty: 1, rate: 1800 }] });
    const jv = await as(op, 'POST', '/api/vouchers', { type: 'journal', date: '2026-06-05', entries: [{ ledgerId: m.bank.id, amount: -100 }, { ledgerId: m.sahoo.id, amount: 100 }] });
    const ps = await as(op, 'POST', '/api/vouchers', { type: 'physical_stock', date: todayISO(), lines: [{ itemId: m.gloves.id, qty: 0 }] });
    // An operator who may alter only today's vouchers can still create old-dated ones and zero the stock.
    expect([old.status, jv.status, ps.status]).toEqual([403, 403, 403]);
  });

  // Left as is for now: the clerk needs stock quantities and the bank balance to take cheques. Owner to decide.
  it.skip('QUESTIONABLE: a Billing operator sees purchase cost through the stock summary and any ledger (bank, capital)', async () => {
    const ss = await as(op, 'GET', '/api/reports/stock-summary?asOf=2026-12-31');
    const bank = await as(op, 'GET', `/api/reports/ledger/${m.bank.id}`);
    expect([ss.status, bank.status]).toEqual([403, 403]);
  });
});

describe('bad input never gives a 500', () => {
  it('BUG: four bad requests give a 500 (object batchNo, bad asOf/to dates on TB and P&L, eway-json ids not a list)', async () => {
    await post(ctx, { type: 'purchase', date: '2026-06-01', partyId: m.supplier.id, refNo: 'UPA/1', lines: [{ itemId: m.para.id, qty: 100, rate: 2000, batchNo: 'P1', expiryDate: '2027-01-31' }] });
    const cases: [string, string, unknown?][] = [
      ['POST', '/api/vouchers', { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, qty: -5, rate: 2500 }] }],
      ['POST', '/api/vouchers', { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, qty: 5, rate: 0 }] }],
      ['POST', '/api/vouchers', { type: 'sales', date: '2025-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, qty: 5, rate: 2500 }] }],
      ['POST', '/api/vouchers', { type: 'sales', date: '01-07-2026', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, qty: 5, rate: 2500 }] }],
      ['POST', '/api/vouchers', { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, qty: 'five', rate: 2500 }] }],
      ['POST', '/api/vouchers', { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: 99999, qty: 1, rate: 2500 }] }],
      ['POST', '/api/vouchers', { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, batchId: 99999, qty: 1, rate: 2500 }] }],
      ['POST', '/api/vouchers', { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, batchId: 'abc', qty: 1, rate: 2500 }] }],
      ['POST', '/api/vouchers', { type: 'purchase', date: '2026-07-01', partyId: m.supplier.id, refNo: 'X1', lines: [{ itemId: m.para.id, qty: 1, rate: 2000, batchNo: 'B9', expiryDate: '2027-02-30' }] }],
      ['POST', '/api/vouchers', { type: 'purchase', date: '2026-07-01', partyId: m.supplier.id, refNo: { a: 1 }, lines: [{ itemId: m.para.id, qty: 1, rate: 2000, batchNo: 'B9' }] }],
      ['POST', '/api/vouchers', { type: 'purchase', date: '2026-07-01', partyId: m.supplier.id, refNo: 'X2', lines: [{ itemId: m.para.id, qty: 1, rate: 2000, batchNo: { x: 1 } }] }],
      ['POST', '/api/vouchers', { type: 'purchase', date: '2026-07-01', partyId: m.supplier.id, refNo: 'X3', lines: [{ itemId: m.para.id, qty: 1, rate: 2000, batchNo: 12345 }] }],
      ['POST', '/api/vouchers', { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, qty: 1, rate: 2500, unit: 'alt', freeQty: -1 }] }],
      ['POST', '/api/vouchers', { type: 'sales', date: '2026-07-01', partyId: m.sahoo.id, lines: [{ itemId: m.para.id, qty: 1e7, rate: 1e11 }] }],
      ['POST', '/api/vouchers', 'just a string'],
      ['POST', '/api/vouchers', [1, 2, 3]],
      ['POST', '/api/items', { name: 'Bad Item', unit_id: m.strip, hsn: '30A4', gst_rate: 12 }],
      ['POST', '/api/items', { name: 'Bad Rate', unit_id: m.strip, gst_rate: -5 }],
      ['POST', '/api/items', { name: '  ', unit_id: m.strip }],
      ['POST', '/api/items', { name: 'Opening Bad', unit_id: m.strip, track_batch: 1, opening_qty: 5, opening_expiry: '2027-13-01' }],
      ['POST', '/api/items/gst-rate', { itemIds: [m.para.id], rate: 'x', from: '2026-10-01' }],
      ['POST', '/api/items/gst-rate', { itemIds: 'all', rate: 5, from: '2026-10-01' }],
      ['POST', '/api/items/gst-rate', { itemIds: [m.para.id], rate: 5, from: '2026-02-31' }],
      ['DELETE', `/api/items/${m.para.id}/gst-rate?from=garbage`],
      ['GET', '/api/vouchers/abc/print'],
      ['GET', '/api/vouchers/999999/print'],
      ['GET', '/api/gst/gstr1?period=2026-13'],
      ['GET', '/api/gst/gstr1?period=2026-00'],
      ['GET', '/api/gst/gstr3b?period=abcd'],
      ['GET', '/api/reports/brs/999999'],
      ['GET', '/api/reports/brs/abc'],
      ['GET', '/api/reports/tds?from=2026-13-01&to=2026-14-01'],
      ['GET', '/api/reports/stock-summary?asOf=yesterday'],
      ['GET', '/api/reports/trial-balance?asOf=31-03-2027'],
      ['GET', '/api/reports/profit-loss?to=garbage'],
      ['GET', '/api/reports/balance-sheet?asOf=2026-02-31'],
      ['GET', `/api/reports/ledger/${m.sahoo.id}?to=xyz`],
      ['GET', '/api/reports/register?type=bogus'],
      ['GET', '/api/reports/sales-by?by=bogus'],
      ['GET', `/api/items/${m.para.id}/query?asOf=bad`],
      ['GET', '/api/items/999999/query'],
      ['GET', '/api/vouchers/next-number?type=bogus'],
      ['GET', '/api/vouchers/next-number?type=sales&date=garbage'],
      ['PUT', '/api/vouchers/999999/bank-date', { date: '2026-07-01' }],
      ['PUT', '/api/ledgers/999999', { name: 'x' }],
      ['POST', '/api/ledgers', { name: 'ଓଡ଼ିଆ ମେଡିକାଲ', group_id: 999999 }],
      ['POST', '/api/units', { symbol: '' }],
      ['POST', '/api/gst/eway-json', { ids: 'x' }],
      ['POST', '/api/gst/eway-json', {}],
      ['POST', '/api/vouchers/abc/bounce', {}],
      ['GET', '/api/reports/pending-bills/abc'],
      ['GET', '/api/reports/reminder/999999'],
      ['GET', '/api/vouchers/999999/whatsapp'],
    ];
    const fivehundreds: string[] = [];
    for (const [method, url, body] of cases) {
      const r = await raw(ctx, method, url, body);
      if (r.status >= 500) fivehundreds.push(`${method} ${url} ${JSON.stringify(body ?? '')} → ${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 160)}`);
    }
    expect(fivehundreds).toEqual([]);
  });

  it('keeps unicode (Odia) names intact in a bill and its print (works)', async () => {
    const odia = await ctx.call('POST', '/api/ledgers', { name: 'ଶ୍ରୀ ଜଗନ୍ନାଥ ମେଡିକାଲ', group_id: m.g('Sundry Debtors'), state_code: '21' });
    await post(ctx, { type: 'purchase', date: '2026-06-01', partyId: m.supplier.id, refNo: 'UPA/1', lines: [{ itemId: m.gloves.id, qty: 10, rate: 1500 }] });
    const s = await post(ctx, { type: 'sales', date: '2026-07-01', partyId: odia.id, narration: 'ଧନ୍ୟବାଦ 🙏', lines: [{ itemId: m.gloves.id, qty: 1, rate: 1800 }] });
    const html = (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${s.id}/print` })).body;
    expect(html).toContain('ଶ୍ରୀ ଜଗନ୍ନାଥ ମେଡିକାଲ');
  });
});
