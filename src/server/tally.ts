import { XMLParser } from 'fast-xml-parser';
import type { Books } from './books';
import { STATES, isValidGstin } from '../core/gst';
import { toPaise } from '../core/money';

/** Asks a running TallyPrime (with its XML server on, usually port 9000) for all masters. */
export const TALLY_MASTERS_REQUEST = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>List of Accounts</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<ACCOUNTTYPE>All Masters</ACCOUNTTYPE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

export async function fetchTallyMasters(url = 'http://localhost:9000'): Promise<string> {
  const res = await fetch(url, { method: 'POST', body: TALLY_MASTERS_REQUEST, headers: { 'Content-Type': 'text/xml' } });
  if (!res.ok) throw new Error(`Tally replied with HTTP ${res.status}.`);
  return res.text();
}

type Node = Record<string, any>;

const text = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return text((v as Node)['#text']);
  return String(v).trim();
};
const list = (v: unknown): Node[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]) as Node[];
const nameOf = (n: Node) => text(n['@_NAME']) || text(n.NAME) || text(list(n['NAME.LIST'])[0]?.NAME);

/** Tally writes debit amounts as negative numbers; Stockwell keeps debit as positive. */
const tallyAmount = (v: unknown) => -toPaise(text(v).replace(/[^\d.-]/g, '') || '0');
const firstNumber = (v: unknown) => Number((text(v).match(/-?[\d.]+/) ?? ['0'])[0]);

export interface TallyMasters {
  groups: { name: string; parent: string }[];
  ledgers: { name: string; parent: string; opening: number; gstin: string; state: string; address: string; pincode: string; phone: string; creditDays: number }[];
  units: string[];
  stockGroups: string[];
  items: { name: string; group: string; unit: string; hsn: string; gstRate: number; openingQty: number; openingValue: number }[];
}

export function parseTallyMasters(xml: string): TallyMasters {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
  const doc = parser.parse(xml);
  const found: Record<string, Node[]> = { GROUP: [], LEDGER: [], UNIT: [], STOCKGROUP: [], STOCKITEM: [] };
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Node)) {
      if (k in found) found[k].push(...list(v));
      else if (typeof v === 'object') list(v).forEach(walk);
    }
  };
  walk(doc);

  const gstRateOf = (item: Node): number => {
    for (const g of list(item['GSTDETAILS.LIST'])) {
      for (const s of list(g['STATEWISEDETAILS.LIST'])) {
        for (const r of list(s['RATEDETAILS.LIST'])) {
          if (/integrated/i.test(text(r.GSTRATEDUTYHEAD))) return firstNumber(r.GSTRATE);
        }
      }
    }
    return 0;
  };
  const hsnOf = (item: Node): string => {
    for (const g of list(item['GSTDETAILS.LIST'])) if (text(g.HSNCODE)) return text(g.HSNCODE);
    for (const h of list(item['HSNDETAILS.LIST'])) if (text(h.HSNCODE)) return text(h.HSNCODE);
    return '';
  };

  return {
    groups: found.GROUP.map((g) => ({ name: nameOf(g), parent: text(g.PARENT) })).filter((g) => g.name),
    ledgers: found.LEDGER.map((l) => {
      const reg = list(l['LEDGSTREGDETAILS.LIST'])[0] ?? {};
      const mail = list(l['LEDMAILINGDETAILS.LIST'])[0] ?? {};
      const addr = list(l['ADDRESS.LIST']).concat(list(mail['ADDRESS.LIST'])).flatMap((a) => list(a.ADDRESS)).map(text).filter(Boolean);
      return {
        name: nameOf(l),
        parent: text(l.PARENT),
        opening: tallyAmount(l.OPENINGBALANCE),
        gstin: (text(l.PARTYGSTIN) || text(reg.GSTIN)).toUpperCase(),
        state: text(l.LEDSTATENAME) || text(mail.STATE) || text(l.STATENAME),
        address: addr.join('\n'),
        pincode: text(l.PINCODE) || text(mail.PINCODE),
        phone: text(l.LEDGERMOBILE) || text(l.LEDGERPHONE),
        creditDays: firstNumber(l.BILLCREDITPERIOD),
      };
    }).filter((l) => l.name),
    units: found.UNIT.map(nameOf).filter(Boolean),
    stockGroups: found.STOCKGROUP.map(nameOf).filter(Boolean),
    items: found.STOCKITEM.map((i) => ({
      name: nameOf(i),
      group: text(i.PARENT),
      unit: text(i.BASEUNITS),
      hsn: hsnOf(i),
      gstRate: gstRateOf(i),
      openingQty: firstNumber(i.OPENINGBALANCE),
      openingValue: Math.abs(tallyAmount(i.OPENINGVALUE)),
    })).filter((i) => i.name),
  };
}

const stateCode = (name: string) => Object.entries(STATES).find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0] ?? '';

/** Adds Tally masters that Stockwell does not have yet. Existing names are left alone. */
export function importTallyMasters(books: Books, m: TallyMasters) {
  const result = { groups: 0, ledgers: 0, units: 0, stockGroups: 0, items: 0, skipped: [] as string[] };
  books.db.transaction(() => {
    const haveGroup = (n: string) => books.db.prepare(`SELECT id FROM groups WHERE name=?`).get(n) as { id: number } | undefined;
    // Parents first: keep looping until no more groups can be placed.
    let pending = m.groups.filter((g) => !haveGroup(g.name));
    for (let pass = 0; pass < 10 && pending.length; pass++) {
      pending = pending.filter((g) => {
        const parent = haveGroup(g.parent);
        if (!parent) return true;
        books.createGroup({ name: g.name, parentId: parent.id });
        result.groups++;
        return false;
      });
    }
    pending.forEach((g) => result.skipped.push(`Group ${g.name} (parent ${g.parent} not found)`));

    for (const l of m.ledgers) {
      if (books.ledgerByName(l.name) || /^profit & loss a\/c$/i.test(l.name)) continue;
      const group = haveGroup(l.parent) ?? haveGroup('Suspense A/c')!;
      books.createLedger({
        name: l.name, group_id: group.id, opening: l.opening,
        gstin: isValidGstin(l.gstin) ? l.gstin : '', state_code: stateCode(l.state), address: l.address,
        pincode: l.pincode, phone: l.phone, credit_days: l.creditDays,
      });
      result.ledgers++;
    }

    for (const u of m.units) {
      if (books.db.prepare(`SELECT id FROM units WHERE symbol=?`).get(u)) continue;
      books.createUnit({ symbol: u });
      result.units++;
    }
    for (const g of m.stockGroups) {
      if (books.db.prepare(`SELECT id FROM stock_groups WHERE name=?`).get(g)) continue;
      books.createStockGroup(g);
      result.stockGroups++;
    }
    for (const i of m.items) {
      if (books.db.prepare(`SELECT id FROM items WHERE name=?`).get(i.name)) continue;
      let unit = books.db.prepare(`SELECT id FROM units WHERE symbol=?`).get(i.unit || 'Pcs') as { id: number } | undefined;
      if (!unit) unit = books.createUnit({ symbol: i.unit }) as { id: number };
      const sg = books.db.prepare(`SELECT id FROM stock_groups WHERE name=?`).get(i.group) as { id: number } | undefined;
      books.createItem({
        name: i.name, unit_id: unit.id, stock_group_id: sg?.id ?? null, hsn: i.hsn, gst_rate: i.gstRate,
        opening_qty: i.openingQty, opening_value: i.openingValue,
      });
      result.items++;
    }
  })();
  return result;
}
