// Registers, analysis and the other TallyPrime reports added in v0.2, plus godowns, bulk GST rate change and F11 features.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Combo } from '../components/Combo';
import { Row, Select, Text, YesNo } from '../components/Field';
import { confirmBox, promptBox } from '../components/Dialog';
import { isOwner, useKeyBar, useNav, useScreenKeys, useTitle, useBooksVersion } from '../nav';
import { VOUCHER_LABEL, drCr, financialYear, formatINR, parseDate, shortDate } from '../format';
import { Period, useRows } from './Reports';

const fyStart = (nav: { workDate: string; company: any }) => {
  const s = financialYear(nav.workDate).start;
  return s > nav.company.books_from ? s : nav.company.books_from;
};
const openVoucher = (nav: ReturnType<typeof useNav>) => (r: { id?: number; voucherId?: number; type?: string }) =>
  nav.push({ name: 'voucher', props: { type: r.type ?? 'purchase', id: r.id ?? r.voucherId } });
const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

// ---------------- Sales / Purchase / ... Register ----------------
export function Register({ type, active }: { type: string; active: boolean }) {
  const nav = useNav();
  const [range, setRange] = useState({ from: fyStart(nav), to: nav.workDate });
  const [data, setData] = useState<any>(null);
  const [month, setMonth] = useState<string | null>(null);
  useTitle(`${VOUCHER_LABEL[type]} Register${month ? ` · ${monthName(month)}` : ''}`);
  useEffect(() => { if (active) api.get(`/api/reports/register?type=${type}&from=${range.from}&to=${range.to}`).then(setData).catch((e) => nav.toast(e.message, true)); }, [active, useBooksVersion(), type, range]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows: any[] = month ? (data?.rows ?? []).filter((r: any) => r.date.startsWith(month)) : data?.months ?? [];
  const { sel, setSel } = useRows(rows, (r: any) => (month ? nav.push({ name: 'voucher', props: { type, id: r.id } }) : setMonth(r.month)), () => { if (month) { setMonth(null); return true; } return false; });
  if (!data) return null;
  return (
    <div className="report">
      <div className="toolbar"><Period from={range.from} to={range.to} onChange={(from, to) => { setRange({ from, to }); setMonth(null); }} />
        <span className="subtle">{month ? 'Esc: back to months' : 'Enter on a month shows its vouchers'}</span></div>
      {!month ? (
        <table className="r">
          <thead><tr><th>Month</th><th className="num">Vouchers</th><th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th></tr></thead>
          <tbody>
            {rows.map((m: any, i) => (
              <tr key={m.month} className={`click ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)} onDoubleClick={() => setMonth(m.month)}>
                <td>{monthName(m.month)}</td><td className="num">{m.count}</td><td className="num">{formatINR(m.taxable)}</td><td className="num">{formatINR(m.tax)}</td><td className="num">{formatINR(m.total)}</td>
              </tr>
            ))}
            <tr className="total"><td>Total</td><td className="num">{data.totals.count}</td><td className="num">{formatINR(data.totals.taxable)}</td><td className="num">{formatINR(data.totals.tax)}</td><td className="num">{formatINR(data.totals.total)}</td></tr>
          </tbody>
        </table>
      ) : (
        <table className="r">
          <thead><tr><th>Date</th><th>Particulars</th><th>Vch no.</th><th>GSTIN</th><th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th></tr></thead>
          <tbody>
            {rows.map((r: any, i) => (
              <tr key={r.id} className={`click ${i === sel ? 'sel' : ''} ${r.cancelled ? 'cancelled' : ''}`} onClick={() => setSel(i)} onDoubleClick={() => nav.push({ name: 'voucher', props: { type, id: r.id } })}>
                <td>{shortDate(r.date)}</td><td>{r.party}{r.cancelled ? ' (cancelled)' : ''}</td><td>{r.number}{r.ref_no && type === 'purchase' ? ` / ${r.ref_no}` : ''}</td><td>{r.gstin}</td>
                <td className="num">{formatINR(r.taxable)}</td><td className="num">{formatINR(r.cgst + r.sgst + r.igst)}</td><td className="num">{formatINR(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!data.rows.length && <div className="empty-state">No {VOUCHER_LABEL[type]} vouchers in this period.</div>}
    </div>
  );
}

// ---------------- Sales analysis by beat, salesman, party, item, company ----------------
const BY: [string, string][] = [['beat', 'Beat'], ['salesman', 'Salesman'], ['party', 'Party'], ['stock_group', 'Company / Brand'], ['item', 'Item']];
export function SalesAnalysis({ by: initialBy, active }: { by?: string; active: boolean }) {
  const nav = useNav();
  const [by, setBy] = useState(initialBy ?? 'beat');
  const [range, setRange] = useState({ from: fyStart(nav), to: nav.workDate });
  const [data, setData] = useState<any>(null);
  useTitle(`Sales by ${BY.find((b) => b[0] === by)?.[1]}`);
  useEffect(() => { if (active) api.get(`/api/reports/sales-by?by=${by}&from=${range.from}&to=${range.to}`).then(setData).catch((e) => nav.toast(e.message, true)); }, [active, useBooksVersion(), by, range]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = data?.rows ?? [];
  const { sel, setSel } = useRows(rows, () => {});
  useKeyBar(BY.map(([k, l], i) => ({ key: `Alt+${i + 1}`, label: `By ${l}`, run: () => setBy(k) })), []);
  useScreenKeys((e) => {
    const i = Number(e.key) - 1;
    if (e.altKey && i >= 0 && i < BY.length) { setBy(BY[i][0]); return true; }
    return false;
  });
  const itemLevel = by === 'item' || by === 'stock_group';
  const total = rows.reduce((a: number, r: any) => a + r.value, 0);
  return (
    <div className="report">
      <div className="toolbar"><Period from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
        <div className="tabs" role="tablist">{BY.map(([k, l]) => <button key={k} role="tab" aria-selected={by === k} className={by === k ? 'on' : ''} onClick={() => setBy(k)}>{l}</button>)}</div></div>
      <table className="r">
        <thead><tr><th>{BY.find((b) => b[0] === by)?.[1]}</th>{itemLevel ? <th className="num">Quantity</th> : <th className="num">Bills</th>}<th className="num">Sales (taxable)</th>
          {!itemLevel && <><th className="num">With GST</th><th className="num">Still due</th></>}<th className="num">Share</th></tr></thead>
        <tbody>
          {rows.map((r: any, i: number) => (
            <tr key={r.name} className={i === sel ? 'sel' : ''} onClick={() => setSel(i)}>
              <td>{r.name}</td><td className="num">{itemLevel ? r.qty : r.bills}</td><td className="num">{formatINR(r.value)}</td>
              {!itemLevel && <><td className="num">{formatINR(r.total)}</td><td className="num">{r.outstanding ? formatINR(r.outstanding) : ''}</td></>}
              <td className="num">{total ? `${Math.round((r.value / total) * 1000) / 10}%` : ''}</td>
            </tr>
          ))}
          {rows.length > 0 && <tr className="total"><td>Total</td><td /><td className="num">{formatINR(total)}</td>{!itemLevel && <><td /><td /></>}<td /></tr>}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state">No sales in this period.</div>}
      {by === 'beat' && <p className="hint">Beats and salesmen come from each party's ledger (Alter → Ledger → Beat / Salesman).</p>}
    </div>
  );
}

// ---------------- Godown stock ----------------
export function GodownStock({ active }: { active: boolean }) {
  const nav = useNav();
  const [to, setTo] = useState(nav.workDate);
  const [data, setData] = useState<any>(null);
  useTitle('Godown Summary');
  useEffect(() => { if (active) api.get(`/api/reports/godown-stock?asOf=${to}`).then(setData).catch((e) => nav.toast(e.message, true)); }, [active, useBooksVersion(), to]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = data?.rows ?? [];
  const { sel, setSel } = useRows(rows, () => {});
  if (!data) return null;
  return (
    <div className="report">
      <div className="toolbar"><Period to={to} single onChange={(_, t) => setTo(t)} /><button className="btn small" onClick={() => nav.push({ name: 'godowns' })}>Godowns…</button></div>
      <table className="r">
        <thead><tr><th>Item</th>{data.godowns.map((g: any) => <th key={g.id} className="num">{g.name}</th>)}<th className="num">Total</th></tr></thead>
        <tbody>
          {rows.map((r: any, i: number) => (
            <tr key={r.id} className={i === sel ? 'sel' : ''} onClick={() => setSel(i)}>
              <td>{r.name}</td>{data.godowns.map((g: any) => <td key={g.id} className="num">{r.godowns[g.id] ? `${r.godowns[g.id]} ${r.unit}` : ''}</td>)}
              <td className="num">{Math.round(Object.values(r.godowns as Record<string, number>).reduce((a, q) => a + q, 0) * 1000) / 1000} {r.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.godowns.length < 2 && <p className="hint">Everything is in the Main Location. Add a godown (for example "Damaged" or a second store) and move stock with a Stock Journal (Alt+F7).</p>}
    </div>
  );
}

export function Godowns({ active }: { active: boolean }) {
  const nav = useNav();
  const [list, setList] = useState<any[]>([]);
  useTitle('Godowns');
  const load = useCallback(() => api.get('/api/godowns').then(setList).catch((e) => nav.toast(e.message, true)), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active) load(); }, [active, load]);
  const create = async () => {
    const name = await promptBox('Name of the new godown (e.g. Damaged, Cuttack store)');
    if (!name) return;
    try { await api.post('/api/godowns', { name }); nav.toast(`Godown "${name}" created`); load(); } catch (e: any) { nav.toast(e.message, true); }
  };
  const rename = async (g: any) => {
    const name = await promptBox(`New name for "${g.name}"`, { value: g.name });
    if (!name || name === g.name) return;
    try { await api.put(`/api/godowns/${g.id}`, { name }); load(); } catch (e: any) { nav.toast(e.message, true); }
  };
  const { sel, setSel } = useRows(list, (g) => (isOwner(nav) ? rename(g) : undefined));
  useKeyBar([{ key: 'Alt+C', label: 'New godown', run: create }], []);
  return (
    <div className="report" style={{ maxWidth: 640 }}>
      <table className="r">
        <thead><tr><th>Godown / location</th></tr></thead>
        <tbody>{list.map((g, i) => <tr key={g.id} className={`click ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)} onDoubleClick={() => rename(g)}><td>{g.name}{g.id === 1 ? ' (opening stock is here)' : ''}</td></tr>)}</tbody>
      </table>
      <p className="hint">Alt+C makes a godown; Enter renames it. With more than one godown, vouchers show a Godown column.</p>
    </div>
  );
}

// ---------------- Scheme claims ----------------
export function SchemeClaims({ active }: { active: boolean }) {
  const nav = useNav();
  const [range, setRange] = useState({ from: fyStart(nav), to: nav.workDate });
  const [data, setData] = useState<any>(null);
  useTitle('Scheme Claims (free goods given)');
  useEffect(() => { if (active) api.get(`/api/reports/scheme-claims?from=${range.from}&to=${range.to}`).then(setData).catch((e) => nav.toast(e.message, true)); }, [active, useBooksVersion(), range]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = data?.rows ?? [];
  const { sel, setSel } = useRows(rows, () => {});
  if (!data) return null;
  return (
    <div className="report">
      <div className="toolbar"><Period from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} /></div>
      <div className="cards">{data.byGroup.map((g: any) => <div key={g.name} className="card"><div className="subtle">{g.name}</div><div className="v">₹{formatINR(g.value)}</div></div>)}</div>
      <table className="r">
        <thead><tr><th>Company</th><th>Item</th><th>Scheme</th><th className="num">Sold</th><th className="num">Free given</th><th className="num">Cost rate</th><th className="num">Claim value</th></tr></thead>
        <tbody>
          {rows.map((r: any, i: number) => (
            <tr key={r.id} className={i === sel ? 'sel' : ''} onClick={() => setSel(i)}>
              <td>{r.stock_group}</td><td>{r.name}</td><td>{r.scheme_buy ? `${r.scheme_buy} + ${r.scheme_free}` : 'by hand'}</td><td className="num">{r.sold_qty} {r.unit}</td>
              <td className="num">{r.free_qty} {r.unit}</td><td className="num">{formatINR(r.rate)}</td><td className="num">{formatINR(r.value)}</td>
            </tr>
          ))}
          {rows.length > 0 && <tr className="total"><td colSpan={6}>Total to claim</td><td className="num">{formatINR(data.total)}</td></tr>}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state">No free goods were given in this period.</div>}
      <p className="hint">Free goods given on sales bills, valued at average purchase cost. Send this to each company with your claim; book the company's credit note as a Debit Note against them, or a Receipt when they pay.</p>
    </div>
  );
}

// ---------------- Bank reconciliation ----------------
export function BankReco({ ledgerId: initial, active }: { ledgerId?: number; active: boolean }) {
  const nav = useNav();
  const [banks, setBanks] = useState<any[]>([]);
  const [ledgerId, setLedgerId] = useState<number | null>(initial ?? null);
  const [to, setTo] = useState(nav.workDate);
  const [data, setData] = useState<any>(null);
  const [dates, setDates] = useState<Record<number, string>>({});
  useTitle(`Bank Reconciliation${data ? ` · ${data.ledger.name}` : ''}`);
  useEffect(() => {
    if (!active) return;
    api.get('/api/ledgers').then((ls: any[]) => {
      const b = ls.filter((l) => ['Bank Accounts', 'Bank OD A/c'].includes(l.group_name));
      setBanks(b);
      if (!ledgerId && b.length) setLedgerId(b[0].id);
    }).catch((e) => nav.toast(e.message, true));
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(() => {
    if (ledgerId) api.get(`/api/reports/brs/${ledgerId}?asOf=${to}`).then((d) => { setData(d); setDates({}); }).catch((e) => nav.toast(e.message, true));
  }, [ledgerId, to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active) load(); }, [active, load]);
  const saveDate = async (r: any) => {
    const text = dates[r.id];
    if (text === undefined) return;
    const d = text.trim() ? parseDate(text, r.date) : null;
    if (text.trim() && !d) { nav.toast('Type the bank date like 12-11-26', true); return; }
    try { await api.put(`/api/vouchers/${r.id}/bank-date`, { date: d }); load(); } catch (e: any) { nav.toast(e.message, true); }
  };
  const save = async () => { for (const r of data?.pending ?? []) if (dates[r.id] !== undefined) await saveDate(r); };
  useKeyBar([{ key: 'Ctrl+A', label: 'Save bank dates', run: save }], [data, dates]);
  useScreenKeys((e) => { if (e.ctrlKey && e.key.toLowerCase() === 'a') { save(); return true; } return false; });
  if (!banks.length) return <div className="empty-state">Make a bank ledger (under Bank Accounts) first.</div>;
  return (
    <div className="report">
      <div className="toolbar">
        <div style={{ width: 260 }}><Combo name="Bank" title="Bank ledgers" value={ledgerId} options={banks.map((b) => ({ id: b.id, label: b.name }))} onChange={setLedgerId} /></div>
        <Period to={to} single onChange={(_, t) => setTo(t)} />
      </div>
      {data && <>
        <div className="cards">
          <div className="card"><div className="subtle">Balance as per books</div><div className="v">{drCr(data.booksBalance) || 'Nil'}</div></div>
          <div className="card warn"><div className="subtle">Not yet in the bank</div><div className="v">{drCr(data.notInBank) || 'Nil'}</div><div className="subtle">{data.pending.length} entries</div></div>
          <div className="card"><div className="subtle">Balance as per bank</div><div className="v">{drCr(data.bankBalance) || 'Nil'}</div></div>
        </div>
        <table className="r">
          <thead><tr><th>Date</th><th>Particulars</th><th>Vch</th><th>Cheque</th><th className="num">Deposit</th><th className="num">Withdrawal</th><th>Bank date</th></tr></thead>
          <tbody>
            {data.pending.map((r: any) => (
              <tr key={r.id}>
                <td>{shortDate(r.date)}</td><td>{r.particulars}</td><td>{VOUCHER_LABEL[r.type]} {r.number}</td><td>{r.cheque_no}</td>
                <td className="num">{r.amount > 0 ? formatINR(r.amount) : ''}</td><td className="num">{r.amount < 0 ? formatINR(-r.amount) : ''}</td>
                <td><input className="f" aria-label={`Bank date ${r.number}`} style={{ width: 100 }} placeholder="dd-mm-yy" value={dates[r.id] ?? (r.bank_date ? shortDate(r.bank_date) : '')}
                  onChange={(e) => setDates((s) => ({ ...s, [r.id]: e.target.value }))} onBlur={() => saveDate(r)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveDate(r); } }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.pending.length && <div className="empty-state">Every entry up to this date is cleared in the bank.</div>}
        <p className="hint">Type the date each entry shows in the bank statement. Cleared entries leave this list.</p>
      </>}
    </div>
  );
}

// ---------------- Post-dated cheques ----------------
export function PdcRegister({ active }: { active: boolean }) {
  const nav = useNav();
  const [rows, setRows] = useState<any[]>([]);
  useTitle('Post-dated Cheques');
  useEffect(() => { if (active) api.get(`/api/reports/pdc?asOf=${nav.workDate}`).then(setRows).catch((e) => nav.toast(e.message, true)); }, [active, useBooksVersion()]); // eslint-disable-line react-hooks/exhaustive-deps
  const { sel, setSel } = useRows(rows, openVoucher(nav));
  return (
    <div className="report">
      <table className="r">
        <thead><tr><th>Due date</th><th>Type</th><th>Party</th><th>Cheque</th><th>Bank</th><th className="num">Amount</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={`click ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)} onDoubleClick={() => openVoucher(nav)(r)}>
              <td>{shortDate(r.date)}</td><td>{VOUCHER_LABEL[r.type]} {r.number}</td><td>{r.party}</td><td>{r.cheque_no}</td><td>{r.bank_name || r.account}</td>
              <td className="num">{formatINR(r.total)}</td><td>{r.upcoming ? <span className="tag warn">Not due</span> : <span className="tag">Due, deposit it</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state">No post-dated cheques. In a Receipt or Payment, Ctrl+T marks the voucher as post-dated.</div>}
    </div>
  );
}

// ---------------- Pending orders and notes ----------------
export function PendingOrders({ kind: initialKind, active }: { kind?: 'sales' | 'purchase'; active: boolean }) {
  const nav = useNav();
  const [kind, setKind] = useState<'sales' | 'purchase'>(initialKind ?? 'sales');
  const [rows, setRows] = useState<any[]>([]);
  useTitle(kind === 'sales' ? 'Sales Orders and Delivery Notes Pending' : 'Purchase Orders and Receipt Notes Pending');
  useEffect(() => { if (active) api.get(`/api/reports/pending-orders?kind=${kind}`).then(setRows).catch((e) => nav.toast(e.message, true)); }, [active, useBooksVersion(), kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const flat = useMemo(() => rows.flatMap((o) => o.lines.map((l: any, j: number) => ({ ...l, order: o, first: j === 0, key: `${o.id}-${l.item_id}` }))), [rows]);
  const { sel, setSel } = useRows(flat, (r: any) => openVoucher(nav)(r.order));
  useKeyBar([{ key: 'Alt+1', label: kind === 'sales' ? 'Purchase side' : 'Sales side', run: () => setKind((k) => (k === 'sales' ? 'purchase' : 'sales')) }], [kind]);
  return (
    <div className="report">
      <table className="r">
        <thead><tr><th>Date</th><th>Voucher</th><th>Party</th><th>Item</th><th className="num">Ordered</th><th className="num">Done</th><th className="num">Pending</th></tr></thead>
        <tbody>
          {flat.map((r: any, i: number) => (
            <tr key={r.key} className={`click ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)} onDoubleClick={() => openVoucher(nav)(r.order)}>
              <td>{r.first ? shortDate(r.order.date) : ''}</td><td>{r.first ? `${VOUCHER_LABEL[r.order.type]} ${r.order.number}` : ''}</td><td>{r.first ? r.order.party : ''}</td>
              <td>{r.name}</td><td className="num">{r.qty} {r.unit}</td><td className="num">{r.done || ''}</td><td className="num">{r.pending} {r.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!flat.length && <div className="empty-state">Nothing pending. Orders and notes leave this list once billed.</div>}
      <p className="hint">Make the bill from the Sales or Purchase voucher: choose the party, then the order or note in "Against order / note".</p>
    </div>
  );
}

// ---------------- TDS register ----------------
export function TdsRegister({ active }: { active: boolean }) {
  const nav = useNav();
  const [range, setRange] = useState({ from: fyStart(nav), to: nav.workDate });
  const [rows, setRows] = useState<any[]>([]);
  useTitle('TDS Register');
  useEffect(() => { if (active) api.get(`/api/reports/tds?from=${range.from}&to=${range.to}`).then(setRows).catch((e) => nav.toast(e.message, true)); }, [active, useBooksVersion(), range]); // eslint-disable-line react-hooks/exhaustive-deps
  const { sel, setSel } = useRows(rows, (r: any) => nav.push({ name: 'ledger-report', props: { id: r.id } }));
  return (
    <div className="report">
      <div className="toolbar"><Period from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} /></div>
      <table className="r">
        <thead><tr><th>Section</th><th>Ledger</th><th className="num">Rate</th><th className="num">Booked (Dr)</th><th className="num">Expected TDS</th><th className="num">TDS deducted</th><th className="num">Short</th></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const expected = Math.round((r.debited * r.tds_rate) / 100);
            return (
              <tr key={r.id} className={`click ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)}>
                <td>{r.tds_section}</td><td>{r.name}</td><td className="num">{r.tds_rate}%</td><td className="num">{formatINR(r.debited)}</td>
                <td className="num">{formatINR(expected)}</td><td className="num">{formatINR(r.tds)}</td><td className="num">{expected - r.tds > 100 ? <span className="tag warn">{formatINR(expected - r.tds)}</span> : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state">No ledger has a TDS section. Set it in the ledger (e.g. Rent 194I, Transport 194C).</div>}
      <p className="hint">Book TDS in the journal or payment with a ledger under Duties &amp; Taxes marked "TDS". Check thresholds with your CA; this register does not file returns.</p>
    </div>
  );
}

// ---------------- GSTR-2B matching ----------------
export function Gstr2b() {
  const nav = useNav();
  const [period, setPeriod] = useState(() => {
    // Last month, worked out on the calendar (not through UTC, which shifts the 1st back a day in India).
    const [y, m] = nav.workDate.split('-').map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  });
  const [json, setJson] = useState<any>(null);
  const [res, setRes] = useState<any>(null);
  const [tab, setTab] = useState<'mismatched' | 'onlyIn2b' | 'onlyInBooks' | 'matched'>('mismatched');
  useTitle('GSTR-2B Reconciliation');
  const pick = async (f: File | undefined) => {
    if (!f) return;
    try { setJson(JSON.parse(await f.text())); setRes(null); } catch { nav.toast('That file is not the GSTR-2B JSON from the portal.', true); }
  };
  const run = async () => {
    try { setRes(await api.post('/api/gst/gstr2b', { json, period })); } catch (e: any) { nav.toast(e.message, true); }
  };
  const rows: any[] = res ? res[tab] : [];
  return (
    <div className="report">
      <div className="toolbar">
        <span className="subtle">Month</span><input className="f" aria-label="Month" style={{ width: 100 }} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-10" />
        <input type="file" accept=".json,application/json" aria-label="GSTR-2B file" onChange={(e) => pick(e.target.files?.[0])} />
        <button className="btn primary" disabled={!json} onClick={run}>Match</button>
      </div>
      {!res && <ol className="steps">
        <li>On the GST portal: Returns → GSTR-2B → choose the month → Download (JSON).</li>
        <li>Choose that file above and press Match. Stockwell compares it with your purchases of the month by supplier GSTIN and bill number.</li>
      </ol>}
      {res && <>
        <div className="cards">
          <div className="card"><div className="subtle">Matched</div><div className="v">{res.summary.matched}</div></div>
          <div className={`card ${res.summary.mismatched ? 'bad' : ''}`}><div className="subtle">Amounts differ</div><div className="v">{res.summary.mismatched}</div></div>
          <div className={`card ${res.summary.onlyIn2b ? 'warn' : ''}`}><div className="subtle">In 2B, not in books</div><div className="v">{res.summary.onlyIn2b}</div></div>
          <div className={`card ${res.summary.onlyInBooks ? 'warn' : ''}`}><div className="subtle">In books, not in 2B</div><div className="v">{res.summary.onlyInBooks}</div><div className="subtle">credit at risk</div></div>
        </div>
        <div className="tabs" role="tablist">
          {([['mismatched', 'Amounts differ'], ['onlyIn2b', 'Missing in books'], ['onlyInBooks', 'Missing in 2B'], ['matched', 'Matched']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <table className="r">
          <thead><tr><th>Supplier</th><th>GSTIN</th><th>Bill no.</th><th>Date</th><th className="num">Taxable</th><th className="num">Tax</th>{tab === 'mismatched' && <><th className="num">Books tax</th><th className="num">Difference</th></>}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.voucherId ? 'click' : ''} onDoubleClick={() => r.voucherId && nav.push({ name: 'voucher', props: { type: 'purchase', id: r.voucherId } })}>
                <td>{r.name ?? r.party}</td><td>{r.gstin}</td><td>{r.number ?? r.supplierInvoice}{r.voucher ? ` (${r.voucher})` : ''}</td><td>{r.date ? shortDate(r.date) : ''}</td>
                <td className="num">{formatINR(r.taxable)}</td><td className="num">{formatINR(r.tax)}</td>
                {tab === 'mismatched' && <><td className="num">{formatINR(r.booksTax)}</td><td className="num">{formatINR(r.diffTax)}</td></>}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty-state">Nothing here.</div>}
        <p className="hint">Claim input credit in GSTR-3B only for bills that are in GSTR-2B. Ask suppliers missing from 2B to file their GSTR-1.</p>
      </>}
    </div>
  );
}

// ---------------- Bulk GST rate change ----------------
export function GstRateChange({ active }: { active: boolean }) {
  const nav = useNav();
  const [items, setItems] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [rate, setRate] = useState('5');
  const [from, setFrom] = useState('');
  useTitle('Change GST Rate');
  useEffect(() => { if (active) api.get('/api/items').then(setItems).catch((e) => nav.toast(e.message, true)); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = items.filter((i) => `${i.name} ${i.stock_group ?? ''} ${i.hsn}`.toLowerCase().includes(filter.toLowerCase()));
  const apply = async () => {
    const d = parseDate(from, nav.workDate);
    if (!d) { nav.toast('Enter the date the new rate applies from, e.g. 22-9-25', true); return; }
    if (!chosen.size) { nav.toast('Tick the items first.', true); return; }
    if (!(await confirmBox(`Set GST ${rate}% from ${shortDate(d)} for ${chosen.size} item${chosen.size > 1 ? 's' : ''}?\nBills before that date keep the old rate.`))) return;
    try { await api.post('/api/items/gst-rate', { itemIds: [...chosen], rate: Number(rate), from: d }); nav.toast('GST rate changed'); setChosen(new Set()); api.get('/api/items').then(setItems); } catch (e: any) { nav.toast(e.message, true); }
  };
  useKeyBar([{ key: 'Ctrl+A', label: 'Apply', run: apply }], [chosen, rate, from]);
  useScreenKeys((e) => { if (e.ctrlKey && e.key.toLowerCase() === 'a') { apply(); return true; } return false; });
  return (
    <div className="report">
      <div className="toolbar">
        <input className="f" aria-label="Filter items" autoFocus placeholder="Filter by name, company or HSN" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn small" onClick={() => setChosen(new Set(shown.map((i) => i.id)))}>Tick all shown</button>
        <span className="subtle">New rate</span><div style={{ width: 90 }}><Select name="New rate" value={rate} onChange={setRate} options={nav.meta.gstRates.map((r: number) => ({ value: r, label: `${r}%` }))} /></div>
        <span className="subtle">from</span><input className="f" aria-label="Applicable from" style={{ width: 110 }} placeholder="dd-mm-yy" value={from} onChange={(e) => setFrom(e.target.value)} />
        <button className="btn primary" onClick={apply}>Apply (Ctrl+A)</button>
      </div>
      <table className="r">
        <thead><tr><th /><th>Item</th><th>Company</th><th>HSN</th><th className="num">Rate now</th><th>Changes</th></tr></thead>
        <tbody>
          {shown.map((i) => (
            <tr key={i.id} className="click" onClick={() => setChosen((s) => { const n = new Set(s); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })}>
              <td><input type="checkbox" readOnly checked={chosen.has(i.id)} aria-label={`Choose ${i.name}`} /></td><td>{i.name}</td><td>{i.stock_group}</td><td>{i.hsn}</td><td className="num">{i.gst_rate}%</td>
              <td className="subtle">{(i.rates ?? []).map((r: any) => `${r.gst_rate}% from ${shortDate(r.from_date)}`).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------- F11 Features ----------------
export function Features() {
  const nav = useNav();
  const c = nav.company;
  const [f, setF] = useState({ allow_negative_stock: !!c.allow_negative_stock, gst_filing: c.gst_filing ?? 'monthly', price_levels: c.price_levels ?? '', expiry_alert_days: String(c.expiry_alert_days ?? 30) });
  useTitle('Company Features (F11)');
  const save = async () => {
    try {
      await api.put('/api/company', { allow_negative_stock: f.allow_negative_stock ? 1 : 0, gst_filing: f.gst_filing, price_levels: f.price_levels, expiry_alert_days: Number(f.expiry_alert_days) || 0 });
      await nav.refreshCompany();
      nav.toast('Features saved. Reopen open screens to see price levels.');
      nav.pop();
    } catch (e: any) { nav.toast(e.message, true); }
  };
  useKeyBar([{ key: 'Ctrl+A', label: 'Accept', run: save }], [f]);
  useScreenKeys((e) => { if (e.ctrlKey && e.key.toLowerCase() === 'a') { save(); return true; } return false; });
  return (
    <div className="form" data-form style={{ maxWidth: 680 }}>
      <h2>Company features</h2>
      <div className="grid">
        <div className="section-title">Inventory</div>
        <Row label="Allow stock to go below zero"><YesNo name="Negative stock" value={f.allow_negative_stock} onChange={(v) => setF({ ...f, allow_negative_stock: v })} /></Row>
        <Row label="Price levels (comma separated)"><Text name="Price levels" value={f.price_levels} onChange={(v) => setF({ ...f, price_levels: v })} placeholder="e.g. Wholesale, Retail, Semi-wholesale" /></Row>
        <Row label="Warn about expiry (days ahead)"><Text name="Expiry days" num value={f.expiry_alert_days} onChange={(v) => setF({ ...f, expiry_alert_days: v })} /></Row>
        <div className="section-title">GST</div>
        <Row label="GST return filing">
          <Select name="GST filing" value={f.gst_filing} onChange={(v) => setF({ ...f, gst_filing: v })} options={[{ value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly (QRMP)' }]} />
        </Row>
      </div>
      <p className="hint">Godowns, batches, alternate units and credit limits switch on by themselves when you set them in a godown, item or ledger. Company details are on F3.</p>
      <div className="actions"><button className="btn primary go" onClick={save}>Accept (Ctrl+A)</button></div>
    </div>
  );
}
