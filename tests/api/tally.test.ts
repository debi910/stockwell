import { describe, expect, it } from 'vitest';
import { setup, gstin } from './helpers';
import { parseTallyMasters } from '../../src/server/tally';

const XML = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE><GROUP NAME="Retailers - Bhubaneswar"><PARENT>Sundry Debtors</PARENT></GROUP></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Maa Tarini Stores"><PARENT>Retailers - Bhubaneswar</PARENT><OPENINGBALANCE>-12500.00</OPENINGBALANCE>
  <PARTYGSTIN>${gstin('21', 'TARIN1234Q')}</PARTYGSTIN><LEDSTATENAME>Odisha</LEDSTATENAME><BILLCREDITPERIOD>15 Days</BILLCREDITPERIOD>
  <ADDRESS.LIST><ADDRESS>Unit 4 Market</ADDRESS><ADDRESS>Bhubaneswar</ADDRESS></ADDRESS.LIST><LEDGERMOBILE>9437111111</LEDGERMOBILE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Cash"><PARENT>Cash-in-Hand</PARENT><OPENINGBALANCE>-2000.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><UNIT NAME="Jar"></UNIT></TALLYMESSAGE>
<TALLYMESSAGE><STOCKGROUP NAME="ITC Sunrise"></STOCKGROUP></TALLYMESSAGE>
<TALLYMESSAGE><STOCKITEM NAME="Sunrise Chilli Powder 100g"><PARENT>ITC Sunrise</PARENT><BASEUNITS>Jar</BASEUNITS>
  <OPENINGBALANCE> 40 Jar</OPENINGBALANCE><OPENINGVALUE>-1600.00</OPENINGVALUE>
  <GSTDETAILS.LIST><HSNCODE>0904</HSNCODE><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE> 5</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>
</STOCKITEM></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

describe('Tally import', () => {
  it('reads masters from Tally XML', () => {
    const m = parseTallyMasters(XML);
    expect(m.ledgers[0]).toMatchObject({ name: 'Maa Tarini Stores', opening: 1250000, creditDays: 15, phone: '9437111111' });
    expect(m.items[0]).toMatchObject({ name: 'Sunrise Chilli Powder 100g', unit: 'Jar', hsn: '0904', gstRate: 5, openingQty: 40, openingValue: 160000 });
  });

  it('adds new masters and leaves existing ones alone', async () => {
    const { call } = await setup();
    const r = await call('POST', '/api/import/tally', { xml: XML });
    // Maa Tarini is new; Stockwell's own Cash ledger, still unused, takes Tally's opening balance.
    expect(r).toMatchObject({ groups: 1, ledgers: 2, units: 1, stockGroups: 1, items: 1 });
    const ledgers = await call<any[]>('GET', '/api/ledgers');
    expect(ledgers.find((l) => l.name === 'Cash').opening).toBe(200000);
    const tarini = ledgers.find((l) => l.name === 'Maa Tarini Stores');
    expect(tarini.state_code).toBe('21');
    expect(tarini.bill_wise).toBe(true);
    const out = await call<any[]>('GET', '/api/reports/outstanding');
    expect(out[0]).toMatchObject({ ref: 'Opening', pending: 1250000 });
    const again = await call('POST', '/api/import/tally', { xml: XML });
    expect(again.ledgers).toBe(0);
  });

  it('brings pending bills, batches with expiry and godowns from Tally', async () => {
    const xml = `<ENVELOPE><BODY><DATA>
<TALLYMESSAGE><GODOWN NAME="Main Location"></GODOWN></TALLYMESSAGE>
<TALLYMESSAGE><GODOWN NAME="Back Store"></GODOWN></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Jagannath Stores"><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>-15000.00</OPENINGBALANCE><BILLCREDITPERIOD>10 Days</BILLCREDITPERIOD>
  <BILLALLOCATIONS.LIST><NAME>S/2025-26/880</NAME><BILLDATE>20260310</BILLDATE><OPENINGBALANCE>-9000.00</OPENINGBALANCE></BILLALLOCATIONS.LIST>
  <BILLALLOCATIONS.LIST><NAME>S/2025-26/901</NAME><BILLDATE>25-Mar-2026</BILLDATE><OPENINGBALANCE>-5000.00</OPENINGBALANCE><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD></BILLALLOCATIONS.LIST>
</LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><STOCKITEM NAME="Gowardhan Paneer 200g"><BASEUNITS>Pcs</BASEUNITS><OPENINGBALANCE> 30 Pcs</OPENINGBALANCE><OPENINGVALUE>-2400.00</OPENINGVALUE>
  <BATCHALLOCATIONS.LIST><BATCHNAME>PN-11</BATCHNAME><GODOWNNAME>Main Location</GODOWNNAME><EXPIRYPERIOD JD="1">15-Apr-2026</EXPIRYPERIOD><OPENINGBALANCE> 20 Pcs</OPENINGBALANCE></BATCHALLOCATIONS.LIST>
  <BATCHALLOCATIONS.LIST><BATCHNAME>PN-12</BATCHNAME><EXPIRYPERIOD>20260430</EXPIRYPERIOD><OPENINGBALANCE> 10 Pcs</OPENINGBALANCE></BATCHALLOCATIONS.LIST>
</STOCKITEM></TALLYMESSAGE>
</DATA></BODY></ENVELOPE>`;
    const { call, books } = await setup();
    const r = await call('POST', '/api/import/tally', { xml });
    expect(r).toMatchObject({ bills: 2, batches: 2, godowns: 1, items: 1 });
    const out = await call<any[]>('GET', '/api/reports/outstanding?asOf=2026-04-30');
    const mine = out.filter((b) => b.ledger_name === 'Jagannath Stores');
    expect(mine.map((b) => [b.ref, b.pending, b.bill_date])).toEqual([
      ['S/2025-26/880', 900000, '2026-03-10'], ['S/2025-26/901', 500000, '2026-03-25'], ['Opening', 100000, '2026-03-31'],
    ]);
    expect(mine.find((b) => b.ref === 'S/2025-26/901').due_date).toBe('2026-04-24');
    const item = (await call<any[]>('GET', '/api/items')).find((i) => i.name === 'Gowardhan Paneer 200g');
    expect(item.track_batch).toBe(1);
    expect(books.batches(item.id).map((b) => [b.batch_no, b.expiry_date, b.qty])).toEqual([['PN-11', '2026-04-15', 20], ['PN-12', '2026-04-30', 10]]);
    // Altering the ledger later keeps the bills and does not count the balance twice.
    const led = (await call<any[]>('GET', '/api/ledgers')).find((l) => l.name === 'Jagannath Stores');
    await call('PUT', `/api/ledgers/${led.id}`, { phone: '9437000001' });
    const again = (await call<any[]>('GET', '/api/reports/outstanding?asOf=2026-04-30')).filter((b) => b.ledger_name === 'Jagannath Stores');
    expect(again.reduce((a, b) => a + b.pending, 0)).toBe(1500000);
    expect((await call('GET', '/api/godowns')).map((g: any) => g.name)).toEqual(['Main Location', 'Back Store']);
  });
});
