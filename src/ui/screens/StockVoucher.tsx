// Stock Journal (Alt+F7) and Physical Stock (Ctrl+F7): item lines only, no party and no ledgers.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Combo } from '../components/Combo';
import { enterNext } from '../components/Field';
import { confirmBox } from '../components/Dialog';
import { keyName, useKeyBar, useNav, useScreenKeys, useTitle } from '../nav';
import { VOUCHER_LABEL, formatINR, parseDate, rupeesText, shortDate, toPaise } from '../format';

interface Line { key: number; itemId: number | null; batchId: number | null; batchNo: string; qty: string; rate: string; dir: 'in' | 'out' }
let seq = 1;
const blank = (dir: 'in' | 'out' = 'out'): Line => ({ key: seq++, itemId: null, batchId: null, batchNo: '', qty: '', rate: '', dir });

export function StockVoucherForm({ type, id, active }: { type: 'stock_journal' | 'physical_stock'; id?: number; active: boolean }) {
  const nav = useNav();
  // Counting happens on a new Physical Stock voucher; altering one shows what it posted, line by line, as in/out.
  const physical = type === 'physical_stock' && !id;
  const label = VOUCHER_LABEL[type];
  useTitle(id ? `Alter ${label} Voucher` : `${label} Voucher Creation`);
  const [items, setItems] = useState<any[]>([]);
  const [batches, setBatches] = useState<Record<number, any[]>>({});
  const [dateText, setDateText] = useState(shortDate(nav.workDate));
  const [number, setNumber] = useState('');
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [loaded, setLoaded] = useState(!id);
  const saving = useRef(false);
  const date = parseDate(dateText, nav.workDate);
  // F2 changes the date of the voucher being entered, as in Tally.
  useEffect(() => { if (!id) setDateText(shortDate(nav.workDate)); }, [nav.workDate, id]);

  useEffect(() => { if (active) api.get('/api/items').then(setItems).catch((e) => nav.toast(e.message, true)); }, [active]);
  useEffect(() => {
    if (!id && date) api.get(`/api/vouchers/next-number?type=${type}&date=${date}`).then((r) => setNumber(r.number)).catch(() => {});
  }, [id, type, date]);
  const loadBatches = useCallback((itemId: number) => {
    api.get(`/api/items/${itemId}/batches?asOf=${date ?? nav.workDate}`).then((b) => setBatches((s) => ({ ...s, [itemId]: b }))).catch(() => {});
  }, [date]);

  // Altering an existing voucher: Physical Stock is shown as what was posted (in/out), so it is altered as a Stock Journal would be.
  useEffect(() => {
    if (!id) return;
    api.get(`/api/vouchers/${id}`).then((v) => {
      setNumber(v.number);
      setDateText(shortDate(v.date));
      setNarration(v.narration ?? '');
      setLines([...v.lines.map((l: any) => ({ key: seq++, itemId: l.item_id, batchId: l.batch_id, batchNo: l.batch_no ?? '', qty: String(l.qty), rate: rupeesText(l.rate), dir: l.direction > 0 ? 'in' : 'out' })), blank()]);
      for (const l of v.lines) loadBatches(l.item_id);
      setLoaded(true);
    }).catch((e) => nav.toast(e.message, true));
  }, [id]);

  const itemById = (i: number | null) => items.find((x) => x.id === i);
  const setLine = (key: number, patch: Partial<Line>) =>
    setLines((ls) => {
      const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l));
      if (next[next.length - 1].itemId) next.push(blank(next[next.length - 1].dir));
      return next;
    });
  const filled = lines.filter((l) => l.itemId && l.qty !== '');
  const dirty = filled.length > 0 || !!narration;

  const save = async () => {
    if (saving.current) return;
    if (!date) { nav.toast('Enter a valid date', true); return; }
    if (!filled.length) { nav.toast('Add at least one item', true); return; }
    saving.current = true;
    try {
      const body = {
        type, date, narration,
        lines: filled.map((l) => ({
          itemId: l.itemId, batchId: l.batchId || undefined, batchNo: l.batchNo || undefined, qty: Number(l.qty),
          rate: l.rate ? toPaise(l.rate) : undefined, direction: physical ? undefined : l.dir,
        })),
      };
      const v = id ? await api.put(`/api/vouchers/${id}`, body) : await api.post('/api/vouchers', body);
      nav.toast(`${label} ${v.number} saved`);
      if (id) { nav.pop(); return; }
      setLines([blank()]);
      setNarration('');
      api.get(`/api/vouchers/next-number?type=${type}&date=${date}`).then((r) => setNumber(r.number));
    } catch (e: any) { nav.toast(e.message, true); } finally { saving.current = false; }
  };

  useScreenKeys((e) => {
    const k = keyName(e);
    if (k === 'Ctrl+A') { save(); return true; }
    if (k === 'Ctrl+D') {
      const row = (document.activeElement as HTMLElement | null)?.closest('tr[data-line]') as HTMLElement | null;
      const key = Number(row?.dataset.line);
      if (key) setLines((ls) => { const n = ls.filter((x) => x.key !== key); return n.length ? n : [blank()]; });
      return true;
    }
    if (k === 'Esc' && dirty) {
      confirmBox('Quit this voucher? What you typed will be lost.', { yes: 'Quit', no: 'Keep typing' }).then((q) => { if (q) nav.pop(); });
      return true;
    }
    return false;
  });
  useKeyBar([{ key: 'Ctrl+A', label: 'Accept', run: save }, { key: 'Ctrl+D', label: 'Remove line' }], [save]);

  if (!loaded) return <div className="empty-state">Loading…</div>;
  const options = items.map((i) => ({ id: i.id, label: i.name, meta: `${i.stock} ${i.unit}` }));
  const value = filled.reduce((a, l) => a + Math.round(Number(l.qty) * toPaise(l.rate || 0)) * (l.dir === 'in' ? 1 : -1), 0);

  return (
    <div className="voucher" data-form>
      <div className="vhead">
        <div><span className="vtype">{label}</span><span className="vno">No. <b>{number}</b></span></div>
        <div className="vdate">Date <input className="f" aria-label="Date" style={{ width: 110, display: 'inline-block' }} value={dateText} onChange={(e) => setDateText(e.target.value)} onBlur={() => date && setDateText(shortDate(date))} onKeyDown={enterNext} /></div>
      </div>
      <p className="hint" style={{ margin: '8px 16px' }}>
        {physical
          ? 'Type the quantity you counted. Stockwell posts the difference from the books as shortage or excess.'
          : 'Out: stock leaving (damaged, expired, used for repacking). In: stock arriving (the repacked item, or found stock).'}
      </p>
      <table className="lines">
        <thead>
          <tr>
            <th style={{ width: '38%' }}>Name of item</th><th style={{ width: '18%' }}>Batch</th>
            {!physical && <th>In / Out</th>}
            <th className="num">{physical ? 'Counted quantity' : 'Quantity'}</th>
            {!physical && <><th className="num">Rate</th><th className="num">Value</th></>}
            {physical && <th className="num">In books</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, idx) => {
            const it = itemById(l.itemId);
            const bl = l.itemId ? batches[l.itemId] ?? [] : [];
            const inBooks = l.batchId ? bl.find((b) => b.id === l.batchId)?.qty : it?.stock;
            return (
              <tr key={l.key} data-line={l.key}>
                <td><Combo name={`Item ${idx + 1}`} title="List of Stock Items" value={l.itemId} options={options}
                  autoFocus={idx === 0 && !id}
                  onChange={(v) => { const x = itemById(v); setLine(l.key, { itemId: v, batchId: null, batchNo: '', rate: rupeesText(x?.purchase_rate || (x?.opening_qty ? Math.round(x.opening_value / x.opening_qty) : 0)) }); if (x?.track_batch) loadBatches(v); }} /></td>
                <td>
                  {it?.track_batch ? (
                    l.dir === 'in' && !physical
                      ? <input className="f" aria-label={`Batch ${idx + 1}`} placeholder="Batch" value={l.batchNo} onChange={(e) => setLine(l.key, { batchNo: e.target.value })} onKeyDown={enterNext} />
                      : <Combo name={`Batch ${idx + 1}`} title="Batches" value={l.batchId} onChange={(v) => setLine(l.key, { batchId: v })} placeholder={physical ? 'Choose batch' : 'Auto (soonest expiry)'}
                          options={bl.map((b) => ({ id: b.id, label: b.batch_no, meta: `${b.qty} in books${b.expiry_date ? ` · exp ${shortDate(b.expiry_date)}` : ''}` }))} />
                  ) : <span className="subtle">—</span>}
                </td>
                {!physical && (
                  <td><select className="f" aria-label={`Direction ${idx + 1}`} value={l.dir} onChange={(e) => setLine(l.key, { dir: e.target.value as 'in' | 'out' })} onKeyDown={enterNext}>
                    <option value="out">Out</option><option value="in">In</option>
                  </select></td>
                )}
                <td><input className="f num" aria-label={`Quantity ${idx + 1}`} value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} /></td>
                {!physical && <>
                  <td><input className="f num" aria-label={`Rate ${idx + 1}`} value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} /></td>
                  <td className="num">{l.itemId && l.qty ? formatINR(Math.round(Number(l.qty) * toPaise(l.rate || 0))) : ''}</td>
                </>}
                {physical && <td className="num subtle">{it ? `${inBooks ?? 0} ${it.unit}` : ''}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="vtotals">
        <div>
          <div className="row"><label>Narration</label><textarea className="f" aria-label="Narration" rows={2} value={narration} onChange={(e) => setNarration(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmBox('Accept?', { yes: 'Yes', no: 'No' }).then((y) => { if (y) save(); }); } }} /></div>
          <div className="hint" style={{ marginTop: 6 }}>Ctrl+D removes a line. Ctrl+A saves.</div>
        </div>
        {!physical && <table><tbody><tr className="grand"><td>Net value</td><td className="num">{formatINR(value)}</td></tr></tbody></table>}
      </div>
    </div>
  );
}
