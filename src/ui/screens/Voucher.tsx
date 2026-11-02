import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, desktop, openWhatsApp, printUrl } from '../api';
import { Combo } from '../components/Combo';
import { enterNext } from '../components/Field';
import { confirmBox } from '../components/Dialog';
import { useKeyBar, useNav, useScreenKeys, useTitle, keyName } from '../nav';
import { VOUCHER_LABEL, computeInvoice, drCr, focusNext, formatINR, isIntraState, parseDate, rupeesText, schemeFreeQty, shortDate, toPaise } from '../format';

const INVENTORY = ['sales', 'purchase', 'credit_note', 'debit_note'];
const TYPE_KEYS: Record<string, string> = { F4: 'contra', F5: 'payment', F6: 'receipt', F7: 'journal', F8: 'sales', F9: 'purchase', 'Ctrl+F8': 'credit_note', 'Ctrl+F9': 'debit_note' };

interface ItemLine { key: number; itemId: number | null; batchId: number | null; batchNo: string; expiry: string; qty: string; free: string; freeTouched: boolean; rate: string; disc: string }
interface AccLine { key: number; ledgerId: number | null; amount: string; side: 'Dr' | 'Cr'; bills: { ref: string; amount: number }[] | null }

let keySeq = 1;
/** A random key. crypto.randomUUID is missing on the second PC (plain http), so build one from random bytes. */
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const blankItem = (): ItemLine => ({ key: keySeq++, itemId: null, batchId: null, batchNo: '', expiry: '', qty: '', free: '', freeTouched: false, rate: '', disc: '' });
const blankAcc = (side: 'Dr' | 'Cr' = 'Cr'): AccLine => ({ key: keySeq++, ledgerId: null, amount: '', side, bills: null });

/** Saves the bill as PDF (desktop) or opens it for printing (browser). */
export async function printVoucher(id: number, fileName: string, toast: (m: string, e?: boolean) => void) {
  if (!desktop) {
    // Open the window first (browsers only allow it straight after a key press), then point it at the bill.
    const w = window.open('about:blank', '_blank');
    if (!w) throw new Error('The browser blocked the print window. Allow pop-ups for Stockwell.');
    w.location.href = await printUrl(id);
    setTimeout(() => { try { w.print(); } catch { /* window closed */ } }, 800);
    return null;
  }
  const path = await desktop.savePdf(await printUrl(id), fileName);
  toast(`Saved ${path}`);
  return path;
}

export async function sendBillOnWhatsApp(id: number, toast: (m: string, e?: boolean) => void) {
  const msg = await api.get(`/api/vouchers/${id}/whatsapp`);
  if (!msg.phone) toast(`No mobile number for ${msg.partyName}. Add it in the ledger to send directly.`, true);
  if (desktop) {
    const path = await desktop.savePdf(await printUrl(id), msg.fileName);
    await desktop.showInFolder(path);
    toast('Bill PDF is ready in the folder that opened. Drag it into the WhatsApp chat, then press Send.');
  }
  await openWhatsApp(msg.phone, msg.text);
}

export function VoucherForm({ type: initialType, id, active }: { type: string; id?: number; active: boolean }) {
  const nav = useNav();
  const [type, setType] = useState(initialType);
  const inventory = INVENTORY.includes(type);
  const [ledgers, setLedgers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [batches, setBatches] = useState<Record<number, any[]>>({});
  const [number, setNumber] = useState('');
  // The number shown is a guess until saving; the server gives the real next number unless the user typed one.
  const numberTyped = useRef(false);
  // One key per voucher being entered, so a save that is retried after a network hiccup never makes two vouchers.
  const clientKey = useRef(newKey());
  const [dateText, setDateText] = useState(shortDate(nav.workDate));
  const [partyId, setPartyId] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [lines, setLines] = useState<ItemLine[]>([blankItem()]);
  const [acc, setAcc] = useState<AccLine[]>([blankAcc()]);
  const [narration, setNarration] = useState('');
  const [refNo, setRefNo] = useState('');
  const [againstRef, setAgainstRef] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [distance, setDistance] = useState('');
  const [pending, setPending] = useState<Record<number, any[]>>({});
  const [last, setLast] = useState<any>(null);
  const [billEdit, setBillEdit] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(!id);
  const narrationRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const label = VOUCHER_LABEL[type];
  useTitle(id ? `Alter ${label} Voucher` : `${label} Voucher Creation`);

  const reloadMasters = useCallback(async () => {
    const [l, i] = await Promise.all([api.get('/api/ledgers'), api.get('/api/items')]);
    setLedgers(l);
    setItems(i);
  }, []);
  useEffect(() => { if (active) reloadMasters(); }, [active, reloadMasters]);

  const date = parseDate(dateText, nav.workDate);

  useEffect(() => {
    if (!id && date) api.get(`/api/vouchers/next-number?type=${type}&date=${date}`).then((r) => setNumber(r.number));
  }, [id, type, date]);

  // Defaults: the Sales/Purchase ledger for invoices, Cash for receipts and payments.
  useEffect(() => {
    if (id || !ledgers.length) return;
    if (inventory) {
      const name = type === 'sales' || type === 'credit_note' ? 'Sales' : 'Purchase';
      setAccountId((a) => a ?? ledgers.find((l) => l.name === name)?.id ?? null);
    } else if (type !== 'journal') {
      setAccountId((a) => a ?? ledgers.find((l) => l.name === 'Cash')?.id ?? null);
    }
  }, [ledgers, type, inventory, id]);

  // Load an existing voucher for alteration.
  useEffect(() => {
    if (!id) return;
    api.get(`/api/vouchers/${id}`).then((v) => {
      setType(v.type);
      setNumber(v.number);
      setDateText(shortDate(v.date));
      setNarration(v.narration ?? '');
      setRefNo(v.ref_no ?? '');
      setVehicle(v.vehicle_no ?? '');
      setDistance(v.distance_km ? String(v.distance_km) : '');
      if (INVENTORY.includes(v.type)) {
        setPartyId(v.party_id);
        setAccountId(v.account_id);
        setLines([...v.lines.map((l: any) => ({
          key: keySeq++, itemId: l.item_id, batchId: l.batch_id, batchNo: l.batch_no ?? '', expiry: l.expiry_date ?? '',
          qty: String(l.qty), free: l.free_qty ? String(l.free_qty) : '', freeTouched: true, rate: rupeesText(l.rate), disc: l.discount_pct ? String(l.discount_pct) : '',
        })), blankItem()]);
        const agst = v.bills.find((b: any) => b.kind === 'agst');
        if (agst) setAgainstRef(agst.ref);
      } else if (v.type === 'journal') {
        setAcc([...v.entries.map((e: any) => ({ key: keySeq++, ledgerId: e.ledger_id, amount: rupeesText(Math.abs(e.amount)), side: e.amount > 0 ? 'Dr' : 'Cr', bills: null })), blankAcc('Dr')]);
      } else {
        setAccountId(v.account_id);
        const others = v.entries.filter((e: any) => e.ledger_id !== v.account_id);
        setAcc([...others.map((e: any) => ({
          key: keySeq++, ledgerId: e.ledger_id, amount: rupeesText(Math.abs(e.amount)), side: 'Cr',
          bills: v.bills.filter((b: any) => b.ledger_id === e.ledger_id && b.kind === 'agst').map((b: any) => ({ ref: b.ref, amount: Math.abs(b.amount) })),
        })), blankAcc()]);
      }
      setLoaded(true);
    }).catch((e) => nav.toast(e.message, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const company = nav.company;
  const party = ledgers.find((l) => l.id === partyId);
  const intra = isIntraState(company.state_code, party?.state_code || company.state_code);
  const itemById = (iid: number | null) => items.find((i) => i.id === iid);

  const loadBatches = useCallback(async (itemId: number) => {
    const b = await api.get(`/api/items/${itemId}/batches`);
    setBatches((s) => ({ ...s, [itemId]: b }));
  }, []);

  const loadPending = useCallback(async (ledgerId: number) => {
    const b = await api.get(`/api/reports/pending-bills/${ledgerId}`);
    setPending((s) => ({ ...s, [ledgerId]: b }));
  }, []);
  useEffect(() => { if (partyId && (type === 'credit_note' || type === 'debit_note')) loadPending(partyId); }, [partyId, type, loadPending]);

  const filledLines = lines.filter((l) => l.itemId && Number(l.qty) > 0);
  const totals = useMemo(() => computeInvoice(filledLines.map((l) => ({
    qty: Number(l.qty), rate: toPaise(l.rate || 0), discountPct: Number(l.disc) || 0, gstRate: itemById(l.itemId)?.gst_rate ?? 0,
  })), intra), [filledLines, intra, items]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLine = (key: number, patch: Partial<ItemLine>) => setLines((ls) => {
    const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l));
    if (next[next.length - 1].itemId) next.push(blankItem());
    return next;
  });

  const pickItem = (key: number, itemId: number) => {
    const it = itemById(itemId);
    const sell = type === 'sales' || type === 'credit_note';
    setLine(key, { itemId, rate: rupeesText(sell ? it?.sale_rate : it?.purchase_rate), batchId: null, batchNo: '', freeTouched: false });
    if (it?.track_batch) loadBatches(itemId);
  };

  const setQty = (l: ItemLine, qty: string) => {
    const it = itemById(l.itemId);
    const patch: Partial<ItemLine> = { qty };
    if (type === 'sales' && !l.freeTouched) {
      const f = schemeFreeQty(Number(qty) || 0, it?.scheme_buy, it?.scheme_free);
      patch.free = f ? String(f) : '';
    }
    setLine(l.key, patch);
  };

  // ---------- accounting lines ----------
  const setAccLine = (key: number, patch: Partial<AccLine>) => setAcc((ls) => {
    const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l));
    if (next[next.length - 1].ledgerId) next.push(blankAcc(type === 'journal' ? (drTotal() > crTotal(next) ? 'Cr' : 'Dr') : 'Cr'));
    return next;
  });
  const drTotal = (ls = acc) => ls.filter((l) => l.side === 'Dr').reduce((a, l) => a + toPaise(l.amount || 0), 0);
  const crTotal = (ls = acc) => ls.filter((l) => l.side === 'Cr').reduce((a, l) => a + toPaise(l.amount || 0), 0);
  const accTotal = acc.reduce((a, l) => a + toPaise(l.amount || 0), 0);

  /** Oldest bills first, the way most shops settle. */
  const autoAllocate = (ledgerId: number, amount: number) => {
    const bills = (pending[ledgerId] ?? []).filter((b) => (type === 'receipt' ? b.pending > 0 : b.pending < 0));
    let left = amount;
    const out: { ref: string; amount: number }[] = [];
    for (const b of bills) {
      if (left <= 0) break;
      const take = Math.min(left, Math.abs(b.pending));
      out.push({ ref: b.ref, amount: take });
      left -= take;
    }
    return out;
  };

  const isBillWise = (ledgerId: number | null) => !!ledgers.find((l) => l.id === ledgerId)?.bill_wise;

  // ---------- save ----------
  const reset = () => {
    setLines([blankItem()]);
    setAcc([blankAcc()]);
    setPartyId(null);
    setNarration('');
    setRefNo('');
    setAgainstRef('');
    setVehicle('');
    setDistance('');
    setTimeout(() => (formRef.current?.querySelector('input.f') as HTMLElement | null)?.focus(), 50);
  };

  const saving = useRef(false);
  const save = async () => {
    if (saving.current) return; // a second Ctrl+A while saving must not make a second voucher
    if (!date) { nav.toast('Enter a valid date', true); return; }
    saving.current = true;
    try { await doSave(); } finally { saving.current = false; }
  };
  const doSave = async () => {
    const body: any = { type, date, narration };
    if (id || numberTyped.current) body.number = number;
    if (!id) body.clientKey = clientKey.current;
    if (inventory) {
      Object.assign(body, {
        partyId, accountId, refNo, againstRef: againstRef || undefined, vehicleNo: vehicle, distanceKm: Number(distance) || 0,
        lines: filledLines.map((l) => ({
          itemId: l.itemId, batchId: l.batchId || undefined, batchNo: l.batchNo || undefined, expiryDate: l.expiry || undefined,
          qty: Number(l.qty), freeQty: Number(l.free) || 0, rate: toPaise(l.rate || 0), discountPct: Number(l.disc) || 0,
        })),
      });
    } else if (type === 'journal') {
      body.entries = acc.filter((l) => l.ledgerId && toPaise(l.amount || 0)).map((l) => ({ ledgerId: l.ledgerId, amount: toPaise(l.amount) * (l.side === 'Dr' ? 1 : -1) }));
    } else {
      body.accountId = accountId;
      body.entries = acc.filter((l) => l.ledgerId && toPaise(l.amount || 0)).map((l) => {
        const amount = toPaise(l.amount);
        const bills = isBillWise(l.ledgerId) ? (l.bills ?? autoAllocate(l.ledgerId!, amount)) : undefined;
        return { ledgerId: l.ledgerId, amount, bills };
      });
    }
    try {
      const v = id ? await api.put(`/api/vouchers/${id}`, body) : await api.post('/api/vouchers', body);
      nav.toast(`${label} ${v.number} saved · ₹${formatINR(v.total)}`);
      if (id) { nav.pop(); return; }
      setLast(v);
      numberTyped.current = false;
      clientKey.current = newKey();
      reset();
      api.get(`/api/vouchers/next-number?type=${type}&date=${date}`).then((r) => setNumber(r.number));
      if (Object.keys(batches).length) Object.keys(batches).forEach((k) => loadBatches(Number(k)));
    } catch (e: any) { nav.toast(e.message, true); }
  };

  const cancelVoucher = async () => {
    if (!id || !(await confirmBox(`Cancel ${label} ${number}?\nThe number stays used and the voucher shows as cancelled.`, { danger: true }))) return;
    try { await api.post(`/api/vouchers/${id}/cancel`); nav.toast(`${number} cancelled`); nav.pop(); } catch (e: any) { nav.toast(e.message, true); }
  };

  const print = async (vid: number, no: string) => { try { await printVoucher(vid, `${no.replace(/[\\/:*?"<>|]/g, '-')}.pdf`, nav.toast); } catch (e: any) { nav.toast(e.message, true); } };
  const whatsapp = async (vid: number) => { try { await sendBillOnWhatsApp(vid, nav.toast); } catch (e: any) { nav.toast(e.message, true); } };

  const dirty = inventory ? !!partyId || filledLines.length > 0 : acc.some((l) => l.ledgerId || l.amount);
  useScreenKeys((e) => {
    const k = keyName(e);
    if (k === 'Ctrl+A') { save(); return true; }
    if (k === 'Esc' && dirty) {
      // Like Tally's "Quit? Yes or No": an unsaved voucher is never thrown away by one stray Esc.
      confirmBox(id ? 'Leave without saving the changes?' : 'Quit this voucher? What you typed will be lost.', { yes: 'Quit', no: 'Keep typing' })
        .then((quit) => { if (quit) nav.pop(); });
      return true;
    }
    if (TYPE_KEYS[k] && !id) {
      const t = TYPE_KEYS[k];
      if (t !== type) { setType(t); setAccountId(null); setLines([blankItem()]); setAcc([blankAcc(t === 'journal' ? 'Dr' : 'Cr')]); setPartyId(null); }
      return true;
    }
    if (k === 'Alt+X' && id) { cancelVoucher(); return true; }
    const target = id ?? last?.id;
    const targetNo = id ? number : last?.number;
    if (k === 'Alt+P' && target && inventory) { print(target, targetNo); return true; }
    if (k === 'Alt+W' && target && (id ? type === 'sales' : last?.type === 'sales')) { whatsapp(target); return true; }
    return false;
  });
  const target = id ?? last?.id;
  useKeyBar([
    { key: 'Ctrl+A', label: 'Accept', run: save },
    { key: 'Alt+P', label: 'Print / PDF', run: () => target && print(target, id ? number : last.number), disabled: !target || !inventory },
    { key: 'Alt+W', label: 'WhatsApp bill', run: () => target && whatsapp(target), disabled: !target || !(id ? type === 'sales' : last?.type === 'sales') },
    ...(id ? [{ key: 'Alt+X', label: 'Cancel voucher', run: cancelVoucher }] : []),
  ], [save, target, inventory, type, id, number, last]);

  if (!loaded) return <div className="empty-state">Loading…</div>;

  const partyOptions = ledgers
    .filter((l) => ['Sundry Debtors', 'Sundry Creditors', 'Cash-in-Hand', 'Bank Accounts'].includes(l.group_name) || l.bill_wise)
    .map((l) => ({ id: l.id, label: l.name, meta: drCr(l.balance) || l.group_name }));
  const allLedgerOptions = ledgers.map((l) => ({ id: l.id, label: l.name, meta: drCr(l.balance) || l.group_name }));
  const cashBank = ledgers.filter((l) => ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'].includes(l.group_name)).map((l) => ({ id: l.id, label: l.name, meta: drCr(l.balance) }));
  const accountOptions = ledgers.filter((l) => (type === 'sales' || type === 'credit_note' ? l.group_name === 'Sales Accounts' : l.group_name === 'Purchase Accounts')).map((l) => ({ id: l.id, label: l.name }));
  const itemOptions = items.map((i) => ({ id: i.id, label: i.name, meta: `${i.stock} ${i.unit} · ₹${formatINR(type === 'purchase' ? i.purchase_rate : i.sale_rate)}` }));
  const createParty = (typed: string) => nav.push({
    name: 'ledger-form',
    props: { name: typed, groupHint: type === 'purchase' || type === 'debit_note' ? 'Sundry Creditors' : 'Sundry Debtors', onSaved: (l: any) => { reloadMasters(); setPartyId(l.id); } },
  });
  const createItem = (key: number) => (typed: string) => nav.push({ name: 'item-form', props: { name: typed, onSaved: async (it: any) => { await reloadMasters(); setLine(key, { itemId: it.id, rate: rupeesText(it.sale_rate) }); } } });
  const showEway = type === 'sales' && totals.total > company.ewb_threshold;

  return (
    <div className="voucher" data-form ref={formRef}>
      <div className="vhead">
        <div><span className="vtype">{label}</span><span className="vno">No. <input className="f" style={{ width: 150, display: 'inline-block' }} aria-label="Voucher number" value={number} onChange={(e) => { numberTyped.current = true; setNumber(e.target.value); }} onKeyDown={enterNext} /></span></div>
        {last && !id && (
          <div className="subtle">
            Last saved: <b>{last.number}</b> ₹{formatINR(last.total)}{' '}
            {INVENTORY.includes(last.type) && <button className="btn small" onClick={() => print(last.id, last.number)}>Print (Alt+P)</button>}{' '}
            {last.type === 'sales' && <button className="btn small wa" onClick={() => whatsapp(last.id)}>WhatsApp (Alt+W)</button>}
          </div>
        )}
        <div>Date <input className="f" style={{ width: 110, display: 'inline-block' }} aria-label="Date" value={dateText} onChange={(e) => setDateText(e.target.value)} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} />
          <span className="subtle"> {date ? new Date(date).toLocaleDateString('en-IN', { weekday: 'long' }) : 'invalid date'}</span></div>
      </div>

      {inventory ? (
        <>
          <div className="vparty">
            <div className="row"><label>Party A/c name</label>
              <Combo name="Party" title="List of Ledger Accounts" value={partyId} options={partyOptions} autoFocus={!id}
                onChange={(v) => setPartyId(v)} onCreate={createParty} />
            </div>
            <div className="row"><label>{type === 'sales' || type === 'credit_note' ? 'Sales ledger' : 'Purchase ledger'}</label>
              <Combo name="Account" title="Ledgers" value={accountId} options={accountOptions} onChange={setAccountId} />
            </div>
            {party && <div className="balance">Current balance: {drCr(party.balance) || 'Nil'} · {party.state_code ? `${nav.meta.states[party.state_code]} · ` : ''}{intra ? 'CGST + SGST' : 'IGST'}{party.gstin ? ` · ${party.gstin}` : ' · Unregistered'}</div>}
            {type === 'purchase' && <div className="row"><label>Supplier invoice no.</label><input className="f" aria-label="Supplier invoice" value={refNo} onChange={(e) => setRefNo(e.target.value)} onKeyDown={enterNext} /></div>}
            {(type === 'credit_note' || type === 'debit_note') && (
              <div className="row"><label>Against bill</label>
                <Combo name="Against bill" title="Pending bills" value={againstRef || null} onChange={(v) => setAgainstRef(v)}
                  options={(partyId ? pending[partyId] ?? [] : []).map((b: any) => ({ id: b.ref, label: b.ref, meta: `${shortDate(b.bill_date)} · ${drCr(b.pending)}` }))} />
              </div>
            )}
          </div>
          <table className="lines">
            <thead>
              <tr>
                <th style={{ width: '32%' }}>Name of item</th><th style={{ width: '15%' }}>Batch</th>
                <th className="num">Quantity</th><th className="num">Free</th><th className="num">Rate</th><th className="num">Disc %</th><th className="num">GST</th><th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, idx) => {
                const it = itemById(l.itemId);
                const t = l.itemId && Number(l.qty) > 0 ? totals.lines[filledLines.findIndex((f) => f.key === l.key)] : null;
                const bl = l.itemId ? batches[l.itemId] ?? [] : [];
                return (
                  <tr key={l.key}>
                    <td>
                      <Combo name={`Item ${idx + 1}`} title="List of Stock Items" value={l.itemId} options={itemOptions} onChange={(v) => pickItem(l.key, v)}
                        onCreate={createItem(l.key)} onEmptyEnter={() => (idx === lines.length - 1 ? narrationRef.current?.focus() : undefined)} />
                    </td>
                    <td>
                      {it?.track_batch ? (
                        type === 'purchase' || type === 'credit_note' ? (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <input className="f" aria-label={`Batch ${idx + 1}`} placeholder="Batch" value={l.batchNo} onChange={(e) => setLine(l.key, { batchNo: e.target.value })} onKeyDown={enterNext} />
                            <input className="f" aria-label={`Expiry ${idx + 1}`} placeholder="Expiry" title="Expiry date, e.g. 30-11-26" value={l.expiry ? shortDate(l.expiry) : ''} onChange={(e) => setLine(l.key, { expiry: parseDate(e.target.value) ?? '' })} onKeyDown={enterNext} />
                          </div>
                        ) : (
                          <Combo name={`Batch ${idx + 1}`} title="Batches (soonest expiry first)" value={l.batchId} onChange={(v) => setLine(l.key, { batchId: v })}
                            options={bl.filter((b) => b.qty > 0 || b.id === l.batchId).map((b) => ({ id: b.id, label: b.batch_no, meta: `${b.qty} left${b.expiry_date ? ` · exp ${shortDate(b.expiry_date)}` : ''}` }))} placeholder="Auto (FEFO)" />
                        )
                      ) : <span className="subtle">—</span>}
                    </td>
                    <td><input className="f num" aria-label={`Quantity ${idx + 1}`} value={l.qty} onChange={(e) => setQty(l, e.target.value)} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} /></td>
                    <td><input className="f num" aria-label={`Free ${idx + 1}`} value={l.free} onChange={(e) => setLine(l.key, { free: e.target.value, freeTouched: true })} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} /></td>
                    <td><input className="f num" aria-label={`Rate ${idx + 1}`} value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} /></td>
                    <td><input className="f num" aria-label={`Discount ${idx + 1}`} value={l.disc} onChange={(e) => setLine(l.key, { disc: e.target.value })} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} /></td>
                    <td className="num subtle">{it ? `${it.gst_rate}%` : ''}</td>
                    <td className="num">{t ? formatINR(t.taxable) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="vtotals">
            <div>
              <div className="row"><label>Narration</label><textarea ref={narrationRef} className="f" aria-label="Narration" rows={2} value={narration} onChange={(e) => setNarration(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (showEway) focusNext(e.currentTarget); else save(); } }} /></div>
              {type === 'sales' && (
                <div className="row"><label>Vehicle / distance</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="f" aria-label="Vehicle number" placeholder="Vehicle no." value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())} onKeyDown={enterNext} />
                    <input className="f num" aria-label="Distance km" placeholder="km" style={{ width: 80 }} value={distance} onChange={(e) => setDistance(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
                  </div>
                </div>
              )}
              {showEway && <div className="hint"><span className="tag warn">e-Way Bill needed</span> This bill is over ₹{formatINR(company.ewb_threshold)}. Fill the vehicle and distance; make the e-Way Bill from GST Returns.</div>}
              <div className="hint" style={{ marginTop: 6 }}>Press Enter on an empty item line to finish items. Ctrl+A saves.</div>
            </div>
            <table>
              <tbody>
                <tr><td>Taxable value</td><td className="num">{formatINR(totals.taxable)}</td></tr>
                {intra ? <>
                  <tr><td>CGST</td><td className="num">{formatINR(totals.cgst)}</td></tr>
                  <tr><td>SGST</td><td className="num">{formatINR(totals.sgst)}</td></tr>
                </> : <tr><td>IGST</td><td className="num">{formatINR(totals.igst)}</td></tr>}
                {totals.roundOff !== 0 && <tr><td>Round off</td><td className="num">{formatINR(totals.roundOff)}</td></tr>}
                <tr className="grand"><td>Total</td><td className="num">₹{formatINR(totals.total)}</td></tr>
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          {type !== 'journal' && (
            <div className="vparty">
              <div className="row"><label>Account</label>
                <Combo name="Account" title="Cash and Bank" value={accountId} options={cashBank} onChange={setAccountId} autoFocus={!id} />
              </div>
              <div className="balance">{accountId ? `Current balance: ${drCr(ledgers.find((l) => l.id === accountId)?.balance ?? 0) || 'Nil'}` : ''}</div>
            </div>
          )}
          <table className="lines">
            <thead>
              <tr>{type === 'journal' && <th style={{ width: 60 }}>Dr/Cr</th>}<th style={{ width: '45%' }}>Particulars</th><th>Bill-wise</th>{type === 'journal' ? <><th className="num">Debit</th><th className="num">Credit</th></> : <th className="num">Amount</th>}</tr>
            </thead>
            <tbody>
              {acc.map((l, idx) => {
                const amt = toPaise(l.amount || 0);
                const bw = isBillWise(l.ledgerId);
                const alloc = bw && amt && type !== 'journal' && type !== 'contra' ? (l.bills ?? autoAllocate(l.ledgerId!, amt)) : [];
                const onAcc = amt - alloc.reduce((a, b) => a + b.amount, 0);
                const options = type === 'contra' ? cashBank : allLedgerOptions;
                return (
                  <tr key={l.key}>
                    {type === 'journal' && <td>
                      <select className="f" aria-label={`Side ${idx + 1}`} value={l.side} onChange={(e) => setAccLine(l.key, { side: e.target.value as 'Dr' | 'Cr' })} onKeyDown={enterNext}><option>Dr</option><option>Cr</option></select>
                    </td>}
                    <td>
                      <Combo name={`Particulars ${idx + 1}`} title="List of Ledger Accounts" value={l.ledgerId} options={options} autoFocus={type === 'journal' && idx === 0 && !id}
                        onChange={(v) => { setAccLine(l.key, { ledgerId: v, bills: null }); if (isBillWise(v)) loadPending(v); }}
                        onCreate={(typed) => nav.push({ name: 'ledger-form', props: { name: typed, onSaved: (x: any) => { reloadMasters(); setAccLine(l.key, { ledgerId: x.id }); } } })}
                        onEmptyEnter={() => narrationRef.current?.focus()} />
                    </td>
                    <td className="subtle">
                      {bw && amt > 0 && type !== 'journal' && type !== 'contra' && (
                        <button className="btn small" onClick={() => setBillEdit(l.key)} title="Choose which bills this settles">
                          {alloc.length ? `Agst ${alloc.map((b) => b.ref).join(', ')}` : 'On account'}{onAcc > 0 && alloc.length ? ` + ₹${formatINR(onAcc)} on acc` : ''}
                        </button>
                      )}
                    </td>
                    {type === 'journal' ? <>
                      <td><input className="f num" aria-label={`Debit ${idx + 1}`} disabled={l.side !== 'Dr'} value={l.side === 'Dr' ? l.amount : ''} onChange={(e) => setAccLine(l.key, { amount: e.target.value })} onKeyDown={enterNext} /></td>
                      <td><input className="f num" aria-label={`Credit ${idx + 1}`} disabled={l.side !== 'Cr'} value={l.side === 'Cr' ? l.amount : ''} onChange={(e) => setAccLine(l.key, { amount: e.target.value })} onKeyDown={enterNext} /></td>
                    </> : <td><input className="f num" aria-label={`Amount ${idx + 1}`} value={l.amount} onChange={(e) => setAccLine(l.key, { amount: e.target.value, bills: null })} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} /></td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="vtotals">
            <div className="row"><label>Narration</label><textarea ref={narrationRef} className="f" aria-label="Narration" rows={2} value={narration} onChange={(e) => setNarration(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } }} /></div>
            <table><tbody>
              {type === 'journal'
                ? <><tr><td>Debit</td><td className="num">{formatINR(drTotal())}</td></tr><tr><td>Credit</td><td className="num">{formatINR(crTotal())}</td></tr>
                  <tr className="grand"><td>Difference</td><td className="num" style={{ color: drTotal() === crTotal() ? 'var(--good)' : 'var(--danger)' }}>{formatINR(drTotal() - crTotal())}</td></tr></>
                : <tr className="grand"><td>Total</td><td className="num">₹{formatINR(accTotal)}</td></tr>}
            </tbody></table>
          </div>
        </>
      )}
      {billEdit !== null && (() => {
        const line = acc.find((x) => x.key === billEdit)!;
        return <BillAllocation
          bills={(pending[line.ledgerId!] ?? []).filter((b: any) => (type === 'receipt' ? b.pending > 0 : b.pending < 0))}
          amount={toPaise(line.amount || 0)}
          initial={line.bills ?? autoAllocate(line.ledgerId!, toPaise(line.amount || 0))}
          onDone={(b) => { if (b) setAccLine(line.key, { bills: b }); setBillEdit(null); }}
        />;
      })()}
    </div>
  );
}

function BillAllocation({ bills, amount, initial, onDone }: { bills: any[]; amount: number; initial: { ref: string; amount: number }[]; onDone: (b: { ref: string; amount: number }[] | null) => void }) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(initial.map((b) => [b.ref, rupeesText(b.amount)])));
  const used = Object.values(vals).reduce((a, v) => a + toPaise(v || 0), 0);
  const finish = () => onDone(Object.entries(vals).filter(([, v]) => toPaise(v || 0) > 0).map(([ref, v]) => ({ ref, amount: toPaise(v) })));
  return (
    <div className="modal-back" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onDone(null); if ((e.ctrlKey && e.key.toLowerCase() === 'a')) { e.preventDefault(); finish(); } }}>
      <div className="modal" data-form>
        <h3>Bill-wise details · ₹{formatINR(amount)}</h3>
        <table className="lines">
          <thead><tr><th>Bill</th><th>Date</th><th className="num">Pending</th><th className="num">Settle now</th></tr></thead>
          <tbody>
            {bills.map((b, i) => (
              <tr key={b.ref}>
                <td>{b.ref}</td><td>{shortDate(b.bill_date)}</td><td className="num">{formatINR(Math.abs(b.pending))}</td>
                <td><input className="f num" autoFocus={i === 0} aria-label={`Settle ${b.ref}`} value={vals[b.ref] ?? ''} onChange={(e) => setVals((s) => ({ ...s, [b.ref]: e.target.value }))} onKeyDown={enterNext} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!bills.length && <div className="empty-state">No pending bills. The amount goes on account.</div>}
        <p className="hint">Allocated ₹{formatINR(used)} · On account ₹{formatINR(Math.max(0, amount - used))}</p>
        <div className="actions"><button className="btn" onClick={() => onDone(null)}>Cancel</button><button className="btn primary go" onClick={finish}>Done (Ctrl+A)</button></div>
      </div>
    </div>
  );
}
