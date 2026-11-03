import type { Books, Group } from './books';
import { addDays, daysBetween, financialYear, todayISO } from '../core/dates';

export interface BalanceRow { id: number; name: string; group_id: number; balance: number }

export interface GroupNode {
  id: number;
  name: string;
  nature: string;
  balance: number; // +Dr
  groups: GroupNode[];
  ledgers: { id: number; name: string; balance: number }[];
}

/** Closing balance of every ledger on a date (+Dr / -Cr), opening included. */
export function ledgerBalances(books: Books, asOf: string, from?: string): BalanceRow[] {
  const rows = books.db.prepare(`
    SELECT l.id, l.name, l.group_id,
      ${from ? '0' : 'l.opening'} + COALESCE((SELECT SUM(e.amount) FROM entries e JOIN vouchers v ON v.id=e.voucher_id
        WHERE e.ledger_id=l.id AND v.cancelled=0 AND v.optional=0 AND v.date<=? ${from ? 'AND v.date>=?' : ''}), 0) AS balance
    FROM ledgers l ORDER BY l.name`).all(...(from ? [asOf, from] : [asOf])) as BalanceRow[];
  return rows;
}

/** First day of the financial year of a date, but never before the books begin. */
export function yearStart(books: Books, asOf: string): string {
  const fy = financialYear(asOf).start;
  const from = books.company().books_from;
  return fy > from ? fy : from;
}

const INCOME_EXPENSE = `SELECT l.id FROM ledgers l JOIN groups g ON g.id=l.group_id WHERE g.nature IN ('income','expense')`;

/**
 * Balances as Tally shows them in the trial balance: assets and liabilities carry forward,
 * income and expense ledgers start again at zero each April.
 */
export function yearBalances(books: Books, asOf: string): BalanceRow[] {
  const start = yearStart(books, asOf);
  const ie = new Set((books.db.prepare(INCOME_EXPENSE).all() as { id: number }[]).map((r) => r.id));
  const thisYear = new Map(ledgerBalances(books, asOf, start).map((b) => [b.id, b.balance]));
  return ledgerBalances(books, asOf).map((b) => (ie.has(b.id) ? { ...b, balance: thisYear.get(b.id) ?? 0 } : b));
}

export function groupTree(books: Books, balances: BalanceRow[], include: (g: Group) => boolean = () => true): GroupNode[] {
  const groups = books.groups();
  const nodes = new Map<number, GroupNode>();
  for (const g of groups) nodes.set(g.id, { id: g.id, name: g.name, nature: g.nature, balance: 0, groups: [], ledgers: [] });
  for (const b of balances) {
    if (b.balance === 0) continue;
    nodes.get(b.group_id)!.ledgers.push({ id: b.id, name: b.name, balance: b.balance });
  }
  const roots: GroupNode[] = [];
  for (const g of groups) {
    const n = nodes.get(g.id)!;
    if (g.parent_id) nodes.get(g.parent_id)!.groups.push(n);
    else if (include(g)) roots.push(n);
  }
  const total = (n: GroupNode): number => {
    n.balance = n.ledgers.reduce((a, l) => a + l.balance, 0) + n.groups.reduce((a, g) => a + total(g), 0);
    return n.balance;
  };
  roots.forEach(total);
  const prune = (n: GroupNode): GroupNode | null => {
    n.groups = n.groups.map(prune).filter(Boolean) as GroupNode[];
    return n.groups.length || n.ledgers.length ? n : null;
  };
  return roots.map(prune).filter(Boolean) as GroupNode[];
}

// ---------- stock ----------
export interface StockRow {
  id: number; name: string; unit: string; stock_group: string | null; hsn: string; gst_rate: number;
  opening_qty: number; inward: number; outward: number; closing_qty: number; rate: number; value: number; reorder_level: number;
}

/** Stock position on a date, valued at weighted average purchase cost. */
export function stockSummary(books: Books, asOf: string, from?: string): StockRow[] {
  const items = books.db.prepare(`
    SELECT i.*, u.symbol AS unit, sg.name AS stock_group FROM items i JOIN units u ON u.id=i.unit_id
    LEFT JOIN stock_groups sg ON sg.id=i.stock_group_id ORDER BY sg.name, i.name`).all() as
    { id: number; name: string; unit: string; stock_group: string | null; hsn: string; gst_rate: number; opening_qty: number; opening_value: number; reorder_level: number }[];
  const move = books.db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN iv.direction>0 AND v.date<? THEN iv.qty+iv.free_qty END),0) AS in_before,
      COALESCE(SUM(CASE WHEN iv.direction<0 AND v.date<? THEN iv.qty+iv.free_qty END),0) AS out_before,
      COALESCE(SUM(CASE WHEN iv.direction>0 AND v.date>=? THEN iv.qty+iv.free_qty END),0) AS inward,
      COALESCE(SUM(CASE WHEN iv.direction<0 AND v.date>=? THEN iv.qty+iv.free_qty END),0) AS outward,
      COALESCE(SUM(CASE WHEN v.type='purchase' THEN iv.qty+iv.free_qty WHEN v.type='debit_note' THEN -(iv.qty+iv.free_qty) END),0) AS bought_qty,
      COALESCE(SUM(CASE WHEN v.type='purchase' THEN iv.taxable WHEN v.type='debit_note' THEN -iv.taxable END),0) AS bought_value
    FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id
    WHERE iv.item_id=? AND v.cancelled=0 AND v.optional=0 AND v.date<=?`);
  const start = from ?? '0000-01-01';
  return items.map((i) => {
    const m = move.get(start, start, start, start, i.id, asOf) as Record<string, number>;
    const opening = i.opening_qty + m.in_before - m.out_before;
    const closing = opening + m.inward - m.outward;
    const costQty = i.opening_qty + m.bought_qty;
    const rate = costQty > 0 ? (i.opening_value + m.bought_value) / costQty : 0;
    return {
      id: i.id, name: i.name, unit: i.unit, stock_group: i.stock_group, hsn: i.hsn, gst_rate: i.gst_rate,
      opening_qty: round3(opening), inward: round3(m.inward), outward: round3(m.outward), closing_qty: round3(closing),
      rate: Math.round(rate), value: Math.round(closing * rate), reorder_level: i.reorder_level,
    };
  });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function stockValue(books: Books, asOf: string): number {
  return stockSummary(books, asOf).reduce((a, r) => a + r.value, 0);
}

export function openingStockValue(books: Books): number {
  return (books.db.prepare(`SELECT COALESCE(SUM(opening_value),0) v FROM items`).get() as { v: number }).v;
}

// ---------- statements ----------
export function trialBalance(books: Books, asOf: string) {
  const start = yearStart(books, asOf);
  const booksFrom = books.company().books_from;
  const balances = yearBalances(books, asOf);
  const tree = groupTree(books, balances);
  const openingStockBooks = openingStockValue(books);
  // From the second year on, earlier years' result sits in the Profit & Loss A/c line, and the year
  // opens with the stock that was on hand at its start (as in Tally).
  let profitLossAc = 0;
  let openingStock = openingStockBooks;
  if (start > booksFrom) {
    const ie = new Set((books.db.prepare(INCOME_EXPENSE).all() as { id: number }[]).map((r) => r.id));
    const earlierIE = ledgerBalances(books, addDays(start, -1)).filter((b) => ie.has(b.id)).reduce((a, b) => a + b.balance, 0);
    openingStock = stockValue(books, addDays(start, -1));
    profitLossAc = earlierIE + openingStockBooks - openingStock; // +Dr: a loss; -Cr: a profit
  }
  const dr = balances.filter((b) => b.balance > 0).reduce((a, b) => a + b.balance, 0) + Math.max(0, profitLossAc);
  const cr = -balances.filter((b) => b.balance < 0).reduce((a, b) => a + b.balance, 0) + Math.max(0, -profitLossAc);
  const openingDiff = (books.db.prepare(`SELECT COALESCE(SUM(opening),0) s FROM ledgers`).get() as { s: number }).s + openingStockBooks;
  return { asOf, from: start, tree, openingStock, profitLossAc, openingDiff, totalDr: dr + openingStock, totalCr: cr };
}

function sumNature(tree: GroupNode[], pick: (n: GroupNode) => boolean) {
  return tree.filter(pick);
}

export function profitAndLoss(books: Books, from: string, to: string) {
  const balances = ledgerBalances(books, to, from);
  const groups = books.groups();
  const byId = new Map(groups.map((g) => [g.id, g]));
  const tree = groupTree(books, balances, (g) => g.nature === 'income' || g.nature === 'expense');
  const direct = (n: GroupNode) => !!byId.get(n.id)?.direct;
  const openingStock = from <= books.company().books_from ? openingStockValue(books) : stockValue(books, addDays(from, -1));
  const closingStock = stockValue(books, to);
  const tradingDr = sumNature(tree, (n) => n.nature === 'expense' && direct(n));
  const tradingCr = sumNature(tree, (n) => n.nature === 'income' && direct(n));
  const indirectDr = sumNature(tree, (n) => n.nature === 'expense' && !direct(n));
  const indirectCr = sumNature(tree, (n) => n.nature === 'income' && !direct(n));
  const t = (list: GroupNode[]) => list.reduce((a, n) => a + n.balance, 0);
  const grossProfit = -t(tradingCr) + closingStock - openingStock - t(tradingDr);
  const netProfit = grossProfit - t(indirectDr) - t(indirectCr);
  return { from, to, openingStock, closingStock, tradingDr, tradingCr, indirectDr, indirectCr, grossProfit, netProfit };
}

export function balanceSheet(books: Books, asOf: string) {
  const fy = financialYear(asOf);
  const from = fy.start < books.company().books_from ? books.company().books_from : fy.start;
  const pl = profitAndLoss(books, from, asOf);
  // Profit of earlier years stays inside the P&L account until it is moved to capital.
  const earlier = from > books.company().books_from ? profitAndLoss(books, books.company().books_from, addDays(from, -1)).netProfit : 0;
  const balances = ledgerBalances(books, asOf);
  const tree = groupTree(books, balances, (g) => g.nature === 'asset' || g.nature === 'liability');
  const liabilities = tree.filter((n) => n.nature === 'liability');
  const assets = tree.filter((n) => n.nature === 'asset');
  const openingStock = openingStockValue(books);
  const openingDiff = (books.db.prepare(`SELECT COALESCE(SUM(opening),0) s FROM ledgers`).get() as { s: number }).s + openingStock;
  const totalLiab = -liabilities.reduce((a, n) => a + n.balance, 0) + pl.netProfit + earlier + (openingDiff > 0 ? openingDiff : 0);
  const totalAssets = assets.reduce((a, n) => a + n.balance, 0) + pl.closingStock + (openingDiff < 0 ? -openingDiff : 0);
  return {
    asOf, liabilities, assets, profit: pl.netProfit + earlier, closingStock: pl.closingStock, openingDiff,
    totalLiabilities: totalLiab, totalAssets,
  };
}

export function ledgerStatement(books: Books, ledgerId: number, from: string, to: string) {
  const l = books.ledger(ledgerId);
  // Income and expense ledgers start each financial year at zero.
  const nature = books.group(l.group_id).nature;
  const pl = nature === 'income' || nature === 'expense';
  const floor = pl ? yearStart(books, from) : '0000-01-01';
  const before = books.db.prepare(`
    SELECT COALESCE(SUM(e.amount),0) s FROM entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE e.ledger_id=? AND v.cancelled=0 AND v.optional=0 AND v.date<? AND v.date>=?`).get(ledgerId, from, floor) as { s: number };
  const opening = (pl ? 0 : l.opening) + before.s;
  const rows = books.db.prepare(`
    SELECT v.id AS voucher_id, v.date, v.type, v.number, v.narration, e.amount,
      (SELECT GROUP_CONCAT(l2.name, ', ') FROM entries e2 JOIN ledgers l2 ON l2.id=e2.ledger_id
        WHERE e2.voucher_id=v.id AND e2.ledger_id<>e.ledger_id AND SIGN(e2.amount)<>SIGN(e.amount)) AS particulars
    FROM entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE e.ledger_id=? AND v.cancelled=0 AND v.optional=0 AND v.date BETWEEN ? AND ? ORDER BY v.date, v.id`).all(ledgerId, from, to) as
    { voucher_id: number; date: string; type: string; number: string; narration: string; amount: number; particulars: string }[];
  let running = opening;
  const lines = rows.map((r) => ({ ...r, balance: (running += r.amount) }));
  return { ledger: l, from, to, opening, lines, closing: running };
}

export function dayBook(books: Books, from: string, to: string) {
  return books.vouchers({ from, to });
}

// ---------- alerts ----------
export function alerts(books: Books, asOf = todayISO()) {
  const company = books.company();
  const pending = books.pendingBills({ asOf });
  const overdue = pending.filter((b) => b.pending > 0 && b.overdue_days > 0)
    .sort((a, b) => b.overdue_days - a.overdue_days);

  // MSMED Act: payment is due within the agreed period, at most 45 days, or 15 days if nothing was agreed.
  const msmeLimit = (creditDays: number) => Math.min(creditDays > 0 ? creditDays : 15, 45);
  const rate = company.msme_interest_rate || 0;
  /** s.16 MSMED Act: compound interest with monthly rests from the day after the due date until payment. */
  const interestOn = (amount: number, lateDays: number) => {
    if (rate <= 0 || lateDays <= 0 || amount <= 0) return 0;
    const months = Math.floor(lateDays / 30);
    const days = lateDays - months * 30;
    return Math.round(amount * (Math.pow(1 + rate / 1200, months) * (1 + (rate / 100) * days / 365) - 1));
  };
  // Every MSME buyer's bill that was (or still is) paid late, including bills already settled late:
  // interest runs until the day each part was paid.
  const fyStart = financialYear(asOf).start;
  const msmeBills = books.db.prepare(`
    SELECT b.ledger_id, l.name AS ledger_name, l.phone, l.credit_days, b.ref, b.date AS bill_date, b.amount AS bill_amount
    FROM bills b JOIN ledgers l ON l.id=b.ledger_id
    WHERE l.msme_buyer=1 AND b.kind='new' AND b.voucher_id IS NOT NULL AND b.amount>0 AND b.date<=?`).all(asOf) as
    { ledger_id: number; ledger_name: string; phone: string; credit_days: number; ref: string; bill_date: string; bill_amount: number }[];
  const paymentsQ = books.db.prepare(`SELECT date, -amount AS paid FROM bills WHERE ledger_id=? AND ref=? AND kind='agst' AND date<=? ORDER BY date`);
  const msmeReceivables = msmeBills.map((b) => {
    const due = addDays(b.bill_date, msmeLimit(b.credit_days));
    let pending = b.bill_amount;
    let interest = 0;
    let lastPaid: string | null = null;
    for (const p of paymentsQ.all(b.ledger_id, b.ref, asOf) as { date: string; paid: number }[]) {
      const part = Math.min(pending, p.paid);
      interest += interestOn(part, daysBetween(due, p.date));
      pending -= part;
      lastPaid = p.date;
    }
    interest += interestOn(pending, daysBetween(due, asOf));
    const lateDays = Math.max(0, daysBetween(due, pending > 0 ? asOf : (lastPaid ?? asOf)));
    return { ...b, pending, msme_due: due, late_days: lateDays, interest, paid_late: pending <= 0 };
  }).filter((b) => b.late_days > 0 && (b.pending > 0 || (b.bill_date >= fyStart && b.interest > 0) || (b.bill_date >= fyStart && rate === 0)))
    .sort((a, b) => b.late_days - a.late_days);

  // Section 43B(h): our own purchases from MSME suppliers must be paid within the same limit to stay tax-deductible.
  const msmePayables = pending
    .filter((b) => b.pending < 0 && b.msme_supplier)
    .map((b) => {
      const limit = msmeLimit(b.credit_days);
      return { ...b, pay_by: addDays(b.bill_date, limit), days_left: limit - b.age_days };
    })
    .filter((b) => b.days_left <= 7)
    .sort((a, b) => a.days_left - b.days_left);

  const expiring = books.db.prepare(`SELECT id, name FROM items WHERE track_batch=1`).all() as { id: number; name: string }[];
  const expiringBatches = expiring.flatMap((i) =>
    books.batches(i.id, asOf)
      .filter((b) => b.qty > 0 && b.expiry_date && daysBetween(asOf, b.expiry_date) <= company.expiry_alert_days)
      .map((b) => ({ item_id: i.id, item_name: i.name, batch_no: b.batch_no, expiry_date: b.expiry_date!, qty: b.qty, days_left: daysBetween(asOf, b.expiry_date!) })))
    .sort((a, b) => a.days_left - b.days_left);

  const lowStock = stockSummary(books, asOf).filter((s) => s.reorder_level > 0 && s.closing_qty <= s.reorder_level);

  return {
    asOf,
    overdue,
    overdueTotal: overdue.reduce((a, b) => a + b.pending, 0),
    msmeReceivables,
    msmeNote: 'Interest under the MSMED Act can be claimed only if your Udyam registration is as a manufacturer or service provider. Traders are generally not covered, so treat these figures as a guide.',
    msmePayables,
    expiringBatches,
    lowStock,
  };
}

// ---------- registers and analysis (v0.2) ----------
const LIVE = `v.cancelled=0 AND v.optional=0`;

/** Sales/Purchase/... Register: month-wise totals and the vouchers, as Tally's Display → Account Books → Sales Register. */
export function register(books: Books, type: string, from: string, to: string) {
  const rows = books.db.prepare(`
    SELECT v.id, v.number, v.date, v.ref_no, p.name AS party, COALESCE(v.party_gstin,'') AS gstin, v.taxable, v.cgst, v.sgst, v.igst,
      v.charges, v.round_off, v.total, v.cancelled
    FROM vouchers v LEFT JOIN ledgers p ON p.id=v.party_id
    WHERE v.type=? AND v.optional=0 AND v.date BETWEEN ? AND ? ORDER BY v.date, v.seq, v.id`).all(type, from, to) as
    { id: number; number: string; date: string; ref_no: string; party: string; gstin: string; taxable: number; cgst: number; sgst: number; igst: number; charges: number; round_off: number; total: number; cancelled: number }[];
  const months = new Map<string, { month: string; count: number; taxable: number; tax: number; total: number }>();
  for (const r of rows) {
    if (r.cancelled) continue;
    const m = months.get(r.date.slice(0, 7)) ?? { month: r.date.slice(0, 7), count: 0, taxable: 0, tax: 0, total: 0 };
    m.count++; m.taxable += r.taxable; m.tax += r.cgst + r.sgst + r.igst; m.total += r.total;
    months.set(m.month, m);
  }
  const live = rows.filter((r) => !r.cancelled);
  return {
    type, from, to, rows, months: [...months.values()],
    totals: { count: live.length, taxable: live.reduce((a, r) => a + r.taxable, 0), tax: live.reduce((a, r) => a + r.cgst + r.sgst + r.igst, 0), total: live.reduce((a, r) => a + r.total, 0) },
  };
}

/** Sales net of credit notes, grouped by beat, salesman, party, item or stock group (brand/company). */
export function salesBy(books: Books, by: string, from: string, to: string) {
  const col: Record<string, string> = {
    beat: `COALESCE(NULLIF(p.beat,''),'(no beat)')`, salesman: `COALESCE(NULLIF(p.salesman,''),'(no salesman)')`, party: 'p.name',
    item: 'i.name', stock_group: `COALESCE(sg.name,'(no group)')`,
  };
  const c = col[by] ?? col.party;
  const itemLevel = by === 'item' || by === 'stock_group';
  const rows = itemLevel
    ? books.db.prepare(`
      SELECT ${c} AS name, SUM(CASE WHEN v.type='sales' THEN iv.qty + iv.free_qty ELSE -(iv.qty + iv.free_qty) END) AS qty,
        SUM(CASE WHEN v.type='sales' THEN iv.taxable ELSE -iv.taxable END) AS value, COUNT(DISTINCT v.id) AS bills
      FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id JOIN items i ON i.id=iv.item_id LEFT JOIN stock_groups sg ON sg.id=i.stock_group_id
      LEFT JOIN ledgers p ON p.id=v.party_id
      WHERE ${LIVE} AND v.type IN ('sales','credit_note') AND v.date BETWEEN ? AND ? GROUP BY 1 ORDER BY value DESC`).all(from, to)
    : books.db.prepare(`
      SELECT ${c} AS name, SUM(CASE WHEN v.type='sales' THEN v.taxable ELSE -v.taxable END) AS value,
        SUM(CASE WHEN v.type='sales' THEN v.total ELSE -v.total END) AS total, SUM(v.type='sales') AS bills
      FROM vouchers v JOIN ledgers p ON p.id=v.party_id
      WHERE ${LIVE} AND v.type IN ('sales','credit_note') AND v.date BETWEEN ? AND ? GROUP BY 1 ORDER BY value DESC`).all(from, to);
  // Money still due, by the same grouping (parties only).
  let due: Map<string, number> | null = null;
  if (!itemLevel) {
    due = new Map();
    const keyOf = (b: { beat: string; salesman: string; ledger_name: string }) =>
      by === 'beat' ? b.beat || '(no beat)' : by === 'salesman' ? b.salesman || '(no salesman)' : b.ledger_name;
    for (const b of books.pendingBills({ asOf: to }).filter((x) => x.pending > 0)) due.set(keyOf(b), (due.get(keyOf(b)) ?? 0) + b.pending);
  }
  return { by, from, to, rows: (rows as Record<string, unknown>[]).map((r) => ({ ...r, outstanding: due?.get(r.name as string) ?? 0 })) };
}

/** Stock in each godown on a date. */
export function godownStock(books: Books, asOf: string) {
  const godowns = books.godowns();
  const rows = books.db.prepare(`
    SELECT i.id, i.name, u.symbol AS unit, COALESCE(iv.godown_id,1) AS godown_id, SUM(iv.direction * (iv.qty + iv.free_qty)) AS qty
    FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id JOIN items i ON i.id=iv.item_id JOIN units u ON u.id=i.unit_id
    WHERE ${LIVE} AND v.date<=? GROUP BY i.id, 4`).all(asOf) as { id: number; name: string; unit: string; godown_id: number; qty: number }[];
  const items = books.db.prepare(`SELECT i.id, i.name, u.symbol AS unit, i.opening_qty FROM items i JOIN units u ON u.id=i.unit_id ORDER BY i.name`).all() as { id: number; name: string; unit: string; opening_qty: number }[];
  const out = items.map((i) => {
    const by: Record<number, number> = { 1: i.opening_qty };
    for (const r of rows.filter((x) => x.id === i.id)) by[r.godown_id] = Math.round(((by[r.godown_id] ?? 0) + r.qty) * 1000) / 1000;
    return { id: i.id, name: i.name, unit: i.unit, godowns: by };
  }).filter((r) => Object.values(r.godowns).some((q) => q !== 0));
  return { asOf, godowns, rows: out };
}

/** Free goods given under company schemes: what to claim from Patanjali, Parag, ITC and others, at purchase cost. */
export function schemeClaims(books: Books, from: string, to: string) {
  const cost = new Map(stockSummary(books, to).map((s) => [s.id, s.rate]));
  const rows = books.db.prepare(`
    SELECT i.id, i.name, COALESCE(sg.name,'(no group)') AS stock_group, u.symbol AS unit, i.scheme_buy, i.scheme_free,
      SUM(CASE WHEN v.type='sales' THEN iv.free_qty ELSE -iv.free_qty END) AS free_qty,
      SUM(CASE WHEN v.type='sales' THEN iv.qty ELSE -iv.qty END) AS sold_qty, COUNT(DISTINCT v.id) AS bills
    FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id JOIN items i ON i.id=iv.item_id JOIN units u ON u.id=i.unit_id
    LEFT JOIN stock_groups sg ON sg.id=i.stock_group_id
    WHERE ${LIVE} AND v.type IN ('sales','credit_note') AND v.date BETWEEN ? AND ? AND iv.free_qty<>0
    GROUP BY i.id ORDER BY stock_group, i.name`).all(from, to) as { id: number; name: string; stock_group: string; unit: string; scheme_buy: number; scheme_free: number; free_qty: number; sold_qty: number; bills: number }[];
  const list = rows.map((r) => ({ ...r, rate: cost.get(r.id) ?? 0, value: Math.round(r.free_qty * (cost.get(r.id) ?? 0)) }));
  const groups = new Map<string, number>();
  for (const r of list) groups.set(r.stock_group, (groups.get(r.stock_group) ?? 0) + r.value);
  return { from, to, rows: list, byGroup: [...groups.entries()].map(([name, value]) => ({ name, value })), total: list.reduce((a, r) => a + r.value, 0) };
}

/** Bank reconciliation for one bank ledger: entries the bank has not shown yet (no bank date, or a later one). */
export function bankReconciliation(books: Books, ledgerId: number, asOf: string) {
  const l = books.ledger(ledgerId);
  const rows = books.db.prepare(`
    SELECT v.id, v.date, v.type, v.number, v.cheque_no, v.cheque_date, v.bank_date, v.narration, e.amount,
      (SELECT GROUP_CONCAT(l2.name, ', ') FROM entries e2 JOIN ledgers l2 ON l2.id=e2.ledger_id WHERE e2.voucher_id=v.id AND e2.ledger_id<>e.ledger_id) AS particulars
    FROM entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE e.ledger_id=? AND ${LIVE} AND v.date<=? ORDER BY v.date, v.id`).all(ledgerId, asOf) as
    { id: number; date: string; type: string; number: string; cheque_no: string; cheque_date: string | null; bank_date: string | null; narration: string; amount: number; particulars: string }[];
  const booksBalance = l.opening + rows.reduce((a, r) => a + r.amount, 0);
  const pending = rows.filter((r) => !r.bank_date || r.bank_date > asOf);
  const notInBank = pending.reduce((a, r) => a + r.amount, 0);
  return {
    ledger: { id: l.id, name: l.name }, asOf, booksBalance, bankBalance: booksBalance - notInBank, notInBank,
    pending, cleared: rows.filter((r) => r.bank_date && r.bank_date <= asOf).slice(-200),
  };
}

/** Post-dated cheques (Ctrl+T) still to come, and those already due. */
export function pdcRegister(books: Books, asOf: string) {
  return books.db.prepare(`
    SELECT v.id, v.type, v.number, v.date, v.cheque_no, v.cheque_date, v.bank_name, v.total, v.narration,
      COALESCE(p.name, (SELECT l.name FROM entries e JOIN ledgers l ON l.id=e.ledger_id WHERE e.voucher_id=v.id AND e.ledger_id<>v.account_id LIMIT 1)) AS party,
      a.name AS account, v.date > ? AS upcoming
    FROM vouchers v LEFT JOIN ledgers p ON p.id=v.party_id LEFT JOIN ledgers a ON a.id=v.account_id
    WHERE v.pdc=1 AND ${LIVE} ORDER BY v.date`).all(asOf);
}

/** Orders and delivery/receipt notes not yet billed in full (Tally's order and tracking outstanding). */
export function pendingOrders(books: Books, kind: 'sales' | 'purchase') {
  const orderType = kind === 'sales' ? 'sales_order' : 'purchase_order';
  const noteType = kind === 'sales' ? 'delivery_note' : 'receipt_note';
  const orders = books.db.prepare(`
    SELECT v.id, v.type, v.number, v.date, p.name AS party, v.party_id, v.total FROM vouchers v JOIN ledgers p ON p.id=v.party_id
    WHERE v.type IN (?, ?) AND ${LIVE} ORDER BY v.date, v.id`).all(orderType, noteType) as { id: number; type: string; number: string; date: string; party: string; party_id: number; total: number }[];
  const ordered = books.db.prepare(`SELECT iv.item_id, i.name, u.symbol AS unit, SUM(iv.qty + iv.free_qty) AS qty FROM inventory iv JOIN items i ON i.id=iv.item_id JOIN units u ON u.id=i.unit_id WHERE iv.voucher_id=? GROUP BY iv.item_id`);
  const done = books.db.prepare(`SELECT iv.item_id, SUM(iv.qty + iv.free_qty) AS qty FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id WHERE v.against_id=? AND ${LIVE} GROUP BY iv.item_id`);
  const out = [];
  for (const o of orders) {
    const got = new Map((done.all(o.id) as { item_id: number; qty: number }[]).map((d) => [d.item_id, d.qty]));
    const lines = (ordered.all(o.id) as { item_id: number; name: string; unit: string; qty: number }[])
      .map((l) => ({ ...l, done: got.get(l.item_id) ?? 0, pending: Math.round((l.qty - (got.get(l.item_id) ?? 0)) * 1000) / 1000 }))
      .filter((l) => l.pending > 0);
    // A note is billed once, in full.
    if (o.type === noteType && got.size) continue;
    if (lines.length) out.push({ ...o, lines });
  }
  return out;
}

/** TDS: what was booked to each ledger marked with a TDS section, and the TDS credited in those vouchers. */
export function tdsRegister(books: Books, from: string, to: string) {
  return books.db.prepare(`
    SELECT l.id, l.name, l.tds_section, l.tds_rate,
      COALESCE(SUM(CASE WHEN e.amount<0 THEN -e.amount END),0) AS credited,
      COALESCE(SUM(CASE WHEN e.amount>0 THEN e.amount END),0) AS debited,
      COALESCE((SELECT -SUM(e2.amount) FROM entries e2 JOIN ledgers t ON t.id=e2.ledger_id JOIN vouchers v2 ON v2.id=e2.voucher_id
        WHERE t.tax_kind='tds' AND v2.cancelled=0 AND v2.optional=0 AND v2.date BETWEEN ? AND ?
          AND e2.voucher_id IN (SELECT voucher_id FROM entries WHERE ledger_id=l.id)), 0) AS tds
    FROM ledgers l LEFT JOIN entries e ON e.ledger_id=l.id
      AND e.voucher_id IN (SELECT id FROM vouchers v WHERE ${LIVE} AND v.date BETWEEN ? AND ?)
    WHERE l.tds_section<>'' GROUP BY l.id ORDER BY l.tds_section, l.name`).all(from, to, from, to);
}
