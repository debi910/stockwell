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
  invoice_terms: string; backup_dir: string;
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
}

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
    this.db.prepare(`UPDATE company SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=1`).run(patch);
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
    return l;
  }

  createLedger(input: Partial<Ledger> & { name: string; group_id: number }) {
    const l = this.cleanLedger(input);
    this.group(l.group_id!);
    if (this.ledgerByName(l.name!)) fail(`A ledger named "${l.name}" already exists.`);
    const cols = ['name', 'group_id', 'opening', 'gstin', 'state_code', 'address', 'city', 'pincode', 'phone',
      'credit_days', 'beat', 'salesman', 'msme_supplier', 'msme_buyer', 'udyam_no'] as const;
    const row: Record<string, unknown> = {};
    for (const c of cols) row[c] = (l as Record<string, unknown>)[c] ?? (c === 'opening' || c === 'credit_days' || c.startsWith('msme') ? 0 : '');
    row.msme_supplier = row.msme_supplier ? 1 : 0;
    row.msme_buyer = row.msme_buyer ? 1 : 0;
    const r = this.db.prepare(`INSERT INTO ledgers (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(row);
    const id = Number(r.lastInsertRowid);
    this.syncOpeningBill(id);
    this.audit('ledger', id, 'create', row);
    return this.ledger(id);
  }

  updateLedger(id: number, patch: Partial<Ledger>) {
    const before = this.ledger(id);
    const l = this.cleanLedger(patch);
    if (l.name && l.name.toLowerCase() !== before.name.toLowerCase() && this.ledgerByName(l.name)) fail(`A ledger named "${l.name}" already exists.`);
    const allowed = ['name', 'group_id', 'opening', 'gstin', 'state_code', 'address', 'city', 'pincode', 'phone',
      'credit_days', 'beat', 'salesman', 'msme_supplier', 'msme_buyer', 'udyam_no'];
    const keys = Object.keys(l).filter((k) => allowed.includes(k));
    if (keys.length) {
      const row: Record<string, unknown> = { ...l, id };
      if ('msme_supplier' in row) row.msme_supplier = row.msme_supplier ? 1 : 0;
      if ('msme_buyer' in row) row.msme_buyer = row.msme_buyer ? 1 : 0;
      this.db.prepare(`UPDATE ledgers SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@id`).run(row);
    }
    this.syncOpeningBill(id);
    this.audit('ledger', id, 'update', { before, patch });
    return this.ledger(id);
  }

  deleteLedger(id: number) {
    const l = this.ledger(id);
    if (l.builtin) fail(`"${l.name}" is needed by Stockwell and cannot be deleted.`);
    const used = this.db.prepare(`SELECT COUNT(*) n FROM entries WHERE ledger_id=?`).get(id) as { n: number };
    if (used.n) fail(`"${l.name}" has entries and cannot be deleted.`);
    this.db.prepare(`DELETE FROM bills WHERE ledger_id=? AND voucher_id IS NULL`).run(id);
    this.db.prepare(`DELETE FROM ledgers WHERE id=?`).run(id);
    this.audit('ledger', id, 'delete', l);
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

  private createItemRow(input: Partial<Item> & { name: string; unit_id: number }) {
    const name = input.name?.trim() || fail('Item name is required.');
    if (this.db.prepare(`SELECT id FROM items WHERE name=?`).get(name)) fail(`An item named "${name}" already exists.`);
    const cols = ['name', 'stock_group_id', 'unit_id', 'hsn', 'gst_rate', 'mrp', 'sale_rate', 'purchase_rate', 'track_batch',
      'reorder_level', 'scheme_buy', 'scheme_free', 'opening_qty', 'opening_value'] as const;
    const row: Record<string, unknown> = {};
    for (const c of cols) row[c] = (input as Record<string, unknown>)[c] ?? (c === 'stock_group_id' ? null : c === 'hsn' ? '' : 0);
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
      'reorder_level', 'scheme_buy', 'scheme_free', 'opening_qty', 'opening_value'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (keys.length) {
      const row: Record<string, unknown> = { ...patch, id };
      if ('track_batch' in row) row.track_batch = row.track_batch ? 1 : 0;
      this.db.prepare(`UPDATE items SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@id`).run(row);
    }
    this.audit('item', id, 'update', { before, patch });
    return this.item(id);
  }

  /** Batches of an item with the quantity left, soonest expiry first (FEFO). */
  batches(itemId: number, asOf = '9999-12-31') {
    return this.db.prepare(`
      SELECT b.*, b.opening_qty + COALESCE((
        SELECT SUM(iv.direction * (iv.qty + iv.free_qty)) FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id
        WHERE iv.batch_id=b.id AND v.cancelled=0 AND v.date<=?), 0) AS qty
      FROM batches b WHERE b.item_id=? ORDER BY COALESCE(b.expiry_date,'9999-12-31'), b.id`).all(asOf, itemId) as
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
    const fy = financialYear(date);
    const row = this.db.prepare(`SELECT MAX(seq) m FROM vouchers WHERE type=? AND date BETWEEN ? AND ?`).get(type, fy.start, fy.end) as { m: number | null };
    const seq = (row.m ?? 0) + 1;
    return { number: `${VOUCHER_TYPES[type].prefix}/${fy.label}/${seq}`, seq };
  }

  createVoucher(input: VoucherInput) {
    return this.db.transaction(() => this.writeVoucher(input, null))();
  }

  updateVoucher(id: number, input: VoucherInput) {
    return this.db.transaction(() => {
      const before = this.voucher(id);
      if (before.cancelled) fail('A cancelled voucher cannot be changed.');
      return this.writeVoucher({ ...input, type: before.type as VoucherType }, before);
    })();
  }

  cancelVoucher(id: number) {
    const v = this.voucher(id);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE vouchers SET cancelled=1, updated_at=datetime('now') WHERE id=?`).run(id);
      this.db.prepare(`DELETE FROM bills WHERE voucher_id=?`).run(id);
      this.audit('voucher', id, 'cancel', v);
    })();
    return this.voucher(id);
  }

  private writeVoucher(input: VoucherInput, existing: ReturnType<Books['voucher']> | null) {
    const type = input.type;
    if (!VOUCHER_TYPES[type]) fail(`Unknown voucher type ${type}.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) fail('Enter a valid date.');
    const company = this.company();
    if (input.date < company.books_from) fail(`The date is before the books begin (${company.books_from}).`);

    let numbering: { number: string; seq: number };
    if (existing) numbering = { number: input.number?.trim() || existing.number, seq: existing.seq };
    else {
      numbering = this.nextNumber(type, input.date);
      if (input.number?.trim()) numbering.number = input.number.trim();
    }
    if (type === 'sales' && numbering.number.length > 16) fail('A GST invoice number can have at most 16 characters.');
    const clash = this.db.prepare(`SELECT id FROM vouchers WHERE type=? AND number=? AND id<>?`).get(type, numbering.number, existing?.id ?? 0);
    if (clash) fail(`${VOUCHER_TYPES[type].label} number ${numbering.number} is already used.`);

    const entries: { ledgerId: number; amount: number }[] = [];
    const bills: { ledgerId: number; ref: string; kind: 'new' | 'agst' | 'onacc'; amount: number; due: string }[] = [];
    const invLines: Record<string, unknown>[] = [];
    let header: Record<string, unknown> = { taxable: 0, cgst: 0, sgst: 0, igst: 0, round_off: 0, total: 0, intra: 1, place_of_supply: null };

    if (VOUCHER_TYPES[type].inventory) {
      const party = this.ledger(input.partyId ?? fail('Choose the party (customer or supplier).'));
      const account = this.ledger(input.accountId ?? (type === 'sales' || type === 'credit_note' ? this.ledgerByName('Sales')?.id : this.ledgerByName('Purchase')?.id) ?? fail('Choose the sales or purchase ledger.'));
      const lines = input.lines ?? [];
      if (!lines.length) fail('Add at least one item.');
      const pos = party.state_code || company.state_code;
      const intra = isIntraState(company.state_code, pos);
      const prepared = lines.map((l) => {
        const item = this.item(l.itemId);
        if (!(l.qty > 0)) fail(`Enter a quantity for ${item.name}.`);
        if (!(l.rate >= 0)) fail(`Enter a rate for ${item.name}.`);
        const gstRate = l.gstRate ?? item.gst_rate;
        const freeQty = l.freeQty ?? (type === 'sales' ? schemeFreeQty(l.qty, item.scheme_buy, item.scheme_free) : 0);
        let batchId: number | null = null;
        if (item.track_batch) {
          batchId = type === 'purchase' || type === 'credit_note'
            ? this.ensureBatch(item.id, l)
            : l.batchId ?? this.pickBatch(item.id, l.qty + freeQty, input.date);
          if (!batchId) fail(`Choose a batch for ${item.name}.`);
        }
        return { item, l, gstRate, freeQty, batchId };
      });
      const totals = computeInvoice(prepared.map((p) => ({ qty: p.l.qty, rate: Math.round(p.l.rate), discountPct: p.l.discountPct, gstRate: p.gstRate })), intra);
      const direction = type === 'sales' || type === 'debit_note' ? -1 : 1;
      prepared.forEach((p, i) => {
        const t = totals.lines[i];
        invLines.push({
          line_no: i + 1, item_id: p.item.id, batch_id: p.batchId, qty: p.l.qty, free_qty: p.freeQty, rate: Math.round(p.l.rate),
          discount_pct: p.l.discountPct ?? 0, gst_rate: p.gstRate, taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, direction,
        });
      });
      // Sales and debit notes debit the party; purchases and credit notes credit it.
      const partySign = type === 'sales' || type === 'debit_note' ? 1 : -1;
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
          const ref = type === 'purchase' && input.refNo?.trim() ? input.refNo.trim() : numbering.number;
          bills.push({ ledgerId: party.id, ref, kind: 'new', amount: partySign * totals.total, due: addDays(input.date, party.credit_days || 0) });
        } else {
          const ref = input.againstRef?.trim();
          bills.push({ ledgerId: party.id, ref: ref || numbering.number, kind: ref ? 'agst' : 'onacc', amount: partySign * totals.total, due: input.date });
        }
      }
    } else {
      const lines = input.entries ?? [];
      if (!lines.length) fail('Add at least one ledger line.');
      if (type === 'journal') {
        for (const e of lines) entries.push({ ledgerId: this.ledger(e.ledgerId).id, amount: Math.round(e.amount) });
      } else {
        const account = this.ledger(input.accountId ?? fail('Choose the cash or bank account.'));
        // Receipt: money comes in, account is debited and particulars credited. Payment/contra: the reverse.
        const sign = type === 'receipt' ? -1 : 1;
        let sum = 0;
        for (const e of lines) {
          const amt = Math.round(Math.abs(e.amount));
          if (!amt) fail('Each line needs an amount.');
          entries.push({ ledgerId: this.ledger(e.ledgerId).id, amount: sign * amt });
          sum += amt;
        }
        entries.push({ ledgerId: account.id, amount: -sign * sum });
        header.account_id = account.id;
        if (lines.length === 1) header.party_id = lines[0].ledgerId;
      }
      for (const e of lines) {
        if (!this.isBillWise(e.ledgerId)) continue;
        const signed = type === 'journal' ? Math.round(e.amount) : (type === 'receipt' ? -1 : 1) * Math.round(Math.abs(e.amount));
        let left = signed;
        for (const b of e.bills ?? []) {
          const amt = Math.sign(signed) * Math.abs(Math.round(b.amount));
          if (!amt) continue;
          bills.push({ ledgerId: e.ledgerId, ref: b.ref, kind: b.kind ?? 'agst', amount: amt, due: input.date });
          left -= amt;
        }
        if (left) bills.push({ ledgerId: e.ledgerId, ref: numbering.number, kind: 'onacc', amount: left, due: input.date });
      }
      header.total = entries.filter((e) => e.amount > 0).reduce((a, e) => a + e.amount, 0);
    }

    const net = entries.reduce((a, e) => a + e.amount, 0);
    if (net !== 0) fail(`Debit and credit do not match (difference ${(net / 100).toFixed(2)}).`);
    if (header.total === 0) fail('The voucher total is zero.');

    const row = {
      type, number: numbering.number, seq: numbering.seq, date: input.date, narration: input.narration ?? '',
      party_id: header.party_id ?? null, account_id: header.account_id ?? null, place_of_supply: header.place_of_supply ?? null,
      intra: header.intra, taxable: header.taxable, cgst: header.cgst, sgst: header.sgst, igst: header.igst,
      round_off: header.round_off, total: header.total, ref_no: input.refNo ?? '', ref_date: input.refDate ?? null,
      vehicle_no: (input.vehicleNo ?? '').toUpperCase().replace(/\s/g, ''), distance_km: input.distanceKm ?? 0,
      transporter_name: input.transporterName ?? '', transporter_id: input.transporterId ?? '', ewb_no: input.ewbNo ?? '',
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

  /** First-expiring batch that still has enough stock; falls back to the first batch with any stock. */
  private pickBatch(itemId: number, qty: number, date: string): number | null {
    const list = this.batches(itemId, date);
    return (list.find((b) => b.qty >= qty) ?? list.find((b) => b.qty > 0) ?? list[0])?.id ?? null;
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
