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
        WHERE e.ledger_id=l.id AND v.cancelled=0 AND v.date<=? ${from ? 'AND v.date>=?' : ''}), 0) AS balance
    FROM ledgers l ORDER BY l.name`).all(...(from ? [asOf, from] : [asOf])) as BalanceRow[];
  return rows;
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
      COALESCE(SUM(CASE WHEN v.type='purchase' THEN iv.qty+iv.free_qty END),0) AS bought_qty,
      COALESCE(SUM(CASE WHEN v.type='purchase' THEN iv.taxable END),0) AS bought_value
    FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id
    WHERE iv.item_id=? AND v.cancelled=0 AND v.date<=?`);
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
  const balances = ledgerBalances(books, asOf);
  const tree = groupTree(books, balances);
  const dr = balances.filter((b) => b.balance > 0).reduce((a, b) => a + b.balance, 0);
  const cr = -balances.filter((b) => b.balance < 0).reduce((a, b) => a + b.balance, 0);
  const openingStock = openingStockValue(books);
  const openingDiff = (books.db.prepare(`SELECT COALESCE(SUM(opening),0) s FROM ledgers`).get() as { s: number }).s + openingStock;
  return { asOf, tree, openingStock, openingDiff, totalDr: dr + openingStock, totalCr: cr };
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
  const before = books.db.prepare(`
    SELECT COALESCE(SUM(e.amount),0) s FROM entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE e.ledger_id=? AND v.cancelled=0 AND v.date<?`).get(ledgerId, from) as { s: number };
  const opening = l.opening + before.s;
  const rows = books.db.prepare(`
    SELECT v.id AS voucher_id, v.date, v.type, v.number, v.narration, e.amount,
      (SELECT GROUP_CONCAT(l2.name, ', ') FROM entries e2 JOIN ledgers l2 ON l2.id=e2.ledger_id
        WHERE e2.voucher_id=v.id AND e2.ledger_id<>e.ledger_id AND SIGN(e2.amount)<>SIGN(e.amount)) AS particulars
    FROM entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE e.ledger_id=? AND v.cancelled=0 AND v.date BETWEEN ? AND ? ORDER BY v.date, v.id`).all(ledgerId, from, to) as
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
  const msmeReceivables = pending
    .filter((b) => b.pending > 0 && b.msme_buyer && b.ref !== 'Opening')
    .map((b) => {
      const lateDays = Math.max(0, b.age_days - msmeLimit(b.credit_days));
      // Compound interest with monthly rests, as the Act requires.
      const interest = rate > 0 && lateDays > 0 ? Math.round(b.pending * (Math.pow(1 + rate / 1200, lateDays / 30) - 1)) : 0;
      return { ...b, msme_due: addDays(b.bill_date, msmeLimit(b.credit_days)), late_days: lateDays, interest };
    })
    .filter((b) => b.late_days > 0);

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
    msmePayables,
    expiringBatches,
    lowStock,
  };
}
