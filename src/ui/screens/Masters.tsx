import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Combo } from '../components/Combo';
import { Row, Select, Text, YesNo } from '../components/Field';
import { confirmBox, promptBox } from '../components/Dialog';
import { DepthContext, isOwner, keyName, useKeyBar, useNav, useScreenKeys, useTitle, useBooksVersion } from '../nav';
import { drCr, focusNext, formatINR, isValidGstin, parseDate, rupeesText, shortDate, toPaise } from '../format';

/** Ctrl+A saves; a second press while the first save is still going is ignored, so nothing is saved twice. */
function useSave(save: () => Promise<void>) {
  const busy = useRef(false);
  const nav = useNav();
  const depth = useContext(DepthContext);
  // Anything typed on this form: Esc then asks before throwing it away, as Tally's "Quit? Yes or No".
  const touched = useRef(false);
  useEffect(() => {
    const mark = (e: Event) => {
      const host = (e.target as HTMLElement | null)?.closest?.('[data-depth]');
      if (host && Number(host.getAttribute('data-depth')) === depth) touched.current = true;
    };
    document.addEventListener('input', mark, true);
    document.addEventListener('change', mark, true);
    return () => { document.removeEventListener('input', mark, true); document.removeEventListener('change', mark, true); };
  }, [depth]);
  const once = async () => {
    if (busy.current) return;
    busy.current = true;
    try { await save(); touched.current = false; } finally { busy.current = false; }
  };
  useScreenKeys((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { once(); return true; }
    const k = keyName(e);
    if ((k === 'Esc' || k === 'Ctrl+Q') && touched.current) {
      confirmBox('Quit without saving? What you typed will be lost.', { yes: 'Quit', no: 'Keep typing' }).then((y) => { if (y) nav.pop(); });
      return true;
    }
    return false;
  });
  useKeyBar([{ key: 'Ctrl+A', label: 'Accept', run: once }], [save]);
}

// ---------------- Ledger ----------------
export function LedgerForm({ id, name: initialName, groupHint, onSaved }: { id?: number; name?: string; groupHint?: string; onSaved?: (l: any) => void }) {
  const nav = useNav();
  const [groups, setGroups] = useState<any[]>([]);
  const [l, setL] = useState<any>({ name: initialName ?? '', group_id: null, opening: 0, credit_days: 0, msme_buyer: 0, msme_supplier: 0 });
  const [openText, setOpenText] = useState('');
  const [openSide, setOpenSide] = useState<'Dr' | 'Cr'>('Dr');
  const [limitText, setLimitText] = useState('');
  const [dateText, setDateText] = useState(id ? '' : shortDate(nav.workDate));
  const [salesmen, setSalesmen] = useState<any[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  useTitle(id ? 'Ledger Alteration' : 'Ledger Creation');
  useEffect(() => {
    api.get('/api/salesmen').then(setSalesmen).catch(() => {});
    api.get('/api/areas').then(setAreas).catch(() => {});
  }, []);
  const addSalesman = async (typed: string) => {
    if (!typed.trim()) return;
    try {
      const s = await api.post('/api/salesmen', { name: typed });
      setSalesmen((x) => [...x, s]);
      setL((x: any) => ({ ...x, salesman: s.name }));
      nav.toast(`Salesman "${s.name}" added`);
    } catch (e: any) { nav.toast(e.message, true); }
  };

  useEffect(() => {
    api.get('/api/groups').then((gs) => {
      setGroups(gs);
      if (!id && groupHint) setL((x: any) => ({ ...x, group_id: gs.find((g: any) => g.name === groupHint)?.id ?? null }));
    });
    if (id) api.get(`/api/ledgers/${id}`).then((x) => {
      setL(x);
      setOpenText(rupeesText(Math.abs(x.opening)));
      setOpenSide(x.opening < 0 ? 'Cr' : 'Dr');
      setLimitText(rupeesText(x.credit_limit));
      setDateText(x.created_on ? shortDate(x.created_on) : '');
    });
  }, [id, groupHint]);

  const group = groups.find((g) => g.id === l.group_id);
  /** Names of the group and its parents, to know which questions Tally asks for this ledger. */
  const path = useMemo(() => {
    const out: string[] = [];
    let g = group;
    while (g) { out.push(g.name); g = groups.find((x) => x.id === g.parent_id); }
    return out;
  }, [group, groups]);
  const isIncomeExpense = path.some((n) => ['Direct Expenses', 'Indirect Expenses', 'Direct Incomes', 'Indirect Incomes', 'Sales Accounts', 'Purchase Accounts'].includes(n));
  const isDuties = path.includes('Duties & Taxes');
  const levels: string[] = String(nav.company.price_levels ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const isParty = useMemo(() => {
    let g = group;
    while (g) {
      if (g.name === 'Sundry Debtors' || g.name === 'Sundry Creditors') return true;
      g = groups.find((x) => x.id === g.parent_id);
    }
    return false;
  }, [group, groups]);
  const set = (k: string) => (v: any) => setL((x: any) => ({ ...x, [k]: v }));
  const gstOk = !l.gstin || isValidGstin(l.gstin);

  const save = async () => {
    try {
      const opening = toPaise(openText || 0) * (openSide === 'Cr' ? -1 : 1);
      const created = dateText.trim() ? parseDate(dateText, nav.workDate) : '';
      if (created === null) { nav.toast(`"${dateText}" is not a date. Type it like 5-11-26.`, true); return; }
      const body = { ...l, created_on: created, opening, credit_days: Number(l.credit_days) || 0, credit_limit: toPaise(limitText || 0), tds_rate: Number(l.tds_rate) || 0 };
      const saved = id ? await api.put(`/api/ledgers/${id}`, body) : await api.post('/api/ledgers', body);
      nav.toast(`Ledger "${saved.name}" saved`);
      onSaved?.(saved);
      nav.pop();
    } catch (e: any) { nav.toast(e.message, true); }
  };
  useSave(save);

  return (
    <div className="form" data-form>
      <h2>{id ? 'Alter ledger' : 'Create ledger'}</h2>
      <div className="grid">
        <Row label="Name"><Text name="Name" value={l.name} onChange={set('name')} autoFocus /></Row>
        <Row label="Under">
          <Combo name="Under" title="List of Groups" value={l.group_id} onChange={set('group_id')}
            options={groups.map((g) => ({ id: g.id, label: g.name, meta: g.parent_id ? groups.find((p) => p.id === g.parent_id)?.name : 'Primary' }))} />
        </Row>
        <Row label="Date">
          <Text name="Ledger date" value={dateText} onChange={setDateText} placeholder="e.g. 5-11-26"
            onBlur={() => { const d = parseDate(dateText, nav.workDate); if (d) setDateText(shortDate(d)); }} />
        </Row>
        <Row label="Opening balance">
          <div style={{ display: 'flex', gap: 6 }}>
            <Text name="Opening balance" num value={openText} onChange={setOpenText} />
            <div style={{ width: 70 }}><Select name="Dr or Cr" value={openSide} onChange={(v) => setOpenSide(v as 'Dr' | 'Cr')} options={[{ value: 'Dr', label: 'Dr' }, { value: 'Cr', label: 'Cr' }]} /></div>
          </div>
        </Row>
        {isParty && <Row label="Credit period (days)"><Text name="Credit days" num value={l.credit_days} onChange={set('credit_days')} /></Row>}
        {isParty && <Row label="Credit limit (₹, 0 = none)"><Text name="Credit limit" num value={limitText} onChange={setLimitText} /></Row>}
        {isParty && <Row label="Stop bills if any bill is overdue"><YesNo name="Block overdue" value={!!l.block_overdue} onChange={(v) => set('block_overdue')(v ? 1 : 0)} /></Row>}
        {isParty && levels.length > 0 && <Row label="Price level">
          <Select name="Price level" value={l.price_level ?? ''} onChange={set('price_level')} options={[{ value: '', label: 'Not applicable' }, ...levels.map((x) => ({ value: x, label: x }))]} />
        </Row>}
        {isIncomeExpense && <Row label="Include in assessable value (GST)"><YesNo name="Assessable" value={!!l.assessable} onChange={(v) => set('assessable')(v ? 1 : 0)} /></Row>}
        {isIncomeExpense && !!l.assessable && <p className="hint">On a bill this ledger (freight, packing, trade discount) is spread over the items and taxed at their GST rates.</p>}
        {isDuties && <Row label="Type of duty / tax">
          <Select name="Type of tax" value={l.tax_kind ?? ''} onChange={set('tax_kind')} disabled={['cgst', 'sgst', 'igst', 'roundoff'].includes(l.tax_kind)}
            options={['cgst', 'sgst', 'igst', 'roundoff'].includes(l.tax_kind) ? [{ value: l.tax_kind, label: `GST (${String(l.tax_kind).toUpperCase()}), set by Stockwell` }] : [{ value: '', label: 'Others' }, { value: 'tds', label: 'TDS' }, { value: 'tcs', label: 'TCS' }]} />
        </Row>}
        {(isIncomeExpense || isParty) && <>
          <Row label="TDS section (e.g. 194C, 194I)"><Text name="TDS section" upper value={l.tds_section} onChange={set('tds_section')} placeholder="Blank if no TDS" /></Row>
          {!!l.tds_section && <Row label="TDS rate %"><Text name="TDS rate" num value={l.tds_rate || ''} onChange={set('tds_rate')} /></Row>}
        </>}
        {isParty && <>
          <div className="section-title">Mailing and GST details</div>
          <Row label="Address" wide><textarea className="f" name="Address" aria-label="Address" rows={2} value={l.address ?? ''} onChange={(e) => set('address')(e.target.value)}
            title="Enter adds a line; Enter on an empty line moves on"
            onKeyDown={(e) => {
              // Enter on an empty line (or an empty box) finishes the address and goes to the next field.
              if (e.key !== 'Enter' || e.shiftKey) return;
              const t = e.currentTarget;
              const before = t.value.slice(0, t.selectionStart ?? t.value.length);
              if (!t.value.trim() || before.endsWith('\n') || before === '') {
                e.preventDefault();
                if (t.value.endsWith('\n')) set('address')(t.value.replace(/\n+$/, ''));
                focusNext(t);
              }
            }} /></Row>
          <Row label="City / Town"><Text name="City" value={l.city} onChange={set('city')} /></Row>
          <Row label="Pincode"><Text name="Pincode" value={l.pincode} onChange={set('pincode')} /></Row>
          <Row label="State">
            <Combo name="State" title="States" value={l.state_code || null} onChange={set('state_code')}
              options={Object.entries(nav.meta.states).map(([code, n]) => ({ id: code, label: n as string, meta: code }))} />
          </Row>
          <Row label="GSTIN">
            <Text name="GSTIN" upper value={l.gstin} onChange={set('gstin')} placeholder="Leave blank if unregistered" />
            {!gstOk && <div className="hint" style={{ color: 'var(--danger)' }}>This GSTIN is not valid</div>}
          </Row>
          <Row label="Mobile (WhatsApp)"><Text name="Mobile" value={l.phone} onChange={set('phone')} /></Row>
          <div className="section-title">Distribution</div>
          <Row label="Area / Beat">
            <Combo name="Area" title="Areas (type a new one and press Alt+C)" value={l.beat || null} onChange={(v) => set('beat')(v ?? '')}
              onCreate={(t) => t.trim() && (setAreas((a) => [...new Set([...a, t.trim()])]), set('beat')(t.trim()))}
              options={[...new Set([...areas, ...(l.beat ? [l.beat] : [])])].map((a) => ({ id: a, label: a }))} />
          </Row>
          <Row label="Salesman">
            <Combo name="Salesman" title="Salesmen (Alt+C adds a new one)" value={l.salesman || null} onChange={(v) => set('salesman')(v ?? '')} onCreate={addSalesman}
              options={salesmen.filter((x) => x.active || x.name === l.salesman).map((x) => ({ id: x.name, label: x.name, meta: x.area }))} />
          </Row>
          <div className="section-title">MSME (late payment rules)</div>
          <Row label="Buyer covered by MSME rules"><YesNo name="MSME buyer" value={!!l.msme_buyer} onChange={(v) => set('msme_buyer')(v ? 1 : 0)} /></Row>
          <Row label="Supplier is MSME (43B(h))"><YesNo name="MSME supplier" value={!!l.msme_supplier} onChange={(v) => set('msme_supplier')(v ? 1 : 0)} /></Row>
          {!!l.msme_supplier && <Row label="Supplier Udyam no."><Text name="Udyam" upper value={l.udyam_no} onChange={set('udyam_no')} /></Row>}
        </>}
      </div>
      <div className="actions">
        <button className="btn" onClick={() => nav.pop()}>Cancel (Esc)</button>
        <button className="btn primary go" onClick={save}>Accept (Ctrl+A)</button>
      </div>
    </div>
  );
}

// ---------------- Stock item ----------------
export function ItemForm({ id, name: initialName, onSaved }: { id?: number; name?: string; onSaved?: (i: any) => void }) {
  const nav = useNav();
  const [units, setUnits] = useState<any[]>([]);
  const [sgroups, setSgroups] = useState<any[]>([]);
  const [it, setIt] = useState<any>({ name: initialName ?? '', gst_rate: 18, track_batch: 0, opening_qty: 0, opening_value: 0 });
  const [money, setMoney] = useState({ mrp: '', sale_rate: '', purchase_rate: '', opening_rate: '' });
  const [batch, setBatch] = useState({ no: '', expiry: '' });
  // Opening stock "as on" date: the books start date unless changed; an earlier date back-dates it.
  const [openDate, setOpenDate] = useState(() => shortDate(nav.company.books_from));
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [newRate, setNewRate] = useState({ rate: '', from: '' });
  const levels: string[] = String(nav.company.price_levels ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  useTitle(id ? 'Stock Item Alteration' : 'Stock Item Creation');

  useEffect(() => {
    api.get('/api/units').then((u) => { setUnits(u); if (!id) setIt((x: any) => ({ ...x, unit_id: x.unit_id ?? u.find((y: any) => y.symbol === 'Pcs')?.id })); });
    api.get('/api/stock-groups').then(setSgroups);
    if (id) api.get(`/api/items/${id}`).then((x) => {
      setIt(x);
      setMoney({ mrp: rupeesText(x.mrp), sale_rate: rupeesText(x.sale_rate), purchase_rate: rupeesText(x.purchase_rate), opening_rate: x.opening_qty ? rupeesText(Math.round(x.opening_value / x.opening_qty)) : '' });
      setPrices(Object.fromEntries(Object.entries(x.prices ?? {}).map(([k, v]) => [k, rupeesText(v as number)])));
      setOpenDate(shortDate(x.opening_date ?? nav.company.books_from));
    });
  }, [id]);
  const set = (k: string) => (v: any) => setIt((x: any) => ({ ...x, [k]: v }));
  const m = (k: keyof typeof money) => (v: string) => setMoney((x) => ({ ...x, [k]: v }));
  const openingValue = Math.round(Number(it.opening_qty || 0) * toPaise(money.opening_rate || 0));

  const save = async () => {
    try {
      const od = openDate.trim() ? parseDate(openDate, nav.workDate) : null;
      if (openDate.trim() && !od) { nav.toast(`"${openDate}" is not a date. Type it like 1-11-26, or leave it blank for the books start date (${shortDate(nav.company.books_from)}).`, true); return; }
      const body = {
        ...it, opening_date: od, gst_rate: Number(it.gst_rate) || 0, reorder_level: Number(it.reorder_level) || 0,
        scheme_buy: Number(it.scheme_buy) || 0, scheme_free: Number(it.scheme_free) || 0,
        opening_qty: Number(it.opening_qty) || 0, opening_value: openingValue,
        mrp: toPaise(money.mrp || 0), sale_rate: toPaise(money.sale_rate || 0), purchase_rate: toPaise(money.purchase_rate || 0),
        opening_batch_no: batch.no, opening_expiry: batch.expiry ? parseDate(batch.expiry) ?? batch.expiry : null,
        alt_unit_id: it.alt_unit_id || null, alt_conv: Number(it.alt_conv) || 0,
      };
      delete (body as any).rates; delete (body as any).prices;
      if (newRate.rate !== '' && !parseDate(newRate.from)) { nav.toast('Enter the date the new GST rate applies from, e.g. 1-4-27.', true); return; }
      const saved = id ? await api.put(`/api/items/${id}`, body) : await api.post('/api/items', body);
      if (levels.length && isOwner(nav)) await api.put(`/api/items/${saved.id}/prices`, Object.fromEntries(levels.map((lv) => [lv, toPaise(prices[lv] || 0)])));
      if (newRate.rate !== '') await api.post('/api/items/gst-rate', { itemIds: [saved.id], rate: Number(newRate.rate), from: parseDate(newRate.from) });
      nav.toast(`Item "${saved.name}" saved`);
      onSaved?.(saved);
      nav.pop();
    } catch (e: any) { nav.toast(e.message, true); }
  };
  useSave(save);

  const createGroup = async (typed: string) => {
    const name = typed || (await promptBox('Name of the company or brand')) || '';
    if (!name) return;
    try {
      const g = await api.post('/api/stock-groups', { name });
      setSgroups((s) => [...s, g]);
      set('stock_group_id')(g.id);
    } catch (e: any) { nav.toast(e.message, true); }
  };

  return (
    <div className="form" data-form>
      <h2>{id ? 'Alter stock item' : 'Create stock item'}</h2>
      <div className="grid">
        <Row label="Name"><Text name="Name" value={it.name} onChange={set('name')} autoFocus /></Row>
        <Row label="Under (company)">
          <Combo name="Stock group" title="Companies / Brands" value={it.stock_group_id} onChange={set('stock_group_id')} onCreate={createGroup}
            options={sgroups.map((g) => ({ id: g.id, label: g.name }))} />
        </Row>
        <Row label="Units">
          <Combo name="Units" title="List of Units" value={it.unit_id} onChange={set('unit_id')} options={units.map((u) => ({ id: u.id, label: u.symbol, meta: u.name }))} />
        </Row>
        <Row label="HSN code"><Text name="HSN" value={it.hsn} onChange={set('hsn')} /></Row>
        <Row label="GST rate %">
          <Select name="GST rate" value={it.gst_rate} onChange={set('gst_rate')} options={nav.meta.gstRates.map((r: number) => ({ value: r, label: `${r}%` }))} />
        </Row>
        {id && <>
          {(it.rates ?? []).map((r: any) => <Row key={r.from_date} label={`GST from ${shortDate(r.from_date)}`}><span>{r.gst_rate}%</span></Row>)}
          <Row label="New GST rate from a date">
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ width: 90 }}><Select name="New GST rate" value={newRate.rate} onChange={(v) => setNewRate((x) => ({ ...x, rate: v }))} options={[{ value: '', label: '—' }, ...nav.meta.gstRates.map((r: number) => ({ value: r, label: `${r}%` }))]} /></div>
              <Text name="Applicable from" value={newRate.from} onChange={(v) => setNewRate((x) => ({ ...x, from: v }))} placeholder="from date, e.g. 1-4-27" />
            </div>
          </Row>
        </>}
        <Row label="Alternate unit">
          <Combo name="Alternate unit" title="List of Units" value={it.alt_unit_id ?? null} onChange={set('alt_unit_id')} placeholder="Not applicable (Enter)"
            onEmptyEnter={() => set('alt_unit_id')(null)} options={[{ id: '', label: 'Not applicable' }, ...units.filter((u) => u.id !== it.unit_id).map((u) => ({ id: u.id, label: u.symbol, meta: u.name }))]} />
        </Row>
        {!!it.alt_unit_id && <Row label={`${units.find((u) => u.id === it.unit_id)?.symbol ?? 'Units'} in 1 ${units.find((u) => u.id === it.alt_unit_id)?.symbol ?? ''}`}>
          <Text name="Conversion" num value={it.alt_conv || ''} onChange={set('alt_conv')} placeholder="e.g. 24" />
        </Row>}
        <Row label="MRP"><Text name="MRP" num value={money.mrp} onChange={m('mrp')} /></Row>
        <Row label="Selling rate (before GST)"><Text name="Selling rate" num value={money.sale_rate} onChange={m('sale_rate')} /></Row>
        <Row label="Purchase rate (before GST)"><Text name="Purchase rate" num value={money.purchase_rate} onChange={m('purchase_rate')} /></Row>
        {isOwner(nav) && levels.map((lv) => <Row key={lv} label={`${lv} rate`}><Text name={`${lv} rate`} num value={prices[lv] ?? ''} onChange={(v) => setPrices((p) => ({ ...p, [lv]: v }))} /></Row>)}
        <Row label="Track batches & expiry"><YesNo name="Track batches" value={!!it.track_batch} onChange={(v) => set('track_batch')(v ? 1 : 0)} /></Row>
        <Row label="Reorder level"><Text name="Reorder level" num value={it.reorder_level} onChange={set('reorder_level')} /></Row>
        <div className="section-title">Scheme (buy X get Y free)</div>
        <Row label="Buy quantity"><Text name="Scheme buy" num value={it.scheme_buy || ''} onChange={set('scheme_buy')} /></Row>
        <Row label="Free quantity"><Text name="Scheme free" num value={it.scheme_free || ''} onChange={set('scheme_free')} /></Row>
        <div className="section-title">Opening stock</div>
        <Row label="Quantity"><Text name="Opening quantity" num value={it.opening_qty || ''} onChange={set('opening_qty')} /></Row>
        <Row label="Rate"><Text name="Opening rate" num value={money.opening_rate} onChange={m('opening_rate')} /></Row>
        <Row label="Value"><span className="num">{formatINR(openingValue)}</span></Row>
        <Row label="As on date">
          <Text name="Opening stock date" value={openDate} onChange={setOpenDate} placeholder={`${shortDate(nav.company.books_from)} (books start)`}
            onBlur={() => { const d = parseDate(openDate, nav.workDate); if (openDate.trim() && d) setOpenDate(shortDate(d)); }} />
          <span className="hint"> books start by default; type an earlier date to back-date it</span>
        </Row>
        {!id && !!it.track_batch && <>
          <Row label="Opening batch no."><Text name="Opening batch" value={batch.no} onChange={(v) => setBatch((b) => ({ ...b, no: v }))} /></Row>
          <Row label="Expiry (e.g. 30-11-27)"><Text name="Opening expiry" value={batch.expiry} onChange={(v) => setBatch((b) => ({ ...b, expiry: v }))} /></Row>
        </>}
      </div>
      <div className="actions">
        <button className="btn" onClick={() => nav.pop()}>Cancel (Esc)</button>
        <button className="btn primary go" onClick={save}>Accept (Ctrl+A)</button>
      </div>
    </div>
  );
}

// ---------------- small masters ----------------
export function GroupForm() {
  const nav = useNav();
  const [groups, setGroups] = useState<any[]>([]);
  const [g, setG] = useState<any>({ name: '', parentId: null });
  useTitle('Group Creation');
  useEffect(() => { api.get('/api/groups').then(setGroups); }, []);
  const save = async () => {
    try { await api.post('/api/groups', g); nav.toast(`Group "${g.name}" saved`); nav.pop(); } catch (e: any) { nav.toast(e.message, true); }
  };
  useSave(save);
  return (
    <div className="form" data-form style={{ maxWidth: 520 }}>
      <h2>Create group</h2>
      <Row label="Name"><Text name="Name" value={g.name} onChange={(v) => setG({ ...g, name: v })} autoFocus /></Row>
      <Row label="Under"><Combo name="Under" title="List of Groups" value={g.parentId} onChange={(v) => setG({ ...g, parentId: v })} options={groups.map((x) => ({ id: x.id, label: x.name }))} /></Row>
      <p className="hint">Example: "Retailers - Cuttack" under Sundry Debtors keeps beats apart in reports.</p>
      <div className="actions"><button className="btn primary go" onClick={save}>Accept (Ctrl+A)</button></div>
    </div>
  );
}

export function StockGroupForm() {
  const nav = useNav();
  const [name, setName] = useState('');
  useTitle('Stock Group Creation');
  const save = async () => {
    try { await api.post('/api/stock-groups', { name }); nav.toast(`"${name}" saved`); nav.pop(); } catch (e: any) { nav.toast(e.message, true); }
  };
  useSave(save);
  return (
    <div className="form" data-form style={{ maxWidth: 520 }}>
      <h2>Create stock group</h2>
      <Row label="Name"><Text name="Name" value={name} onChange={setName} autoFocus placeholder="e.g. Patanjali" /></Row>
      <p className="hint">Use one stock group per company you distribute for, so stock and sales can be seen company-wise.</p>
      <div className="actions"><button className="btn primary go" onClick={save}>Accept (Ctrl+A)</button></div>
    </div>
  );
}

export function UnitForm() {
  const nav = useNav();
  const [u, setU] = useState({ symbol: '', name: '', uqc: 'PCS' });
  useTitle('Unit Creation');
  const save = async () => {
    try { await api.post('/api/units', u); nav.toast(`Unit "${u.symbol}" saved`); nav.pop(); } catch (e: any) { nav.toast(e.message, true); }
  };
  useSave(save);
  return (
    <div className="form" data-form style={{ maxWidth: 520 }}>
      <h2>Create unit</h2>
      <Row label="Symbol"><Text name="Symbol" value={u.symbol} onChange={(v) => setU({ ...u, symbol: v })} autoFocus /></Row>
      <Row label="Formal name"><Text name="Formal name" value={u.name} onChange={(v) => setU({ ...u, name: v })} /></Row>
      <Row label="GST unit (UQC)">
        <Select name="UQC" value={u.uqc} onChange={(v) => setU({ ...u, uqc: v })}
          options={['PCS', 'NOS', 'BOX', 'CTN', 'PAC', 'BTL', 'JAR', 'KGS', 'GMS', 'LTR', 'MLT', 'DOZ', 'BAG', 'OTH'].map((x) => ({ value: x, label: x }))} />
      </Row>
      <div className="actions"><button className="btn primary go" onClick={save}>Accept (Ctrl+A)</button></div>
    </div>
  );
}

// ---------------- lists ----------------
export function MasterList({ kind, mode, active }: { kind: 'ledger' | 'item'; mode: 'alter' | 'view' | 'report'; active: boolean }) {
  const nav = useNav();
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  useTitle(kind === 'ledger' ? (mode === 'report' ? 'Select Ledger' : mode === 'view' ? 'Chart of Accounts' : 'Alter Ledger') : 'Alter Stock Item');
  useEffect(() => {
    if (active) api.get(kind === 'ledger' ? '/api/ledgers' : '/api/items').then(setRows);
  }, [active, kind, useBooksVersion()]);
  // Ledger filters: date made (from–to), group, area and salesman.
  const [f, setF] = useState({ from: '', to: '', group: '', area: '', salesman: '' });
  const setFilter = (k: keyof typeof f) => (v: string) => { setF((x) => ({ ...x, [k]: v })); setSel(0); };
  const fromIso = f.from.trim() ? parseDate(f.from, nav.workDate) : null;
  const toIso = f.to.trim() ? parseDate(f.to, nav.workDate) : null;
  const shown = rows.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())
    && (kind !== 'ledger' || ((!fromIso || (r.created_on ?? '') >= fromIso) && (!toIso || (r.created_on ?? '') <= toIso)
      && (!f.group || r.group_name === f.group) && (!f.area || (r.beat || '') === f.area) && (!f.salesman || (r.salesman || '') === f.salesman))));
  const distinct = (k: string) => [...new Set(rows.map((r) => r[k]).filter(Boolean))].sort() as string[];
  const filterBox = { width: 150, background: 'var(--paper)', border: '1px solid var(--line)' };
  const open = (r: any) => {
    if (!r) return;
    if (mode === 'report') nav.push({ name: 'ledger-report', props: { id: r.id } });
    else nav.push({ name: kind === 'ledger' ? 'ledger-form' : 'item-form', props: { id: r.id } });
  };
  useScreenKeys((e) => {
    // The filter boxes keep their own keys; Enter in a date box applies it.
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLSelectElement) return false;
    if (t?.closest?.('[aria-label="Filters"]')) { if (e.key === 'Enter') { t.blur(); return true; } return false; }
    if (e.key === 'ArrowDown') { setSel((s) => Math.min(s + 1, shown.length - 1)); return true; }
    if (e.key === 'ArrowUp') { setSel((s) => Math.max(s - 1, 0)); return true; }
    if (e.key === 'Enter') { open(shown[sel]); return true; }
    return false;
  });
  useKeyBar([{ key: 'Alt+C', label: kind === 'ledger' ? 'New ledger' : 'New item', run: () => nav.push({ name: kind === 'ledger' ? 'ledger-form' : 'item-form' }) }], [kind]);
  return (
    <div className="report">
      <div className="toolbar">
        <input className="f" autoFocus placeholder="Type to search" value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} aria-label="Search" />
        <span className="subtle">{shown.length} of {rows.length}</span>
      </div>
      {kind === 'ledger' && (
        <div className="toolbar" aria-label="Filters">
          <span className="subtle">Date from</span>
          <input className="f" style={{ width: 100 }} aria-label="Date from" placeholder="any" value={f.from} onChange={(e) => setFilter('from')(e.target.value)}
            onBlur={() => { if (f.from.trim()) { const d = parseDate(f.from, nav.workDate); if (d) setFilter('from')(shortDate(d)); else nav.toast(`"${f.from}" is not a date.`, true); } }} />
          <span className="subtle">to</span>
          <input className="f" style={{ width: 100 }} aria-label="Date to" placeholder="any" value={f.to} onChange={(e) => setFilter('to')(e.target.value)}
            onBlur={() => { if (f.to.trim()) { const d = parseDate(f.to, nav.workDate); if (d) setFilter('to')(shortDate(d)); else nav.toast(`"${f.to}" is not a date.`, true); } }} />
          <select className="f" style={filterBox} aria-label="Group filter" value={f.group} onChange={(e) => setFilter('group')(e.target.value)}>
            <option value="">All groups</option>{distinct('group_name').map((g) => <option key={g}>{g}</option>)}
          </select>
          <select className="f" style={filterBox} aria-label="Area filter" value={f.area} onChange={(e) => setFilter('area')(e.target.value)}>
            <option value="">All areas</option>{distinct('beat').map((g) => <option key={g}>{g}</option>)}
          </select>
          <select className="f" style={filterBox} aria-label="Salesman filter" value={f.salesman} onChange={(e) => setFilter('salesman')(e.target.value)}>
            <option value="">All salesmen</option>{distinct('salesman').map((g) => <option key={g}>{g}</option>)}
          </select>
          {Object.values(f).some(Boolean) && <button className="btn small" onClick={() => setF({ from: '', to: '', group: '', area: '', salesman: '' })}>Clear</button>}
        </div>
      )}
      <table className="r">
        <thead>
          {kind === 'ledger'
            ? <tr><th>Ledger</th><th>Under</th><th>Date</th><th>Phone</th><th>Area</th><th>Salesman</th><th className="num">Balance</th></tr>
            : <tr><th>Item</th><th>Company</th><th>HSN</th><th className="num">GST</th><th className="num">Selling rate</th><th className="num">In stock</th></tr>}
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={r.id} className={`click ${i === sel ? 'sel' : ''}`} onClick={() => { setSel(i); open(r); }}>
              {kind === 'ledger'
                ? <><td>{r.name}</td><td>{r.group_name}</td><td>{r.created_on ? shortDate(r.created_on) : ''}</td><td>{r.phone}</td><td>{r.beat}</td><td>{r.salesman}</td><td className="num">{drCr(r.balance)}</td></>
                : <><td>{r.name}</td><td>{r.stock_group}</td><td>{r.hsn}</td><td className="num">{r.gst_rate}%</td><td className="num">{formatINR(r.sale_rate)}</td><td className="num">{r.stock} {r.unit}</td></>}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state">Nothing here yet. Press Alt+C to create one.</div>}
    </div>
  );
}

// ---------------- Salesmen (like Marg's salesman master) ----------------
export function SalesmanForm({ id, name: initialName, onSaved }: { id?: number; name?: string; onSaved?: (s: any) => void }) {
  const nav = useNav();
  const [s, setS] = useState<any>({ name: initialName ?? '', phone: '', area: '', active: 1 });
  const [areas, setAreas] = useState<string[]>([]);
  useTitle(id ? 'Salesman Alteration' : 'Salesman Creation');
  useEffect(() => {
    api.get('/api/areas').then(setAreas).catch(() => {});
    if (id) api.get('/api/salesmen').then((all) => { const x = all.find((y: any) => y.id === id); if (x) setS(x); });
  }, [id]);
  const set = (k: string) => (v: any) => setS((x: any) => ({ ...x, [k]: v }));
  const save = async () => {
    try {
      const body = { name: s.name, phone: s.phone, area: s.area, active: s.active ? 1 : 0 };
      const saved = id ? await api.put(`/api/salesmen/${id}`, body) : await api.post('/api/salesmen', body);
      nav.toast(`Salesman "${saved.name}" saved`);
      onSaved?.(saved);
      nav.pop();
    } catch (e: any) { nav.toast(e.message, true); }
  };
  useSave(save);
  return (
    <div className="form" data-form style={{ maxWidth: 560 }}>
      <h2>{id ? 'Alter salesman' : 'Create salesman'}</h2>
      <Row label="Name"><Text name="Name" value={s.name} onChange={set('name')} autoFocus /></Row>
      <Row label="Mobile"><Text name="Mobile" value={s.phone} onChange={set('phone')} /></Row>
      <Row label="Main area">
        <Combo name="Area" title="Areas (type a new one and press Alt+C)" value={s.area || null} onChange={(v) => set('area')(v ?? '')}
          onCreate={(t) => t.trim() && set('area')(t.trim())}
          options={[...new Set([...areas, ...(s.area ? [s.area] : [])])].map((a) => ({ id: a, label: a }))} />
      </Row>
      {!!id && <Row label="Still working here"><YesNo name="Active" value={!!s.active} onChange={(v) => set('active')(v ? 1 : 0)} /></Row>}
      <p className="hint">
        Give each party its salesman in the party's ledger; bills then take that salesman by themselves, and it can be changed on any bill.
        {id ? ' A new name is carried to the parties and old bills of this salesman.' : ''}
      </p>
      <div className="actions">
        <button className="btn" onClick={() => nav.pop()}>Cancel (Esc)</button>
        <button className="btn primary go" onClick={save}>Accept (Ctrl+A)</button>
      </div>
    </div>
  );
}

export function SalesmenList({ active }: { active: boolean }) {
  const nav = useNav();
  const [rows, setRows] = useState<any[]>([]);
  useTitle('Salesmen');
  useEffect(() => { if (active) api.get('/api/salesmen').then(setRows).catch((e) => nav.toast(e.message, true)); }, [active, useBooksVersion()]); // eslint-disable-line react-hooks/exhaustive-deps
  const owner = isOwner(nav);
  const [sel, setSel] = useState(0);
  const open = (r: any) => {
    if (!r) return;
    if (!owner) { nav.toast('Only an Owner can alter masters. You can still create new ones.', true); return; }
    nav.push({ name: 'salesman-form', props: { id: r.id } });
  };
  useScreenKeys((e) => {
    if (e.key === 'ArrowDown') { setSel((s) => Math.min(s + 1, rows.length - 1)); return true; }
    if (e.key === 'ArrowUp') { setSel((s) => Math.max(s - 1, 0)); return true; }
    if (e.key === 'Enter') { open(rows[sel]); return true; }
    return false;
  });
  const remove = async () => {
    const r = rows[sel];
    if (!r || !(await confirmBox(`Delete salesman "${r.name}"?`, { yes: 'Delete', no: 'Keep', danger: true }))) return;
    try { await api.del(`/api/salesmen/${r.id}`); nav.toast(`${r.name} deleted`); setRows((x) => x.filter((y) => y.id !== r.id)); } catch (e: any) { nav.toast(e.message, true); }
  };
  useKeyBar([
    { key: 'Alt+C', label: 'New salesman', run: () => nav.push({ name: 'salesman-form' }) },
    { key: 'Alt+R', label: 'Sales report', run: () => nav.push({ name: 'sales-analysis', props: { by: 'salesman' } }) },
    ...(owner ? [{ key: 'Alt+D', label: 'Delete', run: remove, disabled: !rows[sel] }] : []),
  ], [rows, sel, owner]);
  return (
    <div className="report">
      <table className="r">
        <thead><tr><th>Salesman</th><th>Mobile</th><th>Main area</th><th className="num">Parties</th><th className="num">Vouchers</th><th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={`click ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)} onDoubleClick={() => open(r)}>
              <td>{r.name}</td><td>{r.phone}</td><td>{r.area}</td><td className="num">{r.parties}</td><td className="num">{r.vouchers}</td>
              <td>{r.active ? '' : <span className="tag">not active</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state">No salesmen yet. Press Alt+C to add one.</div>}
    </div>
  );
}
