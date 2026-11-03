import { AsyncLocalStorage } from 'node:async_hooks';
import type { DB } from './db';
import { computeBill, isIntraState, isValidGstin, schemeFreeQty, stateFromGstin } from '../core/gst';
import { addDays, daysBetween, financialYear, todayISO } from '../core/dates';
import type { Nature } from '../core/groups';

/** Who is making the current request, so the edit log can name them. */
export const currentUser = new AsyncLocalStorage<{ id: number; name: string; role: 'owner' | 'operator' } | null>();

export class BooksError extends Error {
  status = 400;
  /** 'credit': the party is over its credit limit or has overdue bills; an owner may save anyway. */
  code?: string;
}
const fail = (msg: string): never => {
  throw new BooksError(msg);
};
/** A date as YYYY-MM-DD that really exists, or null when empty; anything else is refused. */
const isoDate = (v: unknown, what: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  const t = String(v);
  const d = new Date(`${t}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) fail(`${what} is not a valid date.`);
  return t;
};

export type VoucherType =
  | 'sales' | 'purchase' | 'credit_note' | 'debit_note'
  | 'receipt' | 'payment' | 'contra' | 'journal'
  | 'sales_order' | 'purchase_order' | 'rejection_in' | 'rejection_out' | 'stock_journal' | 'physical_stock'
  | 'delivery_note' | 'receipt_note' | 'memorandum' | 'reversing_journal';

/** TallyPrime's voucher types and their keys (help.tallysolutions.com/keyboard-shortcuts-tally-prime).
 *  inventory: party + item lines. stock: item lines only. books: posts to ledgers. move: stock direction. */
export const VOUCHER_TYPES: Record<VoucherType, { label: string; prefix: string; inventory: boolean; stock?: boolean; books: boolean; move: -1 | 0 | 1; memo?: boolean }> = {
  sales: { label: 'Sales', prefix: 'S', inventory: true, books: true, move: -1 },
  purchase: { label: 'Purchase', prefix: 'P', inventory: true, books: true, move: 1 },
  credit_note: { label: 'Credit Note', prefix: 'CN', inventory: true, books: true, move: 1 },
  debit_note: { label: 'Debit Note', prefix: 'DN', inventory: true, books: true, move: -1 },
  receipt: { label: 'Receipt', prefix: 'R', inventory: false, books: true, move: 0 },
  payment: { label: 'Payment', prefix: 'PY', inventory: false, books: true, move: 0 },
  contra: { label: 'Contra', prefix: 'C', inventory: false, books: true, move: 0 },
  journal: { label: 'Journal', prefix: 'J', inventory: false, books: true, move: 0 },
  // Orders: a record of what was ordered; no stock or ledger effect until the bill is made.
  sales_order: { label: 'Sales Order', prefix: 'SO', inventory: true, books: false, move: 0 },
  purchase_order: { label: 'Purchase Order', prefix: 'PO', inventory: true, books: false, move: 0 },
  // Rejections: goods coming back or going back with no money effect yet (a credit or debit note settles it later).
  rejection_in: { label: 'Rejection In', prefix: 'RI', inventory: true, books: false, move: 1 },
  rejection_out: { label: 'Rejection Out', prefix: 'RO', inventory: true, books: false, move: -1 },
  // Stock only: moving, writing off (damage, expiry) or counting stock.
  stock_journal: { label: 'Stock Journal', prefix: 'SJ', inventory: false, stock: true, books: false, move: 0 },
  physical_stock: { label: 'Physical Stock', prefix: 'PS', inventory: false, stock: true, books: false, move: 0 },
  // Goods sent or received before the bill: stock moves now, the Sales/Purchase made against it later posts the money.
  delivery_note: { label: 'Delivery Note', prefix: 'DL', inventory: true, books: false, move: -1 },
  receipt_note: { label: 'Receipt Note', prefix: 'GRN', inventory: true, books: false, move: 1 },
  // Never in the books: a note for later (Memorandum) or an adjustment for "what if" reports (Reversing Journal).
  memorandum: { label: 'Memorandum', prefix: 'M', inventory: false, books: false, move: 0, memo: true },
  reversing_journal: { label: 'Reversing Journal', prefix: 'RJ', inventory: false, books: false, move: 0, memo: true },
};

/** Which earlier voucher a voucher can be made against (Tally's order and note tracking). */
const FOLLOWS: Partial<Record<VoucherType, VoucherType[]>> = {
  sales: ['sales_order', 'delivery_note'], purchase: ['purchase_order', 'receipt_note'],
  delivery_note: ['sales_order'], receipt_note: ['purchase_order'],
  credit_note: ['rejection_in'], debit_note: ['rejection_out'],
};
/** Ledger-style vouchers with Dr and Cr lines. */
const JOURNAL_LIKE = ['journal', 'memorandum', 'reversing_journal'];

export interface Company {
  name: string; address: string; city: string; pincode: string; state_code: string; gstin: string;
  phone: string; email: string; upi_id: string; bank_details: string; books_from: string;
  ewb_threshold: number; udyam_no: string; msme_interest_rate: number; expiry_alert_days: number;
  invoice_terms: string; backup_dir: string; allow_negative_stock: number; last_backup: string;
  gst_filing: string; price_levels: string;
}

export interface Group { id: number; name: string; parent_id: number | null; nature: Nature; direct: number; builtin: number }

export interface Ledger {
  id: number; name: string; group_id: number; opening: number; gstin: string; state_code: string;
  address: string; city: string; pincode: string; phone: string; credit_days: number; beat: string; salesman: string;
  msme_supplier: number; msme_buyer: number; udyam_no: string; tax_kind: string | null; builtin: number;
  credit_limit: number; block_overdue: number; price_level: string; assessable: number; tds_section: string; tds_rate: number;
}

export interface Item {
  id: number; name: string; stock_group_id: number | null; unit_id: number; hsn: string; gst_rate: number;
  mrp: number; sale_rate: number; purchase_rate: number; track_batch: number; reorder_level: number;
  scheme_buy: number; scheme_free: number; opening_qty: number; opening_value: number;
  taxability: 'taxable' | 'nil' | 'exempt' | 'nongst';
  alt_unit_id: number | null; alt_conv: number;
}

/** A number from the request, or a clear error (text, NaN and Infinity are refused). */
const num = (v: unknown, what: string): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(`The ${what} must be a number.`);
  return n as number;
};

const HSN_RE = /^\d{4}(\d{2}){0,2}$/;
const TAXABILITY = ['taxable', 'nil', 'exempt', 'nongst'];

export interface InventoryLineInput {
  itemId: number;
  batchId?: number | null;
  /** For purchases: create the batch if it does not exist yet. */
  batchNo?: string;
  mfgDate?: string | null;
  expiryDate?: string | null;
  qty: number;
  freeQty?: number;
  rate: number; // paise
  discountPct?: number;
  gstRate?: number;
  /** 'alt': qty and rate are in the item's alternate unit (e.g. Case), converted to the base unit. */
  unit?: 'alt' | 'base';
  godownId?: number | null;
  /** MRP printed on the pack, kept on the batch (purchases). */
  mrp?: number;
}

export interface TaxLineInput { ledgerId: number; amount: number; gstRate?: number; hsn?: string; taxability?: string }
export interface ChargeLineInput { ledgerId: number; amount: number }

export interface BillAllocation { ref: string; amount: number; kind?: 'agst' | 'onacc' | 'new' }

export interface VoucherInput {
  type: VoucherType;
  date: string;
  number?: string;
  /** Set by the screen once per voucher; a repeated save with the same key returns the first voucher. */
  clientKey?: string;
  narration?: string;
  // item invoices
  partyId?: number;
  accountId?: number; // sales/purchase ledger for invoices; cash/bank ledger for receipt/payment/contra
  lines?: InventoryLineInput[];
  refNo?: string;
  refDate?: string | null;
  vehicleNo?: string;
  distanceKm?: number;
  transporterName?: string;
  transporterId?: string;
  ewbNo?: string;
  /** Credit/debit note: which bill it reduces. */
  againstRef?: string;
  /** item (default) or accounting: Tally's "as voucher" mode (Ctrl+H), with ledger lines instead of items. */
  mode?: 'item' | 'accounting';
  taxLines?: TaxLineInput[];
  /** Extra ledgers on a bill: freight, packing, discount (negative), TCS. */
  charges?: ChargeLineInput[];
  /** Rounding as on the supplier's bill (paise), instead of rounding to the rupee. */
  roundOff?: number | null;
  /** The order, delivery/receipt note or rejection this voucher follows. */
  againstId?: number | null;
  /** Ctrl+L: saved but kept out of the books until made regular. */
  optional?: boolean;
  /** Ctrl+T: a post-dated cheque. */
  pdc?: boolean;
  chequeNo?: string;
  chequeDate?: string | null;
  bankName?: string;
  /** Save even though the party is over its credit limit (owners only). */
  overrideCredit?: boolean;
  // accounting vouchers
  /** Receipt/payment/contra: the other side; journal: all lines (+Dr, -Cr). */
  entries?: { ledgerId: number; amount: number; bills?: BillAllocation[] }[];
}

const DEBTOR_GROUPS = ['Sundry Debtors', 'Sundry Creditors'];
const LEDGER_COLS = ['name', 'group_id', 'opening', 'gstin', 'state_code', 'address', 'city', 'pincode', 'phone',
  'credit_days', 'beat', 'salesman', 'msme_supplier', 'msme_buyer', 'udyam_no',
  'credit_limit', 'block_overdue', 'price_level', 'assessable', 'tds_section', 'tds_rate', 'tax_kind'] as const;
const NUMERIC_LEDGER_COLS: string[] = ['opening', 'credit_days', 'msme_supplier', 'msme_buyer', 'credit_limit', 'block_overdue', 'assessable', 'tds_rate'];
const ITEM_COLS = ['name', 'stock_group_id', 'unit_id', 'hsn', 'gst_rate', 'mrp', 'sale_rate', 'purchase_rate', 'track_batch',
  'reorder_level', 'scheme_buy', 'scheme_free', 'opening_qty', 'opening_value', 'taxability', 'alt_unit_id', 'alt_conv'] as const;

export class Books {
  constructor(public db: DB) {}

  // ---------- company ----------
  company(): Company {
    return this.db.prepare(`SELECT * FROM company WHERE id=1`).get() as Company;
  }

  updateCompany(patch: Partial<Company>) {
    const allowed = Object.keys(this.company()).filter((k) => k !== 'id');
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (patch.gstin && !isValidGstin(patch.gstin)) fail('The company GSTIN is not valid. Check the 15 characters.');
    if (patch.gstin) patch.state_code = stateFromGstin(patch.gstin) ?? patch.state_code;
    if (!keys.length) return this.company();
    const before = this.company();
    if (patch.books_from !== undefined && patch.books_from !== before.books_from) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(patch.books_from))) fail('Enter the books start date as YYYY-MM-DD.');
      const earlier = this.db.prepare(`SELECT number, date FROM vouchers WHERE date<? LIMIT 1`).get(patch.books_from) as { number: string; date: string } | undefined;
      if (earlier) fail(`Voucher ${earlier.number} is dated ${earlier.date}, before ${patch.books_from}. The books start date cannot move past existing vouchers.`);
    }
    for (const k of ['ewb_threshold', 'expiry_alert_days'] as const) {
      if (patch[k] !== undefined && !(Number(patch[k]) >= 0)) fail('Amounts and days in settings cannot be negative.');
    }
    if (patch.gst_filing !== undefined && !['monthly', 'quarterly'].includes(String(patch.gst_filing))) fail('GST filing must be monthly or quarterly.');
    if (patch.price_levels !== undefined) patch.price_levels = String(patch.price_levels ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10).join(', ');
    if (patch.allow_negative_stock !== undefined) patch.allow_negative_stock = patch.allow_negative_stock ? 1 : 0;
    if (patch.msme_interest_rate !== undefined && !(Number(patch.msme_interest_rate) >= 0 && Number(patch.msme_interest_rate) <= 100)) fail('Enter the MSME interest rate as a yearly percentage, e.g. 16.5.');
    this.db.prepare(`UPDATE company SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=1`).run(patch);
    if (patch.books_from !== undefined && patch.books_from !== before.books_from) {
      for (const { id } of this.db.prepare(`SELECT id FROM ledgers WHERE opening<>0`).all() as { id: number }[]) this.syncOpeningBill(id);
    }
    this.audit('company', 1, 'update', patch);
    return this.company();
  }

  // ---------- groups & ledgers ----------
  groups(): Group[] {
    return this.db.prepare(`SELECT * FROM groups ORDER BY name`).all() as Group[];
  }

  createGroup(g: { name: string; parentId: number }) {
    const parent = this.group(g.parentId);
    const name = g.name?.trim() || fail('Group name is required.');
    const r = this.db.prepare(`INSERT INTO groups (name, parent_id, nature, direct) VALUES (?, ?, ?, ?)`)
      .run(name, parent.id, parent.nature, parent.direct);
    return this.group(Number(r.lastInsertRowid));
  }

  group(id: number): Group {
    return (this.db.prepare(`SELECT * FROM groups WHERE id=?`).get(id) as Group) ?? fail(`Group ${id} not found.`);
  }

  groupByName(name: string): Group {
    return (this.db.prepare(`SELECT * FROM groups WHERE name=?`).get(name) as Group) ?? fail(`Group "${name}" not found.`);
  }

  /** Names of the group and all its ancestors, nearest first. */
  groupPath(groupId: number): string[] {
    const path: string[] = [];
    let g: Group | undefined = this.group(groupId);
    while (g) {
      path.push(g.name);
      g = g.parent_id ? this.group(g.parent_id) : undefined;
    }
    return path;
  }

  isBillWise(ledgerId: number): boolean {
    const l = this.ledger(ledgerId);
    return this.groupPath(l.group_id).some((n) => DEBTOR_GROUPS.includes(n));
  }

  ledgers(): (Ledger & { group_name: string })[] {
    return this.db.prepare(`SELECT l.*, g.name AS group_name FROM ledgers l JOIN groups g ON g.id=l.group_id ORDER BY l.name`).all() as (Ledger & { group_name: string })[];
  }

  ledger(id: number): Ledger {
    return (this.db.prepare(`SELECT * FROM ledgers WHERE id=?`).get(id) as Ledger) ?? fail(`Ledger ${id} not found.`);
  }

  ledgerByName(name: string): Ledger | undefined {
    return this.db.prepare(`SELECT * FROM ledgers WHERE name=?`).get(name) as Ledger | undefined;
  }

  taxLedger(kind: 'cgst' | 'sgst' | 'igst' | 'roundoff'): Ledger {
    return (this.db.prepare(`SELECT * FROM ledgers WHERE tax_kind=? ORDER BY id LIMIT 1`).get(kind) as Ledger)
      ?? fail(`No ledger is set up for ${kind.toUpperCase()}.`);
  }

  private cleanLedger(input: Partial<Ledger>): Partial<Ledger> {
    const l: Partial<Ledger> = { ...input };
    if (l.name !== undefined) l.name = l.name.trim() || fail('Ledger name is required.');
    if (l.gstin) {
      l.gstin = l.gstin.trim().toUpperCase();
      if (!isValidGstin(l.gstin)) fail(`GSTIN ${l.gstin} is not valid. Check the 15 characters.`);
      l.state_code = stateFromGstin(l.gstin) ?? l.state_code;
    }
    if (l.phone) l.phone = l.phone.replace(/[^\d+]/g, '');
    if (l.opening !== undefined) {
      if (!Number.isFinite(Number(l.opening))) fail('Opening balance must be a number.');
      l.opening = Math.round(Number(l.opening));
    }
    if (l.credit_days !== undefined && !(Number(l.credit_days) >= 0 && Number(l.credit_days) <= 3650)) fail('Credit days must be between 0 and 3650.');
    if (l.credit_limit !== undefined) {
      if (!(Number(l.credit_limit) >= 0 && Number(l.credit_limit) < 1e13)) fail('The credit limit must be zero or more.');
      l.credit_limit = Math.round(Number(l.credit_limit));
    }
    if (l.tds_rate !== undefined && !(Number(l.tds_rate) >= 0 && Number(l.tds_rate) <= 100)) fail('The TDS rate must be between 0 and 100%.');
    for (const k of ['block_overdue', 'assessable'] as const) if (l[k] !== undefined) l[k] = l[k] ? 1 : 0;
    if (l.price_level !== undefined) l.price_level = String(l.price_level ?? '').trim().slice(0, 40);
    if (l.tds_section !== undefined) l.tds_section = String(l.tds_section ?? '').trim().slice(0, 20);
    // Users may mark their own TDS/TCS ledgers; the GST and round-off ledgers are Stockwell's own.
    if (l.tax_kind !== undefined) {
      const k = String(l.tax_kind ?? '');
      if (!['', 'tds', 'tcs'].includes(k)) fail('A ledger can be marked only as TDS or TCS.');
      l.tax_kind = k || null;
    }
    return l;
  }

  /** Income and expense ledgers start every year at zero (as in Tally), so they cannot carry an opening balance. */
  private checkOpening(groupId: number, opening: number | undefined) {
    if (!opening) return;
    const nature = this.group(groupId).nature;
    if (nature === 'income' || nature === 'expense') fail('Income and expense ledgers cannot have an opening balance. Put last year\'s figures into Capital or the Profit & Loss A/c instead.');
  }

  createLedger(input: Partial<Ledger> & { name: string; group_id: number }) {
    const l = this.cleanLedger(input);
    this.group(l.group_id!);
    if (this.ledgerByName(l.name!)) fail(`A ledger named "${l.name}" already exists.`);
    this.checkOpening(l.group_id!, l.opening);
    const cols = LEDGER_COLS;
    const row: Record<string, unknown> = {};
    for (const c of cols) row[c] = (l as Record<string, unknown>)[c] ?? (c === 'tax_kind' ? null : NUMERIC_LEDGER_COLS.includes(c) ? 0 : '');
    row.msme_supplier = row.msme_supplier ? 1 : 0;
    row.msme_buyer = row.msme_buyer ? 1 : 0;
    return this.db.transaction(() => {
      const r = this.db.prepare(`INSERT INTO ledgers (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(row);
      const id = Number(r.lastInsertRowid);
      this.syncOpeningBill(id);
      this.audit('ledger', id, 'create', row);
      return this.ledger(id);
    })();
  }

  updateLedger(id: number, patch: Partial<Ledger>) {
    const before = this.ledger(id);
    if (['cgst', 'sgst', 'igst', 'roundoff'].includes(before.tax_kind ?? '')) { patch = { ...patch }; delete patch.tax_kind; }
    const l = this.cleanLedger(patch);
    if (l.name && l.name.toLowerCase() !== before.name.toLowerCase() && this.ledgerByName(l.name)) fail(`A ledger named "${l.name}" already exists.`);
    const keys = Object.keys(l).filter((k) => (LEDGER_COLS as readonly string[]).includes(k) && !(k === 'tax_kind' && ['cgst', 'sgst', 'igst', 'roundoff'].includes(before.tax_kind ?? '')));
    this.checkOpening(l.group_id ?? before.group_id, l.opening ?? before.opening);
    if (l.group_id && l.group_id !== before.group_id) this.group(l.group_id);
    return this.db.transaction(() => {
      if (keys.length) {
        const row: Record<string, unknown> = { id };
        for (const k of keys) row[k] = (l as Record<string, unknown>)[k];
        if ('msme_supplier' in row) row.msme_supplier = row.msme_supplier ? 1 : 0;
        if ('msme_buyer' in row) row.msme_buyer = row.msme_buyer ? 1 : 0;
        this.db.prepare(`UPDATE ledgers SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@id`).run(row);
      }
      this.syncOpeningBill(id);
      this.audit('ledger', id, 'update', { before, patch });
      return this.ledger(id);
    })();
  }

  deleteLedger(id: number) {
    const l = this.ledger(id);
    if (l.builtin) fail(`"${l.name}" is needed by Stockwell and cannot be deleted.`);
    const used = this.db.prepare(`SELECT COUNT(*) n FROM entries WHERE ledger_id=?`).get(id) as { n: number };
    if (used.n) fail(`"${l.name}" has entries and cannot be deleted.`);
    if (l.opening) fail(`"${l.name}" has an opening balance. Set it to zero first, so the opening totals stay right.`);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM bills WHERE ledger_id=? AND voucher_id IS NULL`).run(id);
      this.db.prepare(`DELETE FROM ledgers WHERE id=?`).run(id);
      this.audit('ledger', id, 'delete', l);
    })();
  }

  /** Opening balance of a party shows in outstandings: as the pending bills brought from Tally, and whatever
   *  part of the balance they do not cover as one bill named "Opening". */
  private syncOpeningBill(ledgerId: number) {
    this.db.prepare(`DELETE FROM bills WHERE ledger_id=? AND voucher_id IS NULL AND ref='Opening'`).run(ledgerId);
    const l = this.ledger(ledgerId);
    if (!this.isBillWise(ledgerId)) return;
    const listed = (this.db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM bills WHERE ledger_id=? AND voucher_id IS NULL`).get(ledgerId) as { s: number }).s;
    const rest = l.opening - listed;
    if (rest) {
      const from = this.company().books_from;
      this.db.prepare(`INSERT INTO bills (voucher_id, ledger_id, ref, kind, amount, date, due_date) VALUES (NULL, ?, 'Opening', 'new', ?, ?, ?)`)
        .run(ledgerId, rest, addDays(from, -1), addDays(from, -1));
    }
  }

  /** Pending bills carried in from the old books (Tally's bill-wise opening). */
  setOpeningBills(ledgerId: number, bills: { ref: string; date: string | null; amount: number; creditDays?: number }[]) {
    const from = this.company().books_from;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM bills WHERE ledger_id=? AND voucher_id IS NULL`).run(ledgerId);
      for (const b of bills) {
        const date = b.date && b.date < from ? b.date : addDays(from, -1);
        this.db.prepare(`INSERT INTO bills (voucher_id, ledger_id, ref, kind, amount, date, due_date) VALUES (NULL, ?, ?, 'new', ?, ?, ?)`)
          .run(ledgerId, String(b.ref).slice(0, 40), Math.round(b.amount), date, addDays(date, b.creditDays || 0));
      }
      this.syncOpeningBill(ledgerId);
      this.audit('ledger', ledgerId, 'opening-bills', bills);
    })();
  }

  // ---------- inventory masters ----------
  units() {
    return this.db.prepare(`SELECT * FROM units ORDER BY symbol`).all();
  }

  createUnit(u: { symbol: string; name?: string; uqc?: string }) {
    const symbol = u.symbol?.trim() || fail('Unit symbol is required.');
    const r = this.db.prepare(`INSERT INTO units (symbol, name, uqc) VALUES (?, ?, ?)`).run(symbol, u.name || symbol, (u.uqc || 'OTH').toUpperCase());
    return this.db.prepare(`SELECT * FROM units WHERE id=?`).get(r.lastInsertRowid);
  }

  stockGroups() {
    return this.db.prepare(`SELECT * FROM stock_groups ORDER BY name`).all();
  }

  createStockGroup(name: string) {
    const n = name?.trim() || fail('Stock group name is required.');
    const r = this.db.prepare(`INSERT INTO stock_groups (name) VALUES (?)`).run(n);
    return this.db.prepare(`SELECT * FROM stock_groups WHERE id=?`).get(r.lastInsertRowid);
  }

  items() {
    const rows = this.db.prepare(`SELECT i.*, u.symbol AS unit, au.symbol AS alt_unit, sg.name AS stock_group FROM items i JOIN units u ON u.id=i.unit_id
      LEFT JOIN units au ON au.id=i.alt_unit_id LEFT JOIN stock_groups sg ON sg.id=i.stock_group_id ORDER BY i.name`).all() as Record<string, unknown>[];
    const rates = new Map<number, { from_date: string; gst_rate: number }[]>();
    for (const r of this.db.prepare(`SELECT item_id, from_date, gst_rate FROM item_gst_rates ORDER BY from_date`).all() as { item_id: number; from_date: string; gst_rate: number }[]) {
      rates.set(r.item_id, [...(rates.get(r.item_id) ?? []), { from_date: r.from_date, gst_rate: r.gst_rate }]);
    }
    const prices = new Map<number, Record<string, number>>();
    for (const p of this.db.prepare(`SELECT item_id, level, rate FROM price_list`).all() as { item_id: number; level: string; rate: number }[]) {
      prices.set(p.item_id, { ...(prices.get(p.item_id) ?? {}), [p.level]: p.rate });
    }
    return rows.map((r) => ({ ...r, id: r.id as number, rates: rates.get(r.id as number) ?? [], prices: prices.get(r.id as number) ?? {} }));
  }

  // ---------- GST rate changes (applicable from a date) ----------
  /** The GST rate of an item on a date: its latest rate change on or before the date, else the rate on the item. */
  rateOn(item: Item, date: string): number {
    const r = this.db.prepare(`SELECT gst_rate FROM item_gst_rates WHERE item_id=? AND from_date<=? ORDER BY from_date DESC LIMIT 1`).get(item.id, date) as { gst_rate: number } | undefined;
    return r ? r.gst_rate : item.gst_rate;
  }

  /** Sets a new GST rate from a date for one or many items (Tally's GST rate setup, with "applicable from"). */
  changeGstRate(input: { itemIds: number[]; rate: number; from: string }) {
    const ids = Array.isArray(input?.itemIds) ? input.itemIds.map((x) => num(x, 'item')) : [];
    if (!ids.length) fail('Choose at least one item.');
    if (ids.length > 5000) fail('Too many items at once.');
    const rate = num(input.rate, 'GST rate');
    if (rate < 0 || rate > 40) fail('GST rate must be between 0 and 40%.');
    const from = isoDate(input.from, 'The applicable-from date') ?? fail('Enter the date the new rate applies from.');
    return this.db.transaction(() => {
      for (const id of ids) {
        const item = this.item(id);
        this.db.prepare(`INSERT INTO item_gst_rates (item_id, from_date, gst_rate) VALUES (?, ?, ?) ON CONFLICT(item_id, from_date) DO UPDATE SET gst_rate=excluded.gst_rate`).run(id, from, rate);
        if (rate > 0 && item.taxability !== 'taxable') this.db.prepare(`UPDATE items SET taxability='taxable' WHERE id=?`).run(id);
      }
      this.audit('item', null, 'gst-rate', { itemIds: ids, rate, from });
      return { ok: true, count: ids.length };
    })();
  }

  removeGstRate(itemId: number, from: string) {
    this.db.prepare(`DELETE FROM item_gst_rates WHERE item_id=? AND from_date=?`).run(itemId, from);
    this.audit('item', itemId, 'gst-rate-remove', { from });
    return { ok: true };
  }

  // ---------- price levels ----------
  priceLevels(): string[] {
    return this.company().price_levels.split(',').map((x) => x.trim()).filter(Boolean);
  }

  setPrices(itemId: number, prices: Record<string, unknown>) {
    this.item(itemId);
    const levels = this.priceLevels();
    return this.db.transaction(() => {
      for (const [level, v] of Object.entries(prices ?? {})) {
        if (!levels.some((l) => l.toLowerCase() === level.toLowerCase())) fail(`"${level}" is not a price level. Add it in Company settings first.`);
        if (v === null || v === '' || v === undefined || Number(v) === 0) { this.db.prepare(`DELETE FROM price_list WHERE item_id=? AND level=?`).run(itemId, level); continue; }
        const rate = num(v, 'rate');
        if (!(rate >= 0) || rate > 1e11) fail('Enter a valid rate.');
        this.db.prepare(`INSERT INTO price_list (item_id, level, rate) VALUES (?, ?, ?) ON CONFLICT(item_id, level) DO UPDATE SET rate=excluded.rate`).run(itemId, level, Math.round(rate));
      }
      this.audit('item', itemId, 'prices', prices);
      return { ok: true };
    })();
  }

  // ---------- godowns ----------
  godowns() {
    return this.db.prepare(`SELECT * FROM godowns ORDER BY id=1 DESC, name`).all() as { id: number; name: string }[];
  }

  createGodown(name: string) {
    const n = String(name ?? '').trim() || fail('Godown name is required.');
    if (n.length > 60) fail('The godown name is too long.');
    if (this.db.prepare(`SELECT 1 FROM godowns WHERE name=?`).get(n)) fail(`A godown named "${n}" already exists.`);
    const r = this.db.prepare(`INSERT INTO godowns (name) VALUES (?)`).run(n);
    this.audit('godown', Number(r.lastInsertRowid), 'create', { name: n });
    return { id: Number(r.lastInsertRowid), name: n };
  }

  renameGodown(id: number, name: string) {
    const n = String(name ?? '').trim() || fail('Godown name is required.');
    if (!this.db.prepare(`SELECT 1 FROM godowns WHERE id=?`).get(id)) fail('Godown not found.');
    if (this.db.prepare(`SELECT 1 FROM godowns WHERE name=? AND id<>?`).get(n, id)) fail(`A godown named "${n}" already exists.`);
    this.db.prepare(`UPDATE godowns SET name=? WHERE id=?`).run(n, id);
    return { id, name: n };
  }

  private godownId(v: unknown): number {
    if (v === undefined || v === null || v === '') return 1;
    const id = num(v, 'godown');
    if (!this.db.prepare(`SELECT 1 FROM godowns WHERE id=?`).get(id)) fail('That godown does not exist.');
    return id;
  }

  item(id: number): Item {
    return (this.db.prepare(`SELECT * FROM items WHERE id=?`).get(id) as Item) ?? fail(`Item ${id} not found.`);
  }

  createItem(input: Partial<Item> & { name: string; unit_id: number; opening_batch_no?: string; opening_expiry?: string | null }) {
    return this.db.transaction(() => {
      const item = this.createItemRow(input);
      if (item.track_batch && item.opening_qty) {
        this.db.prepare(`INSERT INTO batches (item_id, batch_no, expiry_date, opening_qty) VALUES (?, ?, ?, ?)`)
          .run(item.id, input.opening_batch_no?.trim() || 'Opening', isoDate(input.opening_expiry, 'The opening batch expiry'), item.opening_qty);
      }
      return item;
    })();
  }

  private checkItem(i: Partial<Item>) {
    if (i.hsn !== undefined && i.hsn !== null && String(i.hsn).trim() !== '') {
      i.hsn = String(i.hsn).replace(/\s/g, '');
      if (!HSN_RE.test(i.hsn)) fail('HSN code must be 4, 6 or 8 digits.');
    }
    if (i.gst_rate !== undefined && !(Number(i.gst_rate) >= 0 && Number(i.gst_rate) <= 40)) fail('GST rate must be between 0 and 40%.');
    if (i.taxability !== undefined && !TAXABILITY.includes(i.taxability)) fail('Taxability must be taxable, nil, exempt or non-GST.');
    for (const k of ['opening_qty', 'reorder_level', 'scheme_buy', 'scheme_free', 'mrp', 'sale_rate', 'purchase_rate', 'opening_value'] as const) {
      if (i[k] !== undefined && i[k] !== null && !(Number(i[k]) >= 0)) fail('Quantities and rates on an item cannot be negative.');
    }
    if (i.unit_id !== undefined && !this.db.prepare(`SELECT 1 FROM units WHERE id=?`).get(i.unit_id)) fail('Choose a unit for the item.');
    if (i.alt_unit_id) {
      if (!this.db.prepare(`SELECT 1 FROM units WHERE id=?`).get(i.alt_unit_id)) fail('Choose the alternate unit from the list.');
      if (i.unit_id !== undefined && Number(i.alt_unit_id) === Number(i.unit_id)) fail('The alternate unit must differ from the main unit.');
      if (!(Number(i.alt_conv) > 0 && Number(i.alt_conv) <= 1e6)) fail('Say how many of the main unit make one alternate unit (e.g. 24 Pcs in 1 Case).');
    }
  }

  private createItemRow(input: Partial<Item> & { name: string; unit_id: number }) {
    const name = input.name?.trim() || fail('Item name is required.');
    this.checkItem(input);
    if (this.db.prepare(`SELECT id FROM items WHERE name=?`).get(name)) fail(`An item named "${name}" already exists.`);
    const cols = ITEM_COLS;
    const row: Record<string, unknown> = {};
    for (const c of cols) row[c] = (input as Record<string, unknown>)[c] ?? (c === 'stock_group_id' || c === 'alt_unit_id' ? null : c === 'hsn' ? '' : c === 'taxability' ? (Number(input.gst_rate) > 0 ? 'taxable' : 'nil') : 0);
    if (!row.alt_unit_id) { row.alt_unit_id = null; row.alt_conv = 0; }
    row.name = name;
    row.track_batch = row.track_batch ? 1 : 0;
    const r = this.db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(row);
    const id = Number(r.lastInsertRowid);
    this.audit('item', id, 'create', row);
    return this.item(id);
  }

  updateItem(id: number, patch: Partial<Item>) {
    const before = this.item(id);
    const keys = Object.keys(patch).filter((k) => (ITEM_COLS as readonly string[]).includes(k));
    this.checkItem({ ...patch, unit_id: patch.unit_id ?? before.unit_id, alt_unit_id: 'alt_unit_id' in patch ? patch.alt_unit_id : before.alt_unit_id, alt_conv: patch.alt_conv ?? before.alt_conv });
    if ('alt_unit_id' in patch && !patch.alt_unit_id) { patch.alt_unit_id = null; patch.alt_conv = 0; if (!keys.includes('alt_conv')) keys.push('alt_conv'); }
    if (patch.name !== undefined) {
      patch.name = String(patch.name).trim() || fail('Item name is required.');
      const other = this.db.prepare(`SELECT id FROM items WHERE name=? AND id<>?`).get(patch.name, id);
      if (other) fail(`An item named "${patch.name}" already exists.`);
    }
    if (keys.length) {
      const row: Record<string, unknown> = { ...patch, id };
      if ('track_batch' in row) row.track_batch = row.track_batch ? 1 : 0;
      this.db.prepare(`UPDATE items SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@id`).run(row);
    }
    this.audit('item', id, 'update', { before, patch });
    return this.item(id);
  }

  /** Batches of an item with the quantity left, soonest expiry first (FEFO). */
  batches(itemId: number, asOf = '9999-12-31', excludeVoucher = 0, godownId: number | null = null) {
    // Opening stock sits in the Main Location (godown 1).
    return this.db.prepare(`
      SELECT b.*, (CASE WHEN @g IS NULL OR @g=1 THEN b.opening_qty ELSE 0 END) + COALESCE((
        SELECT SUM(iv.direction * (iv.qty + iv.free_qty)) FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id
        WHERE iv.batch_id=b.id AND v.cancelled=0 AND v.optional=0 AND v.date<=@asOf AND v.id<>@ex AND (@g IS NULL OR COALESCE(iv.godown_id,1)=@g)), 0) AS qty
      FROM batches b WHERE b.item_id=@item ORDER BY COALESCE(b.expiry_date,'9999-12-31'), b.id`).all({ asOf, ex: excludeVoucher, item: itemId, g: godownId }) as
      { id: number; batch_no: string; expiry_date: string | null; mfg_date: string | null; mrp: number; qty: number }[];
  }

  private ensureBatch(itemId: number, l: InventoryLineInput): number | null {
    if (l.batchId) return l.batchId;
    if (!l.batchNo) return null;
    const existing = this.db.prepare(`SELECT id FROM batches WHERE item_id=? AND batch_no=?`).get(itemId, l.batchNo) as { id: number } | undefined;
    if (existing) return existing.id;
    const r = this.db.prepare(`INSERT INTO batches (item_id, batch_no, mfg_date, expiry_date) VALUES (?, ?, ?, ?)`)
      .run(itemId, String(l.batchNo).slice(0, 40), isoDate(l.mfgDate, 'The manufacturing date'), isoDate(l.expiryDate, `The expiry date of batch ${l.batchNo}`));
    return Number(r.lastInsertRowid);
  }

  // ---------- vouchers ----------
  nextNumber(type: VoucherType, date: string): { number: string; seq: number } {
    if (!VOUCHER_TYPES[type] || !Object.prototype.hasOwnProperty.call(VOUCHER_TYPES, type)) fail(`Unknown voucher type ${type}.`);
    const fy = financialYear(date);
    const row = this.db.prepare(`SELECT MAX(seq) m FROM vouchers WHERE type=? AND date BETWEEN ? AND ?`).get(type, fy.start, fy.end) as { m: number | null };
    let seq = (row.m ?? 0) + 1;
    const taken = this.db.prepare(`SELECT 1 FROM vouchers WHERE type=? AND number=?`);
    const make = (n: number) => `${VOUCHER_TYPES[type].prefix}/${fy.label}/${n}`;
    // A number typed by hand may already sit ahead of the series: skip over it instead of getting stuck.
    while (taken.get(type, make(seq))) seq++;
    return { number: make(seq), seq };
  }

  createVoucher(input: VoucherInput) {
    return this.db.transaction(() => {
      const key = typeof input?.clientKey === 'string' ? input.clientKey.slice(0, 64) : '';
      if (key) {
        const done = this.db.prepare(`SELECT id FROM vouchers WHERE client_key=?`).get(key) as { id: number } | undefined;
        if (done) return this.voucher(done.id); // the same save arriving twice
      }
      const v = this.writeVoucher(input, null);
      if (key) this.db.prepare(`UPDATE vouchers SET client_key=? WHERE id=?`).run(key, v.id);
      return this.voucher(v.id);
    })();
  }

  updateVoucher(id: number, input: VoucherInput) {
    return this.db.transaction(() => {
      const before = this.voucher(id);
      if (before.cancelled) fail('A cancelled voucher cannot be changed.');
      return this.writeVoucher({ ...input, type: before.type as VoucherType }, before);
    })();
  }

  /** Bills of other vouchers that settle the bills this voucher raised (receipts against an invoice, etc.). */
  private dependants(v: { id: number; number: string; party_id: number | null }) {
    const own = this.db.prepare(`SELECT ledger_id, ref FROM bills WHERE voucher_id=? AND kind='new'`).all(v.id) as { ledger_id: number; ref: string }[];
    const found: { number: string; ref: string }[] = [];
    for (const b of own) {
      const rows = this.db.prepare(`
        SELECT DISTINCT v2.number FROM bills b JOIN vouchers v2 ON v2.id=b.voucher_id
        WHERE b.ledger_id=? AND b.ref=? AND b.kind='agst' AND b.voucher_id<>? AND v2.cancelled=0 AND v2.optional=0`).all(b.ledger_id, b.ref, v.id) as { number: string }[];
      for (const r of rows) found.push({ number: r.number, ref: b.ref });
    }
    return { own, found };
  }

  cancelVoucher(id: number) {
    return this.db.transaction(() => {
      const v = this.voucher(id);
      if (v.cancelled) fail(`${v.number} is already cancelled.`);
      const dep = this.dependants(v);
      if (dep.found.length) {
        fail(`${v.number} cannot be cancelled: ${[...new Set(dep.found.map((d) => d.number))].join(', ')} ${dep.found.length > 1 ? 'are' : 'is'} set against it. Alter or cancel ${dep.found.length > 1 ? 'those' : 'that'} first.`);
      }
      this.checkLinks(v);
      if (!v.optional) this.checkStockWithout(v);
      this.db.prepare(`UPDATE vouchers SET cancelled=1, updated_at=datetime('now') WHERE id=?`).run(id);
      if (v.bounce_of) this.db.prepare(`UPDATE vouchers SET bounced_by=NULL WHERE id=?`).run(v.bounce_of);
      this.db.prepare(`DELETE FROM bills WHERE voucher_id=?`).run(id);
      this.audit('voucher', id, 'cancel', v);
      return this.voucher(id);
    })();
  }

  /** Deletes a voucher for good (Tally's Alt+D). The edit log keeps a full copy, and GSTR-1 Table 13
   *  still counts the missing number. A cancel (Alt+X) is usually better for sales bills. */
  deleteVoucher(id: number) {
    return this.db.transaction(() => {
      const v = this.voucher(id);
      const dep = this.dependants(v);
      if (dep.found.length) {
        fail(`${v.number} cannot be deleted: ${[...new Set(dep.found.map((d) => d.number))].join(', ')} ${dep.found.length > 1 ? 'are' : 'is'} set against it. Alter or delete ${dep.found.length > 1 ? 'those' : 'that'} first.`);
      }
      this.checkLinks(v);
      if (!v.cancelled && !v.optional) this.checkStockWithout(v);
      if ((v as unknown as { ewb_no?: string }).ewb_no && !v.cancelled) fail(`${v.number} has an e-Way Bill (${(v as unknown as { ewb_no?: string }).ewb_no}). Cancel the e-Way Bill on the portal and then cancel this voucher (Alt+X) instead.`);
      this.audit('voucher', id, 'delete', v);
      for (const t of ['entries', 'inventory', 'bills', 'tax_lines', 'voucher_charges']) this.db.prepare(`DELETE FROM ${t} WHERE voucher_id=?`).run(id);
      this.db.prepare(`DELETE FROM vouchers WHERE id=?`).run(id);
      if (v.bounce_of) this.db.prepare(`UPDATE vouchers SET bounced_by=NULL WHERE id=?`).run(v.bounce_of);
      this.db.prepare(`UPDATE vouchers SET against_id=NULL WHERE against_id=?`).run(id);
      // A batch that only this voucher brought in goes too.
      this.db.prepare(`DELETE FROM batches WHERE opening_qty=0 AND NOT EXISTS (SELECT 1 FROM inventory iv WHERE iv.batch_id=batches.id)`).run();
      return { ok: true, number: v.number };
    })();
  }

  /** A voucher that another one is made against (an order or note that was billed), or a receipt whose cheque bounced, stays. */
  private checkLinks(v: { id: number; number: string; bounced_by?: unknown }) {
    const f = this.db.prepare(`SELECT number FROM vouchers WHERE against_id=? AND cancelled=0`).get(v.id) as { number: string } | undefined;
    if (f) fail(`${f.number} is made against ${v.number}. Cancel or alter ${f.number} first.`);
    if (v.bounced_by) fail(`The cheque in ${v.number} bounced. Delete the bounce entry first.`);
  }

  /**
   * Cheque bounce: a journal that puts the receipt back (Dr party, Cr bank) and reopens the bills it settled.
   * Bank charges for the bounce, if any, are a separate payment.
   */
  bounceCheque(id: number, input: { date?: string; narration?: string } = {}) {
    return this.db.transaction(() => {
      const r = this.voucher(id);
      if (r.type !== 'receipt') fail('Only a receipt can bounce.');
      if (r.cancelled || r.optional) fail(`${r.number} is cancelled or optional.`);
      if (r.bounced_by) fail(`${r.number} is already marked as bounced.`);
      const date = isoDate(input.date, 'The bounce date') ?? r.date;
      if (date < r.date) fail('The bounce date cannot be before the receipt.');
      const entries = (r.entries as { ledger_id: number; amount: number }[]).map((e) => ({ ledger_id: e.ledger_id, amount: -e.amount }));
      const no = this.nextNumber('journal', date);
      const text = String(input.narration ?? '').slice(0, 500) || `Cheque ${r.cheque_no || ''} in ${r.number} bounced`.replace('  ', ' ');
      const row = this.db.prepare(`INSERT INTO vouchers (type, number, seq, date, narration, party_id, account_id, total, bounce_of, cheque_no, bank_name)
        VALUES ('journal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(no.number, no.seq, date, text, r.party_id, r.account_id, r.total, r.id, r.cheque_no ?? '', r.bank_name ?? '');
      const jid = Number(row.lastInsertRowid);
      const insE = this.db.prepare(`INSERT INTO entries (voucher_id, ledger_id, amount) VALUES (?, ?, ?)`);
      for (const e of entries) insE.run(jid, e.ledger_id, e.amount);
      // The bills the receipt settled become pending again.
      for (const b of r.bills as { ledger_id: number; ref: string; kind: string; amount: number }[]) {
        this.db.prepare(`INSERT INTO bills (voucher_id, ledger_id, ref, kind, amount, date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(jid, b.ledger_id, b.ref, b.kind === 'onacc' ? 'onacc' : 'agst', -b.amount, date, date);
      }
      this.db.prepare(`UPDATE vouchers SET bounced_by=? WHERE id=?`).run(jid, r.id);
      this.audit('voucher', jid, 'bounce', { receipt: r.number });
      return this.voucher(jid);
    })();
  }

  /** Bank reconciliation: the date the bank shows the entry (blank = not yet cleared). */
  setBankDate(id: number, date: unknown) {
    const v = this.voucher(id);
    const d = isoDate(date, 'The bank date');
    if (d && d < v.date) fail('The bank date cannot be before the voucher date.');
    this.db.prepare(`UPDATE vouchers SET bank_date=? WHERE id=?`).run(d, id);
    this.audit('voucher', id, 'bank-date', { date: d });
    return { id, bank_date: d };
  }

  /** Taking out a purchase (or other stock coming in) must not leave later bills selling stock that is not there. */
  private checkStockWithout(v: { id: number; number: string }) {
    if (this.company().allow_negative_stock) return;
    const inward = this.db.prepare(`SELECT DISTINCT item_id, batch_id, COALESCE(godown_id,1) AS godown_id FROM inventory WHERE voucher_id=? AND direction=1`).all(v.id) as { item_id: number; batch_id: number | null; godown_id: number }[];
    for (const l of inward) {
      if (this.stockOf(l.item_id, '9999-12-31', v.id) < 0) fail(`Without ${v.number}, the stock of ${this.item(l.item_id).name} would go below zero, because later bills sold it. Alter those bills first.`);
      if (this.stockOf(l.item_id, '9999-12-31', v.id, l.godown_id) < 0) fail(`Without ${v.number}, the stock of ${this.item(l.item_id).name} in its godown would go below zero, because later vouchers took it out.`);
      if (l.batch_id) {
        const b = this.batches(l.item_id, '9999-12-31', v.id).find((x) => x.id === l.batch_id);
        if (b && b.qty < 0) fail(`Without ${v.number}, batch ${b.batch_no} of ${this.item(l.item_id).name} would go below zero, because later bills sold from it.`);
      }
    }
  }

  /** Stock Journal and Physical Stock lines. Stock Journal: each line goes 'in' or 'out' (damage written off,
   *  stock moved or repacked). Physical Stock: each line is the counted quantity, and the difference is posted. */
  private stockLines(type: VoucherType, input: VoucherInput, excludeId: number, out: Record<string, unknown>[], allowNegative: number) {
    const lines = Array.isArray(input.lines) ? input.lines : [];
    if (!lines.length) fail('Add at least one item.');
    if (lines.length > 500) fail('A voucher can have at most 500 item lines.');
    const take = new Map<string, number>();
    let total = 0;
    let gid = 1;
    const push = (item: Item, batchId: number | null, qty: number, rate: number, direction: 1 | -1) => {
      const value = Math.round(qty * rate);
      out.push({ line_no: out.length + 1, item_id: item.id, batch_id: batchId, qty, free_qty: 0, rate, discount_pct: 0, gst_rate: 0, taxable: value, cgst: 0, sgst: 0, igst: 0, direction, godown_id: gid === 1 ? null : gid, alt_qty: null, base_taxable: null });
      if (direction < 0) take.set(`${item.id}|${gid}`, (take.get(`${item.id}|${gid}`) ?? 0) + qty);
      total += value;
    };
    for (const l of lines as (InventoryLineInput & { direction?: string })[]) {
      if (!l || typeof l !== 'object') fail('An item line is empty.');
      const item = this.item(num(l.itemId, 'item'));
      gid = this.godownId(l.godownId);
      const qty = num(l.qty, 'quantity');
      if (qty < 0 || qty > 1e7) fail(`Enter a quantity for ${item.name}.`);
      const rate = l.rate === undefined || l.rate === null ? (item.purchase_rate || (item.opening_qty ? Math.round(item.opening_value / item.opening_qty) : 0)) : num(l.rate, 'rate');
      if (!(rate >= 0) || rate > 1e11) fail(`Enter a rate for ${item.name}.`);
      if (type === 'physical_stock' && l.direction === undefined) {
        // Counted stock: post the difference from what the books say.
        let batchId: number | null = null;
        let booked: number;
        if (item.track_batch && (l.batchId || l.batchNo)) {
          batchId = l.batchId ? this.ownBatch(item.id, l.batchId) : this.ensureBatch(item.id, l);
          booked = this.batches(item.id, input.date, excludeId, gid).find((b) => b.id === batchId)?.qty ?? 0;
        } else {
          if (item.track_batch) fail(`Choose the batch you counted for ${item.name}.`);
          booked = this.stockOf(item.id, input.date, excludeId, gid);
        }
        const diff = Math.round((qty - booked) * 1000) / 1000;
        if (diff) push(item, batchId, Math.abs(diff), rate, diff > 0 ? 1 : -1);
        continue;
      }
      if (!(qty > 0)) fail(`Enter a quantity for ${item.name}.`);
      const dir = l.direction === 'in' ? 1 : l.direction === 'out' ? -1 : fail(`Say whether ${item.name} goes in or out.`);
      if (!item.track_batch) { push(item, null, qty, rate, dir); continue; }
      if (dir > 0) {
        const bid = l.batchId ? this.ownBatch(item.id, l.batchId) : this.ensureBatch(item.id, l);
        if (!bid) fail(`Enter a batch number for ${item.name}.`);
        push(item, bid, qty, rate, 1);
      } else if (l.batchId) {
        push(item, this.ownBatch(item.id, l.batchId), qty, rate, -1);
      } else {
        // Damaged or expired stock may come from expired batches too, so take the soonest-expiring first.
        let left = qty;
        for (const b of this.batches(item.id, input.date, excludeId, gid)) {
          if (left <= 0) break;
          const q = Math.min(left, b.qty);
          if (q > 0) { push(item, b.id, q, rate, -1); left -= q; }
        }
        if (left > 1e-9) {
          if (!allowNegative) fail(`Not enough stock of ${item.name} in its batches.`);
          push(item, null, left, rate, -1);
        }
      }
    }
    if (!out.length) fail('The counted stock matches the books, so there is nothing to post.');
    if (!allowNegative) {
      for (const [key, need] of take) {
        const [itemId, g] = key.split('|').map(Number);
        const have = this.stockOf(itemId, input.date, excludeId, g);
        if (need > have + 1e-9) fail(`Not enough stock of ${this.item(itemId).name}${g !== 1 ? ` in ${this.godownName(g)}` : ''}: ${have} in stock on ${input.date}, this voucher takes out ${need}.`);
      }
    }
    return { total, party_id: null, account_id: null };
  }

  private godownName(id: number) {
    return (this.db.prepare(`SELECT name FROM godowns WHERE id=?`).get(id) as { name: string } | undefined)?.name ?? 'the godown';
  }

  /** Stock of an item on a date, leaving out one voucher (the one being altered). */
  stockOf(itemId: number, date: string, excludeVoucher = 0, godownId: number | null = null): number {
    const item = this.item(itemId);
    const r = this.db.prepare(`
      SELECT COALESCE(SUM(iv.direction * (iv.qty + iv.free_qty)), 0) q FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id
      WHERE iv.item_id=@item AND v.cancelled=0 AND v.optional=0 AND v.date<=@date AND v.id<>@ex AND (@g IS NULL OR COALESCE(iv.godown_id,1)=@g)`)
      .get({ item: itemId, date, ex: excludeVoucher, g: godownId }) as { q: number };
    const opening = godownId === null || godownId === 1 ? item.opening_qty : 0;
    return Math.round((opening + r.q) * 1000) / 1000;
  }

  private writeVoucher(input: VoucherInput, existing: ReturnType<Books['voucher']> | null) {
    if (!input || typeof input !== 'object') fail('The voucher is empty.');
    const type = input.type;
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(VOUCHER_TYPES, type)) fail(`Unknown voucher type ${String(type)}.`);
    if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date))) fail('Enter a valid date.');
    for (const k of ['number', 'narration', 'refNo', 'vehicleNo', 'transporterName', 'transporterId', 'ewbNo', 'againstRef', 'chequeNo', 'bankName'] as const) {
      if (input[k] !== undefined && input[k] !== null && typeof input[k] !== 'string') fail(`${k} must be text.`);
    }
    if ((input.narration ?? '').length > 2000) fail('The narration is too long (2000 characters at most).');
    const company = this.company();
    if (input.date < company.books_from) fail(`The date is before the books begin (${company.books_from}).`);
    const excludeId = existing?.id ?? 0;
    const vt = VOUCHER_TYPES[type];
    // Memorandum and Reversing Journal never touch the books; any other voucher can be saved as Optional (Ctrl+L).
    const memo = !!vt.memo;
    const optional = memo || input.optional === true;
    const wasOptional = !!(existing as { optional?: number } | null)?.optional;

    let numbering: { number: string; seq: number };
    const sameFy = existing && financialYear(existing.date).label === financialYear(input.date).label;
    const typed = input.number?.trim();
    if (optional && !memo) {
      // Optional vouchers take their own series, so the real series (and GSTR-1 Table 13) has no gaps.
      if (existing && wasOptional && sameFy) numbering = { number: typed || existing.number, seq: 0 };
      else {
        const fy = financialYear(input.date).label;
        let n = 1;
        const taken = this.db.prepare(`SELECT 1 FROM vouchers WHERE type=? AND number=?`);
        while (taken.get(type, `OPT/${fy}/${n}`)) n++;
        numbering = { number: `OPT/${fy}/${n}`, seq: 0 };
      }
    } else if (existing && sameFy && !(wasOptional && !memo)) numbering = { number: typed || existing.number, seq: existing.seq };
    else {
      // New voucher, one moved into another financial year, or an optional one made regular: next number of the series.
      numbering = this.nextNumber(type, input.date);
      if (typed && (!existing || typed !== existing.number) && !typed.startsWith('OPT/')) numbering.number = typed;
    }
    if (numbering.number.length > 40) fail('The voucher number is too long.');
    if (type === 'sales' && !optional && numbering.number.length > 16) fail('A GST invoice number can have at most 16 characters.');
    if (type === 'sales' && !/^[A-Za-z0-9/-]+$/.test(numbering.number)) fail('A GST invoice number may use only letters, digits, / and -.');
    const clash = this.db.prepare(`SELECT id FROM vouchers WHERE type=? AND number=? AND id<>?`).get(type, numbering.number, excludeId);
    if (clash) fail(`${vt.label} number ${numbering.number} is already used.`);

    const entries: { ledgerId: number; amount: number }[] = [];
    let bills: { ledgerId: number; ref: string; kind: 'new' | 'agst' | 'onacc'; amount: number; due: string }[] = [];
    const invLines: Record<string, unknown>[] = [];
    const taxRows: Record<string, unknown>[] = [];
    const chargeRows: Record<string, unknown>[] = [];
    let header: Record<string, unknown> = { taxable: 0, cgst: 0, sgst: 0, igst: 0, round_off: 0, total: 0, intra: 1, place_of_supply: null, charges: 0 };
    let snapshot = { gstin: '', state: '' };
    let mode: 'item' | 'accounting' = 'item';
    let againstId: number | null = null;

    /** Checks a settlement against a pending bill of the party and returns it, or fails with a clear message. */
    const pendingFor = (ledgerId: number, ref: string) => {
      const row = this.db.prepare(`SELECT COALESCE(SUM(amount),0) p, SUM(kind='new') n FROM bills WHERE ledger_id=? AND ref=? AND COALESCE(voucher_id,0)<>?`)
        .get(ledgerId, ref, excludeId) as { p: number; n: number };
      return row;
    };

    if (vt.stock) {
      header = { ...header, ...this.stockLines(type, input, excludeId, invLines, company.allow_negative_stock) };
    } else if (vt.inventory) {
      const party = this.ledger(input.partyId == null || (input.partyId as unknown) === '' ? fail('Choose the party (customer or supplier).') : num(input.partyId, 'party'));
      mode = input.mode === 'accounting' ? 'accounting' : 'item';
      if (mode === 'accounting' && !vt.books) fail(`A ${vt.label} always has items.`);
      const account = vt.books && mode === 'item'
        ? this.ledger(input.accountId ?? (type === 'sales' || type === 'credit_note' ? this.ledgerByName('Sales')?.id : this.ledgerByName('Purchase')?.id) ?? fail('Choose the sales or purchase ledger.'))
        : null;
      if (account && account.id === party.id) fail('The party and the sales/purchase ledger cannot be the same.');
      const pos = party.state_code || company.state_code;
      const intra = isIntraState(company.state_code, pos);
      const outward = ['sales', 'debit_note', 'sales_order', 'rejection_out', 'delivery_note'].includes(type);
      const purchaseSide = ['purchase', 'debit_note', 'purchase_order', 'rejection_in', 'receipt_note'].includes(type);
      const registered = isValidGstin(party.gstin || '');
      snapshot = { gstin: registered ? party.gstin : '', state: pos };

      // Made against an order, a delivery/receipt note or a rejection: goods that already moved do not move again.
      let move: number = vt.move;
      if (input.againstId !== undefined && input.againstId !== null && (input.againstId as unknown) !== '') {
        const src = this.db.prepare(`SELECT id, type, number, party_id, cancelled, optional FROM vouchers WHERE id=?`).get(num(input.againstId, 'order or note')) as
          { id: number; type: VoucherType; number: string; party_id: number; cancelled: number; optional: number } | undefined;
        if (!src || src.cancelled || src.optional) fail('The order or note this is made against was not found, or is cancelled.');
        if (!(FOLLOWS[type] ?? []).includes(src!.type)) fail(`A ${vt.label} cannot be made against a ${VOUCHER_TYPES[src!.type].label}.`);
        if (src!.party_id !== party.id) fail(`${src!.number} is for a different party.`);
        if (src!.type !== 'sales_order' && src!.type !== 'purchase_order') {
          const used = this.db.prepare(`SELECT number FROM vouchers WHERE against_id=? AND cancelled=0 AND optional=0 AND id<>?`).get(src!.id, excludeId) as { number: string } | undefined;
          if (used && !optional) fail(`${src!.number} is already billed in ${used.number}.`);
          move = 0;
        }
        againstId = src!.id;
      }

      // Credit/debit notes against a bill keep that bill's GST rates (rates change; a return is taxed as originally billed).
      const originalRates = new Map<number, number>();
      const originalHsn = new Map<number, string>();
      const againstRef = input.againstRef?.trim();
      if ((type === 'credit_note' || type === 'debit_note') && againstRef) {
        const orig = this.db.prepare(`
          SELECT gl.item_id, gl.gst_rate, gl.hsn FROM gst_lines gl JOIN vouchers v ON v.id=gl.voucher_id
          JOIN bills b ON b.voucher_id=v.id AND b.kind='new' AND b.ref=? AND b.ledger_id=?
          WHERE v.cancelled=0 AND v.optional=0`).all(againstRef, party.id) as { item_id: number | null; gst_rate: number; hsn: string }[];
        for (const o of orig) {
          if (o.item_id) originalRates.set(o.item_id, o.gst_rate);
          if (o.hsn && !originalHsn.has(o.gst_rate)) originalHsn.set(o.gst_rate, o.hsn);
        }
      }

      // Extra ledgers on the bill (freight, packing, discount, TCS).
      const charges = Array.isArray(input.charges) ? input.charges : [];
      if (charges.length && !vt.books) fail(`A ${vt.label} has no extra ledgers; add them on the bill.`);
      if (charges.length > 20) fail('A bill can have at most 20 extra ledgers.');
      const chargeLedgers = charges.map((c) => {
        if (!c || typeof c !== 'object') fail('An extra ledger line is empty.');
        const l = this.ledger(num(c.ledgerId, 'ledger'));
        const amount = num(c.amount, 'amount');
        if (!Number.isInteger(amount) || !amount || Math.abs(amount) > 1e13) fail(`Enter the amount for ${l.name} in whole paise.`);
        if (l.id === party.id || l.id === account?.id) fail(`${l.name} is already on this bill.`);
        if (l.tax_kind === 'cgst' || l.tax_kind === 'sgst' || l.tax_kind === 'igst' || l.tax_kind === 'roundoff') fail(`${l.name} is calculated by Stockwell; do not add it by hand.`);
        return { ledger: l, amount };
      });
      let roundOff: number | null = null;
      if (input.roundOff !== undefined && input.roundOff !== null && (input.roundOff as unknown) !== '') {
        if (!vt.books) fail(`A ${vt.label} has no round off.`);
        roundOff = num(input.roundOff, 'round off');
        if (!Number.isInteger(roundOff) || Math.abs(roundOff) > 1000) fail('Round off can be at most ₹10 either way.');
      }

      type Prepared = { item: Item | null; ledger?: Ledger; qty: number; free: number; rate: number; disc: number; gstRate: number; batchId: number | null; godownId: number; altQty: number | null; hsn?: string; taxability?: string };
      const prepared: Prepared[] = [];
      if (mode === 'accounting') {
        const tl = Array.isArray(input.taxLines) ? input.taxLines : [];
        if (!tl.length) fail('Add at least one ledger line.');
        if (tl.length > 100) fail('A voucher can have at most 100 ledger lines.');
        for (const t of tl) {
          if (!t || typeof t !== 'object') fail('A ledger line is empty.');
          const l = this.ledger(num(t.ledgerId, 'ledger'));
          if (l.id === party.id) fail('The party cannot also be a ledger line.');
          if (['cgst', 'sgst', 'igst', 'roundoff'].includes(l.tax_kind ?? '')) fail(`${l.name} is calculated by Stockwell; do not add it by hand.`);
          const amount = num(t.amount, 'amount');
          if (!Number.isInteger(amount) || amount <= 0 || amount > 1e13) fail(`Enter the amount for ${l.name}.`);
          let gstRate = t.gstRate === undefined || t.gstRate === null || (t.gstRate as unknown) === '' ? 0 : num(t.gstRate, 'GST rate');
          if (gstRate < 0 || gstRate > 40) fail(`GST rate for ${l.name} must be between 0 and 40%.`);
          if (purchaseSide && !registered) gstRate = 0;
          let hsn = String(t.hsn ?? '').replace(/\s/g, '') || originalHsn.get(gstRate) || '';
          if (hsn && !HSN_RE.test(hsn)) fail(`HSN/SAC for ${l.name} must be 4, 6 or 8 digits.`);
          if ((type === 'sales' || type === 'credit_note') && gstRate > 0 && !hsn) fail(`Enter the HSN/SAC for ${l.name}. GSTR-1 needs it.`);
          // A line with no GST (a cash discount, interest) is outside GST and is left out of the returns.
          const taxability = gstRate > 0 ? 'taxable' : (TAXABILITY.includes(String(t.taxability)) ? String(t.taxability) : 'outside');
          if (gstRate === 0) hsn = hsn || '';
          prepared.push({ item: null, ledger: l, qty: 1, free: 0, rate: amount, disc: 0, gstRate, batchId: null, godownId: 1, altQty: null, hsn, taxability });
        }
      } else {
        const lines = Array.isArray(input.lines) ? input.lines : [];
        if (!lines.length) fail('Add at least one item.');
        if (lines.length > 500) fail('A voucher can have at most 500 item lines.');
        const needByItem = new Map<string, number>();
        for (const l of lines) {
          if (!l || typeof l !== 'object') fail('An item line is empty.');
          const item = this.item(num(l.itemId, 'item'));
          let qty = num(l.qty, 'quantity');
          let rate = num(l.rate, 'rate');
          let altQty: number | null = null;
          if (l.unit === 'alt') {
            if (!item.alt_unit_id || !(item.alt_conv > 0)) fail(`${item.name} has no alternate unit. Set it in the stock item first.`);
            altQty = qty;
            qty = Math.round(qty * item.alt_conv * 1000) / 1000;
            rate = rate / item.alt_conv;
          }
          const gid = this.godownId(l.godownId);
          const free = l.freeQty === undefined || l.freeQty === null ? (type === 'sales' ? schemeFreeQty(qty, item.scheme_buy, item.scheme_free) : 0) : num(l.freeQty, 'free quantity');
          const disc = l.discountPct === undefined || l.discountPct === null ? 0 : num(l.discountPct, 'discount');
          if (!(qty > 0) || qty > 1e7) fail(`Enter a quantity for ${item.name}.`);
          if (!(rate >= 0) || rate > 1e11) fail(`Enter a rate for ${item.name}.`);
          if (free < 0 || free > 1e7) fail(`Free quantity for ${item.name} cannot be negative.`);
          if (disc < 0 || disc > 100) fail(`Discount for ${item.name} must be between 0 and 100%.`);
          let gstRate = l.gstRate === undefined || l.gstRate === null ? (originalRates.get(item.id) ?? this.rateOn(item, input.date)) : num(l.gstRate, 'GST rate');
          if (gstRate < 0 || gstRate > 40) fail(`GST rate for ${item.name} must be between 0 and 40%.`);
          if (item.taxability !== 'taxable') gstRate = 0;
          // An unregistered supplier cannot charge GST, so there is no tax (and no input credit) on the purchase.
          if (purchaseSide && !registered) gstRate = 0;
          if ((type === 'sales' || type === 'credit_note') && gstRate > 0 && !HSN_RE.test(item.hsn || '')) {
            fail(`Add a 4, 6 or 8 digit HSN code to "${item.name}" first (Alter → Stock Item). GSTR-1 needs it.`);
          }
          // Keep the rate to 1/100 paise, so landing rates like ₹42.3729 are not cut short before qty × rate.
          const exactRate = Math.round(rate * 100) / 100;
          const base = { item, qty, free, rate: exactRate, disc, gstRate, godownId: gid, altQty };
          needByItem.set(`${item.id}|${gid}`, (needByItem.get(`${item.id}|${gid}`) ?? 0) + qty + free);
          if (l.mrp !== undefined && l.mrp !== null && (l.mrp as unknown) !== '' && !(num(l.mrp, 'MRP') >= 0)) fail(`MRP for ${item.name} cannot be negative.`);

          if (!item.track_batch || move === 0) {
            if (l.batchId) this.ownBatch(item.id, l.batchId);
            prepared.push({ ...base, batchId: l.batchId && item.track_batch ? num(l.batchId, 'batch') : null });
            continue;
          }
          if (move > 0) {
            const bid = l.batchId ? this.ownBatch(item.id, l.batchId) : this.ensureBatch(item.id, l);
            if (!bid) fail(`Enter a batch number for ${item.name}.`);
            if (l.mrp && Number(l.mrp) > 0) this.db.prepare(`UPDATE batches SET mrp=? WHERE id=?`).run(Math.round(Number(l.mrp)), bid);
            prepared.push({ ...base, batchId: bid });
            continue;
          }
          if (l.batchId) {
            const bid = this.ownBatch(item.id, l.batchId);
            if (type === 'sales' || type === 'delivery_note') {
              const b = this.db.prepare(`SELECT batch_no, expiry_date FROM batches WHERE id=?`).get(bid) as { batch_no: string; expiry_date: string | null };
              if (b.expiry_date && b.expiry_date < input.date) fail(`Batch ${b.batch_no} of ${item.name} expired on ${b.expiry_date}. Expired stock cannot be sold; send it back with Rejection Out or write it off with a Stock Journal.`);
            }
            prepared.push({ ...base, batchId: bid });
            continue;
          }
          // Outward without a chosen batch: take from the soonest-expiring batches that are not expired (FEFO),
          // splitting the line when one batch does not have enough.
          for (const part of this.allocateBatches(item, qty, free, input.date, excludeId, gid)) prepared.push({ ...base, ...part, altQty: part.qty === qty ? altQty : null });
        }

        if (move < 0 && !company.allow_negative_stock && !optional) {
          for (const [key, need] of needByItem) {
            const [itemId, g] = key.split('|').map(Number);
            const have = this.stockOf(itemId, input.date, excludeId, g);
            if (need > have + 1e-9) fail(`Not enough stock of ${this.item(itemId).name}${g !== 1 ? ` in ${this.godownName(g)}` : ''}: ${have} in stock on ${input.date}, this voucher needs ${need}.`);
          }
        }
      }

      const totals = computeBill(prepared.map((p) => ({ qty: p.qty, rate: p.rate, discountPct: p.disc, gstRate: p.gstRate })), intra,
        chargeLedgers.map((c) => ({ amount: c.amount, assessable: !!c.ledger.assessable })), roundOff);
      if (totals.lines.some((t) => t.taxable < 0)) fail('The discount is more than the value of the items.');
      if (totals.total < 0) fail('The bill total cannot be below zero.');
      const direction = move;
      prepared.forEach((p, i) => {
        const t = totals.lines[i];
        if (p.item) {
          invLines.push({
            line_no: invLines.length + 1, item_id: p.item.id, batch_id: p.batchId, qty: p.qty, free_qty: p.free, rate: p.rate,
            discount_pct: p.disc, gst_rate: p.gstRate, taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, direction,
            godown_id: p.godownId === 1 ? null : p.godownId, alt_qty: p.altQty, base_taxable: totals.allocated[i] ? totals.baseTaxable[i] : null,
          });
        } else {
          taxRows.push({ line_no: taxRows.length + 1, ledger_id: p.ledger!.id, hsn: p.hsn ?? '', gst_rate: p.gstRate, taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, taxability: p.taxability ?? 'taxable', base: totals.baseTaxable[i] });
        }
      });
      chargeLedgers.forEach((c, i) => chargeRows.push({ line_no: i + 1, ledger_id: c.ledger.id, amount: c.amount, assessable: c.ledger.assessable ? 1 : 0 }));
      // Sales and debit notes debit the party; purchases and credit notes credit it.
      const partySign = outward ? 1 : -1;
      if (vt.books) {
        entries.push({ ledgerId: party.id, amount: partySign * totals.total });
        if (account) entries.push({ ledgerId: account.id, amount: -partySign * totals.baseTaxable.reduce((a, x) => a + x, 0) });
        else taxRows.forEach((t) => entries.push({ ledgerId: t.ledger_id as number, amount: -partySign * (t.base as number) }));
        for (const c of chargeLedgers) entries.push({ ledgerId: c.ledger.id, amount: -partySign * c.amount });
        if (totals.cgst) entries.push({ ledgerId: this.taxLedger('cgst').id, amount: -partySign * totals.cgst });
        if (totals.sgst) entries.push({ ledgerId: this.taxLedger('sgst').id, amount: -partySign * totals.sgst });
        if (totals.igst) entries.push({ ledgerId: this.taxLedger('igst').id, amount: -partySign * totals.igst });
        if (totals.roundOff) entries.push({ ledgerId: this.taxLedger('roundoff').id, amount: -partySign * totals.roundOff });
      }
      header = {
        taxable: totals.taxable, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, round_off: totals.roundOff,
        total: totals.total, intra: intra ? 1 : 0, place_of_supply: pos, charges: totals.charges,
      };
      header.party_id = party.id;
      header.account_id = account?.id ?? (taxRows[0]?.ledger_id as number | undefined) ?? null;

      // Credit control: a sale that takes the party past its credit limit, or to a party with overdue bills, needs the owner.
      if (type === 'sales' && !optional && (party.credit_limit > 0 || party.block_overdue)) {
        const user = currentUser.getStore();
        const mayOverride = !user || user.role === 'owner';
        if (!(input.overrideCredit && mayOverride)) {
          const bal = (this.db.prepare(`SELECT COALESCE(SUM(e.amount),0) s FROM entries e JOIN vouchers v ON v.id=e.voucher_id
            WHERE e.ledger_id=? AND v.cancelled=0 AND v.optional=0 AND v.id<>?`).get(party.id, excludeId) as { s: number }).s + party.opening;
          const problems: string[] = [];
          if (party.credit_limit > 0 && bal + totals.total > party.credit_limit) {
            problems.push(`${party.name} would owe ₹${(Math.round(bal + totals.total) / 100).toFixed(2)}, over the credit limit of ₹${(party.credit_limit / 100).toFixed(2)}.`);
          }
          if (party.block_overdue) {
            const overdue = this.pendingBills({ ledgerId: party.id, asOf: input.date }).filter((b) => b.pending > 0 && b.overdue_days > 0);
            if (overdue.length) problems.push(`${party.name} has ${overdue.length} overdue bill${overdue.length > 1 ? 's' : ''} (oldest ${overdue.sort((a, b) => b.overdue_days - a.overdue_days)[0].overdue_days} days).`);
          }
          if (problems.length) {
            const e = new BooksError(`${problems.join(' ')}${mayOverride ? ' Save anyway?' : ' Ask the owner to allow this bill.'}`);
            e.code = 'credit';
            throw e;
          }
        }
      }

      if (vt.books && this.isBillWise(party.id)) {
        if (type === 'sales' || type === 'purchase') {
          let ref = numbering.number;
          if (type === 'purchase' && input.refNo?.trim()) {
            ref = input.refNo.trim().slice(0, 40);
            const prior = this.db.prepare(`SELECT b.date FROM bills b WHERE b.ledger_id=? AND b.ref=? AND b.kind='new' AND COALESCE(b.voucher_id,0)<>?`)
              .get(party.id, ref, excludeId) as { date: string } | undefined;
            if (prior) {
              if (financialYear(prior.date).label === financialYear(input.date).label) fail(`Supplier bill ${ref} from ${party.name} is already entered.`);
              // Suppliers restart their numbering every April: keep last year's bill separate.
              ref = `${ref} (${financialYear(input.date).label})`;
            }
          }
          bills.push({ ledgerId: party.id, ref, kind: 'new', amount: partySign * totals.total, due: addDays(input.date, party.credit_days || 0) });
        } else if (againstRef) {
          const p = pendingFor(party.id, againstRef);
          if (!p.n) fail(`There is no bill ${againstRef} for ${party.name}.`);
          // Reduce the bill by what is still due on it; anything more stays on account.
          const amount = partySign * totals.total;
          const room = Math.sign(p.p) === -Math.sign(amount) ? Math.min(Math.abs(p.p), Math.abs(amount)) : 0;
          if (room) bills.push({ ledgerId: party.id, ref: againstRef, kind: 'agst', amount: Math.sign(amount) * room, due: input.date });
          if (Math.abs(amount) - room) bills.push({ ledgerId: party.id, ref: numbering.number, kind: 'onacc', amount: Math.sign(amount) * (Math.abs(amount) - room), due: input.date });
        } else {
          bills.push({ ledgerId: party.id, ref: numbering.number, kind: 'onacc', amount: partySign * totals.total, due: input.date });
        }
      }
    } else {
      const lines = Array.isArray(input.entries) ? input.entries : [];
      if (!lines.length) fail('Add at least one ledger line.');
      if (lines.length > 500) fail('A voucher can have at most 500 lines.');
      const amountOf = (v: unknown) => {
        const a = num(v, 'amount');
        if (!Number.isInteger(a) || Math.abs(a) > 1e13) fail('Amounts must be whole paise below ₹1 lakh crore.');
        return a;
      };
      const journal = JOURNAL_LIKE.includes(type);
      if (journal) {
        for (const e of lines) entries.push({ ledgerId: this.ledger(num(e?.ledgerId, 'ledger')).id, amount: amountOf(e.amount) });
        if (entries.some((e) => e.amount === 0)) fail('Each line needs an amount.');
      } else {
        const account = this.ledger(input.accountId == null || (input.accountId as unknown) === '' ? fail('Choose the cash or bank account.') : num(input.accountId, 'account'));
        // Receipt: money comes in, account is debited and particulars credited. Payment/contra: the reverse.
        const sign = type === 'receipt' ? -1 : 1;
        let sum = 0;
        for (const e of lines) {
          const amt = Math.abs(amountOf(e?.amount));
          if (!amt) fail('Each line needs an amount.');
          const l = this.ledger(num(e.ledgerId, 'ledger'));
          if (l.id === account.id) fail('The account and the particulars cannot be the same ledger.');
          entries.push({ ledgerId: l.id, amount: sign * amt });
          sum += amt;
        }
        entries.push({ ledgerId: account.id, amount: -sign * sum });
        header.account_id = account.id;
        if (lines.length === 1) header.party_id = lines[0].ledgerId;
      }
      for (const e of lines) {
        if (!this.isBillWise(e.ledgerId)) continue;
        const signed = journal ? Math.round(e.amount) : (type === 'receipt' ? -1 : 1) * Math.abs(Math.round(e.amount));
        let left = signed;
        const allocs = Array.isArray(e.bills) ? e.bills : [];
        const usedHere = new Map<string, number>();
        for (const b of allocs) {
          if (!b || typeof b.ref !== 'string' || !b.ref.trim()) fail('Each bill allocation needs a bill reference.');
          const amt = Math.sign(signed) * Math.abs(amountOf(b.amount));
          if (!amt) continue;
          const kind = b.kind === 'new' || b.kind === 'onacc' ? b.kind : 'agst';
          if (kind === 'agst') {
            const p = pendingFor(e.ledgerId, b.ref);
            if (!p.n && b.ref !== 'Opening') fail(`There is no bill ${b.ref} for ${this.ledger(e.ledgerId).name}.`);
            const already = usedHere.get(b.ref) ?? 0;
            if (Math.sign(p.p) !== -Math.sign(amt) || Math.abs(amt) + already > Math.abs(p.p)) {
              fail(`Bill ${b.ref} has only ₹${(Math.abs(p.p) / 100).toFixed(2)} pending; the rest can go on account.`);
            }
            usedHere.set(b.ref, already + Math.abs(amt));
          }
          if (Math.abs(amt) > Math.abs(left)) fail('The bill allocations add up to more than the line amount.');
          bills.push({ ledgerId: e.ledgerId, ref: b.ref.trim(), kind, amount: amt, due: input.date });
          left -= amt;
        }
        if (left) bills.push({ ledgerId: e.ledgerId, ref: numbering.number, kind: 'onacc', amount: left, due: input.date });
      }
      header.total = entries.filter((e) => e.amount > 0).reduce((a, e) => a + e.amount, 0);
    }

    for (const e of entries) if (!Number.isSafeInteger(e.amount)) fail('An amount is too large.');
    const net = entries.reduce((a, e) => a + e.amount, 0);
    if (net !== 0) fail(`Debit and credit do not match (difference ${(net / 100).toFixed(2)}).`);
    // Orders, notes and rejections may carry no prices; everything else needs an amount.
    if (header.total === 0 && !vt.stock && (vt.books || !vt.inventory)) fail('The voucher total is zero.');
    // An optional voucher, memorandum or reversing journal is shown but never settles or raises bills.
    if (optional) bills = [];

    if (existing) {
      // Bills that other vouchers settle must keep their party and reference.
      const dep = this.dependants(existing);
      if (dep.found.length) {
        const keeps = dep.own.every((o) => bills.some((b) => b.kind === 'new' && b.ledgerId === o.ledger_id && b.ref === o.ref));
        if (!keeps) fail(`${existing.number} has ${[...new Set(dep.found.map((d) => d.number))].join(', ')} set against it, so its party and bill number cannot change.`);
      }
      const follower = this.db.prepare(`SELECT number FROM vouchers WHERE against_id=? AND cancelled=0 AND optional=0`).get(existing.id) as { number: string } | undefined;
      if (follower && (optional || header.party_id !== existing.party_id)) fail(`${follower.number} is made against ${existing.number}, so its party cannot change and it cannot become optional.`);
      if ((existing as { bounced_by?: number | null }).bounced_by) fail(`The cheque in ${existing.number} bounced. Delete the bounce entry first to change it.`);
    }

    const pdc = !!input.pdc && !vt.inventory && !vt.stock;
    const row = {
      type, number: numbering.number, seq: numbering.seq, date: input.date, narration: input.narration ?? '',
      party_id: header.party_id ?? null, account_id: header.account_id ?? null, place_of_supply: header.place_of_supply ?? null,
      intra: header.intra, taxable: header.taxable, cgst: header.cgst, sgst: header.sgst, igst: header.igst,
      round_off: header.round_off, total: header.total, ref_no: (input.refNo?.trim() || ((type === 'credit_note' || type === 'debit_note') ? input.againstRef?.trim() : '') || '').slice(0, 40), ref_date: isoDate(input.refDate, 'The reference date'),
      vehicle_no: (input.vehicleNo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15), distance_km: Math.max(0, Math.min(4000, Math.round(Number(input.distanceKm) || 0))),
      transporter_name: (input.transporterName ?? '').slice(0, 100), transporter_id: (input.transporterId ?? '').slice(0, 15), ewb_no: (input.ewbNo ?? ((existing as Record<string, unknown> | null)?.ewb_no as string) ?? '').replace(/\D/g, '').slice(0, 12),
      party_gstin: snapshot.gstin, party_state: snapshot.state,
      mode, optional: optional ? 1 : 0, pdc: pdc ? 1 : 0, cheque_no: (input.chequeNo ?? '').trim().slice(0, 20),
      cheque_date: isoDate(input.chequeDate, 'The cheque date'), bank_name: (input.bankName ?? '').trim().slice(0, 60),
      against_id: againstId, charges: header.charges ?? 0,
    };
    let id: number;
    if (existing) {
      id = existing.id;
      this.db.prepare(`UPDATE vouchers SET ${Object.keys(row).map((k) => `${k}=@${k}`).join(', ')}, updated_at=datetime('now') WHERE id=@id`).run({ ...row, id });
      for (const t of ['entries', 'inventory', 'bills', 'tax_lines', 'voucher_charges']) this.db.prepare(`DELETE FROM ${t} WHERE voucher_id=?`).run(id);
    } else {
      const r = this.db.prepare(`INSERT INTO vouchers (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map((k) => '@' + k).join(',')})`).run(row);
      id = Number(r.lastInsertRowid);
    }
    const insE = this.db.prepare(`INSERT INTO entries (voucher_id, ledger_id, amount) VALUES (?, ?, ?)`);
    for (const e of entries) if (e.amount) insE.run(id, e.ledgerId, e.amount);
    const insI = this.db.prepare(`INSERT INTO inventory (voucher_id, line_no, item_id, batch_id, qty, free_qty, rate, discount_pct, gst_rate, taxable, cgst, sgst, igst, direction, godown_id, alt_qty, base_taxable)
      VALUES (@voucher_id, @line_no, @item_id, @batch_id, @qty, @free_qty, @rate, @discount_pct, @gst_rate, @taxable, @cgst, @sgst, @igst, @direction, @godown_id, @alt_qty, @base_taxable)`);
    for (const l of invLines) insI.run({ godown_id: null, alt_qty: null, base_taxable: null, ...l, voucher_id: id });
    const insT = this.db.prepare(`INSERT INTO tax_lines (voucher_id, line_no, ledger_id, hsn, gst_rate, taxable, cgst, sgst, igst, taxability, base)
      VALUES (@voucher_id, @line_no, @ledger_id, @hsn, @gst_rate, @taxable, @cgst, @sgst, @igst, @taxability, @base)`);
    for (const t of taxRows) insT.run({ ...t, voucher_id: id });
    const insC = this.db.prepare(`INSERT INTO voucher_charges (voucher_id, line_no, ledger_id, amount, assessable) VALUES (@voucher_id, @line_no, @ledger_id, @amount, @assessable)`);
    for (const c of chargeRows) insC.run({ ...c, voucher_id: id });
    const insB = this.db.prepare(`INSERT INTO bills (voucher_id, ledger_id, ref, kind, amount, date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const b of bills) insB.run(id, b.ledgerId, b.ref, b.kind, b.amount, input.date, b.due);
    this.audit('voucher', id, existing ? 'update' : 'create', existing ? { before: existing, after: input } : input);
    return this.voucher(id);
  }

  /** A batch chosen on screen must belong to the item. */
  private ownBatch(itemId: number, batchId: unknown): number {
    const id = num(batchId, 'batch');
    const b = this.db.prepare(`SELECT item_id FROM batches WHERE id=?`).get(id) as { item_id: number } | undefined;
    if (!b || b.item_id !== itemId) fail('That batch belongs to a different item.');
    return id;
  }

  /**
   * Splits an outward quantity over batches, soonest expiry first, skipping expired ones (FEFO).
   * Free quantity is taken after the paid quantity.
   */
  private allocateBatches(item: Item, qty: number, free: number, date: string, excludeVoucher: number, godownId = 1) {
    const list = this.batches(item.id, date, excludeVoucher, godownId).filter((b) => b.qty > 0 && !(b.expiry_date && b.expiry_date < date));
    let paidLeft = qty;
    let freeLeft = free;
    const parts: { qty: number; free: number; batchId: number }[] = [];
    for (const b of list) {
      if (paidLeft <= 0 && freeLeft <= 0) break;
      let room = b.qty;
      const p = Math.min(room, paidLeft); room -= p; paidLeft -= p;
      const f = Math.min(room, freeLeft); freeLeft -= f;
      if (p > 0 || f > 0) parts.push({ qty: p, free: f, batchId: b.id });
    }
    if (paidLeft > 1e-9 || freeLeft > 1e-9) {
      const anyExpired = this.batches(item.id, date, excludeVoucher, godownId).some((b) => b.qty > 0 && b.expiry_date && b.expiry_date < date);
      fail(`Not enough unexpired stock of ${item.name} in its batches${anyExpired ? ' (some stock has expired; pick that batch by hand only if you really mean to)' : ''}.`);
    }
    // A part with only free goods needs a paid quantity for the GST line; fold it into the previous part.
    const merged: typeof parts = [];
    for (const p of parts) {
      if (p.qty === 0 && merged.length) merged.push({ qty: 0, free: p.free, batchId: p.batchId });
      else merged.push(p);
    }
    return merged.map((p) => ({ qty: p.qty, free: p.free, batchId: p.batchId }));
  }

  voucher(id: number) {
    const v = this.db.prepare(`
      SELECT v.*, p.name AS party_name, a.name AS account_name FROM vouchers v
      LEFT JOIN ledgers p ON p.id=v.party_id LEFT JOIN ledgers a ON a.id=v.account_id WHERE v.id=?`).get(id) as
      (Record<string, unknown> & { id: number; type: string; number: string; seq: number; date: string; cancelled: number; optional: number; total: number; party_id: number | null;
        account_id: number | null; bounced_by: number | null; bounce_of: number | null; cheque_no: string; bank_name: string }) | undefined;
    if (!v) fail(`Voucher ${id} not found.`);
    const entries = this.db.prepare(`SELECT e.ledger_id, l.name AS ledger_name, e.amount FROM entries e JOIN ledgers l ON l.id=e.ledger_id WHERE voucher_id=? ORDER BY e.id`).all(id);
    const lines = this.db.prepare(`
      SELECT iv.*, i.name AS item_name, i.hsn, u.symbol AS unit, u.uqc, au.symbol AS alt_unit, i.alt_conv, b.batch_no, b.expiry_date,
        COALESCE(NULLIF(b.mrp,0), i.mrp) AS mrp, g.name AS godown
      FROM inventory iv JOIN items i ON i.id=iv.item_id JOIN units u ON u.id=i.unit_id LEFT JOIN units au ON au.id=i.alt_unit_id
      LEFT JOIN batches b ON b.id=iv.batch_id LEFT JOIN godowns g ON g.id=iv.godown_id
      WHERE voucher_id=? ORDER BY line_no`).all(id);
    const bills = this.db.prepare(`SELECT ledger_id, ref, kind, amount, due_date FROM bills WHERE voucher_id=?`).all(id);
    const taxLines = this.db.prepare(`SELECT t.*, l.name AS ledger_name FROM tax_lines t JOIN ledgers l ON l.id=t.ledger_id WHERE voucher_id=? ORDER BY line_no`).all(id);
    const charges = this.db.prepare(`SELECT c.*, l.name AS ledger_name FROM voucher_charges c JOIN ledgers l ON l.id=c.ledger_id WHERE voucher_id=? ORDER BY line_no`).all(id);
    const against = v!.against_id ? this.db.prepare(`SELECT id, type, number, date FROM vouchers WHERE id=?`).get(v!.against_id) : null;
    const followers = this.db.prepare(`SELECT id, type, number, date FROM vouchers WHERE against_id=? AND cancelled=0`).all(id);
    return { ...v!, entries, lines, bills, taxLines, charges, against, followers };
  }

  vouchers(opts: { from?: string; to?: string; type?: string; ledgerId?: number } = {}) {
    const where = ['1=1'];
    const args: unknown[] = [];
    if (opts.from) { where.push('v.date>=?'); args.push(opts.from); }
    if (opts.to) { where.push('v.date<=?'); args.push(opts.to); }
    if (opts.type) { where.push('v.type=?'); args.push(opts.type); }
    if (opts.ledgerId) { where.push('v.id IN (SELECT voucher_id FROM entries WHERE ledger_id=?)'); args.push(opts.ledgerId); }
    return this.db.prepare(`
      SELECT v.id, v.type, v.number, v.date, v.total, v.cancelled, v.optional, v.pdc, v.bank_date, v.bounced_by, v.bounce_of, v.cheque_no, v.mode, v.narration, v.ewb_no, v.party_id,
        COALESCE(p.name, a.name, (SELECT l.name FROM entries e JOIN ledgers l ON l.id=e.ledger_id WHERE e.voucher_id=v.id ORDER BY e.id LIMIT 1)) AS particulars
      FROM vouchers v LEFT JOIN ledgers p ON p.id=v.party_id LEFT JOIN ledgers a ON a.id=v.account_id
      WHERE ${where.join(' AND ')} ORDER BY v.date, v.id`).all(...args);
  }

  // ---------- outstandings ----------
  /** Pending bills of one party (or all), signed +Dr. */
  pendingBills(opts: { ledgerId?: number; asOf?: string } = {}) {
    const asOf = opts.asOf ?? todayISO();
    const args: unknown[] = [asOf];
    let filter = '';
    if (opts.ledgerId) { filter = 'AND b.ledger_id=?'; args.push(opts.ledgerId); }
    const rows = this.db.prepare(`
      SELECT b.ledger_id, l.name AS ledger_name, l.phone, l.beat, l.salesman, l.credit_days, l.msme_buyer, l.msme_supplier,
        b.ref, SUM(b.amount) AS pending,
        MIN(CASE WHEN b.kind='new' THEN b.date END) AS bill_date,
        MIN(CASE WHEN b.kind='new' THEN b.due_date END) AS due_date,
        MAX(CASE WHEN b.kind='new' THEN b.amount END) AS bill_amount
      FROM bills b JOIN ledgers l ON l.id=b.ledger_id
      WHERE b.date<=? ${filter}
      GROUP BY b.ledger_id, b.ref HAVING SUM(b.amount)<>0
      ORDER BY l.name, COALESCE(MIN(CASE WHEN b.kind='new' THEN b.date END), MIN(b.date))`).all(...args) as {
        ledger_id: number; ledger_name: string; phone: string; beat: string; salesman: string; credit_days: number;
        msme_buyer: number; msme_supplier: number; ref: string; pending: number; bill_date: string | null; due_date: string | null; bill_amount: number | null;
      }[];
    return rows.map((r) => {
      const billDate = r.bill_date ?? asOf;
      const due = r.due_date ?? billDate;
      return { ...r, bill_date: billDate, due_date: due, age_days: daysBetween(billDate, asOf), overdue_days: Math.max(0, daysBetween(due, asOf)) };
    });
  }

  // ---------- helpers ----------
  audit(entity: string, id: number | null, action: string, data: unknown) {
    this.db.prepare(`INSERT INTO audit (entity, entity_id, action, data, user_name) VALUES (?, ?, ?, ?, ?)`)
      .run(entity, id, action, JSON.stringify(data), currentUser.getStore()?.name ?? null);
  }

  auditLog(limit = 200) {
    return this.db.prepare(`SELECT * FROM audit ORDER BY id DESC LIMIT ?`).all(limit);
  }
}
