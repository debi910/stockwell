import { BooksError } from './books';
import { XMLParser } from 'fast-xml-parser';
import type { Books } from './books';
import { STATES, isValidGstin } from '../core/gst';

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
    // UTF-16, as Tally's own tools send it, so company and ledger names in Odia, Hindi or any script match exactly.
    res = await fetch(checkTallyUrl(url), { method: 'POST', body: Buffer.from(body, 'utf16le'), headers: { 'Content-Type': 'text/xml;charset=utf-16' }, signal: AbortSignal.timeout(timeoutMs) });
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

/** The first signed number in Tally's text: "(-)5 Nos" → -5, " 1,200.50/Box" → 1200.5. Never NaN. */
export const firstNumber = (v: unknown): number => {
  const t = text(v).replace(/\(-\)\s*/g, '-').replace(/,/g, '');
  const m = /-?\s*\d+(?:\.\d+)?|-?\s*\.\d+/.exec(t);
  const n = m ? Number(m[0].replace(/\s+/g, '')) : 0;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Tally writes debit amounts as negative numbers; Stockwell keeps debit as positive.
 * A foreign-currency amount ("-$ 100.00 @ ₹ 83.00/$ = -₹ 8300.00") counts in rupees: the part after the last "=".
 */
export const tallyAmount = (v: unknown): number => {
  let t = text(v);
  if (t.includes('=')) t = t.slice(t.lastIndexOf('=') + 1);
  // "-₹ 8300.00": the sign may sit before the currency symbol.
  const n = firstNumber(t.replace(/\(-\)/g, '-').replace(/[^\d.,-]/g, ' '));
  return n ? -Math.round(n * 100) : 0;
};

/** Compound units of the Tally masters ("Box of 10 Pcs" = Box made of 10 Pcs). Stockwell keeps such items in the smallest unit. */
export interface TallyUnit { name: string; simple: boolean; base: string; add: string; conv: number; decimals: number }

/** Each unit name an item's compound unit is made of, with how many of the smallest unit it holds. */
export function unitFactors(units: TallyUnit[], name: string): { smallest: string; factors: Map<string, number> } {
  const byName = new Map(units.map((u) => [u.name.toLowerCase(), u]));
  const chain: TallyUnit[] = [];
  let cur = name;
  for (let u = byName.get(cur.toLowerCase()); u && !u.simple && chain.length < 5; u = byName.get(cur.toLowerCase())) { chain.push(u); cur = u.add; }
  const factors = new Map<string, number>([[cur.toLowerCase(), 1]]);
  let f = 1;
  for (const c of chain.reverse()) { f *= c.conv || 1; factors.set(c.base.toLowerCase(), f); factors.set(c.name.toLowerCase(), f); }
  return { smallest: cur, factors };
}

/** A quantity in a compound unit, e.g. "1 Box 5 Pcs" or "1-5 Box of 10 Pcs", in the smallest unit (15). */
export function compoundQty(raw: unknown, units: TallyUnit[], unitName: string): number {
  const { factors } = unitFactors(units, unitName);
  if (factors.size < 2) return firstNumber(raw);
  let t = text(raw).replace(/\(-\)\s*/g, '-').replace(/,/g, '');
  // "1 Box of 10 Pcs" is one Box: take the compound names out first (longest first), so their own numbers are not read as quantities.
  for (const u of units.filter((x) => !x.simple).sort((a, b) => b.name.length - a.name.length)) t = t.split(u.name).join(u.base);
  const sign = /^\s*-/.test(t) ? -1 : 1;
  const top = factors.get(unitName.toLowerCase()) ?? 1;
  const sub = Math.min(...factors.values());
  let total = 0;
  const dash = /^\s*-?(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\s*(.*)$/.exec(t);
  if (dash) total = Number(dash[1]) * top + Number(dash[2]) * sub;
  else {
    const re = /(\d+(?:\.\d+)?)\s*([^\d]*)/g;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const unit = m[2].trim().toLowerCase();
      // The first unit word that is known gives the factor ("Box of 10 Pcs" → Box).
      const f = factors.get(unit) ?? [...factors.entries()].find(([k]) => unit.startsWith(k))?.[1] ?? (total ? sub : top);
      total += Number(m[1]) * f;
    }
  }
  return sign * Math.round(total * 1000) / 1000;
}

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

export interface TallyGroup { name: string; parent: string; reserved: string; nature: 'asset' | 'liability' | 'income' | 'expense'; direct: boolean }
export interface TallyMasters {
  /** BOOKSFROM of the company, when the file carries its company record. */
  booksFrom?: string | null;
  groups: TallyGroup[];
  voucherTypes?: { name: string; parent: string }[];
  ledgers: { name: string; parent: string; gstHead?: string; opening: number; gstin: string; state: string; address: string; pincode: string; phone: string; creditDays: number;
    bills: { ref: string; date: string | null; amount: number; creditDays: number }[] }[];
  units: string[];
  unitDefs?: TallyUnit[];
  stockGroups: string[];
  godowns: string[];
  items: { name: string; group: string; unit: string; tallyUnit?: string; hsn: string; gstRate: number; gstRates?: { from: string; rate: number }[]; taxability?: string;
    openingQty: number; openingValue: number;
    batches: { name: string; godown: string; expiry: string | null; mfg: string | null; qty: number; value: number }[] }[];
}

/** Tally writes its own names with a leading control character ("&#4; Primary", "&#4; Any"). */
export const plain = (v: unknown) => text(v).replace(/[\x00-\x1f]/g, '').trim();
/** "Branch / Divisions", "Branch/Divisions" and "branch/divisions" are the same group. */
export const groupKey = (n: string) => plain(n).toLowerCase().replace(/\s*([/.&()-])\s*/g, '$1').replace(/\s+/g, ' ');

/** The entry of a dated Tally list (GST details, GST registration, mailing details) in force on a date: the latest one on or before it. */
function inForce(nodes: Node[], on: string): Node | undefined {
  if (nodes.length < 2) return nodes[0];
  const dated = nodes.map((n, i) => ({ n, i, d: tallyDate(n.APPLICABLEFROM) ?? '' }));
  const ok = dated.filter((x) => x.d <= on);
  const pick = (ok.length ? ok : dated).sort((a, b) => a.d.localeCompare(b.d) || a.i - b.i);
  return pick[pick.length - 1].n;
}

export function parseTallyMasters(xml: string, today = new Date().toISOString().slice(0, 10)): TallyMasters {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
  if (typeof xml !== 'string' || !/<\s*(ENVELOPE|TALLYMESSAGE|LEDGER|STOCKITEM|GROUP)\b/i.test(xml)) {
    throw new BooksError('This is not a Tally export. In TallyPrime, export the masters as XML (Alt+E > Masters > Format: XML) and choose that file.');
  }
  let doc: unknown;
  try { doc = parser.parse(xml); } catch { throw new BooksError('The Tally file could not be read. Export it again from TallyPrime as XML.'); }
  const found: Record<string, Node[]> = { GROUP: [], LEDGER: [], UNIT: [], STOCKGROUP: [], STOCKITEM: [], GODOWN: [], VOUCHERTYPE: [], COMPANY: [] };
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Node)) {
      if (k in found) found[k].push(...list(v));
      else if (typeof v === 'object') list(v).forEach(walk);
    }
  };
  walk(doc);

  // Every GST rate the item has had, each with the date it applies from (Tally keeps rate changes as dated entries).
  const gstRatesOf = (item: Node): { from: string; rate: number }[] => {
    const out: { from: string; rate: number }[] = [];
    for (const g of list(item['GSTDETAILS.LIST'])) {
      let rate: number | null = null;
      for (const s of list(g['STATEWISEDETAILS.LIST'])) {
        for (const r of list(s['RATEDETAILS.LIST'])) {
          if (/integrated/i.test(text(r.GSTRATEDUTYHEAD)) && rate === null) rate = firstNumber(r.GSTRATE);
        }
      }
      if (rate !== null) out.push({ from: tallyDate(g.APPLICABLEFROM) ?? '', rate });
    }
    return out.sort((a, b) => a.from.localeCompare(b.from));
  };
  const gstNow = (rates: { from: string; rate: number }[]) => {
    const ok = rates.filter((r) => r.from <= today);
    return (ok.length ? ok : rates).at(-1)?.rate ?? 0;
  };
  const hsnOf = (item: Node): string => {
    const g = inForce(list(item['GSTDETAILS.LIST']).filter((x) => text(x.HSNCODE)), today);
    if (g) return text(g.HSNCODE);
    for (const h of list(item['HSNDETAILS.LIST'])) if (text(h.HSNCODE)) return text(h.HSNCODE);
    return '';
  };
  const taxabilityOf = (item: Node): string => {
    const t = plain(inForce(list(item['GSTDETAILS.LIST']), today)?.TAXABILITY).toLowerCase();
    return /exempt/.test(t) ? 'exempt' : /nil/.test(t) ? 'nil' : /non.?gst/.test(t) ? 'nongst' : 'taxable';
  };

  const unitDefs: TallyUnit[] = found.UNIT.map((u) => ({
    name: nameOf(u), simple: !/^no$/i.test(text(u.ISSIMPLEUNIT)) || !text(u.ADDITIONALUNITS), base: text(u.BASEUNITS), add: text(u.ADDITIONALUNITS),
    conv: firstNumber(u.CONVERSION) || 1, decimals: firstNumber(u.DECIMALPLACES),
  })).filter((u) => u.name);
  const yesOf = (v: unknown) => /^yes$/i.test(text(v));
  const company = found.COMPANY.find((c) => text(c.BOOKSFROM));

  return {
    booksFrom: company ? tallyDate(company.BOOKSFROM) : null,
    groups: found.GROUP.map((g) => {
      const revenue = yesOf(g.ISREVENUE), debit = yesOf(g.ISDEEMEDPOSITIVE);
      return {
        name: nameOf(g), parent: plain(g.PARENT), reserved: plain(g['@_RESERVEDNAME']) || plain(g.RESERVEDNAME),
        nature: (revenue ? (debit ? 'expense' : 'income') : debit ? 'asset' : 'liability') as TallyGroup['nature'],
        direct: yesOf(g.AFFECTSGROSSPROFIT),
      };
    }).filter((g) => g.name),
    ledgers: found.LEDGER.map((l) => {
      const reg = inForce(list(l['LEDGSTREGDETAILS.LIST']), today) ?? {};
      const mail = inForce(list(l['LEDMAILINGDETAILS.LIST']), today) ?? {};
      const own = list(l['ADDRESS.LIST']).flatMap((a) => list(a.ADDRESS)).map(text).filter(Boolean);
      const addr = own.length ? own : list(mail['ADDRESS.LIST']).flatMap((a) => list(a.ADDRESS)).map(text).filter(Boolean);
      return {
        name: nameOf(l),
        parent: plain(l.PARENT),
        gstHead: text(l.GSTDUTYHEAD),
        opening: tallyAmount(l.OPENINGBALANCE),
        // TallyPrime 3.0+ keeps GSTIN and state in dated lists; older releases on the ledger itself.
        gstin: (text(reg.GSTIN) || text(l.PARTYGSTIN)).toUpperCase(),
        state: plain(mail.STATE) || plain(reg.STATE) || plain(l.LEDSTATENAME) || plain(l.STATENAME),
        address: addr.join('\n'),
        pincode: text(mail.PINCODE) || text(l.PINCODE),
        phone: text(l.LEDGERMOBILE) || text(l.LEDGERPHONE),
        creditDays: firstNumber(l.BILLCREDITPERIOD),
        // Each pending bill of the party, so outstandings and overdue days carry over bill by bill.
        bills: list(l['BILLALLOCATIONS.LIST']).map((b) => ({
          ref: text(b.NAME), date: tallyDate(b.BILLDATE), amount: tallyAmount(b.OPENINGBALANCE), creditDays: firstNumber(b.BILLCREDITPERIOD),
        })).filter((b) => b.ref && b.amount),
      };
    }).filter((l) => l.name),
    units: unitDefs.filter((u) => u.simple).map((u) => u.name),
    unitDefs,
    stockGroups: found.STOCKGROUP.map(nameOf).filter(Boolean),
    items: found.STOCKITEM.map((i) => {
      const tallyUnit = text(i.BASEUNITS);
      const { smallest } = unitFactors(unitDefs, tallyUnit);
      const qty = (v: unknown) => compoundQty(v, unitDefs, tallyUnit);
      const gstRates = gstRatesOf(i);
      return {
        name: nameOf(i),
        group: plain(i.PARENT),
        unit: smallest,
        tallyUnit,
        hsn: hsnOf(i),
        gstRate: gstNow(gstRates),
        gstRates,
        taxability: taxabilityOf(i),
        openingQty: qty(i.OPENINGBALANCE),
        openingValue: Math.abs(tallyAmount(i.OPENINGVALUE)),
        batches: list(i['BATCHALLOCATIONS.LIST']).map((b) => ({
          name: text(b.BATCHNAME) || 'Primary Batch', godown: text(b.GODOWNNAME), expiry: tallyDate(b.EXPIRYPERIOD), mfg: tallyDate(b.MFDON),
          qty: qty(b.OPENINGBALANCE), value: Math.abs(tallyAmount(b.OPENINGVALUE)),
        })).filter((b) => b.qty),
      };
    }).filter((i) => i.name),
    godowns: found.GODOWN.map(nameOf).filter((n) => n && !/^main location$/i.test(n)),
    voucherTypes: found.VOUCHERTYPE.map((v) => ({ name: nameOf(v), parent: plain(v.PARENT) })).filter((v) => v.name),
  };
}

const stateCode = (name: string) => Object.entries(STATES).find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0] ?? '';

/** Tally's own "Profit & Loss A/c" ledger: last years' result. Stockwell works the current years out itself,
 *  so what Tally carried in at the books start sits in this ledger under Reserves & Surplus. */
export const PL_LEDGER = 'Profit & Loss A/c (brought forward)';
export const isTallyPL = (name: string) => /^profit\s*&\s*loss\s*a\/c$/i.test(name.trim());
const rs = (paise: number) => `₹${(Math.abs(paise) / 100).toFixed(2)} ${paise >= 0 ? 'Dr' : 'Cr'}`;

/** Adds Tally masters that Stockwell does not have yet. Existing names are left alone. */
export function importTallyMasters(books: Books, m: TallyMasters) {
  const result = { groups: 0, ledgers: 0, units: 0, stockGroups: 0, items: 0, bills: 0, batches: 0, godowns: 0, skipped: [] as string[] };
  const moves: { itemId: number; lines: { batch: string | null; godown: string; qty: number; value: number }[] }[] = [];
  books.db.transaction(() => {
    // Groups by name, with Tally's spellings ("Branch / Divisions") and renamed built-in groups (RESERVEDNAME) pointing at Stockwell's own.
    const groupId = new Map<string, number>();
    for (const g of books.db.prepare(`SELECT id, name FROM groups`).all() as { id: number; name: string }[]) groupId.set(groupKey(g.name), g.id);
    for (const g of m.groups) {
      const own = g.reserved ? groupId.get(groupKey(g.reserved)) : undefined;
      if (own && !groupId.has(groupKey(g.name))) groupId.set(groupKey(g.name), own);
    }
    const haveGroup = (n: string) => { const id = groupId.get(groupKey(n)); return id ? { id } : undefined; };
    const topLevel = (p: string) => !p || /^primary$/i.test(p);
    // Parents first: keep looping until no more groups can be placed.
    let pending = m.groups.filter((g) => !haveGroup(g.name));
    for (let pass = 0; pass < 10 && pending.length; pass++) {
      pending = pending.filter((g) => {
        if (topLevel(g.parent)) {
          // A main group made in Tally: it keeps the nature Tally gives it (asset, liability, income or expense).
          const r = books.db.prepare(`INSERT INTO groups (name, parent_id, nature, direct) VALUES (?, NULL, ?, ?)`).run(g.name.slice(0, 100), g.nature, g.direct && (g.nature === 'income' || g.nature === 'expense') ? 1 : 0);
          groupId.set(groupKey(g.name), Number(r.lastInsertRowid));
          result.groups++;
          return false;
        }
        const parent = haveGroup(g.parent);
        if (!parent) return true;
        const made = books.createGroup({ name: g.name.slice(0, 100), parentId: parent.id });
        groupId.set(groupKey(g.name), made.id);
        result.groups++;
        return false;
      });
    }
    pending.forEach((g) => result.skipped.push(`Group ${g.name} (parent ${g.parent} not found)`));

    const used = books.db.prepare(`SELECT 1 FROM entries WHERE ledger_id=? LIMIT 1`);
    for (const l of m.ledgers) {
      const pl = isTallyPL(l.name);
      if (pl && !l.opening) continue;
      const name = pl ? PL_LEDGER : l.name;
      const have = books.ledgerByName(name);
      if (have) {
        if (have.opening === l.opening) continue;
        // A ledger Stockwell made itself (Cash, Sales…) takes Tally's opening balance while it is still unused.
        if (!have.opening && !used.get(have.id)) {
          books.updateLedger(have.id, { opening: l.opening } as never);
          result.ledgers++;
        } else result.skipped.push(`Ledger ${name}: kept Stockwell's opening ${rs(have.opening)}; Tally has ${rs(l.opening)}. Check it.`);
        continue;
      }
      let group = pl ? haveGroup('Reserves & Surplus') : haveGroup(l.parent);
      if (!group) {
        group = haveGroup('Suspense A/c')!;
        result.skipped.push(`Ledger ${l.name}: its group "${l.parent}" was not found, so it went under Suspense A/c. Move it to the right group (Alter > Ledger).`);
      }
      books.createLedger({
        name, group_id: group.id, opening: l.opening,
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
      if (i.tallyUnit && i.tallyUnit !== i.unit) result.skipped.push(`${i.name}: Tally keeps it in "${i.tallyUnit}"; Stockwell keeps it in ${i.unit}, with every quantity worked out in ${i.unit}.`);
      const sg = books.db.prepare(`SELECT id FROM stock_groups WHERE name=?`).get(i.group) as { id: number } | undefined;
      // Batches with names other than Tally's default "Primary Batch" mean the item is tracked by batch.
      const realBatches = i.batches.filter((b) => b.name !== 'Primary Batch' || b.expiry);
      const taxability = i.taxability && i.taxability !== 'taxable' ? i.taxability : i.gstRate > 0 ? 'taxable' : undefined;
      const created = books.createItem({
        name: i.name, unit_id: unit.id, stock_group_id: sg?.id ?? null, hsn: i.hsn, gst_rate: i.gstRate, taxability: taxability as never,
        opening_qty: i.openingQty, opening_value: i.openingValue, track_batch: realBatches.length ? 1 : 0,
        opening_batch_no: 'Opening',
      });
      // Rate changes over the years (e.g. the GST rate cuts of 22 Sep 2025), each from its own date.
      const dated = (i.gstRates ?? []).filter((r) => r.from);
      if (new Set(dated.map((r) => r.rate)).size > 1) {
        for (const r of dated) books.db.prepare(`INSERT INTO item_gst_rates (item_id, from_date, gst_rate) VALUES (?, ?, ?) ON CONFLICT(item_id, from_date) DO UPDATE SET gst_rate=excluded.gst_rate`).run(created.id, r.from, r.rate);
      }
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
      }
      // Stock kept in other Tally godowns: opening stock starts in the Main Location, so move it with a Stock Journal on the first day.
      // Items without batches keep their godown split in Tally as "Primary Batch" lines.
      const away = (realBatches.length ? realBatches : i.batches).filter((b) => b.godown && b.qty > 0 && b.godown.toLowerCase() !== 'main location');
      if (away.length) moves.push({ itemId: created.id, lines: away.map((b) => ({ batch: realBatches.length ? b.name.slice(0, 40) : null, godown: b.godown, qty: b.qty, value: b.value })) });
      result.items++;
    }
    const from = books.company().books_from;
    for (const mv of moves) {
      const lines: Record<string, unknown>[] = [];
      for (const l of mv.lines) {
        const bid = l.batch === null ? null : (books.db.prepare(`SELECT id FROM batches WHERE item_id=? AND batch_no=?`).get(mv.itemId, l.batch) as { id: number } | undefined)?.id;
        let gid = (books.db.prepare(`SELECT id FROM godowns WHERE name=? COLLATE NOCASE`).get(l.godown) as { id: number } | undefined)?.id;
        if (!gid) gid = (books.createGodown(l.godown) as { id: number }).id;
        if (bid === undefined || gid === 1) continue;
        const rate = l.qty ? Math.round(l.value / l.qty) : 0;
        lines.push({ itemId: mv.itemId, batchId: bid, qty: l.qty, rate, direction: 'out', godownId: 1 }, { itemId: mv.itemId, batchId: bid, qty: l.qty, rate, direction: 'in', godownId: gid });
      }
      if (lines.length) books.createVoucher({ type: 'stock_journal', date: from, narration: 'Opening stock in other godowns (from Tally)', lines } as never);
    }
  })();
  return result;
}
