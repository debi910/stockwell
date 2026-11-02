import { AsyncLocalStorage } from 'node:async_hooks';
import type { DB } from './db';
import { computeInvoice, isIntraState, isValidGstin, schemeFreeQty, stateFromGstin } from '../core/gst';
import { addDays, daysBetween, financialYear, todayISO } from '../core/dates';
import type { Nature } from '../core/groups';

/** Who is making the current request, so the edit log can name them. */
export const currentUser = new AsyncLocalStorage<{ id: number; name: string; role: 'owner' | 'operator' } | null>();

export class BooksError extends Error {
  status = 400;
}
const fail = (msg: string): never => {
  throw new BooksError(msg);
};

export type VoucherType =
  | 'sales' | 'purchase' | 'credit_note' | 'debit_note'
  | 'receipt' | 'payment' | 'contra' | 'journal';

export const VOUCHER_TYPES: Record<VoucherType, { label: string; prefix: string; inventory: boolean }> = {
  sales: { label: 'Sales', prefix: 'S', inventory: true },
  purchase: { label: 'Purchase', prefix: 'P', inventory: true },
  credit_note: { label: 'Credit Note', prefix: 'CN', inventory: true },
  debit_note: { label: 'Debit Note', prefix: 'DN', inventory: true },
  receipt: { label: 'Receipt', prefix: 'R', inventory: false },
  payment: { label: 'Payment', prefix: 'PY', inventory: false },
  contra: { label: 'Contra', prefix: 'C', inventory: false },
  journal: { label: 'Journal', prefix: 'J', inventory: false },
};

export interface Company {
  name: string; address: string; city: string; pincode: string; state_code: string; gstin: string;
  phone: string; email: string; upi_id: string; bank_details: string; books_from: string;
  ewb_threshold: number; udyam_no: string; msme_interest_rate: number; expiry_alert_days: number;
  invoice_terms: string; backup_dir: string; allow_negative_stock: number; last_backup: string;
}

export interface Group { id: number; name: string; parent_id: number | null; nature: Nature; direct: number; builtin: number }

export interface Ledger {
  id: number; name: string; group_id: number; opening: number; gstin: string; state_code: string;
  address: string; city: string; pincode: string; phone: string; credit_days: number; beat: string; salesman: string;
  msme_supplier: number; msme_buyer: number; udyam_no: string; tax_kind: string | null; builtin: number;
}

export interface Item {
  id: number; name: string; stock_group_id: number | null; unit_id: number; hsn: string; gst_rate: number;
  mrp: number; sale_rate: number; purchase_rate: number; track_batch: number; reorder_level: number;
  scheme_buy: number; scheme_free: number; opening_qty: number; opening_value: number;
  taxability: 'taxable' | 'nil' | 'exempt' | 'nongst';
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
}

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
  // accounting vouchers
  /** Receipt/payment/contra: the other side; journal: all lines (+Dr, -Cr). */
  entries?: { ledgerId: number; amount: number; bills?: BillAllocation[] }[];
}

const DEBTOR_GROUPS = ['Sundry Debtors', 'Sundry Creditors'];

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
    const cols = ['name', 'group_id', 'opening', 'gstin', 'state_code', 'address', 'city', 'pincode', 'phone',
      'credit_days', 'beat', 'salesman', 'msme_supplier', 'msme_buyer', 'udyam_no'] as const;
    const row: Record<string, unknown> = {};
    for (const c of cols) row[c] = (l as Record<string, unknown>)[c] ?? (c === 'opening' || c === 'credit_days' || c.startsWith('msme') ? 0 : '');
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
    const l = this.cleanLedger(patch);
    if (l.name && l.name.toLowerCase() !== before.name.toLowerCase() && this.ledgerByName(l.name)) fail(`A ledger named "${l.name}" already exists.`);
    const allowed = ['name', 'group_id', 'opening', 'gstin', 'state_code', 'address', 'city', 'pincode', 'phone',
      'credit_days', 'beat', 'salesman', 'msme_supplier', 'msme_buyer', 'udyam_no'];
    const keys = Object.keys(l).filter((k) => allowed.includes(k));
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

  /** Opening balance of a party is kept as one bill named "Opening" so it shows in outstandings. */
  private syncOpeningBill(ledgerId: number) {
    this.db.prepare(`DELETE FROM bills WHERE ledger_id=? AND voucher_id IS NULL AND ref='Opening'`).run(ledgerId);
    const l = this.ledger(ledgerId);
    if (l.opening && this.isBillWise(ledgerId)) {
      const from = this.company().books_from;
      this.db.prepare(`INSERT INTO bills (voucher_id, ledger_id, ref, kind, amount, date, due_date) VALUES (NULL, ?, 'Opening', 'new', ?, ?, ?)`)
        .run(ledgerId, l.opening, addDays(from, -1), addDays(from, -1));
    }
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
    return this.db.prepare(`SELECT i.*, u.symbol AS unit, sg.name AS stock_group FROM items i JOIN units u ON u.id=i.unit_id LEFT JOIN stock_groups sg ON sg.id=i.stock_group_id ORDER BY i.name`).all();
  }

  item(id: number): Item {
    return (this.db.prepare(`SELECT * FROM items WHERE id=?`).get(id) as Item) ?? fail(`Item ${id} not found.`);
  }

  createItem(input: Partial<Item> & { name: string; unit_id: number; opening_batch_no?: string; opening_expiry?: string | null }) {
    return this.db.transaction(() => {
      const item = this.createItemRow(input);
      if (item.track_batch && item.opening_qty) {
        this.db.prepare(`INSERT INTO batches (item_id, batch_no, expiry_date, opening_qty) VALUES (?, ?, ?, ?)`)
          .run(item.id, input.opening_batch_no?.trim() || 'Opening', input.opening_expiry || null, item.opening_qty);
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
  }

  private createItemRow(input: Partial<Item> & { name: string; unit_id: number }) {
    const name = input.name?.trim() || fail('Item name is required.');
    this.checkItem(input);
    if (this.db.prepare(`SELECT id FROM items WHERE name=?`).get(name)) fail(`An item named "${name}" already exists.`);
    const cols = ['name', 'stock_group_id', 'unit_id', 'hsn', 'gst_rate', 'mrp', 'sale_rate', 'purchase_rate', 'track_batch',
      'reorder_level', 'scheme_buy', 'scheme_free', 'opening_qty', 'opening_value', 'taxability'] as const;
    const row: Record<string, unknown> = {};
    for (const c of cols) row[c] = (input as Record<string, unknown>)[c] ?? (c === 'stock_group_id' ? null : c === 'hsn' ? '' : c === 'taxability' ? (Number(input.gst_rate) > 0 ? 'taxable' : 'nil') : 0);
    row.name = name;
    row.track_batch = row.track_batch ? 1 : 0;
    const r = this.db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(row);
    const id = Number(r.lastInsertRowid);
    this.audit('item', id, 'create', row);
    return this.item(id);
  }

  updateItem(id: number, patch: Partial<Item>) {
    const before = this.item(id);
    const allowed = ['name', 'stock_group_id', 'unit_id', 'hsn', 'gst_rate', 'mrp', 'sale_rate', 'purchase_rate', 'track_batch',
      'reorder_level', 'scheme_buy', 'scheme_free', 'opening_qty', 'opening_value', 'taxability'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    this.checkItem(patch);
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
  batches(itemId: number, asOf = '9999-12-31', excludeVoucher = 0) {
    return this.db.prepare(`
      SELECT b.*, b.opening_qty + COALESCE((
        SELECT SUM(iv.direction * (iv.qty + iv.free_qty)) FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id
        WHERE iv.batch_id=b.id AND v.cancelled=0 AND v.date<=? AND v.id<>?), 0) AS qty
      FROM batches b WHERE b.item_id=? ORDER BY COALESCE(b.expiry_date,'9999-12-31'), b.id`).all(asOf, excludeVoucher, itemId) as
      { id: number; batch_no: string; expiry_date: string | null; mfg_date: string | null; mrp: number; qty: number }[];
  }

  private ensureBatch(itemId: number, l: InventoryLineInput): number | null {
    if (l.batchId) return l.batchId;
    if (!l.batchNo) return null;
    const existing = this.db.prepare(`SELECT id FROM batches WHERE item_id=? AND batch_no=?`).get(itemId, l.batchNo) as { id: number } | undefined;
    if (existing) return existing.id;
    const r = this.db.prepare(`INSERT INTO batches (item_id, batch_no, mfg_date, expiry_date) VALUES (?, ?, ?, ?)`)
      .run(itemId, l.batchNo, l.mfgDate ?? null, l.expiryDate ?? null);
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
        WHERE b.ledger_id=? AND b.ref=? AND b.kind='agst' AND b.voucher_id<>? AND v2.cancelled=0`).all(b.ledger_id, b.ref, v.id) as { number: string }[];
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
      this.db.prepare(`UPDATE vouchers SET cancelled=1, updated_at=datetime('now') WHERE id=?`).run(id);
      this.db.prepare(`DELETE FROM bills WHERE voucher_id=?`).run(id);
      this.audit('voucher', id, 'cancel', v);
      return this.voucher(id);
    })();
  }

  /** Stock of an item on a date, leaving out one voucher (the one being altered). */
  private stockOf(itemId: number, date: string, excludeVoucher = 0): number {
    const item = this.item(itemId);
    const r = this.db.prepare(`
      SELECT COALESCE(SUM(iv.direction * (iv.qty + iv.free_qty)), 0) q FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id
      WHERE iv.item_id=? AND v.cancelled=0 AND v.date<=? AND v.id<>?`).get(itemId, date, excludeVoucher) as { q: number };
    return Math.round((item.opening_qty + r.q) * 1000) / 1000;
  }

  private writeVoucher(input: VoucherInput, existing: ReturnType<Books['voucher']> | null) {
    if (!input || typeof input !== 'object') fail('The voucher is empty.');
    const type = input.type;
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(VOUCHER_TYPES, type)) fail(`Unknown voucher type ${String(type)}.`);
    if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date))) fail('Enter a valid date.');
    for (const k of ['number', 'narration', 'refNo', 'vehicleNo', 'transporterName', 'transporterId', 'ewbNo', 'againstRef'] as const) {
      if (input[k] !== undefined && input[k] !== null && typeof input[k] !== 'string') fail(`${k} must be text.`);
    }
    if ((input.narration ?? '').length > 2000) fail('The narration is too long (2000 characters at most).');
    const company = this.company();
    if (input.date < company.books_from) fail(`The date is before the books begin (${company.books_from}).`);
    const excludeId = existing?.id ?? 0;

    let numbering: { number: string; seq: number };
    const sameFy = existing && financialYear(existing.date).label === financialYear(input.date).label;
    if (existing && sameFy) numbering = { number: input.number?.trim() || existing.number, seq: existing.seq };
    else {
      // New voucher, or one moved into another financial year: it takes the next number of that year's series.
      numbering = this.nextNumber(type, input.date);
      const typed = input.number?.trim();
      if (typed && (!existing || typed !== existing.number)) numbering.number = typed;
    }
    if (numbering.number.length > 40) fail('The voucher number is too long.');
    if (type === 'sales' && numbering.number.length > 16) fail('A GST invoice number can have at most 16 characters.');
    if (type === 'sales' && !/^[A-Za-z0-9/-]+$/.test(numbering.number)) fail('A GST invoice number may use only letters, digits, / and -.');
    const clash = this.db.prepare(`SELECT id FROM vouchers WHERE type=? AND number=? AND id<>?`).get(type, numbering.number, excludeId);
    if (clash) fail(`${VOUCHER_TYPES[type].label} number ${numbering.number} is already used.`);

    const entries: { ledgerId: number; amount: number }[] = [];
    const bills: { ledgerId: number; ref: string; kind: 'new' | 'agst' | 'onacc'; amount: number; due: string }[] = [];
    const invLines: Record<string, unknown>[] = [];
    let header: Record<string, unknown> = { taxable: 0, cgst: 0, sgst: 0, igst: 0, round_off: 0, total: 0, intra: 1, place_of_supply: null };
    let snapshot = { gstin: '', state: '' };

    /** Checks a settlement against a pending bill of the party and returns it, or fails with a clear message. */
    const pendingFor = (ledgerId: number, ref: string) => {
      const row = this.db.prepare(`SELECT COALESCE(SUM(amount),0) p, SUM(kind='new') n FROM bills WHERE ledger_id=? AND ref=? AND COALESCE(voucher_id,0)<>?`)
        .get(ledgerId, ref, excludeId) as { p: number; n: number };
      return row;
    };

    if (VOUCHER_TYPES[type].inventory) {
      const party = this.ledger(num(input.partyId, 'party') || fail('Choose the party (customer or supplier).'));
      const account = this.ledger(input.accountId ?? (type === 'sales' || type === 'credit_note' ? this.ledgerByName('Sales')?.id : this.ledgerByName('Purchase')?.id) ?? fail('Choose the sales or purchase ledger.'));
      const lines = Array.isArray(input.lines) ? input.lines : [];
      if (!lines.length) fail('Add at least one item.');
      if (lines.length > 500) fail('A voucher can have at most 500 item lines.');
      const pos = party.state_code || company.state_code;
      const intra = isIntraState(company.state_code, pos);
      const outward = type === 'sales' || type === 'debit_note';
      const registered = isValidGstin(party.gstin || '');
      snapshot = { gstin: registered ? party.gstin : '', state: pos };

      // Credit/debit notes against a bill keep that bill's GST rates (rates change; a return is taxed as originally billed).
      const originalRates = new Map<number, number>();
      const againstRef = input.againstRef?.trim();
      if ((type === 'credit_note' || type === 'debit_note') && againstRef) {
        const orig = this.db.prepare(`
          SELECT iv.item_id, iv.gst_rate FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id
          JOIN bills b ON b.voucher_id=v.id AND b.kind='new' AND b.ref=? AND b.ledger_id=?
          WHERE v.cancelled=0`).all(againstRef, party.id) as { item_id: number; gst_rate: number }[];
        for (const o of orig) originalRates.set(o.item_id, o.gst_rate);
      }

      type Prepared = { item: Item; qty: number; free: number; rate: number; disc: number; gstRate: number; batchId: number | null };
      const prepared: Prepared[] = [];
      const needByItem = new Map<number, number>();
      for (const l of lines) {
        if (!l || typeof l !== 'object') fail('An item line is empty.');
        const item = this.item(num(l.itemId, 'item'));
        const qty = num(l.qty, 'quantity');
        const rate = num(l.rate, 'rate');
        const free = l.freeQty === undefined || l.freeQty === null ? (type === 'sales' ? schemeFreeQty(qty, item.scheme_buy, item.scheme_free) : 0) : num(l.freeQty, 'free quantity');
        const disc = l.discountPct === undefined || l.discountPct === null ? 0 : num(l.discountPct, 'discount');
        if (!(qty > 0) || qty > 1e7) fail(`Enter a quantity for ${item.name}.`);
        if (!(rate >= 0) || rate > 1e11) fail(`Enter a rate for ${item.name}.`);
        if (free < 0 || free > 1e7) fail(`Free quantity for ${item.name} cannot be negative.`);
        if (disc < 0 || disc > 100) fail(`Discount for ${item.name} must be between 0 and 100%.`);
        let gstRate = l.gstRate === undefined || l.gstRate === null ? (originalRates.get(item.id) ?? item.gst_rate) : num(l.gstRate, 'GST rate');
        if (gstRate < 0 || gstRate > 40) fail(`GST rate for ${item.name} must be between 0 and 40%.`);
        if (item.taxability !== 'taxable') gstRate = 0;
        // An unregistered supplier cannot charge GST, so there is no tax (and no input credit) on the purchase.
        if ((type === 'purchase' || type === 'debit_note') && !registered) gstRate = 0;
        if ((type === 'sales' || type === 'credit_note') && gstRate > 0 && !HSN_RE.test(item.hsn || '')) {
          fail(`Add a 4, 6 or 8 digit HSN code to "${item.name}" first (Alter → Stock Item). GSTR-1 needs it.`);
        }
        // Keep the rate to 1/100 paise, so landing rates like ₹42.3729 are not cut short before qty × rate.
        const exactRate = Math.round(rate * 100) / 100;
        const base = { item, qty, free, rate: exactRate, disc, gstRate };
        needByItem.set(item.id, (needByItem.get(item.id) ?? 0) + qty + free);

        if (!item.track_batch) {
          if (l.batchId) this.ownBatch(item.id, l.batchId);
          prepared.push({ ...base, batchId: null });
          continue;
        }
        if (type === 'purchase' || type === 'credit_note') {
          const bid = l.batchId ? this.ownBatch(item.id, l.batchId) : this.ensureBatch(item.id, l);
          if (!bid) fail(`Enter a batch number for ${item.name}.`);
          prepared.push({ ...base, batchId: bid });
          continue;
        }
        if (l.batchId) { prepared.push({ ...base, batchId: this.ownBatch(item.id, l.batchId) }); continue; }
        // Outward without a chosen batch: take from the soonest-expiring batches that are not expired (FEFO),
        // splitting the line when one batch does not have enough.
        for (const part of this.allocateBatches(item, qty, free, input.date, excludeId)) prepared.push({ ...base, ...part });
      }

      if (outward && !company.allow_negative_stock) {
        for (const [itemId, need] of needByItem) {
          const have = this.stockOf(itemId, input.date, excludeId);
          if (need > have + 1e-9) fail(`Not enough stock of ${this.item(itemId).name}: ${have} in stock on ${input.date}, this voucher needs ${need}.`);
        }
      }

      const totals = computeInvoice(prepared.map((p) => ({ qty: p.qty, rate: p.rate, discountPct: p.disc, gstRate: p.gstRate })), intra);
      const direction = outward ? -1 : 1;
      prepared.forEach((p, i) => {
        const t = totals.lines[i];
        invLines.push({
          line_no: i + 1, item_id: p.item.id, batch_id: p.batchId, qty: p.qty, free_qty: p.free, rate: p.rate,
          discount_pct: p.disc, gst_rate: p.gstRate, taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, direction,
        });
      });
      // Sales and debit notes debit the party; purchases and credit notes credit it.
      const partySign = outward ? 1 : -1;
      entries.push({ ledgerId: party.id, amount: partySign * totals.total });
      entries.push({ ledgerId: account.id, amount: -partySign * totals.taxable });
      if (totals.cgst) entries.push({ ledgerId: this.taxLedger('cgst').id, amount: -partySign * totals.cgst });
      if (totals.sgst) entries.push({ ledgerId: this.taxLedger('sgst').id, amount: -partySign * totals.sgst });
      if (totals.igst) entries.push({ ledgerId: this.taxLedger('igst').id, amount: -partySign * totals.igst });
      if (totals.roundOff) entries.push({ ledgerId: this.taxLedger('roundoff').id, amount: -partySign * totals.roundOff });
      header = {
        taxable: totals.taxable, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, round_off: totals.roundOff,
        total: totals.total, intra: intra ? 1 : 0, place_of_supply: pos,
      };
      header.party_id = party.id;
      header.account_id = account.id;
      if (this.isBillWise(party.id)) {
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
      if (type === 'journal') {
        for (const e of lines) entries.push({ ledgerId: this.ledger(num(e?.ledgerId, 'ledger')).id, amount: amountOf(e.amount) });
        if (entries.some((e) => e.amount === 0)) fail('Each line needs an amount.');
      } else {
        const account = this.ledger(num(input.accountId, 'account') || fail('Choose the cash or bank account.'));
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
        const signed = type === 'journal' ? Math.round(e.amount) : (type === 'receipt' ? -1 : 1) * Math.abs(Math.round(e.amount));
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
    if (header.total === 0) fail('The voucher total is zero.');

    if (existing) {
      // Bills that other vouchers settle must keep their party and reference.
      const dep = this.dependants(existing);
      if (dep.found.length) {
        const keeps = dep.own.every((o) => bills.some((b) => b.kind === 'new' && b.ledgerId === o.ledger_id && b.ref === o.ref));
        if (!keeps) fail(`${existing.number} has ${[...new Set(dep.found.map((d) => d.number))].join(', ')} set against it, so its party and bill number cannot change.`);
      }
    }

    const row = {
      type, number: numbering.number, seq: numbering.seq, date: input.date, narration: input.narration ?? '',
      party_id: header.party_id ?? null, account_id: header.account_id ?? null, place_of_supply: header.place_of_supply ?? null,
      intra: header.intra, taxable: header.taxable, cgst: header.cgst, sgst: header.sgst, igst: header.igst,
      round_off: header.round_off, total: header.total, ref_no: (input.refNo?.trim() || ((type === 'credit_note' || type === 'debit_note') ? input.againstRef?.trim() : '') || '').slice(0, 40), ref_date: input.refDate ?? null,
      vehicle_no: (input.vehicleNo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15), distance_km: Math.max(0, Math.min(4000, Math.round(Number(input.distanceKm) || 0))),
      transporter_name: (input.transporterName ?? '').slice(0, 100), transporter_id: (input.transporterId ?? '').slice(0, 15), ewb_no: (input.ewbNo ?? ((existing as Record<string, unknown> | null)?.ewb_no as string) ?? '').replace(/\D/g, '').slice(0, 12),
      party_gstin: snapshot.gstin, party_state: snapshot.state,
    };
    let id: number;
    if (existing) {
      id = existing.id;
      this.db.prepare(`UPDATE vouchers SET ${Object.keys(row).map((k) => `${k}=@${k}`).join(', ')}, updated_at=datetime('now') WHERE id=@id`).run({ ...row, id });
      this.db.prepare(`DELETE FROM entries WHERE voucher_id=?`).run(id);
      this.db.prepare(`DELETE FROM inventory WHERE voucher_id=?`).run(id);
      this.db.prepare(`DELETE FROM bills WHERE voucher_id=?`).run(id);
    } else {
      const r = this.db.prepare(`INSERT INTO vouchers (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map((k) => '@' + k).join(',')})`).run(row);
      id = Number(r.lastInsertRowid);
    }
    const insE = this.db.prepare(`INSERT INTO entries (voucher_id, ledger_id, amount) VALUES (?, ?, ?)`);
    for (const e of entries) if (e.amount) insE.run(id, e.ledgerId, e.amount);
    const insI = this.db.prepare(`INSERT INTO inventory (voucher_id, line_no, item_id, batch_id, qty, free_qty, rate, discount_pct, gst_rate, taxable, cgst, sgst, igst, direction)
      VALUES (@voucher_id, @line_no, @item_id, @batch_id, @qty, @free_qty, @rate, @discount_pct, @gst_rate, @taxable, @cgst, @sgst, @igst, @direction)`);
    for (const l of invLines) insI.run({ ...l, voucher_id: id });
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
  private allocateBatches(item: Item, qty: number, free: number, date: string, excludeVoucher: number) {
    const list = this.batches(item.id, date, excludeVoucher).filter((b) => b.qty > 0 && !(b.expiry_date && b.expiry_date < date));
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
      const anyExpired = this.batches(item.id, date, excludeVoucher).some((b) => b.qty > 0 && b.expiry_date && b.expiry_date < date);
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
      (Record<string, unknown> & { id: number; type: string; number: string; seq: number; date: string; cancelled: number; total: number; party_id: number | null }) | undefined;
    if (!v) fail(`Voucher ${id} not found.`);
    const entries = this.db.prepare(`SELECT e.ledger_id, l.name AS ledger_name, e.amount FROM entries e JOIN ledgers l ON l.id=e.ledger_id WHERE voucher_id=? ORDER BY e.id`).all(id);
    const lines = this.db.prepare(`
      SELECT iv.*, i.name AS item_name, i.hsn, u.symbol AS unit, u.uqc, b.batch_no, b.expiry_date
      FROM inventory iv JOIN items i ON i.id=iv.item_id JOIN units u ON u.id=i.unit_id LEFT JOIN batches b ON b.id=iv.batch_id
      WHERE voucher_id=? ORDER BY line_no`).all(id);
    const bills = this.db.prepare(`SELECT ledger_id, ref, kind, amount, due_date FROM bills WHERE voucher_id=?`).all(id);
    return { ...v!, entries, lines, bills };
  }

  vouchers(opts: { from?: string; to?: string; type?: string; ledgerId?: number } = {}) {
    const where = ['1=1'];
    const args: unknown[] = [];
    if (opts.from) { where.push('v.date>=?'); args.push(opts.from); }
    if (opts.to) { where.push('v.date<=?'); args.push(opts.to); }
    if (opts.type) { where.push('v.type=?'); args.push(opts.type); }
    if (opts.ledgerId) { where.push('v.id IN (SELECT voucher_id FROM entries WHERE ledger_id=?)'); args.push(opts.ledgerId); }
    return this.db.prepare(`
      SELECT v.id, v.type, v.number, v.date, v.total, v.cancelled, v.narration, v.ewb_no, v.party_id,
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
