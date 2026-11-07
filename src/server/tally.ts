import { BooksError } from './books';
import { XMLParser } from 'fast-xml-parser';
import type { Books } from './books';
import { STATES, isValidGstin } from '../core/gst';
import { toPaise } from '../core/money';

/** Asks a running TallyPrime (with its XML server on, usually port 9000) for all masters. */
export const TALLY_MASTERS_REQUEST = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>List of Accounts</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<ACCOUNTTYPE>All Masters</ACCOUNTTYPE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

/** Tally's own server on this PC or another office PC. Anything else (the internet, odd schemes) is refused. */
export function checkTallyUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new BooksError('Tally address should look like http://localhost:9000'); }
  const h = u.hostname.replace(/^\[|\]$/g, '');
  const local = h === 'localhost' || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || !h.includes('.');
  if (u.protocol !== 'http:' || !local) throw new BooksError('Tally must be on this PC or another PC in the office (for example http://localhost:9000).');
  return u.toString();
}

/** Text from Tally: its XML server and its export files may be UTF-8 or UTF-16 ("Unicode"). */
export function decodeTally(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3));
  // UTF-16 without its mark: every other byte of "<ENVELOPE" is zero.
  if (buf.length > 3 && buf[1] === 0 && buf[3] === 0) return new TextDecoder('utf-16le').decode(buf);
  return new TextDecoder('utf-8').decode(buf);
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const companyVar = (company?: string) => (company ? `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>` : '');

/** One request to TallyPrime's own server (F1 > Settings > Connectivity, port 9000). */
export async function tallyPost(url: string, body: string, timeoutMs = 60_000): Promise<string> {
  let res: Response;
  try {
    res = await fetch(checkTallyUrl(url), { method: 'POST', body, headers: { 'Content-Type': 'text/xml;charset=utf-8' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof BooksError) throw e;
    if ((e as Error)?.name === 'TimeoutError') throw new BooksError('TallyPrime took too long to answer. Close other reports in Tally and try again.');
    throw new BooksError('Could not reach Tally. Open TallyPrime with the company loaded, and turn on F1 > Settings > Connectivity > "TallyPrime acts as: Both" on port 9000.');
  }
  if (!res.ok) throw new BooksError(`Tally replied with an error (HTTP ${res.status}).`);
  const xml = decodeTally(new Uint8Array(await res.arrayBuffer()));
  const err = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(xml);
  if (err) throw new BooksError(`Tally said: ${err[1].trim().slice(0, 200)}`);
  return xml;
}

export async function fetchTallyMasters(url = 'http://localhost:9000', company?: string): Promise<string> {
  return tallyPost(url, TALLY_MASTERS_REQUEST.replace('<SVEXPORTFORMAT>', `${companyVar(company)}<SVEXPORTFORMAT>`), 180_000);
}

/** The companies open in TallyPrime now, with the dates their books begin. */
export async function fetchTallyCompanies(url = 'http://localhost:9000'): Promise<{ name: string; booksFrom: string | null; startingFrom: string | null }[]> {
  const xml = await tallyPost(url, `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Stockwell Companies</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE>
<COLLECTION NAME="Stockwell Companies" ISMODIFY="No"><TYPE>Company</TYPE><FETCH>NAME, BOOKSFROM, STARTINGFROM</FETCH></COLLECTION>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`, 30_000);
  return parseTallyCompanies(xml);
}

export function parseTallyCompanies(xml: string) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
  let doc: unknown;
  try { doc = parser.parse(xml); } catch { throw new BooksError('Tally sent a list of companies that could not be read.'); }
  const out: { name: string; booksFrom: string | null; startingFrom: string | null }[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Node)) {
      if (k === 'COMPANY') for (const c of list(v)) { const name = nameOf(c); if (name && !out.some((o) => o.name === name)) out.push({ name, booksFrom: tallyDate(c.BOOKSFROM), startingFrom: tallyDate(c.STARTINGFROM) }); }
      else if (typeof v === 'object') list(v).forEach(walk);
    }
  };
  walk(doc);
  return out;
}

/** All vouchers of a company between two dates, as Tally's Day Book export. */
export async function fetchTallyVouchers(url: string, company: string | undefined, from: string, to: string): Promise<string> {
  const d = (iso: string) => iso.replace(/-/g, '');
  return tallyPost(url, `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES>${companyVar(company)}<SVFROMDATE>${d(from)}</SVFROMDATE><SVTODATE>${d(to)}</SVTODATE>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`, 180_000);
}

export type Node = Record<string, any>;

export const text = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return text((v as Node)['#text']);
  return String(v).trim();
};
export const list = (v: unknown): Node[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]) as Node[];
export const nameOf = (n: Node) => text(n['@_NAME']) || text(n.NAME) || text(list(n['NAME.LIST'])[0]?.NAME);

/** Tally writes debit amounts as negative numbers; Stockwell keeps debit as positive. */
export const tallyAmount = (v: unknown) => -toPaise(text(v).replace(/[^\d.-]/g, '') || '0');
export const firstNumber = (v: unknown) => Number((text(v).replace(/,/g, '').match(/-?[\d.]+/) ?? ['0'])[0]);

/** Tally dates: 20260401, 1-Apr-2026, 01-04-2026 or 2026-04-01 → YYYY-MM-DD (or null). */
export function tallyDate(v: unknown): string | null {
  const t = text(v);
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return t;
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{2,4})$/.exec(t);
  if (m && MON.includes(m[2].toLowerCase())) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${String(MON.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

export interface TallyMasters {
  groups: { name: string; parent: string }[];
  voucherTypes?: { name: string; parent: string }[];
  ledgers: { name: string; parent: string; gstHead?: string; opening: number; gstin: string; state: string; address: string; pincode: string; phone: string; creditDays: number;
    bills: { ref: string; date: string | null; amount: number; creditDays: number }[] }[];
  units: string[];
  stockGroups: string[];
  godowns: string[];
  items: { name: string; group: string; unit: string; hsn: string; gstRate: number; openingQty: number; openingValue: number;
    batches: { name: string; godown: string; expiry: string | null; mfg: string | null; qty: number; value: number }[] }[];
}

export function parseTallyMasters(xml: string): TallyMasters {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
  if (typeof xml !== 'string' || !/<\s*(ENVELOPE|TALLYMESSAGE|LEDGER|STOCKITEM|GROUP)\b/i.test(xml)) {
    throw new BooksError('This is not a Tally export. In TallyPrime, export the masters as XML (Alt+E > Masters > Format: XML) and choose that file.');
  }
  let doc: unknown;
  try { doc = parser.parse(xml); } catch { throw new BooksError('The Tally file could not be read. Export it again from TallyPrime as XML.'); }
  const found: Record<string, Node[]> = { GROUP: [], LEDGER: [], UNIT: [], STOCKGROUP: [], STOCKITEM: [], GODOWN: [], VOUCHERTYPE: [] };
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
        gstHead: text(l.GSTDUTYHEAD),
        opening: tallyAmount(l.OPENINGBALANCE),
        gstin: (text(l.PARTYGSTIN) || text(reg.GSTIN)).toUpperCase(),
        state: text(l.LEDSTATENAME) || text(mail.STATE) || text(l.STATENAME),
        address: addr.join('\n'),
        pincode: text(l.PINCODE) || text(mail.PINCODE),
        phone: text(l.LEDGERMOBILE) || text(l.LEDGERPHONE),
        creditDays: firstNumber(l.BILLCREDITPERIOD),
        // Each pending bill of the party, so outstandings and overdue days carry over bill by bill.
        bills: list(l['BILLALLOCATIONS.LIST']).map((b) => ({
          ref: text(b.NAME), date: tallyDate(b.BILLDATE), amount: tallyAmount(b.OPENINGBALANCE), creditDays: firstNumber(b.BILLCREDITPERIOD),
        })).filter((b) => b.ref && b.amount),
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
      batches: list(i['BATCHALLOCATIONS.LIST']).map((b) => ({
        name: text(b.BATCHNAME) || 'Primary Batch', godown: text(b.GODOWNNAME), expiry: tallyDate(b.EXPIRYPERIOD), mfg: tallyDate(b.MFDON),
        qty: firstNumber(b.OPENINGBALANCE), value: Math.abs(tallyAmount(b.OPENINGVALUE)),
      })).filter((b) => b.qty),
    })).filter((i) => i.name),
    godowns: found.GODOWN.map(nameOf).filter((n) => n && !/^main location$/i.test(n)),
    voucherTypes: found.VOUCHERTYPE.map((v) => ({ name: nameOf(v), parent: text(v.PARENT) })).filter((v) => v.name),
  };
}

const stateCode = (name: string) => Object.entries(STATES).find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0] ?? '';

/** Adds Tally masters that Stockwell does not have yet. Existing names are left alone. */
export function importTallyMasters(books: Books, m: TallyMasters) {
  const result = { groups: 0, ledgers: 0, units: 0, stockGroups: 0, items: 0, bills: 0, batches: 0, godowns: 0, skipped: [] as string[] };
  const moves: { itemId: number; lines: { batch: string; godown: string; qty: number; value: number }[] }[] = [];
  books.db.transaction(() => {
    const haveGroup = (n: string) => books.db.prepare(`SELECT id FROM groups WHERE name=? COLLATE NOCASE`).get(n) as { id: number } | undefined;
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

    const unused = books.db.prepare(`SELECT 1 FROM entries WHERE ledger_id=? LIMIT 1`);
    for (const l of m.ledgers) {
      const have = books.ledgerByName(l.name);
      // A ledger Stockwell made itself (Cash, Sales…) takes Tally's opening balance while it is still unused.
      if (have && !have.opening && l.opening && !unused.get(have.id) && !/^profit & loss a\/c$/i.test(l.name)) {
        books.updateLedger(have.id, { opening: l.opening } as never);
        result.ledgers++;
      }
      if (have || /^profit & loss a\/c$/i.test(l.name)) continue;
      const group = haveGroup(l.parent) ?? haveGroup('Suspense A/c')!;
      books.createLedger({
        name: l.name, group_id: group.id, opening: l.opening,
        gstin: isValidGstin(l.gstin) ? l.gstin : '', state_code: stateCode(l.state), address: l.address,
        pincode: l.pincode, phone: l.phone, credit_days: l.creditDays,
      });
      result.ledgers++;
    }

    for (const l of m.ledgers) {
      // Pending bills from Tally replace the single "Opening" bill.
      const led = books.ledgerByName(l.name);
      if (!led || !l.bills.length || !books.isBillWise(led.id)) continue;
      const have = books.db.prepare(`SELECT COUNT(*) n FROM bills WHERE ledger_id=? AND voucher_id IS NULL AND ref<>'Opening'`).get(led.id) as { n: number };
      if (have.n) continue;
      books.setOpeningBills(led.id, l.bills.map((b) => ({ ref: b.ref, date: b.date, amount: b.amount, creditDays: b.creditDays || l.creditDays })));
      result.bills += l.bills.length;
    }

    for (const g of m.godowns ?? []) {
      if (books.db.prepare(`SELECT id FROM godowns WHERE name=?`).get(g)) continue;
      books.createGodown(g);
      result.godowns++;
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
      // Batches with names other than Tally's default "Primary Batch" mean the item is tracked by batch.
      const realBatches = i.batches.filter((b) => b.name !== 'Primary Batch' || b.expiry);
      const created = books.createItem({
        name: i.name, unit_id: unit.id, stock_group_id: sg?.id ?? null, hsn: i.hsn, gst_rate: i.gstRate,
        opening_qty: i.openingQty, opening_value: i.openingValue, track_batch: realBatches.length ? 1 : 0,
        opening_batch_no: 'Opening',
      });
      if (realBatches.length) {
        books.db.prepare(`DELETE FROM batches WHERE item_id=? AND batch_no='Opening'`).run(created.id);
        let left = i.openingQty;
        for (const b of realBatches) {
          if (b.mfg && b.expiry && b.expiry < b.mfg) {
            result.skipped.push(`Batch ${b.name} of ${i.name}: expiry ${b.expiry} is before its manufacturing date ${b.mfg}, so the manufacturing date was left out. Check it in Tally.`);
            b.mfg = null;
          }
          books.db.prepare(`INSERT INTO batches (item_id, batch_no, mfg_date, expiry_date, opening_qty) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(item_id, batch_no) DO UPDATE SET opening_qty=opening_qty+excluded.opening_qty`).run(created.id, b.name.slice(0, 40), b.mfg, b.expiry, b.qty);
          left -= b.qty;
          result.batches++;
        }
        if (left > 1e-9) books.db.prepare(`INSERT INTO batches (item_id, batch_no, opening_qty) VALUES (?, 'Opening', ?)`).run(created.id, Math.round(left * 1000) / 1000);
        else if (left < -1e-9) {
          // The batches hold more than the item's opening: trust the batches (they are what is on the shelf).
          const total = Math.round((i.openingQty - left) * 1000) / 1000;
          books.db.prepare(`UPDATE items SET opening_qty=? WHERE id=?`).run(total, created.id);
          result.skipped.push(`${i.name}: the batches add up to ${total}, more than the item opening of ${i.openingQty}. The opening was set to ${total}; check it in Tally.`);
        }
        // Stock kept in other Tally godowns: opening stock starts in the Main Location, so move it with a Stock Journal on the first day.
        const away = realBatches.filter((b) => b.godown && b.qty > 0 && b.godown.toLowerCase() !== 'main location');
        if (away.length) moves.push({ itemId: created.id, lines: away.map((b) => ({ batch: b.name.slice(0, 40), godown: b.godown, qty: b.qty, value: b.value })) });
      }
      result.items++;
    }
    const from = books.company().books_from;
    for (const mv of moves) {
      const lines: Record<string, unknown>[] = [];
      for (const l of mv.lines) {
        const bid = (books.db.prepare(`SELECT id FROM batches WHERE item_id=? AND batch_no=?`).get(mv.itemId, l.batch) as { id: number } | undefined)?.id;
        let gid = (books.db.prepare(`SELECT id FROM godowns WHERE name=? COLLATE NOCASE`).get(l.godown) as { id: number } | undefined)?.id;
        if (!gid) gid = (books.createGodown(l.godown) as { id: number }).id;
        if (!bid || gid === 1) continue;
        const rate = l.qty ? Math.round(l.value / l.qty) : 0;
        lines.push({ itemId: mv.itemId, batchId: bid, qty: l.qty, rate, direction: 'out', godownId: 1 }, { itemId: mv.itemId, batchId: bid, qty: l.qty, rate, direction: 'in', godownId: gid });
      }
      if (lines.length) books.createVoucher({ type: 'stock_journal', date: from, narration: 'Opening stock in other godowns (from Tally)', lines } as never);
    }
  })();
  return result;
}
