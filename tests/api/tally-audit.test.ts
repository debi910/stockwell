// What the independent Tally audit found, each as a test: real TallyPrime XML shapes that the first
// importer and exporter got wrong (voucher-mode items, payroll, P&L opening, foreign currency, own main
// groups, renamed groups, altered and deleted vouchers, compound and alternate units, dated GST, godown openings).
import { describe, expect, it } from 'vitest';
import { setup, gstin } from './helpers';
import { compoundQty, firstNumber, parseTallyMasters, tallyAmount, PL_LEDGER, type TallyUnit } from '../../src/server/tally';
import { parseTallyVouchers, removeDeletedInTally } from '../../src/server/tallyVouchers';
import { importTallyXml } from '../../src/server/tallyImport';
import { tallyDayBookXml, tallyMastersXml } from '../../src/server/tallyExport';
import type { Books } from '../../src/server/books';

const env = (inner: string) => `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
const msg = (inner: string) => `<TALLYMESSAGE>${inner}</TALLYMESSAGE>`;

const MASTERS = env([
  msg(`<COMPANY NAME="Samal Traders"><BOOKSFROM>20260401</BOOKSFROM></COMPANY>`),
  // A main group made in Tally (an expense), and Sundry Debtors renamed to "Trade Receivables".
  msg(`<GROUP NAME="Staff Welfare"><PARENT>&#4; Primary</PARENT><ISREVENUE>Yes</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AFFECTSGROSSPROFIT>No</AFFECTSGROSSPROFIT></GROUP>`),
  msg(`<GROUP NAME="Trade Receivables" RESERVEDNAME="Sundry Debtors"><PARENT>Current Assets</PARENT></GROUP>`),
  msg(`<GROUP NAME="Retailers"><PARENT>Trade Receivables</PARENT></GROUP>`),
  msg(`<GROUP NAME="Branch / Divisions" RESERVEDNAME="Branch / Divisions"><PARENT>&#4; Primary</PARENT></GROUP>`),
  msg(`<LEDGER NAME="Profit &amp; Loss A/c" RESERVEDNAME="Profit &amp; Loss A/c"><PARENT>&#4; Primary</PARENT><OPENINGBALANCE>-50000.00</OPENINGBALANCE></LEDGER>`),
  msg(`<LEDGER NAME="Capital A/c"><PARENT>Capital Account</PARENT><OPENINGBALANCE>145250.00</OPENINGBALANCE></LEDGER>`),
  msg(`<LEDGER NAME="Cash"><PARENT>Cash-in-Hand</PARENT><OPENINGBALANCE>-90000.00</OPENINGBALANCE></LEDGER>`),
  msg(`<LEDGER NAME="Tea for staff"><PARENT>Staff Welfare</PARENT></LEDGER>`),
  msg(`<LEDGER NAME="Salary"><PARENT>Indirect Expenses</PARENT></LEDGER>`),
  msg(`<LEDGER NAME="Salary Payable"><PARENT>Current Liabilities</PARENT></LEDGER>`),
  msg(`<LEDGER NAME="Bhubaneswar Branch"><PARENT>Branch / Divisions</PARENT></LEDGER>`),
  // GSTIN and state in TallyPrime 3.0+'s dated lists: the later entry is the one in force.
  msg(`<LEDGER NAME="Maa Tarini Stores"><PARENT>Retailers</PARENT><ISBILLWISEON>Yes</ISBILLWISEON>
    <LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><GSTIN>${gstin('20', 'TARIN1234Q')}</GSTIN></LEDGSTREGDETAILS.LIST>
    <LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20240401</APPLICABLEFROM><GSTIN>${gstin('21', 'TARIN1234Q')}</GSTIN></LEDGSTREGDETAILS.LIST>
    <LEDMAILINGDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><STATE>Jharkhand</STATE></LEDMAILINGDETAILS.LIST>
    <LEDMAILINGDETAILS.LIST><APPLICABLEFROM>20240401</APPLICABLEFROM><STATE>Odisha</STATE><PINCODE>751001</PINCODE></LEDMAILINGDETAILS.LIST></LEDGER>`),
  msg(`<LEDGER NAME="Gupta Suppliers"><PARENT>Sundry Creditors</PARENT></LEDGER>`),
  msg(`<LEDGER NAME="Purchase"><PARENT>Purchase Accounts</PARENT></LEDGER>`),
  msg(`<LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT></LEDGER>`),
  msg(`<LEDGER NAME="Ground Rent"><PARENT>Indirect Expenses</PARENT></LEDGER>`),
  msg(`<LEDGER NAME="Export Sales"><PARENT>Sales Accounts</PARENT></LEDGER>`),
  msg(`<LEDGER NAME="Overseas Buyer"><PARENT>Sundry Debtors</PARENT></LEDGER>`),
  msg(`<UNIT NAME="Nos"><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>`),
  msg(`<UNIT NAME="Box"><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT></UNIT>`),
  msg(`<UNIT NAME="Box of 10 Nos"><ISSIMPLEUNIT>No</ISSIMPLEUNIT><BASEUNITS>Box</BASEUNITS><ADDITIONALUNITS>Nos</ADDITIONALUNITS><CONVERSION> 10</CONVERSION></UNIT>`),
  msg(`<GODOWN NAME="Cuttack Godown"><PARENT>&#4; Primary</PARENT></GODOWN>`),
  // GST rate cut from 18% to 5% on 22 Sep 2025: the item should come in at 5%, keeping 18% for older dates.
  msg(`<STOCKITEM NAME="Ghee 1L"><BASEUNITS>Nos</BASEUNITS><OPENINGBALANCE> 10 Nos</OPENINGBALANCE><OPENINGVALUE>-5000.00</OPENINGVALUE>
    <GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><HSNCODE>0405</HSNCODE><TAXABILITY>Taxable</TAXABILITY><STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>
      <RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE> 18</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>
    <GSTDETAILS.LIST><APPLICABLEFROM>20250922</APPLICABLEFROM><HSNCODE>0405</HSNCODE><TAXABILITY>Taxable</TAXABILITY><STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>
      <RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE> 5</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>
    <BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><OPENINGBALANCE> 6 Nos</OPENINGBALANCE><OPENINGVALUE>-3000.00</OPENINGVALUE></BATCHALLOCATIONS.LIST>
    <BATCHALLOCATIONS.LIST><GODOWNNAME>Cuttack Godown</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><OPENINGBALANCE> 4 Nos</OPENINGBALANCE><OPENINGVALUE>-2000.00</OPENINGVALUE></BATCHALLOCATIONS.LIST>
  </STOCKITEM>`),
  msg(`<STOCKITEM NAME="Agarbatti"><BASEUNITS>Box of 10 Nos</BASEUNITS><OPENINGBALANCE> 2-5 Box of 10 Nos</OPENINGBALANCE><OPENINGVALUE>-250.00</OPENINGVALUE></STOCKITEM>`),
  msg(`<STOCKITEM NAME="Soap"><BASEUNITS>Nos</BASEUNITS><ADDITIONALUNITS>Box</ADDITIONALUNITS><DENOMINATOR> 1</DENOMINATOR><CONVERSION> 12</CONVERSION></STOCKITEM>`),
  msg(`<VOUCHERTYPE NAME="Payroll"><PARENT>Payroll</PARENT></VOUCHERTYPE>`),
].join(''));

const V = (attrs: string, inner: string) => msg(`<VOUCHER ${attrs}>${inner}</VOUCHER>`);
const L = (list: string, ledger: string, amount: string, extra = '') => `<${list}><LEDGERNAME>${ledger}</LEDGERNAME><AMOUNT>${amount}</AMOUNT>${extra}</${list}>`;

const DAYBOOK = env([
  // C1: a purchase entered in voucher mode: the item sits under the Purchase ledger line.
  V('VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Accounting Voucher View"', `<DATE>20260410</DATE><GUID>a-1</GUID><ALTERID>11</ALTERID><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><VOUCHERNUMBER>P-1</VOUCHERNUMBER><PARTYLEDGERNAME>Gupta Suppliers</PARTYLEDGERNAME>
    ${L('ALLLEDGERENTRIES.LIST', 'Gupta Suppliers', '1000.00')}
    ${L('ALLLEDGERENTRIES.LIST', 'Purchase', '-1000.00', `<INVENTORYALLOCATIONS.LIST><STOCKITEMNAME>Ghee 1L</STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><RATE>100.00/Nos</RATE><AMOUNT>-1000.00</AMOUNT><ACTUALQTY> 10 Nos</ACTUALQTY><BILLEDQTY> 10 Nos</BILLEDQTY></INVENTORYALLOCATIONS.LIST>`)}`),
  // C2: payroll posts Salary Dr / Salary Payable Cr; attendance has no amounts.
  V('VCHTYPE="Payroll" ACTION="Create"', `<DATE>20260430</DATE><GUID>a-2</GUID><VOUCHERTYPENAME>Payroll</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>
    ${L('ALLLEDGERENTRIES.LIST', 'Salary', '-15000.00', '<CATEGORYENTRY.LIST><CATEGORY>Primary Cost Category</CATEGORY><EMPLOYEEENTRY.LIST><EMPLOYEENAME>Ravi</EMPLOYEENAME></EMPLOYEEENTRY.LIST></CATEGORYENTRY.LIST>')}
    ${L('ALLLEDGERENTRIES.LIST', 'Salary Payable', '15000.00')}`),
  V('VCHTYPE="Attendance" ACTION="Create"', `<DATE>20260430</DATE><GUID>a-3</GUID><VOUCHERTYPENAME>Attendance</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>`),
  // H1: a foreign-currency sale.
  V('VCHTYPE="Sales" ACTION="Create"', `<DATE>20260412</DATE><GUID>a-4</GUID><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>EX-1</VOUCHERNUMBER>
    ${L('ALLLEDGERENTRIES.LIST', 'Overseas Buyer', '-$ 100.00 @ ₹ 83.00/$ = -₹ 8300.00')}
    ${L('ALLLEDGERENTRIES.LIST', 'Export Sales', '$ 100.00 @ ₹ 83.00/$ = ₹ 8300.00')}`),
  // M6: two godowns, the batches carry no amount of their own; M2: rate per Box, quantity in Nos.
  V('VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View"', `<DATE>20260415</DATE><GUID>a-5</GUID><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>S-1</VOUCHERNUMBER><ISINVOICE>Yes</ISINVOICE><PARTYLEDGERNAME>Maa Tarini Stores</PARTYLEDGERNAME>
    <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Ghee 1L</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>150.00/Nos</RATE><AMOUNT>1500.00</AMOUNT><ACTUALQTY> 10 Nos</ACTUALQTY><BILLEDQTY> 10 Nos</BILLEDQTY>
      <BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><ACTUALQTY> 6 Nos</ACTUALQTY><BILLEDQTY> 6 Nos</BILLEDQTY></BATCHALLOCATIONS.LIST>
      <BATCHALLOCATIONS.LIST><GODOWNNAME>Cuttack Godown</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><ACTUALQTY> 4 Nos</ACTUALQTY><BILLEDQTY> 4 Nos</BILLEDQTY></BATCHALLOCATIONS.LIST>
      <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>1500.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>
    <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Agarbatti</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>100.00/Box</RATE><AMOUNT>150.00</AMOUNT><ACTUALQTY> 1-5 Box of 10 Nos</ACTUALQTY><BILLEDQTY> 1-5 Box of 10 Nos</BILLEDQTY>
      <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>150.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>
    ${L('LEDGERENTRIES.LIST', 'Maa Tarini Stores', '-1650.00', '<BILLALLOCATIONS.LIST><NAME>S-1</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-1650.00</AMOUNT></BILLALLOCATIONS.LIST>')}
    ${L('ALLLEDGERENTRIES.LIST', 'Maa Tarini Stores', '-1650.00')}
    ${L('ALLLEDGERENTRIES.LIST', 'Sales', '1650.00')}`),
  // A ledger named like round-off but not one.
  V('VCHTYPE="Payment" ACTION="Create"', `<DATE>20260416</DATE><GUID>a-6</GUID><ALTERID>20</ALTERID><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>
    ${L('ALLLEDGERENTRIES.LIST', 'Ground Rent', '-500.00')}${L('ALLLEDGERENTRIES.LIST', 'Cash', '500.00')}`),
  V('VCHTYPE="Payment" ACTION="Create"', `<DATE>20260417</DATE><GUID>a-7</GUID><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><VOUCHERNUMBER>2</VOUCHERNUMBER>
    ${L('ALLLEDGERENTRIES.LIST', 'Tea for staff', '-200.00')}${L('ALLLEDGERENTRIES.LIST', 'Cash', '200.00')}`),
].join(''));

const stockOf = (books: Books, name: string, godown: number | null = null) => {
  const id = (books.db.prepare(`SELECT id FROM items WHERE name=?`).get(name) as { id: number }).id;
  return books.stockOf(id, '2027-03-31', 0, godown);
};

async function imported() {
  const s = await setup();
  await s.call('PUT', '/api/company', { name: 'Samal Traders', books_from: '2026-04-01' });
  const masters = importTallyXml(s.books, MASTERS);
  const day = importTallyXml(s.books, DAYBOOK);
  return { ...s, masters, day };
}

describe('reading Tally text', () => {
  it('reads foreign-currency amounts in rupees, and (-) as minus, without ever failing', () => {
    expect(tallyAmount('-$ 100.00 @ ₹ 83.00/$ = -₹ 8300.00')).toBe(830000);
    expect(tallyAmount('$ 100.00 @ ₹ 83.00/$ = ₹ 8300.00')).toBe(-830000);
    expect(tallyAmount('(-)1,250.50')).toBe(125050);
    expect(tallyAmount('-1,250.50')).toBe(125050);
    expect(tallyAmount('nonsense')).toBe(0);
    expect(tallyAmount(undefined)).toBe(0);
    expect(firstNumber(' (-)5 Nos')).toBe(-5);
    expect(firstNumber('12 Nos = 1 Box')).toBe(12);
  });

  it('reads compound-unit quantities in the smallest unit', () => {
    const units: TallyUnit[] = [
      { name: 'Nos', simple: true, base: '', add: '', conv: 1, decimals: 0 },
      { name: 'Box', simple: true, base: '', add: '', conv: 1, decimals: 0 },
      { name: 'Box of 10 Nos', simple: false, base: 'Box', add: 'Nos', conv: 10, decimals: 0 },
    ];
    expect(compoundQty(' 1-5 Box of 10 Nos', units, 'Box of 10 Nos')).toBe(15);
    expect(compoundQty(' 1 Box 5 Nos', units, 'Box of 10 Nos')).toBe(15);
    expect(compoundQty(' 3 Box of 10 Nos', units, 'Box of 10 Nos')).toBe(30);
    expect(compoundQty(' 7 Nos', units, 'Box of 10 Nos')).toBe(7);
    expect(compoundQty(' 4 Nos', units, 'Nos')).toBe(4);
  });

  it('takes the GST rate, GSTIN and state in force today from Tally\'s dated lists', () => {
    const m = parseTallyMasters(MASTERS, '2026-11-07');
    const ghee = m.items.find((i) => i.name === 'Ghee 1L')!;
    expect(ghee.gstRate).toBe(5);
    expect(ghee.gstRates).toEqual([{ from: '2017-07-01', rate: 18 }, { from: '2025-09-22', rate: 5 }]);
    const tarini = m.ledgers.find((l) => l.name === 'Maa Tarini Stores')!;
    expect(tarini.gstin).toBe(gstin('21', 'TARIN1234Q'));
    expect(tarini.state).toBe('Odisha');
    expect(tarini.pincode).toBe('751001');
    expect(m.booksFrom).toBe('2026-04-01');
    expect(m.groups.find((g) => g.name === 'Staff Welfare')).toMatchObject({ parent: 'Primary', nature: 'expense', direct: false });
  });

  it('takes one of the two ledger lists, the one that balances, never both added up', () => {
    const [v] = parseTallyVouchers(env(V('VCHTYPE="Sales"', `<DATE>20260415</DATE><ISINVOICE>Yes</ISINVOICE>
      ${L('LEDGERENTRIES.LIST', 'Party', '-100.00')}${L('ALLLEDGERENTRIES.LIST', 'Party', '-100.00')}${L('ALLLEDGERENTRIES.LIST', 'Sales', '100.00')}`)));
    expect(v.entries.map((e) => [e.ledger, e.amount])).toEqual([['Party', 10000], ['Sales', -10000]]);
  });
});

describe('importing real-shaped Tally data', () => {
  it('brings stock in from a voucher-mode purchase (items under the ledger line)', async () => {
    const { books } = await imported();
    // 10 opening + 10 bought − 10 sold
    expect(stockOf(books, 'Ghee 1L')).toBe(10);
    const p = books.db.prepare(`SELECT v.taxable, i.qty, i.rate, i.direction FROM vouchers v JOIN inventory i ON i.voucher_id=v.id WHERE v.tally_id='a-1'`).get();
    expect(p).toEqual({ taxable: 100000, qty: 10, rate: 10000, direction: 1 });
  });

  it('brings payroll in as a journal and says attendance was left out', async () => {
    const { books, day } = await imported();
    expect(books.db.prepare(`SELECT type FROM vouchers WHERE tally_id='a-2'`).get()).toEqual({ type: 'journal' });
    expect(day.vouchers!.skipped.some((s) => /1 Attendance voucher was left out/.test(s))).toBe(true);
  });

  it('keeps the Profit & Loss A/c opening, so the opening trial balance agrees', async () => {
    const { books, call } = await imported();
    const pl = books.ledgerByName(PL_LEDGER)!;
    expect(pl.opening).toBe(5000000);
    expect(books.groupPath(pl.group_id)).toContain('Reserves & Surplus');
    const tb = await call('GET', '/api/reports/trial-balance?asOf=2026-04-01');
    expect(tb.openingDiff).toBe(0);
  });

  it('makes main groups from Tally with their nature, and maps renamed built-in groups to Stockwell\'s own', async () => {
    const { books, masters } = await imported();
    const welfare = books.groupByName('Staff Welfare');
    expect(welfare).toMatchObject({ parent_id: null, nature: 'expense' });
    expect(books.ledgerByName('Tea for staff')!.group_id).toBe(welfare.id);
    // "Trade Receivables" is Sundry Debtors, so its parties keep bills and count as debtors.
    expect(books.db.prepare(`SELECT 1 FROM groups WHERE name='Trade Receivables'`).get()).toBeUndefined();
    const tarini = books.ledgerByName('Maa Tarini Stores')!;
    expect(books.groupPath(tarini.group_id)).toEqual(['Retailers', 'Sundry Debtors', 'Current Assets']);
    expect(books.isBillWise(tarini.id)).toBe(true);
    expect(tarini.gstin).toBe(gstin('21', 'TARIN1234Q'));
    expect(books.groupPath(books.ledgerByName('Bhubaneswar Branch')!.group_id)).toEqual(['Branch/Divisions']);
    expect(masters.skipped.filter((s) => /Suspense/.test(s))).toEqual([]);
  });

  it('brings foreign-currency vouchers in at their rupee value', async () => {
    const { books, day } = await imported();
    expect(day.vouchers!.skipped).toEqual([expect.stringMatching(/Attendance/)]);
    const v = books.db.prepare(`SELECT total FROM vouchers WHERE tally_id='a-4'`).get();
    expect(v).toEqual({ total: 830000 });
  });

  it('shares a line amount over its godowns, reads compound quantities, and keeps rates per base unit', async () => {
    const { books } = await imported();
    const lines = books.db.prepare(`SELECT i.qty, i.taxable, i.rate, i.godown_id FROM inventory i JOIN vouchers v ON v.id=i.voucher_id WHERE v.tally_id='a-5' ORDER BY i.line_no`).all() as any[];
    expect(lines.map((l) => [l.qty, l.taxable])).toEqual([[6, 90000], [4, 60000], [15, 15000]]);
    expect(lines[2].rate).toBe(1000); // ₹100 a Box of 10 = ₹10 a Nos
    expect(books.db.prepare(`SELECT u.symbol FROM items i JOIN units u ON u.id=i.unit_id WHERE i.name='Agarbatti'`).get()).toEqual({ symbol: 'Nos' });
    expect(stockOf(books, 'Agarbatti')).toBe(25 - 15);
  });

  it('puts opening stock in the godowns Tally had it in, for items without batches', async () => {
    const { books } = await imported();
    const cuttack = (books.db.prepare(`SELECT id FROM godowns WHERE name='Cuttack Godown'`).get() as { id: number }).id;
    // Opening: 6 Main + 4 Cuttack; bought 10 into Main; sold 6 Main + 4 Cuttack.
    expect(stockOf(books, 'Ghee 1L', cuttack)).toBe(0);
    const before = books.stockOf((books.db.prepare(`SELECT id FROM items WHERE name='Ghee 1L'`).get() as { id: number }).id, '2026-04-01', 0, cuttack);
    expect(before).toBe(4);
  });

  it('keeps the GST rate history, so old dates use the old rate', async () => {
    const { books } = await imported();
    const ghee = books.db.prepare(`SELECT * FROM items WHERE name='Ghee 1L'`).get() as any;
    expect(ghee.gst_rate).toBe(5);
    expect(books.rateOn(ghee, '2025-01-01')).toBe(18);
    expect(books.rateOn(ghee, '2026-04-01')).toBe(5);
  });

  it('does not take "Ground Rent" for a round-off ledger', async () => {
    const { books } = await imported();
    expect(books.db.prepare(`SELECT round_off FROM vouchers WHERE tally_id='a-6'`).get()).toEqual({ round_off: 0 });
  });

  it('brings in a voucher again when it was altered in Tally, and takes out vouchers deleted there', async () => {
    const { books } = await imported();
    const altered = DAYBOOK.replace('<ALTERID>20</ALTERID>', '<ALTERID>25</ALTERID>').replace(/-500\.00/, '-700.00').replace(/>500\.00</, '>700.00<');
    const r = importTallyXml(books, altered);
    expect(r.vouchers).toMatchObject({ vouchers: 0, updated: 1 });
    expect(books.db.prepare(`SELECT total FROM vouchers WHERE tally_id='a-6'`).get()).toEqual({ total: 70000 });
    // The same file again: nothing changes.
    expect(importTallyXml(books, altered).vouchers).toMatchObject({ vouchers: 0, updated: 0 });
    // Tally no longer has a-7.
    const r2 = removeDeletedInTally(books, '2026-04-01', '2026-04-30', new Set(['a-1', 'a-2', 'a-4', 'a-5', 'a-6']));
    expect(r2.removed).toBe(1);
    expect(books.db.prepare(`SELECT 1 FROM vouchers WHERE tally_id='a-7'`).get()).toBeUndefined();
    // An empty answer from Tally is not taken as "everything was deleted".
    expect(removeDeletedInTally(books, '2026-04-01', '2026-04-30', new Set()).removed).toBe(0);
  });
});

describe('export for TallyPrime', () => {
  it('writes what TallyPrime needs: batch switches, dated GST, GST registration lists, unit decimals, P&L opening', async () => {
    const { books, call } = await imported();
    const units = await call<any[]>('GET', '/api/units');
    await call('POST', '/api/items', { name: 'Paneer', unit_id: units.find((u) => u.symbol === 'Kg').id, gst_rate: 5, track_batch: 1, opening_qty: 2.5, opening_value: 75000, opening_batch_no: 'B1', opening_expiry: '2026-12-31' });
    const xml = tallyMastersXml(books);
    expect(xml).toMatch(/<STOCKITEM NAME="Paneer">.*<ISBATCHWISEON>Yes<\/ISBATCHWISEON><HASMFGDATE>No<\/HASMFGDATE><ISPERISHABLEON>Yes<\/ISPERISHABLEON>/s);
    expect(xml).toMatch(/<UNIT NAME="Kg">.*?<DECIMALPLACES>3<\/DECIMALPLACES>/s);
    expect(xml).toMatch(/<UNIT NAME="Nos">.*?<DECIMALPLACES>0<\/DECIMALPLACES>/s);
    expect(xml).toMatch(/<STOCKITEM NAME="Ghee 1L">.*?<APPLICABLEFROM>20260401<\/APPLICABLEFROM>.*?<GSTRATEDUTYHEAD>Integrated Tax<\/GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value<\/GSTRATEVALUATIONTYPE><GSTRATE>5<\/GSTRATE>/s);
    expect(xml).toMatch(/<LEDGER NAME="Maa Tarini Stores">.*<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20260401<\/APPLICABLEFROM><GSTREGISTRATIONTYPE>Regular<\/GSTREGISTRATIONTYPE><GSTIN>21/s);
    // Tally's own predefined ledger, with no parent, carrying the opening.
    expect(xml).toMatch(/<LEDGER NAME="Profit &amp; Loss A\/c"><NAME>Profit &amp; Loss A\/c<\/NAME><OPENINGBALANCE>-50000.00<\/OPENINGBALANCE>/);
  });

  it('writes invoices in Tally\'s invoice layout, cancelled vouchers bare, and no made-up GUIDs', async () => {
    const { books, call } = await imported();
    const items = await call<any[]>('GET', '/api/items');
    const ghee = items.find((i) => i.name === 'Ghee 1L');
    const tarini = books.ledgerByName('Maa Tarini Stores')!;
    const sale = await call('POST', '/api/vouchers', { type: 'sales', date: '2026-04-20', partyId: tarini.id, lines: [{ itemId: ghee.id, qty: 1, rate: 15000 }] });
    const gone = await call('POST', '/api/vouchers', { type: 'sales', date: '2026-04-20', partyId: tarini.id, lines: [{ itemId: ghee.id, qty: 1, rate: 15000 }] });
    await call('POST', `/api/vouchers/${gone.id}/cancel`, {});
    const { xml } = tallyDayBookXml(books);
    const mine = xml.split('<TALLYMESSAGE').find((m) => m.includes(`<VOUCHERNUMBER>${sale.number}</VOUCHERNUMBER>`) && m.includes('20260420'))!;
    expect(mine).toMatch(/REMOTEID="stockwell-/);
    expect(mine).not.toMatch(/<GUID>/);
    expect(mine).toMatch(/<PERSISTEDVIEW>Invoice Voucher View<\/PERSISTEDVIEW>/);
    expect(mine).toMatch(/<LEDGERENTRIES.LIST><LEDGERNAME>Maa Tarini Stores<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>/);
    expect(mine).not.toMatch(/ALLLEDGERENTRIES/);
    const cancelled = xml.split('<TALLYMESSAGE').find((m) => m.includes(`<VOUCHERNUMBER>${gone.number}</VOUCHERNUMBER>`))!;
    expect(cancelled).toMatch(/<ISCANCELLED>Yes<\/ISCANCELLED><\/VOUCHER>/);
    expect(cancelled).not.toMatch(/LEDGERENTRIES|INVENTORYENTRIES/);
    // Tally's own vouchers keep their Tally id.
    expect(xml).toMatch(/REMOTEID="a-1"/);
  });

  it('round-trips: Stockwell\'s export imported into a fresh company gives the same books', async () => {
    const { books, call } = await imported();
    const masters = tallyMastersXml(books);
    const { xml } = tallyDayBookXml(books);
    const b = await setup();
    await b.call('PUT', '/api/company', { name: 'Copy', books_from: '2026-04-01' });
    importTallyXml(b.books, masters);
    const r = importTallyXml(b.books, xml);
    expect(r.vouchers!.skipped).toEqual([]);
    const tb1 = await call('GET', '/api/reports/trial-balance?asOf=2027-03-31');
    const tb2 = await b.call('GET', '/api/reports/trial-balance?asOf=2027-03-31');
    expect([tb2.totalDr, tb2.totalCr, tb2.openingDiff]).toEqual([tb1.totalDr, tb1.totalCr, tb1.openingDiff]);
    for (const name of ['Ghee 1L', 'Agarbatti']) expect(stockOf(b.books, name)).toBe(stockOf(books, name));
  });
});
