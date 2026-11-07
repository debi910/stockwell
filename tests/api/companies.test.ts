// Several companies in their own folders, and moving a company's books in and out as Tally XML.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app';
import { decodeTally } from '../../src/server/tally';
import { seedDistributor } from './helpers';

let dir: string;
let built: Awaited<ReturnType<typeof buildApp>>;

const callIn = (company: string | null) => async <T = any>(method: string, url: string, payload?: unknown): Promise<T> => {
  const res = await built.app.inject({ method: method as never, url, payload: payload as never, headers: company ? { 'x-stockwell-company': company } : {} });
  const body = res.body ? JSON.parse(res.body) : null;
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode}: ${body?.error}`);
  return body as T;
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockwell-companies-'));
  built = await buildApp({ dataDir: dir, defaultBackupDir: path.join(dir, 'Backups'), exportDir: path.join(dir, 'Exports') });
});
afterEach(async () => { await built.app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('several companies, each in its own folder', () => {
  it('starts with one company in Companies\\100000 and adds more in the next folders', async () => {
    const list = await callIn(null)('GET', '/api/companies/list');
    expect(list.multi).toBe(true);
    expect(list.companies.map((c: any) => c.id)).toEqual(['100000']);
    expect(fs.existsSync(path.join(dir, 'Companies', '100000', 'stockwell.db'))).toBe(true);
    const b = await callIn('100000')('POST', '/api/companies', { name: 'Cemech Paints', books_from: '2025-04-01' });
    expect(b).toMatchObject({ id: '100001', name: 'Cemech Paints', books_from: '2025-04-01' });
    expect(fs.existsSync(path.join(dir, 'Companies', '100001', 'stockwell.db'))).toBe(true);
    await expect(callIn('100000')('POST', '/api/companies', { name: 'cemech paints' })).rejects.toThrow(/already a company/);
    await expect(callIn('100000')('POST', '/api/companies', { name: 'Bad date', books_from: '31-31-2025' })).rejects.toThrow();
    expect(fs.readdirSync(path.join(dir, 'Companies')).sort()).toEqual(['100000', '100001']);
  });

  it('keeps each company\'s books, users and backups apart', async () => {
    const a = callIn('100000');
    await seedDistributor(a);
    const b = callIn((await a('POST', '/api/companies', { name: 'Uniq Oils' })).id);
    expect((await b<any[]>('GET', '/api/ledgers')).some((l) => l.name === 'Ramesh Stores')).toBe(false);
    expect((await a<any[]>('GET', '/api/ledgers')).some((l) => l.name === 'Ramesh Stores')).toBe(true);
    expect((await b('GET', '/api/company')).name).toBe('Uniq Oils');
    // A login made in one company is not a login in the other.
    await b('POST', '/api/users', { name: 'Owner', role: 'owner', password: 'secret123' });
    const { token } = await b('POST', '/api/login', { name: 'Owner', password: 'secret123' });
    const other = await built.app.inject({ method: 'GET', url: '/api/session', headers: { 'x-stockwell-company': '100000', 'x-stockwell-token': token } });
    expect(JSON.parse(other.body)).toMatchObject({ usersEnabled: false, user: null });
    const mine = await built.app.inject({ method: 'GET', url: '/api/ledgers', headers: { 'x-stockwell-company': '100001' } });
    expect(mine.statusCode).toBe(401);
    // A company made by a logged-in Owner of B takes B's logins along, so the other PCs can open it.
    const c = await built.app.inject({ method: 'POST', url: '/api/companies', payload: { name: 'Weighing Scale' }, headers: { 'x-stockwell-company': '100001', 'x-stockwell-token': token } });
    const cid = JSON.parse(c.body).id;
    const login = await built.app.inject({ method: 'POST', url: '/api/login', payload: { name: 'Owner', password: 'secret123' }, headers: { 'x-stockwell-company': cid } });
    expect(login.statusCode).toBe(200);
    // Backups go in a folder per company.
    await a('POST', '/api/backup');
    const folders = fs.readdirSync(path.join(dir, 'Backups'));
    expect(folders).toEqual(['Samal Distributors (100000)']);
  });

  it('says plainly when a company is not there', async () => {
    const r = await built.app.inject({ method: 'GET', url: '/api/ledgers', headers: { 'x-stockwell-company': '100009' } });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toMatchObject({ code: 'no-company' });
    const bad = await built.app.inject({ method: 'GET', url: '/api/ledgers', headers: { 'x-stockwell-company': '../x' } });
    expect(bad.statusCode).toBe(404);
  });

  it('moves books from before companies had folders into Companies\\100000', async () => {
    await built.app.close();
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'stockwell-old-'));
    const first = await buildApp({ dbPath: path.join(old, 'stockwell.db') });
    await callIn(null)('GET', '/api/meta').catch(() => {});
    await first.app.inject({ method: 'PUT', url: '/api/company', payload: { name: 'Old Books' } });
    await first.app.close();
    built = await buildApp({ dataDir: old });
    expect(fs.existsSync(path.join(old, 'stockwell.db'))).toBe(false);
    expect((await callIn(null)('GET', '/api/companies/list')).companies).toMatchObject([{ id: '100000', name: 'Old Books' }]);
    fs.rmSync(old, { recursive: true, force: true });
  });
});

/** A distributor's year so far: openings, purchases with batches, bills with GST inside and outside Odisha,
 *  free goods, freight, receipts against bills, a journal, a credit note, goods moved to another godown,
 *  a delivery note billed later, and a cancelled bill. */
async function busyYear(call: ReturnType<typeof callIn>) {
  const m = await seedDistributor(call);
  await call('PUT', `/api/items/${m.ghee.id}`, { opening_qty: 10, opening_value: 10 * 50000 });
  const back = await call('POST', '/api/godowns', { name: 'Back Store' });
  const groups = await call<any[]>('GET', '/api/groups');
  const g = (n: string) => groups.find((x) => x.name === n).id;
  const freight = await call('POST', '/api/ledgers', { name: 'Freight Outward', group_id: g('Indirect Incomes') });
  const rent = await call('POST', '/api/ledgers', { name: 'Shop Rent', group_id: g('Indirect Expenses') });
  const v = (body: any) => call('POST', '/api/vouchers', body);
  await v({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'PMF/881', lines: [{ itemId: m.ghee.id, qty: 100, rate: 50000 }] });
  await v({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'PMF/882', lines: [{ itemId: m.curd.id, qty: 200, rate: 2000, batchNo: 'C1', expiryDate: '2027-06-30' }] });
  const s1 = await v({ type: 'sales', date: '2026-10-02', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 22, rate: 60000 }, { itemId: m.curd.id, qty: 15, rate: 2500 }],
    charges: [{ ledgerId: freight.id, amount: 5000 }] });
  await v({ type: 'sales', date: '2026-10-03', partyId: m.kolkata.id, lines: [{ itemId: m.ghee.id, qty: 5, rate: 61000 }] });
  await v({ type: 'receipt', date: '2026-10-05', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: 1000000, bills: [{ ref: s1.number, kind: 'agst', amount: 1000000 }] }] });
  await v({ type: 'payment', date: '2026-10-06', accountId: m.bank.id, entries: [{ ledgerId: m.supplier.id, amount: 3000000 }] });
  await v({ type: 'journal', date: '2026-10-07', entries: [{ ledgerId: rent.id, amount: 1500000 }, { ledgerId: m.capital.id, amount: -1500000 }] });
  await v({ type: 'credit_note', date: '2026-10-08', partyId: m.ramesh.id, againstRef: s1.number, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
  await v({ type: 'stock_journal', date: '2026-10-09', lines: [{ itemId: m.ghee.id, qty: 5, direction: 'out' }, { itemId: m.ghee.id, qty: 5, direction: 'in', godownId: back.id }] });
  const dn = await v({ type: 'delivery_note', date: '2026-10-10', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 2, rate: 60000 }] });
  await v({ type: 'sales', date: '2026-10-11', partyId: m.kalpana.id, againstId: dn.id, lines: [{ itemId: m.ghee.id, qty: 2, rate: 60000 }] });
  const gone = await v({ type: 'sales', date: '2026-10-12', partyId: m.kalpana.id, lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000 }] });
  await call('POST', `/api/vouchers/${gone.id}/cancel`, {});
  return m;
}

/** What must be the same in both companies: every ledger's closing, stock by item and godown, pending bills, profit. */
async function picture(call: ReturnType<typeof callIn>) {
  const tb = await call('GET', '/api/reports/trial-balance?asOf=2027-03-31');
  const flat: Record<string, number> = {};
  const walk = (n: any) => { if (!n) return; if (Array.isArray(n)) return n.forEach(walk); if (n.ledgers) n.ledgers.forEach((l: any) => { flat[l.name] = l.balance ?? l.closing ?? l.amount; }); if (n.children) walk(n.children); if (n.groups) walk(n.groups); };
  walk(tb.groups ?? tb.tree ?? tb);
  const ledgers = await call<any[]>('GET', '/api/ledgers');
  const balances = Object.fromEntries(ledgers.map((l) => [l.name, l.balance]).filter(([, b]) => b));
  const stock = (await call<any[]>('GET', '/api/reports/stock-summary?asOf=2027-03-31')).map((s) => [s.name, s.closing_qty, s.closing_value]);
  const godowns = await call('GET', '/api/reports/godown-stock?asOf=2027-03-31');
  const out = (await call<any[]>('GET', '/api/reports/outstanding?asOf=2027-03-31')).map((b) => [b.ledger_name, b.ref, b.pending]).sort();
  const pl = await call('GET', '/api/reports/profit-loss?from=2026-04-01&to=2027-03-31');
  return { balances, totals: [tb.totalDr, tb.totalCr], stock, godowns, out, profit: [pl.grossProfit, pl.netProfit] };
}

describe('export to Tally XML, one folder per company, and import it back', () => {
  it('gives the same books after export and import', async () => {
    const a = callIn('100000');
    await busyYear(a);
    const exp = await a('POST', '/api/export/companies', {});
    expect(exp.companies).toHaveLength(1);
    const folder = path.join(dir, 'Exports', 'Samal Distributors (100000)');
    expect(exp.companies[0].folder).toBe(folder);
    expect(fs.readdirSync(folder).sort()).toEqual(['DayBook.xml', 'Masters.xml']);

    const copy = await a('POST', '/api/companies', { name: 'Samal Copy' });
    const b = callIn(copy.id);
    const masters = await b('POST', '/api/import/tally', { xml: fs.readFileSync(path.join(folder, 'Masters.xml'), 'utf8') });
    expect(masters.vouchers).toBeNull();
    const day = await b('POST', '/api/import/tally', { xml: fs.readFileSync(path.join(folder, 'DayBook.xml'), 'utf8') });
    expect(day.vouchers.skipped).toEqual([]);
    expect(day.vouchers.vouchers).toBe(12);
    const [pa, pb] = [await picture(a), await picture(b)];
    expect(pb.balances).toEqual(pa.balances);
    expect(pb.totals).toEqual(pa.totals);
    expect(pb.stock).toEqual(pa.stock);
    expect(pb.godowns).toEqual(pa.godowns);
    expect(pb.out).toEqual(pa.out);
    expect(pb.profit).toEqual(pa.profit);
    // The cancelled bill comes across cancelled, and importing again adds nothing.
    expect((await b<any[]>('GET', '/api/reports/day-book?from=2026-10-12&to=2026-10-12'))[0]).toMatchObject({ cancelled: 1 });
    const again = await b('POST', '/api/import/tally', { xml: fs.readFileSync(path.join(folder, 'DayBook.xml'), 'utf8') });
    expect(again.vouchers).toMatchObject({ vouchers: 0, already: 12 });
  });

  it('exports every company into its own folder', async () => {
    const a = callIn('100000');
    await a('PUT', '/api/company', { name: 'Knopff Solutions' });
    await a('POST', '/api/companies', { name: 'Cemech Paints' });
    const r = await a('POST', '/api/export/companies', { all: true });
    expect(r.companies.map((c: any) => path.basename(c.folder))).toEqual(['Knopff Solutions (100000)', 'Cemech Paints (100001)']);
  });

  it('refuses an export folder typed from another PC', async () => {
    const r = await built.app.inject({ method: 'POST', url: '/api/export/companies', payload: { dir: 'C:\\Temp' }, remoteAddress: '192.168.1.20', headers: { 'x-stockwell-company': '100000' } });
    expect(r.statusCode).toBe(403);
  });
});

/** Written the way TallyPrime writes its Day Book export: custom voucher types, item invoices with the
 *  sales ledger inside each item, GST ledgers by duty head, bill-wise details, rounding and a UTF-16 file. */
const TALLY_MASTERS = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC><REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHERTYPE NAME="GST Sales" RESERVEDNAME=""><PARENT>Sales</PARENT></VOUCHERTYPE></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHERTYPE NAME="Bank Receipt"><PARENT>Receipt</PARENT></VOUCHERTYPE></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Sales @ 18%" RESERVEDNAME=""><PARENT>Sales Accounts</PARENT></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Output CGST"><PARENT>Duties &amp; Taxes</PARENT><TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>Central Tax</GSTDUTYHEAD></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Output SGST"><PARENT>Duties &amp; Taxes</PARENT><TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>State Tax</GSTDUTYHEAD></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Rounded Off"><PARENT>Indirect Expenses</PARENT></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Axis Bank"><PARENT>Bank Accounts</PARENT><OPENINGBALANCE>-100000.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Capital A/c"><PARENT>Capital Account</PARENT><OPENINGBALANCE>100000.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Bhoi Telecom"><PARENT>Sundry Debtors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD><LEDSTATENAME>Odisha</LEDSTATENAME></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><UNIT NAME="Nos"><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT></UNIT></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM NAME="Optical Fibre Patch Cord"><BASEUNITS>Nos</BASEUNITS><OPENINGBALANCE> 50 Nos</OPENINGBALANCE><OPENINGVALUE>-10000.00</OPENINGVALUE>
  <GSTDETAILS.LIST><HSNCODE>8544</HSNCODE><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE> 18</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST></STOCKITEM></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

const tallySale = (guid: string, no: string, date: string) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="${guid}" VCHKEY="x" VCHTYPE="GST Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">
 <DATE>${date}</DATE><GUID>${guid}</GUID><STATENAME>Odisha</STATENAME><NARRATION>Supply of cords</NARRATION><PARTYGSTIN></PARTYGSTIN>
 <VOUCHERTYPENAME>GST Sales</VOUCHERTYPENAME><VOUCHERNUMBER>${no}</VOUCHERNUMBER><PARTYLEDGERNAME>Bhoi Telecom</PARTYLEDGERNAME>
 <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><ISINVOICE>Yes</ISINVOICE><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>
 <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Optical Fibre Patch Cord</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
  <RATE>333.33/Nos</RATE><AMOUNT>3333.30</AMOUNT><ACTUALQTY> 10 Nos</ACTUALQTY><BILLEDQTY> 10 Nos</BILLEDQTY>
  <BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><AMOUNT>3333.30</AMOUNT><ACTUALQTY> 10 Nos</ACTUALQTY><BILLEDQTY> 10 Nos</BILLEDQTY><TRACKINGNUMBER>Not Applicable</TRACKINGNUMBER></BATCHALLOCATIONS.LIST>
  <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales @ 18%</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>3333.30</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
 </ALLINVENTORYENTRIES.LIST>
 <LEDGERENTRIES.LIST><LEDGERNAME>Bhoi Telecom</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-3933.00</AMOUNT>
  <BILLALLOCATIONS.LIST><NAME>${no}</NAME><BILLTYPE>New Ref</BILLTYPE><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD><AMOUNT>-3933.00</AMOUNT></BILLALLOCATIONS.LIST></LEDGERENTRIES.LIST>
 <LEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>300.00</AMOUNT></LEDGERENTRIES.LIST>
 <LEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>300.00</AMOUNT></LEDGERENTRIES.LIST>
 <LEDGERENTRIES.LIST><LEDGERNAME>Rounded Off</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-0.30</AMOUNT></LEDGERENTRIES.LIST>
</VOUCHER></TALLYMESSAGE>`;

const tallyReceipt = (guid: string, ref: string, date: string) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="${guid}" VCHTYPE="Bank Receipt" ACTION="Create"><DATE>${date}</DATE><GUID>${guid}</GUID>
 <VOUCHERTYPENAME>Bank Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER><PARTYLEDGERNAME>Bhoi Telecom</PARTYLEDGERNAME>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bhoi Telecom</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>2000.00</AMOUNT>
  <BILLALLOCATIONS.LIST><NAME>${ref}</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>2000.00</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Axis Bank</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER></TALLYMESSAGE>`;

const dayBook = (body: string) => `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>
<STATICVARIABLES><SVCURRENTCOMPANY>KNOPFFSOLUTION ( TELECOM SECTOR)</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

describe('vouchers written by TallyPrime', () => {
  it('reads an item invoice, a bank receipt and a cancelled bill as Tally keeps them', async () => {
    const c = callIn('100000');
    await c('PUT', '/api/company', { name: 'Knopff Telecom', books_from: '2024-04-01' });
    await c('POST', '/api/import/tally', { xml: TALLY_MASTERS });
    const xml = dayBook(tallySale('guid-1', 'KS/24-25/001', '20240415') + tallyReceipt('guid-2', 'KS/24-25/001', '20240420')
      + tallySale('guid-3', 'KS/24-25/002', '20240421').replace('<ISCANCELLED>No</ISCANCELLED>', '<ISCANCELLED>Yes</ISCANCELLED>'));
    // TallyPrime writes "Unicode" export files as UTF-16 with a byte order mark.
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    const text = decodeTally(new Uint8Array(utf16));
    const r = await c('POST', '/api/import/tally', { xml: text });
    expect(r.vouchers).toMatchObject({ vouchers: 3, skipped: [], byType: { Sales: 2, Receipt: 1 } });
    const db = built.store.get('100000').books.db;
    const bal = (n: string) => (db.prepare(`SELECT l.opening + COALESCE((SELECT SUM(e.amount) FROM entries e JOIN vouchers v ON v.id=e.voucher_id WHERE e.ledger_id=l.id AND v.cancelled=0), 0) b FROM ledgers l WHERE l.name=?`).get(n) as { b: number }).b;
    expect(bal('Bhoi Telecom')).toBe(193300);
    expect(bal('Sales @ 18%')).toBe(-333330);
    expect(bal('Output CGST')).toBe(-30000);
    expect(bal('Rounded Off')).toBe(30);
    expect(bal('Axis Bank')).toBe(10000000 + 200000);
    const stock = (await c<any[]>('GET', '/api/reports/stock-summary?asOf=2025-03-31')).find((s) => s.name === 'Optical Fibre Patch Cord');
    expect(stock.closing_qty).toBe(40);
    const out = await c<any[]>('GET', '/api/reports/outstanding?asOf=2025-03-31');
    expect(out.map((b) => [b.ref, b.pending])).toEqual([['KS/24-25/001', 193300]]);
    const sale = (await c<any[]>('GET', '/api/reports/day-book?from=2024-04-15&to=2024-04-15'))[0];
    const v = await c('GET', `/api/vouchers/${sale.id}`);
    expect(v).toMatchObject({ type: 'sales', number: 'KS/24-25/001', taxable: 333330, cgst: 30000, sgst: 30000, total: 393300 });
    const tb = await c('GET', '/api/reports/trial-balance?asOf=2025-03-31');
    expect(tb.totalDr - tb.totalCr).toBe(tb.openingDiff);
  });

  it('lists what it could not bring in, and brings in the rest', async () => {
    const c = callIn('100000');
    await c('PUT', '/api/company', { books_from: '2024-04-01' });
    await c('POST', '/api/import/tally', { xml: TALLY_MASTERS });
    const unknown = tallySale('guid-9', 'X/9', '20240416').replace(/Bhoi Telecom/g, 'Nobody & Sons');
    const r = await c('POST', '/api/import/tally', { xml: dayBook(unknown + tallySale('guid-10', 'X/10', '20240417')) });
    expect(r.vouchers.vouchers).toBe(1);
    expect(r.vouchers.skipped[0]).toMatch(/X\/9.*"Nobody & Sons" is not in Stockwell/);
  });

  it('refuses a file that is not from Tally', async () => {
    await expect(callIn('100000')('POST', '/api/import/tally', { xml: '<html>hello</html>' })).rejects.toThrow(/not a Tally export/);
  });
});

describe('straight from TallyPrime', () => {
  let tally: http.Server;
  let url: string;
  const asked: string[] = [];
  let brokenMonth = '';
  let dropMay = false;
  beforeEach(async () => {
    asked.length = 0;
    brokenMonth = '';
    dropMay = false;
    tally = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (d) => { chunks.push(d); });
      req.on('end', () => {
        // Stockwell asks in UTF-16, as Tally's own tools do.
        expect(req.headers['content-type']).toMatch(/utf-16/);
        const body = Buffer.concat(chunks).toString('utf16le');
        asked.push(body);
        const send = (x: string) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(x, 'utf16le')])); };
        if (body.includes('Stockwell Companies')) return send(`<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="KNOPFFSOLUTION ( TELECOM SECTOR)"><NAME>KNOPFFSOLUTION ( TELECOM SECTOR)</NAME><BOOKSFROM>20240401</BOOKSFROM></COMPANY><COMPANY NAME="CEMECH PAINT'S"><BOOKSFROM>20240401</BOOKSFROM></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>`);
        if (body.includes('List of Accounts')) return send(TALLY_MASTERS);
        if (body.includes('Day Book')) {
          if (brokenMonth && body.includes(`<SVFROMDATE>${brokenMonth}</SVFROMDATE>`)) { res.writeHead(500); return res.end(); }
          if (dropMay && body.includes('<SVFROMDATE>20240501</SVFROMDATE>')) return send(dayBook(''));
          if (body.includes('<SVFROMDATE>20240401</SVFROMDATE>')) return send(dayBook(tallySale('g-1', 'KS/1', '20240415') + tallyReceipt('g-2', 'KS/1', '20240420')));
          if (body.includes('<SVFROMDATE>20240501</SVFROMDATE>')) return send(dayBook(tallySale('g-3', 'KS/2', '20240505')));
          return send(dayBook(''));
        }
        res.writeHead(400); res.end();
      });
    });
    await new Promise<void>((r) => tally.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(tally.address() as { port: number }).port}`;
  });
  afterEach(() => new Promise<void>((r) => tally.close(() => r())));

  const waitFor = async (c: ReturnType<typeof callIn>, id: number) => {
    for (let i = 0; i < 200; i++) {
      const j = await c('GET', `/api/tally/jobs/${id}`);
      if (j.state !== 'running') return j;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('import did not finish');
  };

  it('lists the companies open in Tally and brings one across into a new company, month by month', async () => {
    const c = callIn('100000');
    expect((await c<any[]>('GET', `/api/tally/companies?url=${encodeURIComponent(url)}`)).map((x) => x.name)).toEqual(['KNOPFFSOLUTION ( TELECOM SECTOR)', "CEMECH PAINT'S"]);
    const job = await c('POST', '/api/tally/import', { url, companies: ['KNOPFFSOLUTION ( TELECOM SECTOR)'], into: 'new' });
    const done = await waitFor(c, job.id);
    expect(done.state).toBe('done');
    expect(done.companies[0]).toMatchObject({ id: '100001', name: 'KNOPFFSOLUTION ( TELECOM SECTOR)', vouchers: { vouchers: 3, skipped: [] } });
    // The company is asked for by name, and its vouchers a month at a time.
    expect(asked.filter((b) => b.includes('Day Book')).every((b) => b.includes('<SVCURRENTCOMPANY>KNOPFFSOLUTION ( TELECOM SECTOR)</SVCURRENTCOMPANY>'))).toBe(true);
    const k = callIn('100001');
    expect(await k('GET', '/api/company')).toMatchObject({ name: 'KNOPFFSOLUTION ( TELECOM SECTOR)', books_from: '2024-04-01' });
    expect((await k<any[]>('GET', '/api/ledgers')).find((l) => l.name === 'Bhoi Telecom').balance).toBe(393300 * 2 - 200000);
    // Run again into the same company: nothing doubles.
    const again = await waitFor(k, (await k('POST', '/api/tally/import', { url, companies: ['KNOPFFSOLUTION ( TELECOM SECTOR)'], into: 'current' })).id);
    expect(again.companies[0].vouchers).toMatchObject({ vouchers: 0, already: 3 });
    expect((await k<any[]>('GET', '/api/ledgers')).find((l) => l.name === 'Bhoi Telecom').balance).toBe(393300 * 2 - 200000);
  });

  it('carries on after a month that fails, and a catch-up brings that month, altered and deleted vouchers across', async () => {
    const c = callIn('100000');
    brokenMonth = '20240401';
    const first = await waitFor(c, (await c('POST', '/api/tally/import', { url, companies: ['KNOPFFSOLUTION ( TELECOM SECTOR)'], into: 'new' })).id);
    expect(first.state).toBe('done');
    expect(first.companies[0].monthErrors).toEqual([expect.stringMatching(/^2024-04: Tally replied with an error \(HTTP 500\)/)]);
    expect(first.companies[0].vouchers).toMatchObject({ vouchers: 1 });
    // Months to the end of this financial year are asked for, so post-dated vouchers come too.
    expect(asked.some((b) => b.includes('<SVTODATE>20270331</SVTODATE>'))).toBe(true);
    brokenMonth = '';
    const k = callIn(first.companies[0].id);
    const again = await waitFor(k, (await k('POST', '/api/tally/import', { url, companies: ['KNOPFFSOLUTION ( TELECOM SECTOR)'], into: 'current' })).id);
    expect(again.companies[0]).toMatchObject({ vouchers: { vouchers: 2, already: 1, removed: 0 } });
    expect(again.companies[0].monthErrors).toBeUndefined();
    // KS/2 of May is deleted in Tally: the next catch-up takes it out here too.
    dropMay = true;
    const third = await waitFor(k, (await k('POST', '/api/tally/import', { url, companies: ['KNOPFFSOLUTION ( TELECOM SECTOR)'], into: 'current' })).id);
    expect(third.companies[0].vouchers).toMatchObject({ vouchers: 0, already: 2, removed: 1 });
    expect((await k<any[]>('GET', '/api/ledgers')).find((l) => l.name === 'Bhoi Telecom').balance).toBe(393300 - 200000);
  });

  it('says which company is not open in Tally', async () => {
    const c = callIn('100000');
    const job = await waitFor(c, (await c('POST', '/api/tally/import', { url, companies: ['Weighing Scale'], into: 'new' })).id);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/"Weighing Scale" is not open in TallyPrime/);
  });

  it('refuses a Tally address on the internet', async () => {
    await expect(callIn('100000')('GET', '/api/tally/companies?url=http://example.com:9000')).rejects.toThrow(/this PC or another PC in the office/);
  });
});

describe('Tally voucher types', () => {
  it('finds the Stockwell type through the parent, else by the name', async () => {
    const { stockwellType } = await import('../../src/server/tallyVouchers');
    const parents = new Map([['gst sales', 'Sales'], ['b2b bill', 'gst sales']]);
    expect(stockwellType('B2B Bill', 'B2B Bill', parents)).toBe('sales');
    expect(stockwellType('GST Sales 2024', 'GST Sales 2024', new Map())).toBe('sales');
    expect(stockwellType('Purchase Return (Debit Note)', 'x', new Map())).toBe('debit_note');
    expect(stockwellType('Payroll', 'Payroll', new Map())).toBe('journal');
    expect(stockwellType('Attendance', 'Attendance', new Map())).toBe('skip');
    expect(stockwellType('Something odd', 'Something odd', new Map())).toBeNull();
  });
});
