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
    expect(r).toMatchObject({ groups: 1, ledgers: 1, units: 1, stockGroups: 1, items: 1 });
    const ledgers = await call<any[]>('GET', '/api/ledgers');
    const tarini = ledgers.find((l) => l.name === 'Maa Tarini Stores');
    expect(tarini.state_code).toBe('21');
    expect(tarini.bill_wise).toBe(true);
    const out = await call<any[]>('GET', '/api/reports/outstanding');
    expect(out[0]).toMatchObject({ ref: 'Opening', pending: 1250000 });
    const again = await call('POST', '/api/import/tally', { xml: XML });
    expect(again.ledgers).toBe(0);
  });
});
