// Vouchers brought in from TallyPrime (its Day Book export), exactly as they stand in Tally:
// the same ledgers, amounts, items, godowns, batches and bill references. Nothing is worked out again,
// so the Trial Balance, ledgers, stock and outstandings match Tally.
import { XMLParser } from 'fast-xml-parser';
import { BooksError, VOUCHER_TYPES, type Books, type VoucherType } from './books';
import { STATES } from '../core/gst';
import { addDays } from '../core/dates';
import { PL_LEDGER, firstNumber, isTallyPL, list, tallyAmount, tallyDate, text, type Node } from './tally';

/** Reads a quantity of an item (compound units such as "1 Box 5 Pcs" come out in the item's smallest unit). */
export type QtyReader = (item: string, raw: unknown) => number;

export interface TallyLedgerEntry { ledger: string; amount: number; bills: { ref: string; kind: 'new' | 'agst' | 'onacc'; amount: number; creditDays: number }[] }
export interface TallyStockLine {
  item: string; qty: number; free: number; rate: number; amount: number; inward: boolean; godown: string; batch: string;
  expiry: string | null; tracked: boolean; discount: number;
  /** The unit the Tally rate is per ("Box" in "1200.00/Box"), when it says. */
  rateUnit: string;
}
export interface TallyVoucher {
  guid: string; alterId: number; typeName: string; baseType: string; date: string | null; number: string; party: string; narration: string;
  reference: string; referenceDate: string | null; partyGstin: string; placeOfSupply: string;
  cancelled: boolean; optional: boolean; deleted: boolean; invoice: boolean;
  entries: TallyLedgerEntry[]; stock: TallyStockLine[];
}

const yes = (v: unknown) => /^yes$/i.test(text(v));
const parser = () => new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true, processEntities: true, htmlEntities: true });

const BILL_KIND: Record<string, 'new' | 'agst' | 'onacc'> = { 'new ref': 'new', 'agst ref': 'agst', advance: 'new', 'on account': 'onacc' };

/** "120.00/Pcs" or "120/Box" → paise. */
const rateOf = (v: unknown) => {
  let t = text(v);
  if (t.includes('=')) t = t.slice(t.lastIndexOf('=') + 1); // a foreign-currency rate: the rupee part
  return Math.round(Math.abs(firstNumber(t.split('/')[0])) * 100);
};

export function parseTallyVouchers(xml: string, qtyOf: QtyReader = (_item, raw) => firstNumber(raw)): TallyVoucher[] {
  if (typeof xml !== 'string' || !/<\s*(ENVELOPE|TALLYMESSAGE|VOUCHER)\b/i.test(xml)) {
    throw new BooksError('This is not a Tally export. In TallyPrime, export the Day Book as XML (Alt+E > Transactions > Day Book) and choose that file.');
  }
  let doc: unknown;
  try { doc = parser().parse(xml); } catch { throw new BooksError('The Tally file could not be read. Export it again from TallyPrime as XML.'); }
  const found: Node[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Node)) {
      if (k === 'VOUCHER') found.push(...list(v));
      else if (typeof v === 'object') list(v).forEach(walk);
    }
  };
  walk(doc);

  return found.map((v) => {
    const stock: TallyStockLine[] = [];
    const ledgerLines = (src: Node[]): TallyLedgerEntry[] => {
      const out: TallyLedgerEntry[] = [];
      stock.length = 0;
      const addLedger = (l: Node) => {
        // Items entered in voucher mode sit under their Sales/Purchase ledger line.
        list(l['INVENTORYALLOCATIONS.LIST']).forEach((e) => addStock(e, null, false));
        const ledger = text(l.LEDGERNAME);
        if (!ledger) return;
        out.push({
          ledger, amount: tallyAmount(l.AMOUNT),
          bills: list(l['BILLALLOCATIONS.LIST']).map((b) => ({
            ref: text(b.NAME), kind: BILL_KIND[text(b.BILLTYPE).toLowerCase()] ?? 'new', amount: tallyAmount(b.AMOUNT), creditDays: firstNumber(b.BILLCREDITPERIOD),
          })).filter((b) => (b.ref || b.kind === 'onacc') && b.amount),
        });
      };
      const addStock = (e: Node, inward: boolean | null, withLedgers = true) => {
        const item = text(e.STOCKITEMNAME);
        // The Sales/Purchase ledger of an invoice sits inside each item line.
        if (withLedgers) list(e['ACCOUNTINGALLOCATIONS.LIST']).forEach(addLedger);
        if (!item) return;
        let isIn = inward ?? yes(e.ISDEEMEDPOSITIVE);
        const batches = list(e['BATCHALLOCATIONS.LIST']);
        const discount = firstNumber(e.DISCOUNT);
        const tracked = (b: Node) => { const t = text(b.TRACKINGNUMBER); return !!t && !/^not applicable$/i.test(t); };
        const itemQty = Math.abs(qtyOf(item, e.ACTUALQTY ?? e.BILLEDQTY));
        const itemAmount = Math.abs(tallyAmount(e.AMOUNT));
        // A line with a negative quantity (goods coming back on the same bill) moves the other way.
        if (qtyOf(item, e.ACTUALQTY ?? e.BILLEDQTY) < 0) isIn = !isIn;
        const rateText = text(e.RATE);
        const line = (src: Node, godown: string, batch: string, expiry: string | null, trk: boolean) => {
          // Billed quantity is what is charged; anything more that moved is free goods.
          const actual = Math.abs(qtyOf(item, src.ACTUALQTY ?? src.BILLEDQTY ?? e.ACTUALQTY ?? e.BILLEDQTY));
          const billedRaw = src.BILLEDQTY ?? e.BILLEDQTY;
          const billed = billedRaw === undefined ? actual : Math.min(actual, Math.abs(qtyOf(item, billedRaw)));
          const qty = batches.length > 1 && src.BILLEDQTY === undefined ? actual : billed;
          const free = Math.round(Math.max(0, actual - qty) * 1000) / 1000;
          // A batch without its own amount gets its share of the item's amount by quantity.
          const amount = src.AMOUNT !== undefined ? Math.abs(tallyAmount(src.AMOUNT))
            : src === e || batches.length < 2 ? itemAmount : itemQty ? Math.round((itemAmount * actual) / itemQty) : 0;
          const rt = text(src.RATE) || rateText;
          const rate = rateOf(rt) || (qty ? Math.round(amount / qty) : 0);
          const rateUnit = rt.includes('/') ? rt.slice(rt.lastIndexOf('/') + 1).trim() : '';
          stock.push({ item, qty, free, rate, amount, inward: isIn, godown, batch, expiry, tracked: trk, discount, rateUnit });
        };
        if (batches.length) {
          for (const b of batches) line(b, text(b.GODOWNNAME), text(b.BATCHNAME), tallyDate(b.EXPIRYPERIOD), tracked(b));
        } else line(e, text(e.GODOWNNAME), '', null, false);
      };
      src.forEach(addLedger);
      // Inventory: Tally writes it under one of two names; take one list, never both.
      const allInv = list(v['ALLINVENTORYENTRIES.LIST']);
      (allInv.length ? allInv : list(v['INVENTORYENTRIES.LIST'])).forEach((e) => addStock(e, null));
      list(v['INVENTORYENTRIESIN.LIST']).forEach((e) => addStock(e, true));
      list(v['INVENTORYENTRIESOUT.LIST']).forEach((e) => addStock(e, false));
      return out;
    };
    // Tally writes the ledger lines as ALLLEDGERENTRIES (accounting vouchers) or LEDGERENTRIES (invoices, with the
    // Sales/Purchase ledger inside the item lines). Some files carry both: take the one that balances, never both added up.
    const all = list(v['ALLLEDGERENTRIES.LIST']);
    const led = list(v['LEDGERENTRIES.LIST']);
    const invoiceView = yes(v.ISINVOICE) || /invoice/i.test(text(v.PERSISTEDVIEW) + text(v['@_OBJVIEW']));
    const options = !all.length ? [led] : !led.length ? [all] : invoiceView ? [led, all] : [all, led];
    let entries = ledgerLines(options[0]);
    if (options.length > 1 && entries.reduce((a, x) => a + x.amount, 0) !== 0) {
      const other = ledgerLines(options[1]);
      if (other.reduce((a, x) => a + x.amount, 0) === 0) entries = other;
      else entries = ledgerLines(options[0]);
    }

    const typeName = text(v.VOUCHERTYPENAME) || text(v['@_VCHTYPE']);
    return {
      guid: text(v.GUID) || text(v['@_REMOTEID']) || '',
      alterId: firstNumber(v.ALTERID),
      typeName,
      baseType: text(v['@_VCHTYPE']) || typeName,
      date: tallyDate(v.DATE),
      number: text(v.VOUCHERNUMBER),
      party: text(v.PARTYLEDGERNAME) || text(v.PARTYNAME),
      narration: text(v.NARRATION),
      reference: text(v.REFERENCE),
      referenceDate: tallyDate(v.REFERENCEDATE),
      partyGstin: text(v.PARTYGSTIN).toUpperCase(),
      placeOfSupply: text(v.PLACEOFSUPPLY) || text(v.STATENAME),
      cancelled: yes(v.ISCANCELLED),
      optional: yes(v.ISOPTIONAL),
      deleted: yes(v.ISDELETED) || /^delete$/i.test(text(v['@_ACTION'])),
      invoice: yes(v.ISINVOICE) || /invoice/i.test(text(v.PERSISTEDVIEW)),
      entries, stock,
    };
  });
}

/** Tally's own voucher types and what Stockwell calls them. Custom types (e.g. "GST Sales") are found through their parent. */
const BASE: Record<string, VoucherType | 'skip'> = {
  sales: 'sales', purchase: 'purchase', receipt: 'receipt', payment: 'payment', contra: 'contra', journal: 'journal',
  'credit note': 'credit_note', 'debit note': 'debit_note', 'stock journal': 'stock_journal', 'manufacturing journal': 'stock_journal',
  'material in': 'stock_journal', 'material out': 'stock_journal', 'physical stock': 'physical_stock',
  'delivery note': 'delivery_note', 'receipt note': 'receipt_note', 'rejections in': 'rejection_in', 'rejection in': 'rejection_in',
  'rejections out': 'rejection_out', 'rejection out': 'rejection_out', 'sales order': 'sales_order', 'purchase order': 'purchase_order',
  memorandum: 'memorandum', 'reversing journal': 'reversing_journal',
  // Payroll vouchers post real amounts (Salary Dr, Salary Payable Cr): they come in as journals, without the employee split.
  payroll: 'journal', attendance: 'skip', 'job work in order': 'skip', 'job work out order': 'skip',
};

export function stockwellType(typeName: string, vchType: string, parents: Map<string, string>): VoucherType | 'skip' | null {
  let n = typeName;
  for (let i = 0; i < 10 && n; i++) {
    const b = BASE[n.toLowerCase()];
    if (b) return b;
    n = parents.get(n.toLowerCase()) ?? '';
  }
  const direct = BASE[vchType.toLowerCase()];
  if (direct) return direct;
  // A custom type whose parent is unknown (no voucher type masters in the file): go by its name, e.g. "GST Sales 2024".
  const name = `${typeName} ${vchType}`.toLowerCase();
  const GUESS: [RegExp, VoucherType][] = [
    [/credit\s*note/, 'credit_note'], [/debit\s*note/, 'debit_note'], [/sales?\s*order/, 'sales_order'], [/purchase\s*order/, 'purchase_order'],
    [/delivery\s*note|challan/, 'delivery_note'], [/receipt\s*note|\bgrn\b/, 'receipt_note'], [/stock\s*journal|manufactur/, 'stock_journal'],
    [/physical/, 'physical_stock'], [/\bsales?\b|invoice/, 'sales'], [/purchase/, 'purchase'], [/receipt/, 'receipt'], [/payment/, 'payment'],
    [/contra/, 'contra'], [/journal/, 'journal'],
  ];
  return GUESS.find(([re]) => re.test(name))?.[1] ?? null;
}

export interface VoucherImportResult {
  vouchers: number; already: number; skipped: string[]; byType: Record<string, number>; from: string | null; to: string | null;
  /** Vouchers changed in Tally since they were last brought in, and brought in again. */
  updated?: number;
  /** Vouchers deleted in Tally since they were brought in, and taken out here too. */
  removed?: number;
}

/** Takes a voucher out as it is (used when Tally has altered or deleted it). Tally is the master copy in a catch-up. */
export function dropVoucher(books: Books, id: number) {
  const db = books.db;
  for (const t of ['entries', 'inventory', 'bills', 'tax_lines', 'voucher_charges']) db.prepare(`DELETE FROM ${t} WHERE voucher_id=?`).run(id);
  db.prepare(`UPDATE vouchers SET bounced_by=NULL WHERE bounced_by=?`).run(id);
  db.prepare(`UPDATE vouchers SET against_id=NULL WHERE against_id=?`).run(id);
  db.prepare(`DELETE FROM vouchers WHERE id=?`).run(id);
}

/**
 * Vouchers brought in from Tally earlier for these dates that Tally no longer has (deleted there).
 * Optional and memo vouchers are left alone (Tally's Day Book may not list them). When most of a period
 * would go, nothing is removed, because that looks like a Tally setting hiding vouchers rather than deletions.
 */
export function removeDeletedInTally(books: Books, from: string, to: string, guids: Set<string>): { removed: number; note?: string } {
  const rows = books.db.prepare(`SELECT id, tally_id, number, date FROM vouchers WHERE tally_id IS NOT NULL AND date BETWEEN ? AND ? AND optional=0
    AND type NOT IN ('memorandum','reversing_journal')`).all(from, to) as { id: number; tally_id: string; number: string; date: string }[];
  const gone = rows.filter((r) => !guids.has(r.tally_id));
  if (!gone.length) return { removed: 0 };
  if (!guids.size && gone.length > 1) return { removed: 0, note: `${from.slice(0, 7)}: Tally's Day Book sent no vouchers, though ${gone.length} came in earlier. Nothing was removed.` };
  if (gone.length > 3 && gone.length * 2 > rows.length) {
    return { removed: 0, note: `${from.slice(0, 7)}: ${gone.length} of ${rows.length} vouchers brought in earlier are not in Tally's Day Book now. Nothing was removed; check the Day Book in Tally (F12 settings) and import again.` };
  }
  books.db.transaction(() => {
    for (const r of gone) dropVoucher(books, r.id);
    books.audit('import', null, 'tally-removed', { numbers: gone.map((r) => r.number), from, to });
  })();
  return { removed: gone.length };
}

const stateCode = (name: string) => Object.entries(STATES).find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0] ?? null;

/**
 * Saves Tally vouchers as they are. A voucher already brought in (same Tally GUID) is skipped, so importing
 * again after more entries in Tally brings in only the new ones.
 * gstHeads: ledger name (lower case) → "Central Tax" / "State Tax" / "Integrated Tax" from the Tally masters.
 */
export function importTallyVouchers(books: Books, vouchers: TallyVoucher[], opts: { voucherTypes?: { name: string; parent: string }[]; gstHeads?: Map<string, string> } = {}): VoucherImportResult {
  const db = books.db;
  const parents = new Map((opts.voucherTypes ?? []).map((t) => [t.name.toLowerCase(), t.parent]));
  const result: VoucherImportResult = { vouchers: 0, already: 0, skipped: [], byType: {}, from: null, to: null, updated: 0 };
  const leftOut = new Map<string, number>();
  const skip = (v: TallyVoucher, why: string) => { if (result.skipped.length < 500) result.skipped.push(`${v.typeName || 'Voucher'} ${v.number || '(no number)'} of ${v.date ?? '?'}: ${why}`); };

  const ledgerCache = new Map<string, { id: number; group: string; credit_days: number; billWise: boolean } | null>();
  const ledger = (tallyName: string) => {
    const k = tallyName.toLowerCase();
    // Tally's predefined "Profit & Loss A/c" is Stockwell's ledger for last years' result.
    const name = isTallyPL(tallyName) ? PL_LEDGER : tallyName;
    if (name === PL_LEDGER && !books.ledgerByName(PL_LEDGER)) {
      books.createLedger({ name: PL_LEDGER, group_id: books.groupByName('Reserves & Surplus').id, opening: 0 });
    }
    if (!ledgerCache.has(k)) {
      const l = db.prepare(`SELECT l.id, g.name AS grp, l.credit_days FROM ledgers l JOIN groups g ON g.id=l.group_id WHERE l.name=?`).get(name) as { id: number; grp: string; credit_days: number } | undefined;
      ledgerCache.set(k, l ? { id: l.id, group: l.grp, credit_days: l.credit_days || 0, billWise: books.isBillWise(l.id) } : null);
    }
    return ledgerCache.get(k)!;
  };
  // Which group a ledger finally sits under (Cash-in-Hand, Bank Accounts, Duties & Taxes…).
  const groupPath = new Map<string, string[]>();
  const pathOf = (group: string): string[] => {
    if (!groupPath.has(group)) {
      const out: string[] = [];
      type G = { name: string; parent_id: number | null };
      let g = db.prepare(`SELECT name, parent_id FROM groups WHERE name=?`).get(group) as G | undefined;
      for (let i = 0; g && i < 20; i++) {
        out.push(g.name);
        g = g.parent_id ? db.prepare(`SELECT name, parent_id FROM groups WHERE id=?`).get(g.parent_id) as G | undefined : undefined;
      }
      groupPath.set(group, out);
    }
    return groupPath.get(group)!;
  };
  const under = (l: { group: string }, g: string) => pathOf(l.group).includes(g);
  const taxHead = (name: string, l: { group: string }): 'cgst' | 'sgst' | 'igst' | null => {
    if (!under(l, 'Duties & Taxes')) return null;
    const h = (opts.gstHeads?.get(name.toLowerCase()) ?? '').toLowerCase();
    if (/central/.test(h)) return 'cgst';
    if (/state|ut tax|union/.test(h)) return 'sgst';
    if (/integrated/.test(h)) return 'igst';
    if (h) return null;
    if (/\bcgst\b|central/i.test(name)) return 'cgst';
    if (/\b(sgst|utgst)\b|state tax/i.test(name)) return 'sgst';
    if (/\bigst\b|integrated/i.test(name)) return 'igst';
    return null;
  };

  const item = (name: string) => db.prepare(`SELECT i.id, i.gst_rate, i.track_batch, i.hsn, u.symbol AS unit FROM items i JOIN units u ON u.id=i.unit_id WHERE i.name=?`).get(name) as { id: number; gst_rate: number; track_batch: number; hsn: string; unit: string } | undefined;
  const godownCache = new Map<string, number>();
  const godown = (name: string): number | null => {
    if (!name || /^main location$/i.test(name)) return null;
    const k = name.toLowerCase();
    if (!godownCache.has(k)) {
      const g = db.prepare(`SELECT id FROM godowns WHERE name=? COLLATE NOCASE`).get(name) as { id: number } | undefined;
      godownCache.set(k, g ? g.id : (books.createGodown(name.slice(0, 60)) as { id: number }).id);
    }
    const id = godownCache.get(k)!;
    return id === 1 ? null : id;
  };
  const batch = (itemId: number, name: string, expiry: string | null): number => {
    const n = (name || 'Primary Batch').slice(0, 40);
    const b = db.prepare(`SELECT id FROM batches WHERE item_id=? AND batch_no=?`).get(itemId, n) as { id: number } | undefined;
    if (b) return b.id;
    return Number(db.prepare(`INSERT INTO batches (item_id, batch_no, expiry_date, opening_qty) VALUES (?, ?, ?, 0)`).run(itemId, n, expiry).lastInsertRowid);
  };
  const numberTaken = db.prepare(`SELECT 1 FROM vouchers WHERE type=? AND number=?`);
  const known = db.prepare(`SELECT id, tally_alter FROM vouchers WHERE tally_id=?`);
  const booksFrom = books.company().books_from;

  const insV = db.prepare(`INSERT INTO vouchers (type, number, seq, date, narration, party_id, account_id, place_of_supply, intra, taxable, cgst, sgst, igst,
      round_off, total, ref_no, ref_date, party_gstin, party_state, mode, optional, cancelled, tally_id, tally_alter)
    VALUES (@type, @number, @seq, @date, @narration, @party_id, @account_id, @place_of_supply, @intra, @taxable, @cgst, @sgst, @igst,
      @round_off, @total, @ref_no, @ref_date, @party_gstin, @party_state, @mode, @optional, @cancelled, @tally_id, @tally_alter)`);
  const insE = db.prepare(`INSERT INTO entries (voucher_id, ledger_id, amount) VALUES (?, ?, ?)`);
  const insI = db.prepare(`INSERT INTO inventory (voucher_id, line_no, item_id, batch_id, qty, free_qty, rate, discount_pct, gst_rate, taxable, cgst, sgst, igst, direction, godown_id, hsn)
    VALUES (@voucher_id, @line_no, @item_id, @batch_id, @qty, @free_qty, @rate, @discount_pct, @gst_rate, @taxable, @cgst, @sgst, @igst, @direction, @godown_id, @hsn)`);
  const insB = db.prepare(`INSERT INTO bills (voucher_id, ledger_id, ref, kind, amount, date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)`);

  // In date order, so a stock count is compared with the stock of its own day.
  const ordered = vouchers.map((v, i) => ({ v, i })).sort((a, b) => (a.v.date ?? '').localeCompare(b.v.date ?? '') || a.i - b.i).map((x) => x.v);
  db.transaction(() => {
    for (const v of ordered) {
      if (v.deleted) continue;
      if (!v.date) { skip(v, 'it has no date.'); continue; }
      if (v.date < booksFrom) { skip(v, `it is dated before the books start (${booksFrom}).`); continue; }
      const type = stockwellType(v.typeName, v.baseType, parents);
      if (type === 'skip') { leftOut.set(v.typeName, (leftOut.get(v.typeName) ?? 0) + 1); continue; }
      if (!type) { skip(v, `Stockwell has no voucher type like "${v.typeName}".`); continue; }
      const vt = VOUCHER_TYPES[type];
      let replaces: number | null = null;
      if (v.guid) {
        const k = known.get(v.guid) as { id: number; tally_alter: number | null } | undefined;
        // Altered in Tally since it came in (Tally raises the voucher's ALTERID on every change): bring the new version in.
        if (k && !(v.alterId && k.tally_alter && v.alterId > k.tally_alter)) { result.already++; continue; }
        if (k) replaces = k.id;
      }

      // Ledger lines, with every ledger already in Stockwell (the masters come in first).
      const lines: { id: number; name: string; amount: number; l: NonNullable<ReturnType<typeof ledger>>; bills: TallyLedgerEntry['bills'] }[] = [];
      let missing = '';
      for (const e of v.entries) {
        const l = ledger(e.ledger);
        if (!l) { missing = e.ledger; break; }
        lines.push({ id: l.id, name: e.ledger, amount: e.amount, l, bills: e.bills });
      }
      if (missing) { skip(v, `the ledger "${missing}" is not in Stockwell.`); continue; }
      const sum = lines.reduce((a, x) => a + x.amount, 0);
      if (sum !== 0 && !v.cancelled && vt.books && !vt.memo) { skip(v, `its debit and credit differ by ₹${(Math.abs(sum) / 100).toFixed(2)}.`); continue; }

      const stockLines: { id: number; gst: number; batched: number; hsn: string; unit: string; s: TallyStockLine }[] = [];
      for (const s of v.stock) {
        const it = item(s.item);
        if (!it) { missing = s.item; break; }
        stockLines.push({ id: it.id, gst: it.gst_rate, batched: it.track_batch, hsn: it.hsn, unit: it.unit, s: { ...s } });
      }
      if (missing) { skip(v, `the stock item "${missing}" is not in Stockwell.`); continue; }

      // Party, and the cash/bank or sales/purchase ledger, as Stockwell keeps them.
      const partyLine = (v.party && lines.find((x) => x.name.toLowerCase() === v.party.toLowerCase()))
        || lines.find((x) => under(x.l, 'Sundry Debtors') || under(x.l, 'Sundry Creditors'));
      const cashBank = lines.find((x) => under(x.l, 'Cash-in-Hand') || under(x.l, 'Bank Accounts') || under(x.l, 'Bank OD A/c'));
      const salesPurchaseLines = lines.filter((x) => under(x.l, 'Sales Accounts') || under(x.l, 'Purchase Accounts'));
      const salesPurchase = salesPurchaseLines[0];
      let partyId: number | null = partyLine?.id ?? (v.party ? ledger(v.party)?.id ?? null : null);
      let accountId: number | null = null;
      if (type === 'receipt' || type === 'payment' || type === 'contra') {
        accountId = cashBank?.id ?? null;
        if (!partyId) partyId = lines.find((x) => x.id !== accountId)?.id ?? null;
      } else if (vt.inventory) accountId = salesPurchase?.id ?? null;

      const tax = { cgst: 0, sgst: 0, igst: 0 };
      let roundOff = 0;
      for (const x of lines) {
        const h = taxHead(x.name, x.l);
        if (h) tax[h] += Math.abs(x.amount);
        else if (/^round(ed|ing)?[\s-]*off\b|^rounding\b|\bround\s*off$/i.test(x.name)) roundOff += vt.move === -1 || type === 'sales' ? -x.amount : x.amount;
      }
      const taxable = stockLines.length ? stockLines.reduce((a, x) => a + x.s.amount, 0) : Math.abs(salesPurchaseLines.reduce((a, x) => a + x.amount, 0));
      // A rate per Box on a line counted in Pcs (alternate units): keep the rate per Pcs, so quantity × rate is the amount.
      for (const x of stockLines) {
        if (x.s.rateUnit && x.s.rateUnit.toLowerCase() !== x.unit.toLowerCase() && x.s.qty) x.s.rate = Math.round(x.s.amount / x.s.qty);
      }
      const total = partyLine ? Math.abs(partyLine.amount) : lines.filter((x) => x.amount > 0).reduce((a, x) => a + x.amount, 0) || taxable;

      if (replaces !== null) { dropVoucher(books, replaces); result.updated!++; }
      let number = (v.number || '').slice(0, 40);
      if (!number) number = `T-${v.guid.slice(-8) || result.vouchers + 1}`;
      if (numberTaken.get(type, number)) {
        const alt = `${number} (${v.typeName})`.slice(0, 60);
        number = numberTaken.get(type, alt) ? `${number}/${v.guid.slice(-6) || Date.now()}` : alt;
      }
      const seq = Number((/(\d+)\D*$/.exec(number) ?? ['', '0'])[1]) || 0;
      const pos = stateCode(v.placeOfSupply);
      const memo = !!vt.memo;

      const id = Number(insV.run({
        type, number, seq: Math.min(seq, 1e9), date: v.date, narration: v.narration.slice(0, 1000),
        party_id: partyId, account_id: accountId, place_of_supply: pos, intra: tax.igst ? 0 : 1,
        taxable, cgst: tax.cgst, sgst: tax.sgst, igst: tax.igst, round_off: roundOff, total,
        ref_no: v.reference.slice(0, 40), ref_date: v.referenceDate, party_gstin: v.partyGstin.slice(0, 15), party_state: pos ?? '',
        mode: vt.inventory && !stockLines.length ? 'accounting' : 'item', optional: v.optional || memo ? 1 : 0, cancelled: v.cancelled ? 1 : 0,
        tally_id: v.guid || null, tally_alter: v.alterId || null,
      }).lastInsertRowid);

      if (vt.books || memo) for (const x of lines) if (x.amount) insE.run(id, x.id, x.amount);

      // GST of the bill spread over its item lines by value, so tax reports by item and HSN still add up.
      const totalTaxable = stockLines.reduce((a, x) => a + x.s.amount, 0);
      const spread = (head: 'cgst' | 'sgst' | 'igst') => {
        const parts = stockLines.map((x) => (totalTaxable ? Math.floor((tax[head] * x.s.amount) / totalTaxable) : 0));
        if (parts.length) parts[parts.length - 1] += tax[head] - parts.reduce((a, p) => a + p, 0);
        return parts;
      };
      const [c, s2, ig] = [spread('cgst'), spread('sgst'), spread('igst')];
      stockLines.forEach((x, i) => {
        if (type === 'physical_stock') {
          // Tally keeps the counted quantity; Stockwell keeps the difference from what the books said that day.
          const gid = godown(x.s.godown) ?? 1;
          const bid = x.batched ? batch(x.id, x.s.batch, x.s.expiry) : null;
          const booked = bid ? books.batches(x.id, v.date!, id, gid).find((b) => b.id === bid)?.qty ?? 0 : books.stockOf(x.id, v.date!, id, gid);
          const diff = Math.round((x.s.qty + x.s.free - booked) * 1000) / 1000;
          if (diff) insI.run({ voucher_id: id, line_no: i + 1, item_id: x.id, batch_id: bid, qty: Math.abs(diff), free_qty: 0, rate: x.s.rate, discount_pct: 0, gst_rate: 0, taxable: Math.round(Math.abs(diff) * x.s.rate), cgst: 0, sgst: 0, igst: 0, direction: diff > 0 ? 1 : -1, godown_id: gid === 1 ? null : gid, hsn: null });
          return;
        }
        // An invoice made against a delivery or receipt note does not move the stock again.
        const moves = !(x.s.tracked && (type === 'sales' || type === 'purchase' || type === 'credit_note' || type === 'debit_note'));
        const dir = vt.books || vt.stock || vt.move ? (x.s.inward ? 1 : -1) : 0;
        insI.run({
          voucher_id: id, line_no: i + 1, item_id: x.id, batch_id: x.batched ? batch(x.id, x.s.batch, x.s.expiry) : null,
          qty: x.s.qty, free_qty: x.s.free, rate: x.s.rate, discount_pct: x.s.discount, gst_rate: x.gst, taxable: x.s.amount,
          cgst: c[i], sgst: s2[i], igst: ig[i], direction: moves && type !== 'sales_order' && type !== 'purchase_order' ? dir : 0,
          godown_id: godown(x.s.godown), hsn: x.hsn || null,
        });
      });

      if (vt.books && !memo && !v.optional && !v.cancelled) {
        for (const x of lines) {
          if (!x.l.billWise) continue;
          for (const b of x.bills) {
            const days = b.creditDays || x.l.credit_days;
            insB.run(id, x.id, (b.ref || number).slice(0, 60), b.kind, b.amount, v.date, b.kind === 'new' ? addDays(v.date, days) : v.date);
          }
        }
      }

      if (replaces === null) result.vouchers++;
      result.byType[vt.label] = (result.byType[vt.label] ?? 0) + 1;
      if (!result.from || v.date < result.from) result.from = v.date;
      if (!result.to || v.date > result.to) result.to = v.date;
    }
    for (const [t, n] of leftOut) result.skipped.push(`${n} ${t} voucher${n > 1 ? 's were' : ' was'} left out: Stockwell does not keep ${t.toLowerCase()} records.`);
    if (result.vouchers || result.updated) books.audit('import', null, 'tally-vouchers', { vouchers: result.vouchers, from: result.from, to: result.to, skipped: result.skipped.length });
  })();
  return result;
}

