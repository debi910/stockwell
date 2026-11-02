import { useEffect, useState } from 'react';
import { api, openWhatsApp } from '../api';
import { useKeyBar, useNav, useScreenKeys, useTitle } from '../nav';
import { VOUCHER_LABEL, drCr, financialYear, formatINR, parseDate, shortDate } from '../format';

/** Arrow keys move through rows; Enter opens the selected one. */
function useRows<T>(rows: T[], open: (r: T) => void) {
  const [sel, setSel] = useState(0);
  useScreenKeys((e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false;
    }
    if (e.key === 'ArrowDown') { setSel((s) => Math.min(s + 1, rows.length - 1)); return true; }
    if (e.key === 'ArrowUp') { setSel((s) => Math.max(s - 1, 0)); return true; }
    if (e.key === 'Enter' && rows[sel]) { open(rows[sel]); return true; }
    return false;
  });
  useEffect(() => {
    document.querySelector('.main > div:not([style*="none"]) tr.sel')?.scrollIntoView?.({ block: 'nearest' });
  }, [sel]);
  return { sel, setSel };
}

/** A "From – To" period picker (F2 in Tally) shown in the report toolbar. */
function Period({ from, to, onChange, single }: { from?: string; to: string; onChange: (from: string, to: string) => void; single?: boolean }) {
  const [f, setF] = useState(from ? shortDate(from) : '');
  const [t, setT] = useState(shortDate(to));
  const apply = () => {
    const tt = parseDate(t, to);
    const ff = single ? undefined : parseDate(f, from ?? to);
    if (tt && (single || ff)) onChange(ff ?? tt, tt);
  };
  return (
    <>
      {!single && <><span className="subtle">From</span><input className="f" aria-label="From date" value={f} onChange={(e) => setF(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === 'Enter' && apply()} /></>}
      <span className="subtle">{single ? 'As on' : 'To'}</span><input className="f" aria-label="To date" value={t} onChange={(e) => setT(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === 'Enter' && apply()} />
    </>
  );
}

// ---------------- Day Book ----------------
export function DayBook({ active }: { active: boolean }) {
  const nav = useNav();
  const [range, setRange] = useState({ from: nav.workDate, to: nav.workDate });
  const [rows, setRows] = useState<any[]>([]);
  useTitle('Day Book');
  useEffect(() => { if (active) api.get(`/api/reports/day-book?from=${range.from}&to=${range.to}`).then(setRows); }, [active, range]);
  const { sel, setSel } = useRows(rows, (r) => nav.push({ name: 'voucher', props: { type: r.type, id: r.id } }));
  useKeyBar([{ key: 'F2', label: 'Period', run: () => (document.querySelector('[aria-label="From date"]') as HTMLInputElement)?.focus() }], []);
  const total = rows.filter((r) => !r.cancelled).reduce((a, r) => a + r.total, 0);
  return (
    <div className="report">
      <div className="toolbar"><Period from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} /><span className="subtle">{rows.length} vouchers</span></div>
      <table className="r">
        <thead><tr><th>Date</th><th>Particulars</th><th>Vch type</th><th>Vch no.</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={`click ${i === sel ? 'sel' : ''} ${r.cancelled ? 'cancelled' : ''}`} onClick={() => setSel(i)} onDoubleClick={() => nav.push({ name: 'voucher', props: { type: r.type, id: r.id } })}>
              <td>{shortDate(r.date)}</td><td>{r.particulars}{r.cancelled ? ' (cancelled)' : ''}</td><td>{VOUCHER_LABEL[r.type]}</td><td>{r.number}</td><td className="num">{formatINR(r.total)}</td>
            </tr>
          ))}
          {rows.length > 0 && <tr className="total"><td colSpan={4}>Total</td><td className="num">{formatINR(total)}</td></tr>}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state">No vouchers on these dates. Press F8 to make a sales bill.</div>}
    </div>
  );
}

// ---------------- group tree helpers ----------------
interface Node { id: number; name: string; balance: number; groups: Node[]; ledgers: { id: number; name: string; balance: number }[] }
type Flat = { key: string; name: string; balance: number; depth: number; kind: 'group' | 'ledger'; id: number };

function flatten(nodes: Node[], expanded: boolean, depth = 0, out: Flat[] = []): Flat[] {
  for (const n of nodes) {
    out.push({ key: `g${n.id}`, name: n.name, balance: n.balance, depth, kind: 'group', id: n.id });
    if (expanded) {
      flatten(n.groups, expanded, depth + 1, out);
      for (const l of n.ledgers) out.push({ key: `l${l.id}`, name: l.name, balance: l.balance, depth: depth + 1, kind: 'ledger', id: l.id });
    }
  }
  return out;
}

function useDrill() {
  const nav = useNav();
  return (r: Flat) => nav.push(r.kind === 'ledger' ? { name: 'ledger-report', props: { id: r.id } } : { name: 'group-summary', props: { id: r.id, name: r.name } });
}

// ---------------- Trial Balance ----------------
export function TrialBalance({ active }: { active: boolean }) {
  const nav = useNav();
  const [to, setTo] = useState(nav.workDate);
  const [data, setData] = useState<any>(null);
  const [detailed, setDetailed] = useState(false);
  useTitle('Trial Balance');
  useEffect(() => { if (active) api.get(`/api/reports/trial-balance?to=${to}`).then(setData); }, [active, to]);
  const rows = data ? flatten(data.tree, detailed) : [];
  const drill = useDrill();
  const { sel, setSel } = useRows(rows, drill);
  useKeyBar([{ key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', run: () => setDetailed((d) => !d) }], [detailed]);
  if (!data) return null;
  return (
    <div className="report">
      <div className="toolbar"><Period to={to} single onChange={(_, t) => setTo(t)} /></div>
      <table className="r">
        <thead><tr><th>Particulars</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className={`click ${r.kind === 'group' && r.depth === 0 ? 'group' : 'sub'} ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)} onDoubleClick={() => drill(r)}>
              <td style={{ paddingLeft: 8 + r.depth * 18 }}>{r.name}</td>
              <td className="num">{r.balance > 0 ? formatINR(r.balance) : ''}</td>
              <td className="num">{r.balance < 0 ? formatINR(-r.balance) : ''}</td>
            </tr>
          ))}
          {data.openingStock > 0 && <tr><td>Opening Stock</td><td className="num">{formatINR(data.openingStock)}</td><td /></tr>}
          {data.openingDiff !== 0 && <tr><td><span className="tag warn">Difference in opening balances</span></td><td className="num">{data.openingDiff < 0 ? formatINR(-data.openingDiff) : ''}</td><td className="num">{data.openingDiff > 0 ? formatINR(data.openingDiff) : ''}</td></tr>}
          <tr className="total"><td>Grand Total</td><td className="num">{formatINR(data.totalDr + Math.max(0, -data.openingDiff))}</td><td className="num">{formatINR(data.totalCr + Math.max(0, data.openingDiff))}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

export function GroupSummary({ id, name, active }: { id: number; name: string; active: boolean }) {
  const nav = useNav();
  const [data, setData] = useState<any>(null);
  useTitle(`Group Summary: ${name}`);
  useEffect(() => { if (active) api.get(`/api/reports/trial-balance?to=${nav.workDate}`).then(setData); }, [active, nav.workDate]);
  const find = (nodes: Node[]): Node | null => { for (const n of nodes) { if (n.id === id) return n; const f = find(n.groups); if (f) return f; } return null; };
  const node = data ? find(data.tree) : null;
  const rows: Flat[] = node ? [
    ...node.groups.map((g) => ({ key: `g${g.id}`, name: g.name, balance: g.balance, depth: 0, kind: 'group' as const, id: g.id })),
    ...node.ledgers.map((l) => ({ key: `l${l.id}`, name: l.name, balance: l.balance, depth: 0, kind: 'ledger' as const, id: l.id })),
  ] : [];
  const drill = useDrill();
  const { sel, setSel } = useRows(rows, drill);
  return (
    <div className="report">
      <table className="r">
        <thead><tr><th>Particulars</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className={`click ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)} onDoubleClick={() => drill(r)}>
              <td>{r.name}</td><td className="num">{r.balance > 0 ? formatINR(r.balance) : ''}</td><td className="num">{r.balance < 0 ? formatINR(-r.balance) : ''}</td>
            </tr>
          ))}
          {node && <tr className="total"><td>Total</td><td className="num">{node.balance > 0 ? formatINR(node.balance) : ''}</td><td className="num">{node.balance < 0 ? formatINR(-node.balance) : ''}</td></tr>}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state">Nothing in this group yet.</div>}
    </div>
  );
}

// ---------------- P&L ----------------
export function ProfitLoss({ active }: { active: boolean }) {
  const nav = useNav();
  const fy = financialYear(nav.workDate);
  const [range, setRange] = useState({ from: fy.start < nav.company.books_from ? nav.company.books_from : fy.start, to: nav.workDate });
  const [d, setD] = useState<any>(null);
  useTitle('Profit & Loss A/c');
  useEffect(() => { if (active) api.get(`/api/reports/profit-loss?from=${range.from}&to=${range.to}`).then(setD); }, [active, range]);
  const drill = useDrill();
  if (!d) return null;
  const sideRows = (nodes: Node[], sign: number) => nodes.map((n) => (
    <tr key={n.id} className="click" onDoubleClick={() => drill({ key: '', name: n.name, balance: 0, depth: 0, kind: 'group', id: n.id })}><td>{n.name}</td><td className="num">{formatINR(sign * n.balance)}</td></tr>
  ));
  const gp = d.grossProfit;
  const leftTrading = d.openingStock + d.tradingDr.reduce((a: number, n: Node) => a + n.balance, 0) + (gp > 0 ? gp : 0);
  const rightTrading = -d.tradingCr.reduce((a: number, n: Node) => a + n.balance, 0) + d.closingStock + (gp < 0 ? -gp : 0);
  const np = d.netProfit;
  const leftPl = (gp < 0 ? -gp : 0) + d.indirectDr.reduce((a: number, n: Node) => a + n.balance, 0) + (np > 0 ? np : 0);
  const rightPl = (gp > 0 ? gp : 0) - d.indirectCr.reduce((a: number, n: Node) => a + n.balance, 0) + (np < 0 ? -np : 0);
  return (
    <div className="report">
      <div className="toolbar"><Period from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
        <span className={`tag ${np >= 0 ? 'good' : 'bad'}`}>{np >= 0 ? 'Net profit' : 'Net loss'} ₹{formatINR(Math.abs(np))}</span></div>
      <div className="twocol">
        <div><table className="r"><thead><tr><th>Particulars</th><th className="num">Amount</th></tr></thead><tbody>
          <tr><td>Opening Stock</td><td className="num">{formatINR(d.openingStock)}</td></tr>
          {sideRows(d.tradingDr, 1)}
          {gp > 0 && <tr className="group"><td>Gross Profit c/o</td><td className="num">{formatINR(gp)}</td></tr>}
          <tr className="total"><td /><td className="num">{formatINR(leftTrading)}</td></tr>
          {gp < 0 && <tr><td>Gross Loss b/f</td><td className="num">{formatINR(-gp)}</td></tr>}
          {sideRows(d.indirectDr, 1)}
          {np > 0 && <tr className="group"><td>Nett Profit</td><td className="num">{formatINR(np)}</td></tr>}
          <tr className="total"><td>Total</td><td className="num">{formatINR(leftPl)}</td></tr>
        </tbody></table></div>
        <div><table className="r"><thead><tr><th>Particulars</th><th className="num">Amount</th></tr></thead><tbody>
          {sideRows(d.tradingCr, -1)}
          <tr><td>Closing Stock</td><td className="num">{formatINR(d.closingStock)}</td></tr>
          {gp < 0 && <tr className="group"><td>Gross Loss c/o</td><td className="num">{formatINR(-gp)}</td></tr>}
          <tr className="total"><td /><td className="num">{formatINR(rightTrading)}</td></tr>
          {gp > 0 && <tr><td>Gross Profit b/f</td><td className="num">{formatINR(gp)}</td></tr>}
          {sideRows(d.indirectCr, -1)}
          {np < 0 && <tr className="group"><td>Nett Loss</td><td className="num">{formatINR(-np)}</td></tr>}
          <tr className="total"><td>Total</td><td className="num">{formatINR(rightPl)}</td></tr>
        </tbody></table></div>
      </div>
    </div>
  );
}

// ---------------- Balance Sheet ----------------
export function BalanceSheet({ active }: { active: boolean }) {
  const nav = useNav();
  const [to, setTo] = useState(nav.workDate);
  const [d, setD] = useState<any>(null);
  useTitle('Balance Sheet');
  useEffect(() => { if (active) api.get(`/api/reports/balance-sheet?to=${to}`).then(setD); }, [active, to]);
  const drill = useDrill();
  if (!d) return null;
  const rows = (nodes: Node[], sign: number) => nodes.map((n) => (
    <tr key={n.id} className="click group" onDoubleClick={() => drill({ key: '', name: n.name, balance: 0, depth: 0, kind: 'group', id: n.id })}><td>{n.name}</td><td className="num">{formatINR(sign * n.balance)}</td></tr>
  ));
  return (
    <div className="report">
      <div className="toolbar"><Period to={to} single onChange={(_, t) => setTo(t)} /><span className="subtle">Double-click a group to see its ledgers</span></div>
      <div className="twocol">
        <div><table className="r"><thead><tr><th>Liabilities</th><th className="num">as at {shortDate(to)}</th></tr></thead><tbody>
          {rows(d.liabilities, -1)}
          <tr className="group click" onDoubleClick={() => nav.push({ name: 'profit-loss' })}><td>Profit & Loss A/c</td><td className="num">{formatINR(d.profit)}</td></tr>
          {d.openingDiff > 0 && <tr><td><span className="tag warn">Diff. in opening balances</span></td><td className="num">{formatINR(d.openingDiff)}</td></tr>}
          <tr className="total"><td>Total</td><td className="num">{formatINR(d.totalLiabilities)}</td></tr>
        </tbody></table></div>
        <div><table className="r"><thead><tr><th>Assets</th><th className="num">as at {shortDate(to)}</th></tr></thead><tbody>
          {rows(d.assets, 1)}
          <tr className="group click" onDoubleClick={() => nav.push({ name: 'stock-summary' })}><td>Closing Stock</td><td className="num">{formatINR(d.closingStock)}</td></tr>
          {d.openingDiff < 0 && <tr><td><span className="tag warn">Diff. in opening balances</span></td><td className="num">{formatINR(-d.openingDiff)}</td></tr>}
          <tr className="total"><td>Total</td><td className="num">{formatINR(d.totalAssets)}</td></tr>
        </tbody></table></div>
      </div>
    </div>
  );
}

// ---------------- Ledger ----------------
export function LedgerReport({ id, active }: { id: number; active: boolean }) {
  const nav = useNav();
  const fy = financialYear(nav.workDate);
  const [range, setRange] = useState({ from: fy.start < nav.company.books_from ? nav.company.books_from : fy.start, to: nav.workDate });
  const [d, setD] = useState<any>(null);
  useTitle(d ? `Ledger: ${d.ledger.name}` : 'Ledger');
  useEffect(() => { if (active) api.get(`/api/reports/ledger/${id}?from=${range.from}&to=${range.to}`).then(setD); }, [active, id, range]);
  const rows = d?.lines ?? [];
  const { sel, setSel } = useRows(rows, (r: any) => nav.push({ name: 'voucher', props: { type: r.type, id: r.voucher_id } }));
  const remind = async () => {
    const m = await api.get(`/api/reports/reminder/${id}`);
    if (!m.total) { nav.toast('Nothing is due from this party'); return; }
    await openWhatsApp(m.phone, m.text);
  };
  useKeyBar([
    { key: 'Alt+W', label: 'WhatsApp reminder', run: remind, disabled: !d?.ledger || d.closing <= 0 },
    { key: 'Ctrl+Enter', label: 'Alter ledger', run: () => nav.push({ name: 'ledger-form', props: { id } }) },
  ], [d]);
  if (!d) return null;
  const dr = rows.filter((r: any) => r.amount > 0).reduce((a: number, r: any) => a + r.amount, 0);
  const cr = -rows.filter((r: any) => r.amount < 0).reduce((a: number, r: any) => a + r.amount, 0);
  return (
    <div className="report">
      <div className="toolbar"><Period from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
        {d.ledger.phone && <span className="subtle">Ph {d.ledger.phone}</span>}</div>
      <table className="r">
        <thead><tr><th>Date</th><th>Particulars</th><th>Vch type</th><th>Vch no.</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
        <tbody>
          <tr className="sub"><td /><td>Opening Balance</td><td /><td /><td className="num">{d.opening > 0 ? formatINR(d.opening) : ''}</td><td className="num">{d.opening < 0 ? formatINR(-d.opening) : ''}</td><td className="num">{drCr(d.opening)}</td></tr>
          {rows.map((r: any, i: number) => (
            <tr key={i} className={`click ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)} onDoubleClick={() => nav.push({ name: 'voucher', props: { type: r.type, id: r.voucher_id } })}>
              <td>{shortDate(r.date)}</td><td>{r.particulars}</td><td>{VOUCHER_LABEL[r.type]}</td><td>{r.number}</td>
              <td className="num">{r.amount > 0 ? formatINR(r.amount) : ''}</td><td className="num">{r.amount < 0 ? formatINR(-r.amount) : ''}</td><td className="num">{drCr(r.balance)}</td>
            </tr>
          ))}
          <tr className="total"><td /><td>Current Total</td><td /><td /><td className="num">{formatINR(dr)}</td><td className="num">{formatINR(cr)}</td><td className="num">{drCr(d.closing)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------- Stock Summary ----------------
export function StockSummary({ active }: { active: boolean }) {
  const nav = useNav();
  const [to, setTo] = useState(nav.workDate);
  const [rows, setRows] = useState<any[]>([]);
  const [batchesOf, setBatchesOf] = useState<any>(null);
  useTitle('Stock Summary');
  useEffect(() => { if (active) api.get(`/api/reports/stock-summary?to=${to}`).then(setRows); }, [active, to]);
  const { sel, setSel } = useRows(rows, async (r: any) => setBatchesOf({ item: r, list: await api.get(`/api/items/${r.id}/batches?asOf=${to}`) }));
  const groups = [...new Set(rows.map((r) => r.stock_group ?? 'Other items'))];
  const total = rows.reduce((a, r) => a + r.value, 0);
  let idx = -1;
  return (
    <div className="report">
      <div className="toolbar"><Period to={to} single onChange={(_, t) => setTo(t)} /><span className="subtle">Valued at average purchase cost · Enter shows batches</span></div>
      <table className="r">
        <thead><tr><th>Particulars</th><th className="num">Quantity</th><th className="num">Rate</th><th className="num">Value</th></tr></thead>
        <tbody>
          {groups.map((g) => {
            const list = rows.filter((r) => (r.stock_group ?? 'Other items') === g);
            return [
              <tr key={`g-${g}`} className="group"><td>{g}</td><td /><td /><td className="num">{formatINR(list.reduce((a, r) => a + r.value, 0))}</td></tr>,
              ...list.map((r) => {
                idx = rows.indexOf(r);
                const i = idx;
                const low = r.reorder_level > 0 && r.closing_qty <= r.reorder_level;
                return (
                  <tr key={r.id} className={`click sub ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)}>
                    <td>{r.name} {low && <span className="tag warn">reorder</span>}</td>
                    <td className="num">{r.closing_qty} {r.unit}</td><td className="num">{formatINR(r.rate)}</td><td className="num">{formatINR(r.value)}</td>
                  </tr>
                );
              }),
            ];
          })}
          <tr className="total"><td>Grand Total</td><td /><td /><td className="num">{formatINR(total)}</td></tr>
        </tbody>
      </table>
      {!rows.length && <div className="empty-state">No stock items yet. Gateway › Create › Stock Item.</div>}
      {batchesOf && (
        <div className="modal-back" onClick={() => setBatchesOf(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{batchesOf.item.name}: batches</h3>
            <table className="lines"><thead><tr><th>Batch</th><th>Expiry</th><th className="num">Quantity</th></tr></thead><tbody>
              {batchesOf.list.map((b: any) => <tr key={b.id}><td>{b.batch_no}</td><td>{b.expiry_date ? shortDate(b.expiry_date) : '—'}</td><td className="num">{b.qty}</td></tr>)}
            </tbody></table>
            {!batchesOf.list.length && <p className="hint">This item is not tracked by batch.</p>}
            <div className="actions"><button className="btn" autoFocus onClick={() => setBatchesOf(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Outstandings ----------------
export function Outstanding({ kind, active }: { kind: 'receivable' | 'payable'; active: boolean }) {
  const nav = useNav();
  const [rows, setRows] = useState<any[]>([]);
  const [beat, setBeat] = useState('');
  useTitle(kind === 'receivable' ? 'Bills Receivable' : 'Bills Payable');
  useEffect(() => { if (active) api.get(`/api/reports/outstanding?kind=${kind}&asOf=${nav.workDate}`).then(setRows); }, [active, kind, nav.workDate]);
  const beats = [...new Set(rows.map((r) => r.beat).filter(Boolean))];
  const shown = rows.filter((r) => !beat || r.beat === beat);
  const { sel, setSel } = useRows(shown, (r: any) => nav.push({ name: 'ledger-report', props: { id: r.ledger_id } }));
  const remind = async (ledgerId: number) => {
    const m = await api.get(`/api/reports/reminder/${ledgerId}`);
    await openWhatsApp(m.phone, m.text);
    if (!m.phone) nav.toast(`No mobile number saved for ${m.partyName}`, true);
  };
  useKeyBar(kind === 'receivable' ? [{ key: 'Alt+W', label: 'WhatsApp reminder', run: () => shown[sel] && remind(shown[sel].ledger_id) }] : [], [shown, sel]);
  const total = shown.reduce((a, r) => a + r.pending, 0);
  return (
    <div className="report">
      <div className="toolbar">
        {beats.length > 0 && <select className="f" aria-label="Beat" style={{ width: 200, background: 'var(--paper)', border: '1px solid var(--line)' }} value={beat} onChange={(e) => setBeat(e.target.value)}>
          <option value="">All beats</option>{beats.map((b) => <option key={b}>{b}</option>)}
        </select>}
        <span className="subtle">{shown.length} bills · ₹{formatINR(Math.abs(total))}</span>
      </div>
      <table className="r">
        <thead><tr><th>Date</th><th>Ref. no.</th><th>Party</th><th>Beat</th><th className="num">Pending</th><th>Due on</th><th className="num">Overdue by</th><th /></tr></thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={`${r.ledger_id}-${r.ref}`} className={`click ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)} onDoubleClick={() => nav.push({ name: 'ledger-report', props: { id: r.ledger_id } })}>
              <td>{shortDate(r.bill_date)}</td><td>{r.ref}</td><td>{r.ledger_name}</td><td>{r.beat}</td>
              <td className="num">{formatINR(Math.abs(r.pending))}</td><td>{shortDate(r.due_date)}</td>
              <td className="num">{r.overdue_days > 0 ? <span className={`tag ${r.overdue_days > 30 ? 'bad' : 'warn'}`}>{r.overdue_days} days</span> : ''}</td>
              <td>{kind === 'receivable' && <button className="btn small wa" onClick={(e) => { e.stopPropagation(); remind(r.ledger_id); }}>Remind</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!shown.length && <div className="empty-state">Nothing pending.</div>}
    </div>
  );
}

// ---------------- Alerts ----------------
export function Alerts({ active }: { active: boolean }) {
  const nav = useNav();
  const [a, setA] = useState<any>(null);
  useTitle('Alerts & Reminders');
  useEffect(() => { if (active) api.get(`/api/reports/alerts?asOf=${nav.workDate}`).then(setA); }, [active, nav.workDate]);
  if (!a) return null;
  const remind = async (ledgerId: number) => {
    const m = await api.get(`/api/reports/reminder/${ledgerId}`);
    await openWhatsApp(m.phone, m.text);
  };
  const parties = [...new Map(a.overdue.map((b: any) => [b.ledger_id, b])).values()] as any[];
  return (
    <div className="report">
      <div className="cards">
        <div className={`card ${a.overdue.length ? 'bad' : ''}`}><div className="subtle">Overdue from retailers</div><div className="v">₹{formatINR(a.overdueTotal)}</div><div className="subtle">{a.overdue.length} bills · {parties.length} parties</div></div>
        <div className={`card ${a.msmeReceivables.length ? 'warn' : ''}`}><div className="subtle">MSME interest claimable</div><div className="v">₹{formatINR(a.msmeReceivables.reduce((s: number, b: any) => s + b.interest, 0))}</div><div className="subtle">{nav.company.msme_interest_rate ? `at ${nav.company.msme_interest_rate}% a year` : 'set the rate in Company settings'}</div></div>
        <div className={`card ${a.msmePayables.length ? 'warn' : ''}`}><div className="subtle">Pay MSME suppliers (43B(h))</div><div className="v">{a.msmePayables.length}</div></div>
        <div className={`card ${a.expiringBatches.length ? 'warn' : ''}`}><div className="subtle">Batches near expiry</div><div className="v">{a.expiringBatches.length}</div></div>
      </div>

      <h3>Overdue bills</h3>
      <table className="r">
        <thead><tr><th>Party</th><th>Bill</th><th>Bill date</th><th className="num">Pending</th><th className="num">Overdue</th><th /></tr></thead>
        <tbody>
          {a.overdue.map((b: any) => (
            <tr key={`${b.ledger_id}-${b.ref}`}>
              <td>{b.ledger_name}</td><td>{b.ref}</td><td>{shortDate(b.bill_date)}</td><td className="num">{formatINR(b.pending)}</td>
              <td className="num"><span className={`tag ${b.overdue_days > 30 ? 'bad' : 'warn'}`}>{b.overdue_days} days</span></td>
              <td><button className="btn small wa" onClick={() => remind(b.ledger_id)}>WhatsApp reminder</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!a.overdue.length && <div className="empty-state">No overdue bills.</div>}

      {a.msmeReceivables.length > 0 && <>
        <h3>Late payments under the MSME Act (buyers marked as covered)</h3>
        <table className="r"><thead><tr><th>Party</th><th>Bill</th><th>Was due</th><th className="num">Pending</th><th className="num">Days late</th><th className="num">Interest</th></tr></thead><tbody>
          {a.msmeReceivables.map((b: any) => <tr key={`${b.ledger_id}-${b.ref}`}><td>{b.ledger_name}</td><td>{b.ref}</td><td>{shortDate(b.msme_due)}</td><td className="num">{formatINR(b.pending)}</td><td className="num">{b.late_days}</td><td className="num">{formatINR(b.interest)}</td></tr>)}
        </tbody></table>
      </>}

      {a.msmePayables.length > 0 && <>
        <h3>MSME suppliers to pay (Section 43B(h))</h3>
        <p className="hint">Unpaid past the date below, the purchase is not tax-deductible this year until it is paid.</p>
        <table className="r"><thead><tr><th>Supplier</th><th>Bill</th><th>Pay by</th><th className="num">Pending</th><th /></tr></thead><tbody>
          {a.msmePayables.map((b: any) => <tr key={`${b.ledger_id}-${b.ref}`}><td>{b.ledger_name}</td><td>{b.ref}</td><td>{shortDate(b.pay_by)}</td><td className="num">{formatINR(-b.pending)}</td>
            <td><span className={`tag ${b.days_left < 0 ? 'bad' : 'warn'}`}>{b.days_left < 0 ? `${-b.days_left} days late` : `${b.days_left} days left`}</span></td></tr>)}
        </tbody></table>
      </>}

      <h3>Stock expiring within {nav.company.expiry_alert_days} days</h3>
      <table className="r"><thead><tr><th>Item</th><th>Batch</th><th>Expiry</th><th className="num">Quantity</th><th /></tr></thead><tbody>
        {a.expiringBatches.map((b: any) => <tr key={`${b.item_id}-${b.batch_no}`}><td>{b.item_name}</td><td>{b.batch_no}</td><td>{shortDate(b.expiry_date)}</td><td className="num">{b.qty}</td>
          <td><span className={`tag ${b.days_left < 0 ? 'bad' : 'warn'}`}>{b.days_left < 0 ? 'expired' : `${b.days_left} days`}</span></td></tr>)}
      </tbody></table>
      {!a.expiringBatches.length && <div className="empty-state">No batches near expiry.</div>}
    </div>
  );
}

// ---------------- Edit log ----------------
export function AuditLog({ active }: { active: boolean }) {
  const [rows, setRows] = useState<any[]>([]);
  useTitle('Edit Log');
  useEffect(() => { if (active) api.get('/api/audit').then(setRows); }, [active]);
  return (
    <div className="report">
      <table className="r"><thead><tr><th>When</th><th>User</th><th>What</th><th>Action</th></tr></thead><tbody>
        {rows.map((r) => <tr key={r.id}><td>{r.at}</td><td>{r.user_name ?? ''}</td><td>{r.entity} #{r.entity_id}</td><td>{r.action}</td></tr>)}
      </tbody></table>
    </div>
  );
}
