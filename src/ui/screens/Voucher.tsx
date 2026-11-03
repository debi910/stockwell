import { flushSync } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, desktop, openWhatsApp, printUrl } from '../api';
import { Combo } from '../components/Combo';
import { enterNext } from '../components/Field';
import { confirmBox } from '../components/Dialog';
import { isOwner, useKeyBar, useNav, useScreenKeys, useTitle, keyName } from '../nav';
import { VOUCHER_LABEL, computeBill, drCr, focusNext, formatINR, isIntraState, parseDate, rateOn, rupeesText, schemeFreeQty, shortDate, toPaise } from '../format';

const INVENTORY = ['sales', 'purchase', 'credit_note', 'debit_note', 'sales_order', 'purchase_order', 'rejection_in', 'rejection_out', 'delivery_note', 'receipt_note'];
/** Types that post to ledgers (orders, notes and rejections only move stock or nothing). */
const BOOKS = ['sales', 'purchase', 'credit_note', 'debit_note'];
/** Types priced at the selling rate. */
const SELL = ['sales', 'credit_note', 'sales_order', 'rejection_in', 'delivery_note'];
/** Types that bring stock in, so a new batch can be typed. */
const STOCK_IN = ['purchase', 'credit_note', 'rejection_in', 'receipt_note'];
/** Types on the buying side: an unregistered supplier charges no GST. */
const PURCHASE_SIDE = ['purchase', 'debit_note', 'purchase_order', 'rejection_in', 'receipt_note'];
/** Ledger-style vouchers with Dr and Cr lines. */
const JOURNAL_LIKE = ['journal', 'memorandum', 'reversing_journal'];
/** What a voucher can be made against (orders and delivery/receipt notes), as in Tally's tracking. */
const FOLLOWS: Record<string, string[]> = {
  sales: ['sales_order', 'delivery_note'], purchase: ['purchase_order', 'receipt_note'], delivery_note: ['sales_order'], receipt_note: ['purchase_order'],
};
/** TallyPrime's voucher keys (help.tallysolutions.com/keyboard-shortcuts-tally-prime). */
export const TYPE_KEYS: Record<string, string> = {
  F4: 'contra', F5: 'payment', F6: 'receipt', F7: 'journal', F8: 'sales', F9: 'purchase',
  'Alt+F6': 'credit_note', 'Alt+F5': 'debit_note', 'Ctrl+F8': 'sales_order', 'Ctrl+F9': 'purchase_order',
  'Ctrl+F6': 'rejection_in', 'Ctrl+F5': 'rejection_out', 'Alt+F7': 'stock_journal', 'Ctrl+F7': 'physical_stock',
  'Alt+F8': 'delivery_note', 'Alt+F9': 'receipt_note',
};
export const STOCK_TYPES = ['stock_journal', 'physical_stock'];

interface ItemLine {
  key: number; itemId: number | null; batchId: number | null; batchNo: string; expiry: string; mrp: string;
  qty: string; free: string; freeTouched: boolean; rate: string; disc: string; alt: boolean; godownId: number | null;
}
interface AccLine { key: number; ledgerId: number | null; amount: string; side: 'Dr' | 'Cr'; bills: { ref: string; amount: number }[] | null }
interface TaxRow { key: number; ledgerId: number | null; hsn: string; gst: string; amount: string }
interface Charge { key: number; ledgerId: number | null; amount: string }

let keySeq = 1;
/** A random key. crypto.randomUUID is missing on the second PC (plain http), so build one from random bytes. */
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const blankItem = (): ItemLine => ({ key: keySeq++, itemId: null, batchId: null, batchNo: '', expiry: '', mrp: '', qty: '', free: '', freeTouched: false, rate: '', disc: '', alt: false, godownId: null });
const blankAcc = (side: 'Dr' | 'Cr' = 'Cr'): AccLine => ({ key: keySeq++, ledgerId: null, amount: '', side, bills: null });
const blankTax = (): TaxRow => ({ key: keySeq++, ledgerId: null, hsn: '', gst: '', amount: '' });
const blankCharge = (): Charge => ({ key: keySeq++, ledgerId: null, amount: '' });
/** "2", "2 case", "2cs": the number and whether a unit word was typed after it. */
const qtyParts = (t: string) => {
  const m = /^\s*(-?[\d.]+)\s*([A-Za-z]*)\s*$/.exec(t);
  return m ? { n: Number(m[1]), unit: m[2].toLowerCase() } : { n: Number(t) || 0, unit: '' };
};

/** F12 settings for the voucher screen, kept on this PC. */
const loadConfig = () => {
  try { return { showFree: true, showDisc: true, ...JSON.parse(localStorage.getItem('stockwell-voucher-config') ?? '{}') }; } catch { return { showFree: true, showDisc: true }; }
};

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

export function VoucherForm({ type: initialType, id, copyFrom, active }: { type: string; id?: number; copyFrom?: number; active: boolean }) {
  const nav = useNav();
  const owner = isOwner(nav);
  const [type, setType] = useState(initialType);
  const inventory = INVENTORY.includes(type);
  const books = BOOKS.includes(type);
  const journal = JOURNAL_LIKE.includes(type);
  const [ledgers, setLedgers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [godowns, setGodowns] = useState<{ id: number; name: string }[]>([]);
  const [batches, setBatches] = useState<Record<number, any[]>>({});
  const [number, setNumber] = useState('');
  // The number shown is a guess until saving; the server gives the real next number unless the user typed one.
  const numberTyped = useRef(false);
  // One key per voucher being entered, so a save that is retried after a network hiccup never makes two vouchers.
  const clientKey = useRef(newKey());
  const [dateText, setDateText] = useState(shortDate(nav.workDate));
  const [partyId, setPartyId] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [mode, setMode] = useState<'item' | 'accounting'>('item');
  const [lines, setLines] = useState<ItemLine[]>([blankItem()]);
  const [taxRows, setTaxRows] = useState<TaxRow[]>([blankTax()]);
  const [charges, setCharges] = useState<Charge[]>([blankCharge()]);
  const [roundOffText, setRoundOffText] = useState('');
  const [acc, setAcc] = useState<AccLine[]>(() => [blankAcc(JOURNAL_LIKE.includes(initialType) ? 'Dr' : 'Cr')]);
  const [narration, setNarration] = useState('');
  const [refNo, setRefNo] = useState('');
  const [refDate, setRefDate] = useState('');
  const [againstRef, setAgainstRef] = useState('');
  const [againstId, setAgainstId] = useState<number | null>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [vehicle, setVehicle] = useState('');
  const [distance, setDistance] = useState('');
  const [transporter, setTransporter] = useState('');
  const [optional, setOptional] = useState(false);
  const [pdc, setPdc] = useState(false);
  const [cheque, setCheque] = useState({ no: '', date: '', bank: '' });
  const [pending, setPending] = useState<Record<number, any[]>>({});
  const [last, setLast] = useState<any>(null);
  const [loadedVoucher, setLoadedVoucher] = useState<any>(null);
  const [billEdit, setBillEdit] = useState<number | null>(null);
  const [details, setDetails] = useState(false);
  const [query, setQuery] = useState<number | null>(null);
  const [config, setConfig] = useState(loadConfig);
  const [showConfig, setShowConfig] = useState(false);
  const [loaded, setLoaded] = useState(!id && !copyFrom);
  const [cancelled, setCancelled] = useState(false);
  const narrationRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const label = VOUCHER_LABEL[type];
  useTitle(id ? `Alter ${label} Voucher` : `${label} Voucher Creation`);
  const modal = billEdit !== null || details || query !== null || showConfig;

  const reloadMasters = useCallback(async () => {
    const [l, i, g] = await Promise.all([api.get('/api/ledgers'), api.get('/api/items'), api.get('/api/godowns')]);
    setLedgers(l);
    setItems(i);
    setGodowns(g);
  }, []);
  useEffect(() => { if (active) reloadMasters().catch((e) => nav.toast(e.message, true)); }, [active, reloadMasters]); // eslint-disable-line react-hooks/exhaustive-deps

  const date = parseDate(dateText, nav.workDate);
  // F2 changes the date of the voucher being entered, as in Tally.
  useEffect(() => { if (!id) setDateText(shortDate(nav.workDate)); }, [nav.workDate, id]);

  useEffect(() => {
    if (!id && date && !optional) api.get(`/api/vouchers/next-number?type=${type}&date=${date}`).then((r) => setNumber(r.number)).catch(() => {});
    if (!id && optional) setNumber('(optional)');
  }, [id, type, date, optional]);

  // Defaults: the Sales/Purchase ledger for invoices, Cash for receipts and payments.
  useEffect(() => {
    if (id || !ledgers.length) return;
    if (inventory && !books) return;
    if (inventory) {
      const name = type === 'sales' || type === 'credit_note' ? 'Sales' : 'Purchase';
      setAccountId((a) => a ?? ledgers.find((l) => l.name === name)?.id ?? null);
    } else if (!journal) {
      setAccountId((a) => a ?? ledgers.find((l) => l.name === 'Cash')?.id ?? null);
    }
  }, [ledgers, type, inventory, books, journal, id]);

  const loadBatches = useCallback(async (itemId: number) => {
    const b = await api.get(`/api/items/${itemId}/batches`);
    setBatches((s) => ({ ...s, [itemId]: b }));
  }, []);

  // Load an existing voucher for alteration, or as the start of a new one (Alt+2 Duplicate).
  useEffect(() => {
    const src = id ?? copyFrom;
    if (!src) return;
    const copy = !id;
    api.get(`/api/vouchers/${src}`).then((v) => {
      setType(v.type);
      if (!copy) {
        setLoadedVoucher(v); setCancelled(!!v.cancelled); setNumber(v.number); setDateText(shortDate(v.date)); setRefNo(v.ref_no ?? ''); setVehicle(v.vehicle_no ?? '');
        setRefDate(v.ref_date ? shortDate(v.ref_date) : ''); setTransporter(v.transporter_name ?? ''); setOptional(!!v.optional); setPdc(!!v.pdc);
        setCheque({ no: v.cheque_no ?? '', date: v.cheque_date ? shortDate(v.cheque_date) : '', bank: v.bank_name ?? '' });
        setAgainstId(v.against_id ?? null);
        setDistance(v.distance_km ? String(v.distance_km) : '');
      }
      setNarration(v.narration ?? '');
      if (INVENTORY.includes(v.type)) {
        setPartyId(v.party_id);
        setMode(v.mode === 'accounting' ? 'accounting' : 'item');
        if (v.mode === 'accounting') {
          setTaxRows([...v.taxLines.map((t: any) => ({ key: keySeq++, ledgerId: t.ledger_id, hsn: t.hsn ?? '', gst: t.gst_rate ? String(t.gst_rate) : '', amount: rupeesText(t.base ?? t.taxable) })), blankTax()]);
        } else {
          setAccountId(v.account_id);
          // Batches of a sales bill are picked afresh on a copy; on an alteration they show as saved.
          const fresh = copy && ['sales', 'delivery_note'].includes(v.type);
          setLines([...v.lines.map((l: any) => ({
            key: keySeq++, itemId: l.item_id, batchId: fresh ? null : l.batch_id, batchNo: fresh ? '' : l.batch_no ?? '', expiry: fresh ? '' : l.expiry_date ? shortDate(l.expiry_date) : '',
            mrp: STOCK_IN.includes(v.type) && l.mrp ? rupeesText(l.mrp) : '',
            qty: l.alt_qty ? `${l.alt_qty} ${l.alt_unit}` : String(l.qty), alt: !!l.alt_qty, godownId: l.godown_id ?? null,
            free: l.free_qty ? String(l.free_qty) : '', freeTouched: true, rate: rupeesText(l.alt_qty ? Math.round(l.rate * l.alt_conv * 100) / 100 : l.rate), disc: l.discount_pct ? String(l.discount_pct) : '',
          })), blankItem()]);
          for (const itemId of new Set<number>(v.lines.filter((l: any) => l.batch_id).map((l: any) => l.item_id))) loadBatches(itemId);
        }
        if (v.charges?.length) setCharges([...v.charges.map((c: any) => ({ key: keySeq++, ledgerId: c.ledger_id, amount: rupeesText(c.amount) })), blankCharge()]);
        if (PURCHASE_SIDE.includes(v.type) && v.round_off && !copy) setRoundOffText(rupeesText(v.round_off) || '0');
        const agst = v.bills.find((b: any) => b.kind === 'agst');
        if (agst && !copy) setAgainstRef(agst.ref);
        else if (!copy && v.ref_no && (v.type === 'credit_note' || v.type === 'debit_note')) setAgainstRef(v.ref_no);
      } else if (JOURNAL_LIKE.includes(v.type)) {
        setAcc([...v.entries.map((e: any) => ({ key: keySeq++, ledgerId: e.ledger_id, amount: rupeesText(Math.abs(e.amount)), side: e.amount > 0 ? 'Dr' : 'Cr', bills: null })), blankAcc('Dr')]);
      } else {
        setAccountId(v.account_id);
        const others = v.entries.filter((e: any) => e.ledger_id !== v.account_id);
        setAcc([...others.map((e: any) => ({
          key: keySeq++, ledgerId: e.ledger_id, amount: rupeesText(Math.abs(e.amount)), side: 'Cr',
          bills: copy ? null : v.bills.filter((b: any) => b.ledger_id === e.ledger_id && b.kind === 'agst').map((b: any) => ({ ref: b.ref, amount: Math.abs(b.amount) })),
        })), blankAcc()]);
      }
      setLoaded(true);
    }).catch((e) => nav.toast(e.message, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, copyFrom]);

  const company = nav.company;
  const party = ledgers.find((l) => l.id === partyId);
  const intra = isIntraState(company.state_code, party?.state_code || company.state_code);
  const itemById = (iid: number | null) => items.find((i) => i.id === iid);
  const ledgerById = (lid: number | null) => ledgers.find((l) => l.id === lid);
  const showGodown = godowns.length > 1;

  const loadPending = useCallback(async (ledgerId: number) => {
    const b = await api.get(`/api/reports/pending-bills/${ledgerId}`);
    setPending((s) => ({ ...s, [ledgerId]: b }));
  }, []);
  useEffect(() => { if (partyId && (type === 'credit_note' || type === 'debit_note')) loadPending(partyId).catch(() => {}); }, [partyId, type, loadPending]);
  // Orders and notes of this party that this voucher can be made against.
  useEffect(() => {
    if (!partyId || !FOLLOWS[type]) { setOrders([]); return; }
    api.get(`/api/reports/pending-orders?kind=${SELL.includes(type) ? 'sales' : 'purchase'}`)
      .then((list: any[]) => setOrders(list.filter((o) => o.party_id === partyId && FOLLOWS[type].includes(o.type))))
      .catch(() => setOrders([]));
  }, [partyId, type]);

  /** The GST rate of a line as the server will charge it. */
  const gstOf = (it: any) => {
    if (!it || it.taxability !== 'taxable') return 0;
    if (PURCHASE_SIDE.includes(type) && party && !party.gstin) return 0;
    return rateOn(it, date ?? nav.workDate);
  };
  /** Quantity and rate in the main unit (a line typed in Cases is converted). */
  const baseOf = (l: ItemLine) => {
    const it = itemById(l.itemId);
    const q = qtyParts(l.qty).n;
    const conv = l.alt && it?.alt_conv > 0 ? it.alt_conv : 1;
    return { qty: Math.round(q * conv * 1000) / 1000, rate: toPaise(l.rate || 0) / conv };
  };
  const filledLines = lines.filter((l) => l.itemId && qtyParts(l.qty).n > 0);
  const filledTax = taxRows.filter((t) => t.ledgerId && toPaise(t.amount || 0) > 0);
  const filledCharges = charges.filter((c) => c.ledgerId && toPaise(c.amount || 0) !== 0);
  const roundOverride = roundOffText.trim() === '' ? null : toPaise(roundOffText);
  const totals = useMemo(() => {
    const ch = filledCharges.map((c) => ({ amount: toPaise(c.amount), assessable: !!ledgerById(c.ledgerId)?.assessable }));
    if (mode === 'accounting') {
      return computeBill(filledTax.map((t) => ({ qty: 1, rate: toPaise(t.amount), gstRate: PURCHASE_SIDE.includes(type) && party && !party.gstin ? 0 : Number(t.gst) || 0 })), intra, ch, roundOverride);
    }
    return computeBill(filledLines.map((l) => ({ ...baseOf(l), discountPct: Number(l.disc) || 0, gstRate: gstOf(itemById(l.itemId)) })), intra, ch, roundOverride);
  }, [filledLines, filledTax, filledCharges, intra, items, ledgers, mode, roundOverride, date, party]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLine = (key: number, patch: Partial<ItemLine>) => setLines((ls) => {
    const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l));
    if (next[next.length - 1].itemId) next.push(blankItem());
    return next;
  });
  const setTax = (key: number, patch: Partial<TaxRow>) => setTaxRows((ls) => {
    const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l));
    if (next[next.length - 1].ledgerId) next.push(blankTax());
    return next;
  });
  const setCharge = (key: number, patch: Partial<Charge>) => setCharges((ls) => {
    const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l));
    if (next[next.length - 1].ledgerId) next.push(blankCharge());
    return next;
  });

  /** The rate an item starts at: the party's price level, else the item's selling or buying rate. */
  const defaultRate = (it: any) => {
    if (!SELL.includes(type)) return it?.purchase_rate;
    const level = party?.price_level;
    return (level && it?.prices?.[level]) || it?.sale_rate;
  };
  const pickItem = (key: number, itemId: number) => {
    const it = itemById(itemId);
    setLine(key, { itemId, rate: rupeesText(defaultRate(it)), batchId: null, batchNo: '', freeTouched: false, alt: false });
    if (it?.track_batch) loadBatches(itemId);
  };

  const setQty = (l: ItemLine, qty: string) => {
    const it = itemById(l.itemId);
    const patch: Partial<ItemLine> = { qty };
    // "2 cs" or "2 case" is in the item's alternate unit; the rate follows the unit.
    const unit = qtyParts(qty).unit;
    const alt = !!(unit && it?.alt_unit && it.alt_conv > 0 && it.alt_unit.toLowerCase().startsWith(unit.slice(0, 2)));
    if (alt !== l.alt && it?.alt_conv > 0 && l.rate) patch.rate = rupeesText(Math.round(toPaise(l.rate) * (alt ? it.alt_conv : 1 / it.alt_conv)));
    patch.alt = alt;
    if (type === 'sales' && !l.freeTouched) {
      const baseQty = qtyParts(qty).n * (alt ? it.alt_conv : 1);
      const f = schemeFreeQty(baseQty || 0, it?.scheme_buy, it?.scheme_free);
      patch.free = f ? String(f) : '';
    }
    setLine(l.key, patch);
  };

  // ---------- accounting lines ----------
  const setAccLine = (key: number, patch: Partial<AccLine>) => setAcc((ls) => {
    let next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l));
    if (journal) {
      // As in Tally: a new line takes the side that balances the entry, and picking its ledger fills in the difference.
      const others = next.filter((l) => l.key !== key);
      const diff = drTotal(others) - crTotal(others);
      next = next.map((l) => {
        if (l.key !== key || !patch.ledgerId || l.amount) return l;
        return diff ? { ...l, side: diff > 0 ? 'Cr' : 'Dr', amount: rupeesText(Math.abs(diff)) } : l;
      });
    }
    if (next[next.length - 1].ledgerId) next.push(blankAcc(journal ? (drTotal(next) > crTotal(next) ? 'Cr' : 'Dr') : 'Cr'));
    if (journal) {
      const last = next[next.length - 1];
      if (!last.ledgerId && !last.amount) {
        const side: 'Dr' | 'Cr' = drTotal(next) > crTotal(next) ? 'Cr' : 'Dr';
        if (last.side !== side) next = [...next.slice(0, -1), { ...last, side }];
      }
    }
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

  /** Copies the pending lines of an order or note into this voucher (Tally's "Order No." / "Tracking No."). */
  const pickAgainst = async (srcId: number | null) => {
    setAgainstId(srcId);
    if (!srcId) return;
    try {
      const src = await api.get(`/api/vouchers/${srcId}`);
      const pend = orders.find((o) => o.id === srcId);
      const left = new Map<number, number>((pend?.lines ?? []).map((l: any) => [l.item_id, l.pending]));
      const note = src.type === 'delivery_note' || src.type === 'receipt_note';
      const copied = src.lines
        .filter((l: any) => note || (left.get(l.item_id) ?? 0) > 0)
        .map((l: any) => ({
          ...blankItem(), itemId: l.item_id, batchId: note ? l.batch_id : null, batchNo: note ? l.batch_no ?? '' : '',
          qty: String(note ? l.qty : Math.min(l.qty, left.get(l.item_id) ?? l.qty)), free: l.free_qty ? String(l.free_qty) : '', freeTouched: true,
          rate: rupeesText(l.rate) || rupeesText(defaultRate(itemById(l.item_id))), disc: l.discount_pct ? String(l.discount_pct) : '', godownId: l.godown_id ?? null,
        }));
      if (copied.length) setLines([...copied, blankItem()]);
      for (const l of src.lines) if (l.batch_id) loadBatches(l.item_id);
      nav.toast(`Lines copied from ${VOUCHER_LABEL[src.type]} ${src.number}`);
    } catch (e: any) { nav.toast(e.message, true); }
  };

  // ---------- save ----------
  const reset = () => {
    setLines([blankItem()]);
    setTaxRows([blankTax()]);
    setCharges([blankCharge()]);
    setRoundOffText('');
    setAcc([blankAcc(journal ? 'Dr' : 'Cr')]);
    setPartyId(null);
    setNarration('');
    setRefNo('');
    setRefDate('');
    setAgainstRef('');
    setAgainstId(null);
    setVehicle('');
    setDistance('');
    setTransporter('');
    setCheque({ no: '', date: '', bank: '' });
    setPdc(false);
    setOptional(false);
    setTimeout(() => (formRef.current?.querySelector('input.f') as HTMLElement | null)?.focus(), 50);
  };

  // Enter at the end of a voucher asks "Accept?", as Tally does; Ctrl+A saves straight away.
  const askAccept = async () => { if (await confirmBox('Accept?', { yes: 'Yes', no: 'No' })) save(); };
  const saving = useRef(false);
  const save = async () => {
    if (saving.current) return; // a second Ctrl+A while saving must not make a second voucher
    if (!date) { nav.toast('Enter a valid date', true); return; }
    if (inventory && mode === 'item') {
      const noQty = lines.find((l) => l.itemId && !(qtyParts(l.qty).n > 0));
      if (noQty) { nav.toast(`Enter a quantity for ${itemById(noQty.itemId)?.name ?? 'the item'}, or remove the line with Ctrl+D.`, true); return; }
      const noRate = lines.find((l) => l.itemId && l.rate.trim() === '' && books);
      if (noRate) { nav.toast(`Enter a rate for ${itemById(noRate.itemId)?.name ?? 'the item'} (type 0 if it is free).`, true); return; }
    }
    if (roundOffText.trim() && Number.isNaN(Number(roundOffText))) { nav.toast('Round off must be a number, e.g. -0.45', true); return; }
    saving.current = true;
    try { await doSave(false); } finally { saving.current = false; }
  };
  const doSave = async (overrideCredit: boolean) => {
    const badExpiry = inventory && filledLines.find((l) => l.expiry && !parseDate(l.expiry, date ?? undefined));
    if (badExpiry) { nav.toast(`The expiry date "${badExpiry.expiry}" is not a date. Type it like 30-11-27.`, true); return; }
    const body: any = { type, date, narration, optional, refNo, refDate: refDate ? parseDate(refDate, date ?? undefined) : null };
    if ((id || numberTyped.current) && !optional) body.number = number;
    if (!id) body.clientKey = clientKey.current;
    if (overrideCredit) body.overrideCredit = true;
    if (inventory) {
      Object.assign(body, {
        partyId, mode, againstRef: againstRef || undefined, againstId: againstId || undefined, vehicleNo: vehicle, distanceKm: Number(distance) || 0, transporterName: transporter,
        charges: books ? filledCharges.map((c) => ({ ledgerId: c.ledgerId, amount: toPaise(c.amount) })) : undefined,
        roundOff: books && roundOverride !== null ? roundOverride : undefined,
      });
      if (mode === 'accounting') {
        body.taxLines = filledTax.map((t) => ({ ledgerId: t.ledgerId, amount: toPaise(t.amount), gstRate: Number(t.gst) || 0, hsn: t.hsn || undefined }));
      } else {
        body.accountId = books ? accountId : undefined;
        body.lines = filledLines.map((l) => ({
          itemId: l.itemId, batchId: l.batchId || undefined, batchNo: l.batchNo || undefined, expiryDate: l.expiry ? parseDate(l.expiry, date ?? undefined) ?? undefined : undefined,
          mrp: l.mrp ? toPaise(l.mrp) : undefined, qty: qtyParts(l.qty).n, unit: l.alt ? 'alt' : undefined, godownId: l.godownId || undefined,
          freeQty: Number(l.free) || 0, rate: toPaise(l.rate || 0), discountPct: Number(l.disc) || 0,
        }));
      }
    } else if (journal) {
      body.entries = acc.filter((l) => l.ledgerId && toPaise(l.amount || 0)).map((l) => ({ ledgerId: l.ledgerId, amount: toPaise(l.amount) * (l.side === 'Dr' ? 1 : -1) }));
      body.pdc = pdc;
    } else {
      body.accountId = accountId;
      body.pdc = pdc;
      Object.assign(body, { chequeNo: cheque.no, chequeDate: cheque.date ? parseDate(cheque.date, date ?? undefined) : null, bankName: cheque.bank });
      body.entries = acc.filter((l) => l.ledgerId && toPaise(l.amount || 0)).map((l) => {
        const amount = toPaise(l.amount);
        const bills = isBillWise(l.ledgerId) && type !== 'contra' ? (l.bills ?? autoAllocate(l.ledgerId!, amount)) : undefined;
        return { ledgerId: l.ledgerId, amount, bills };
      });
    }
    try {
      const v = id ? await api.put(`/api/vouchers/${id}`, body) : await api.post('/api/vouchers', body);
      if (id) { nav.toast(`${label} ${v.number} saved · ₹${formatINR(v.total)}`); nav.pop(); return; }
      numberTyped.current = false;
      clientKey.current = newKey();
      // Clear the form before the "saved" message shows, so an Esc pressed right after it never asks "Quit?".
      flushSync(() => { setLast(v); reset(); });
      nav.toast(`${label} ${v.number} saved · ₹${formatINR(v.total)}`);
      if (date) api.get(`/api/vouchers/next-number?type=${type}&date=${date}`).then((r) => setNumber(r.number)).catch(() => {});
      if (Object.keys(batches).length) Object.keys(batches).forEach((k) => loadBatches(Number(k)));
    } catch (e: any) {
      // Over the credit limit or overdue: the owner may save anyway; an operator is told to ask.
      if (e.code === 'credit' && owner && !overrideCredit) {
        if (await confirmBox(e.message, { yes: 'Save anyway', no: 'Go back' })) await doSave(true);
        return;
      }
      nav.toast(e.message, true);
    }
  };

  const cancelVoucher = async () => {
    if (!id || !(await confirmBox(`Cancel ${label} ${number}?\nThe number stays used and the voucher shows as cancelled.`, { danger: true }))) return;
    try { await api.post(`/api/vouchers/${id}/cancel`); nav.toast(`${number} cancelled`); nav.pop(); } catch (e: any) { nav.toast(e.message, true); }
  };

  const deleteVoucher = async () => {
    if (!id) return;
    const msg = type === 'sales'
      ? `Delete ${label} ${number}?\nFor sales bills, Cancel (Alt+X) is usually better: GST wants every bill number accounted for. A deleted number shows as cancelled in GSTR-1.`
      : `Delete ${label} ${number}? This cannot be undone. A copy stays in the edit log.`;
    if (!(await confirmBox(msg, { yes: 'Delete', no: 'Keep', danger: true }))) return;
    try { await api.del(`/api/vouchers/${id}`); nav.toast(`${number} deleted`); nav.pop(); } catch (e: any) { nav.toast(e.message, true); }
  };

  const bounce = async () => {
    if (!id || type !== 'receipt') return;
    if (!(await confirmBox(`Mark the cheque in ${number} as bounced?\nStockwell makes a journal that takes the money out of the bank and puts the bills back as pending.`, { yes: 'Cheque bounced', no: 'Go back', danger: true }))) return;
    try { const j = await api.post(`/api/vouchers/${id}/bounce`, { date: nav.workDate }); nav.toast(`Bounce entered as ${j.number}`); nav.pop(); } catch (e: any) { nav.toast(e.message, true); }
  };

  const print = async (vid: number, no: string) => { try { await printVoucher(vid, `${no.replace(/[\\/:*?"<>|]/g, '-')}.pdf`, nav.toast); } catch (e: any) { nav.toast(e.message, true); } };
  const whatsapp = async (vid: number) => { try { await sendBillOnWhatsApp(vid, nav.toast); } catch (e: any) { nav.toast(e.message, true); } };

  /** Ctrl+R: narration of the last voucher of this type. Alt+R: of this party. */
  const retrieveNarration = async (byParty: boolean) => {
    const pid = inventory ? partyId : acc.find((l) => l.ledgerId)?.ledgerId;
    if (byParty && !pid) { nav.toast('Choose the party first.', true); return; }
    try {
      const r = await api.get(`/api/vouchers/last-narration?type=${type}${byParty ? `&partyId=${pid}` : ''}`);
      if (r.narration) { setNarration(r.narration); narrationRef.current?.focus(); } else nav.toast('No earlier narration to bring back.');
    } catch (e: any) { nav.toast(e.message, true); }
  };

  /** Page Up / Page Down: the previous or next voucher of this type. */
  const neighbour = async (dir: 'prev' | 'next') => {
    try {
      const n = await api.get(`/api/vouchers/${id ?? 0}/neighbour?dir=${dir}&type=${type}`);
      if (!n) { nav.toast(dir === 'prev' ? 'This is the first voucher.' : 'This is the last voucher.'); return; }
      nav.replace({ name: 'voucher', props: { type: n.type, id: n.id } });
    } catch (e: any) { nav.toast(e.message, true); }
  };

  const currentRowKey = () => Number(((document.activeElement as HTMLElement | null)?.closest('tr[data-line]') as HTMLElement | null)?.dataset.line) || 0;

  const switchType = (t: string) => {
    if (t === type) return;
    setType(t); setAccountId(null); setLines([blankItem()]); setTaxRows([blankTax()]); setCharges([blankCharge()]); setRoundOffText('');
    setAcc([blankAcc(JOURNAL_LIKE.includes(t) ? 'Dr' : 'Cr')]); setPartyId(null); setMode('item'); setAgainstId(null); setPdc(false);
  };

  const dirty = inventory ? !!partyId || filledLines.length > 0 || filledTax.length > 0 : acc.some((l) => l.ledgerId || l.amount);
  useScreenKeys((e) => {
    const k = keyName(e);
    if (modal) {
      if (k === 'Esc') { setBillEdit(null); setDetails(false); setQuery(null); setShowConfig(false); return true; }
      return false;
    }
    if (k === 'Ctrl+A') { save(); return true; }
    if ((k === 'Esc' || k === 'Ctrl+Q') && dirty) {
      // Like Tally's "Quit? Yes or No": an unsaved voucher is never thrown away by one stray Esc.
      confirmBox(id ? 'Leave without saving the changes?' : 'Quit this voucher? What you typed will be lost.', { yes: 'Quit', no: 'Keep typing' })
        .then((quit) => { if (quit) nav.pop(); });
      return true;
    }
    if (TYPE_KEYS[k] && !id) {
      const t = TYPE_KEYS[k];
      if (t === type) return true;
      const go = () => (STOCK_TYPES.includes(t) ? nav.replace({ name: 'voucher', props: { type: t } }) : switchType(t));
      if (dirty) confirmBox(`Change to ${VOUCHER_LABEL[t]}? What you typed in this ${label} will be lost.`, { yes: 'Change', no: 'Keep typing' }).then((y) => { if (y) go(); });
      else go();
      return true;
    }
    if (k === 'Ctrl+H') {
      // Change mode: a credit/debit note (or bill) with ledger lines instead of items, as Tally's "Accounting Invoice".
      if (!books) { nav.toast(`A ${label} always has items.`, true); return true; }
      setMode((m) => (m === 'item' ? 'accounting' : 'item'));
      nav.toast(mode === 'item' ? 'Accounting mode: type ledgers and amounts instead of items' : 'Item mode');
      return true;
    }
    if (k === 'Ctrl+L') { setOptional((o) => !o); nav.toast(optional ? 'Regular voucher' : 'Optional: saved, but kept out of the books until you make it regular (Ctrl+L again)'); return true; }
    if (k === 'Ctrl+T') {
      if (inventory) { nav.toast('Only receipts, payments, contra and journals can be post-dated.', true); return true; }
      setPdc((p) => !p); nav.toast(pdc ? 'Regular voucher' : 'Post-dated: stays out of the balances until its date'); return true;
    }
    if (k === 'Ctrl+I') { setDetails(true); return true; }
    if (k === 'Alt+S') {
      const row = lines.find((l) => l.key === currentRowKey()) ?? lines.find((l) => l.itemId);
      if (row?.itemId) setQuery(row.itemId); else nav.toast('Put the cursor on an item line for the stock query.', true);
      return true;
    }
    if (k === 'Ctrl+R' || k === 'Alt+R') { retrieveNarration(k === 'Alt+R'); return true; }
    if (k === 'PageUp' || k === 'PageDown') { if (!dirty || id) neighbour(k === 'PageUp' ? 'prev' : 'next'); return true; }
    if (k === 'F12') { setShowConfig(true); return true; }
    if (k === 'Ctrl+D' || k === 'Alt+I') {
      // Ctrl+D removes the line the cursor is on; Alt+I puts a blank line above it.
      const key = currentRowKey();
      if (!key) return true;
      const cut = <T extends { key: number }>(ls: T[], blank: () => T) => {
        if (k === 'Alt+I') { const i = ls.findIndex((x) => x.key === key); return i < 0 ? ls : [...ls.slice(0, i), blank(), ...ls.slice(i)]; }
        const next = ls.filter((x) => x.key !== key);
        return next.length ? next : [blank()];
      };
      if (inventory && mode === 'item' && lines.some((l) => l.key === key)) setLines((ls) => cut(ls, blankItem));
      else if (taxRows.some((l) => l.key === key)) setTaxRows((ls) => cut(ls, blankTax));
      else if (charges.some((l) => l.key === key)) setCharges((ls) => cut(ls, blankCharge));
      else setAcc((ls) => cut(ls, () => blankAcc(journal ? 'Dr' : 'Cr')));
      return true;
    }
    if ((k === 'Alt+X' || k === 'Alt+D') && id && !owner) { nav.toast('Only an Owner can cancel or delete a voucher.', true); return true; }
    if (k === 'Alt+X' && id) { cancelVoucher(); return true; }
    if (k === 'Alt+D' && id) { deleteVoucher(); return true; }
    if (k === 'Alt+2' && (id ?? last?.id)) { nav.push({ name: 'voucher', props: { type, copyFrom: id ?? last.id } }); return true; }
    const target = id ?? last?.id;
    const targetNo = id ? number : last?.number;
    if ((k === 'Ctrl+P' || k === 'Alt+P') && target && inventory) { print(target, targetNo); return true; }
    if ((k === 'Ctrl+Alt+W' || k === 'Alt+W') && target && (id ? type === 'sales' : last?.type === 'sales')) { whatsapp(target); return true; }
    return false;
  });
  const target = id ?? last?.id;
  useKeyBar([
    { key: 'Ctrl+A', label: 'Accept', run: save },
    { key: 'Ctrl+P', label: 'Print / PDF', run: () => target && print(target, id ? number : last.number), disabled: !target || !inventory },
    { key: 'Ctrl+Alt+W', label: 'WhatsApp bill', run: () => target && whatsapp(target), disabled: !target || !(id ? type === 'sales' : last?.type === 'sales') },
    { key: 'Alt+2', label: 'Duplicate', run: () => target && nav.push({ name: 'voucher', props: { type, copyFrom: target } }), disabled: !target },
    ...(books ? [{ key: 'Ctrl+H', label: mode === 'item' ? 'Accounting mode' : 'Item mode', run: () => setMode((m) => (m === 'item' ? 'accounting' : 'item')) }] : []),
    { key: 'Ctrl+I', label: 'More details', run: () => setDetails(true) },
    { key: 'Ctrl+L', label: optional ? 'Make regular' : 'Optional', run: () => setOptional((o) => !o) },
    ...(!inventory ? [{ key: 'Ctrl+T', label: pdc ? 'Not post-dated' : 'Post-dated', run: () => setPdc((p) => !p) }] : []),
    ...(inventory && mode === 'item' ? [{ key: 'Alt+S', label: 'Stock query', run: () => { const r = lines.find((l) => l.itemId); if (r) setQuery(r.itemId); } }] : []),
    { key: 'Ctrl+R', label: 'Last narration', run: () => retrieveNarration(false) },
    { key: 'F12', label: 'Configure', run: () => setShowConfig(true) },
    ...(id && owner ? [{ key: 'Alt+X', label: 'Cancel voucher', run: cancelVoucher }, { key: 'Alt+D', label: 'Delete', run: deleteVoucher }] : []),
    ...(id && type === 'receipt' && owner && !loadedVoucher?.bounced_by ? [{ key: 'Alt+B', label: 'Cheque bounced', run: bounce }] : []),
    { key: 'PageUp', label: 'Previous voucher', run: () => neighbour('prev'), hidden: true },
    { key: 'PageDown', label: 'Next voucher', run: () => neighbour('next'), hidden: true },
    { key: 'Alt+I', label: 'Insert line', hidden: true },
    { key: 'Alt+R', label: 'Party narration', hidden: true, run: () => retrieveNarration(true) },
  ], [save, target, inventory, type, id, number, last, mode, optional, pdc, books, loadedVoucher, owner]);

  if (!loaded) return <div className="empty-state">Loading…</div>;

  const partyOptions = ledgers
    .filter((l) => ['Sundry Debtors', 'Sundry Creditors', 'Cash-in-Hand', 'Bank Accounts'].includes(l.group_name) || l.bill_wise)
    .map((l) => ({ id: l.id, label: l.name, meta: drCr(l.balance) || l.group_name }));
  const allLedgerOptions = ledgers.map((l) => ({ id: l.id, label: l.name, meta: drCr(l.balance) || l.group_name }));
  const cashBank = ledgers.filter((l) => ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'].includes(l.group_name)).map((l) => ({ id: l.id, label: l.name, meta: drCr(l.balance) }));
  const accountOptions = ledgers.filter((l) => (type === 'sales' || type === 'credit_note' ? l.group_name === 'Sales Accounts' : l.group_name === 'Purchase Accounts')).map((l) => ({ id: l.id, label: l.name }));
  // Ledger lines of an accounting invoice and extra ledgers on a bill: anything but parties, cash/bank and the GST ledgers Stockwell fills.
  const lineLedgerOptions = ledgers
    .filter((l) => l.id !== partyId && !['cgst', 'sgst', 'igst', 'roundoff'].includes(l.tax_kind) && !['Sundry Debtors', 'Sundry Creditors', 'Cash-in-Hand', 'Bank Accounts'].includes(l.group_name))
    .map((l) => ({ id: l.id, label: l.name, meta: `${l.group_name}${l.assessable ? ' · in taxable value' : ''}` }));
  const itemOptions = items.map((i) => ({ id: i.id, label: i.name, meta: `${i.stock} ${i.unit}${i.alt_unit ? ` (${Math.floor(i.stock / i.alt_conv)} ${i.alt_unit})` : ''} · ₹${formatINR(defaultRate(i))}` }));
  const createParty = (typed: string) => nav.push({
    name: 'ledger-form',
    props: { name: typed, groupHint: SELL.includes(type) ? 'Sundry Debtors' : 'Sundry Creditors', onSaved: (l: any) => { reloadMasters(); setPartyId(l.id); } },
  });
  const alterLedger = (lid: number) => (!owner ? nav.toast('Only an Owner can alter masters.', true) : nav.push({ name: 'ledger-form', props: { id: lid, onSaved: () => reloadMasters() } }));
  const alterItem = (iid: number) => (!owner ? nav.toast('Only an Owner can alter masters.', true) : nav.push({ name: 'item-form', props: { id: iid, onSaved: () => reloadMasters() } }));
  const createItem = (key: number) => (typed: string) => nav.push({ name: 'item-form', props: { name: typed, onSaved: async (it: any) => { await reloadMasters(); setLine(key, { itemId: it.id, rate: rupeesText(defaultRate(it)) }); } } });
  const showEway = type === 'sales' && totals.total > company.ewb_threshold;
  const partyLabel = SELL.includes(type) ? 'Party A/c name' : 'Supplier A/c name';

  const extraLedgers = books && (
    <table className="lines" aria-label="Additional ledgers">
      <tbody>
        {charges.map((c, idx) => {
          const l = ledgerById(c.ledgerId);
          return (
            <tr key={c.key} data-line={c.key}>
              <td style={{ width: '45%' }}>
                <Combo name={`Extra ledger ${idx + 1}`} title="Freight, discount, TCS…" value={c.ledgerId} options={lineLedgerOptions} placeholder={idx === 0 ? 'Freight, discount, TCS (optional)' : ''}
                  onChange={(v) => setCharge(c.key, { ledgerId: v })} onAlter={alterLedger}
                  onCreate={(typed) => nav.push({ name: 'ledger-form', props: { name: typed, onSaved: (x: any) => { reloadMasters(); setCharge(c.key, { ledgerId: x.id }); } } })}
                  onEmptyEnter={() => narrationRef.current?.focus()} />
              </td>
              <td className="subtle">{l ? (l.assessable ? 'Added to the taxable value, GST on it' : 'After tax, no GST') : ''}</td>
              <td style={{ width: 140 }}><input className="f num" aria-label={`Extra amount ${idx + 1}`} placeholder={l ? '− for discount' : ''} value={c.amount}
                onChange={(e) => setCharge(c.key, { amount: e.target.value })} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} disabled={!c.ledgerId} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const totalsTable = (
    <table>
      <tbody>
        {totals.charges !== 0 && totals.allocated.some((a) => a) && <tr><td>Value of goods</td><td className="num">{formatINR(totals.baseTaxable.reduce((a, x) => a + x, 0))}</td></tr>}
        <tr><td>Taxable value</td><td className="num">{formatINR(totals.taxable)}</td></tr>
        {intra ? <>
          <tr><td>CGST</td><td className="num">{formatINR(totals.cgst)}</td></tr>
          <tr><td>SGST</td><td className="num">{formatINR(totals.sgst)}</td></tr>
        </> : <tr><td>IGST</td><td className="num">{formatINR(totals.igst)}</td></tr>}
        {filledCharges.filter((c) => !ledgerById(c.ledgerId)?.assessable).map((c) => <tr key={c.key}><td>{ledgerById(c.ledgerId)?.name}</td><td className="num">{formatINR(toPaise(c.amount))}</td></tr>)}
        {books && PURCHASE_SIDE.includes(type) ? (
          <tr><td>Round off</td><td className="num"><input className="f num" aria-label="Round off" style={{ width: 90 }} placeholder={rupeesText(totals.roundOff) || '0'} title="Leave blank to round to the rupee, or type the round off on the supplier's bill"
            value={roundOffText} onChange={(e) => setRoundOffText(e.target.value)} onKeyDown={enterNext} /></td></tr>
        ) : totals.roundOff !== 0 && <tr><td>Round off</td><td className="num">{formatINR(totals.roundOff)}</td></tr>}
        <tr className="grand"><td>Total</td><td className="num">₹{formatINR(totals.total)}</td></tr>
      </tbody>
    </table>
  );

  return (
    <div className="voucher" data-form ref={formRef}>
      <div className="vhead">
        <div>
          <span className="vtype">{label}</span>
          {cancelled && <span className="tag bad" style={{ marginLeft: 8 }}>CANCELLED</span>}
          {optional && <span className="tag warn" style={{ marginLeft: 8 }}>OPTIONAL</span>}
          {pdc && <span className="tag warn" style={{ marginLeft: 8 }}>POST-DATED</span>}
          {mode === 'accounting' && <span className="tag" style={{ marginLeft: 8 }}>ACCOUNTING MODE</span>}
          {loadedVoucher?.bounced_by && <span className="tag bad" style={{ marginLeft: 8 }}>CHEQUE BOUNCED</span>}
          <span className="vno">No. <input className="f" style={{ width: 150, display: 'inline-block' }} aria-label="Voucher number" value={number} disabled={optional && !id}
            onChange={(e) => { numberTyped.current = true; setNumber(e.target.value); }} onKeyDown={enterNext} /></span>
        </div>
        {last && !id && (
          <div className="subtle">
            Last saved: <b>{last.number}</b> ₹{formatINR(last.total)}{' '}
            {INVENTORY.includes(last.type) && <button className="btn small" onClick={() => print(last.id, last.number)}>Print (Ctrl+P)</button>}{' '}
            {last.type === 'sales' && <button className="btn small wa" onClick={() => whatsapp(last.id)}>WhatsApp (Ctrl+Alt+W)</button>}
          </div>
        )}
        <div>Date <input className="f" style={{ width: 110, display: 'inline-block' }} aria-label="Date" value={dateText} onChange={(e) => setDateText(e.target.value)} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} />
          <span className="subtle"> {date ? new Date(date).toLocaleDateString('en-IN', { weekday: 'long' }) : 'invalid date'}</span></div>
      </div>

      {inventory ? (
        <>
          <div className="vparty">
            <div className="row"><label>{partyLabel}</label>
              <Combo name="Party" title="List of Ledger Accounts" value={partyId} options={partyOptions} autoFocus={!id}
                onChange={(v) => setPartyId(v)} onCreate={createParty} onAlter={alterLedger} />
            </div>
            {books && mode === 'item' && (
              <div className="row"><label>{type === 'sales' || type === 'credit_note' ? 'Sales ledger' : 'Purchase ledger'}</label>
                <Combo name="Account" title="Ledgers" value={accountId} options={accountOptions} onChange={setAccountId} onAlter={alterLedger} />
              </div>
            )}
            {party && <div className="balance">Current balance: {drCr(party.balance) || 'Nil'} · {party.state_code ? `${nav.meta.states[party.state_code]} · ` : ''}{intra ? 'CGST + SGST' : 'IGST'}{party.gstin ? ` · ${party.gstin}` : ' · Unregistered'}
              {party.credit_limit > 0 && ` · Credit limit ₹${formatINR(party.credit_limit)}`}{party.price_level && ` · ${party.price_level} prices`}</div>}
            {(type === 'purchase' || type === 'receipt_note') && <div className="row"><label>Supplier invoice no.</label><input className="f" aria-label="Supplier invoice" value={refNo} onChange={(e) => setRefNo(e.target.value)} onKeyDown={enterNext} /></div>}
            {FOLLOWS[type] && (orders.length > 0 || againstId) && (
              <div className="row"><label>Against order / note</label>
                <Combo name="Against order" title="Pending orders and notes" value={againstId} placeholder="None (Enter to skip)"
                  onChange={(v) => pickAgainst(v)} onEmptyEnter={() => focusNext(document.activeElement as HTMLElement)}
                  options={[...orders.map((o) => ({ id: o.id, label: o.number, meta: `${VOUCHER_LABEL[o.type]} · ${shortDate(o.date)} · ${o.lines.length} item${o.lines.length > 1 ? 's' : ''} pending` })),
                    ...(againstId && !orders.some((o) => o.id === againstId) ? [{ id: againstId, label: loadedVoucher?.against?.number ?? `#${againstId}` }] : [])]} />
              </div>
            )}
            {(type === 'credit_note' || type === 'debit_note') && (
              <div className="row"><label>Against bill</label>
                <Combo name="Against bill" title="Pending bills" value={againstRef || null} onChange={(v) => setAgainstRef(v)} onEmptyEnter={() => focusNext(document.activeElement as HTMLElement)}
                  options={(partyId ? pending[partyId] ?? [] : []).map((b: any) => ({ id: b.ref, label: b.ref, meta: `${shortDate(b.bill_date)} · ${drCr(b.pending)}` }))} />
              </div>
            )}
          </div>
          {mode === 'accounting' ? (
            <table className="lines">
              <thead><tr><th style={{ width: '45%' }}>Particulars</th><th>HSN / SAC</th><th className="num">GST %</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {taxRows.map((t, idx) => (
                  <tr key={t.key} data-line={t.key}>
                    <td><Combo name={`Ledger ${idx + 1}`} title="List of Ledger Accounts" value={t.ledgerId} options={lineLedgerOptions} onChange={(v) => setTax(t.key, { ledgerId: v })} onAlter={alterLedger}
                      onCreate={(typed) => nav.push({ name: 'ledger-form', props: { name: typed, onSaved: (x: any) => { reloadMasters(); setTax(t.key, { ledgerId: x.id }); } } })}
                      onEmptyEnter={() => (document.querySelector('[aria-label="Extra ledger 1"]') as HTMLElement | null)?.focus() ?? narrationRef.current?.focus()} autoFocus={false} /></td>
                    <td><input className="f" aria-label={`HSN ${idx + 1}`} value={t.hsn} placeholder={againstRef ? 'from the bill' : ''} onChange={(e) => setTax(t.key, { hsn: e.target.value })} onKeyDown={enterNext} /></td>
                    <td><select className="f num" aria-label={`GST ${idx + 1}`} value={t.gst} onChange={(e) => setTax(t.key, { gst: e.target.value })} onKeyDown={enterNext}>
                      <option value="">No GST</option>{(nav.meta.gstRates as number[]).filter((r) => r > 0).map((r) => <option key={r} value={r}>{r}%</option>)}
                    </select></td>
                    <td><input className="f num" aria-label={`Ledger amount ${idx + 1}`} value={t.amount} onChange={(e) => setTax(t.key, { amount: e.target.value })} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="lines">
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>Name of item</th>{showGodown && <th>Godown</th>}<th style={{ width: '15%' }}>Batch</th>
                  <th className="num">Quantity</th>{config.showFree && <th className="num">Free</th>}<th className="num">Rate</th>{config.showDisc && <th className="num">Disc %</th>}<th className="num">GST</th><th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => {
                  const it = itemById(l.itemId);
                  const fi = filledLines.findIndex((f) => f.key === l.key);
                  const t = fi >= 0 ? totals.lines[fi] : null;
                  const bl = l.itemId ? batches[l.itemId] ?? [] : [];
                  return (
                    <tr key={l.key} data-line={l.key}>
                      <td>
                        <Combo name={`Item ${idx + 1}`} title="List of Stock Items" value={l.itemId} options={itemOptions} onChange={(v) => pickItem(l.key, v)}
                          onCreate={createItem(l.key)} onAlter={alterItem}
                          onEmptyEnter={() => (idx === lines.length - 1 ? ((document.querySelector('[aria-label="Extra ledger 1"]') as HTMLElement | null) ?? narrationRef.current)?.focus() : undefined)} />
                      </td>
                      {showGodown && <td>
                        <select className="f" aria-label={`Godown ${idx + 1}`} value={l.godownId ?? 1} onChange={(e) => setLine(l.key, { godownId: Number(e.target.value) === 1 ? null : Number(e.target.value) })} onKeyDown={enterNext}>
                          {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                      </td>}
                      <td>
                        {it?.track_batch && !['sales_order', 'purchase_order'].includes(type) ? (
                          STOCK_IN.includes(type) && !againstId ? (
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input className="f" aria-label={`Batch ${idx + 1}`} placeholder="Batch" value={l.batchNo} onChange={(e) => setLine(l.key, { batchNo: e.target.value })} onKeyDown={enterNext} />
                              <input className="f" aria-label={`Expiry ${idx + 1}`} placeholder="Expiry" title="Expiry date, e.g. 30-11-26" value={l.expiry} onChange={(e) => setLine(l.key, { expiry: e.target.value })}
                                onBlur={(e) => { const d = parseDate(e.target.value, date ?? undefined); if (d) setLine(l.key, { expiry: shortDate(d) }); }} onKeyDown={enterNext} />
                              <input className="f num" aria-label={`MRP ${idx + 1}`} placeholder="MRP" title="MRP printed on the pack" style={{ width: 70 }} value={l.mrp} onChange={(e) => setLine(l.key, { mrp: e.target.value })} onKeyDown={enterNext} />
                            </div>
                          ) : (
                            <Combo name={`Batch ${idx + 1}`} title="Batches (soonest expiry first)" value={l.batchId} onChange={(v) => setLine(l.key, { batchId: v })}
                              onEmptyEnter={() => focusNext(document.activeElement as HTMLElement)}
                              options={bl.filter((b) => (b.qty > 0 && !(type === 'sales' && b.expiry_date && date && b.expiry_date < date)) || b.id === l.batchId).map((b) => ({ id: b.id, label: b.batch_no, meta: `${b.qty} left${b.expiry_date ? ` · exp ${shortDate(b.expiry_date)}` : ''}${b.mrp ? ` · MRP ${formatINR(b.mrp)}` : ''}` }))} placeholder="Auto (FEFO)" />
                          )
                        ) : <span className="subtle">—</span>}
                      </td>
                      <td><input className="f num" aria-label={`Quantity ${idx + 1}`} value={l.qty} title={it?.alt_unit ? `Type "2 ${it.alt_unit}" for ${it.alt_conv} ${it.unit} each` : undefined}
                        onChange={(e) => setQty(l, e.target.value)} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()}
                        onBlur={() => { if (l.alt && it) setLine(l.key, { qty: `${qtyParts(l.qty).n} ${it.alt_unit}` }); }} />
                        {l.alt && it && <div className="subtle" style={{ fontSize: 11, textAlign: 'right' }}>= {baseOf(l).qty} {it.unit}</div>}</td>
                      {config.showFree && <td><input className="f num" aria-label={`Free ${idx + 1}`} value={l.free} onChange={(e) => setLine(l.key, { free: e.target.value, freeTouched: true })} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} /></td>}
                      <td><input className="f num" aria-label={`Rate ${idx + 1}`} value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} />
                        {it && <div className="subtle" style={{ fontSize: 11, textAlign: 'right' }}>per {l.alt ? it.alt_unit : it.unit}</div>}</td>
                      {config.showDisc && <td><input className="f num" aria-label={`Discount ${idx + 1}`} value={l.disc} onChange={(e) => setLine(l.key, { disc: e.target.value })} onKeyDown={enterNext} onFocus={(e) => e.currentTarget.select()} /></td>}
                      <td className="num subtle">{it ? `${gstOf(it)}%` : ''}</td>
                      <td className="num">{t ? formatINR(t.taxable - (totals.allocated[fi] ?? 0)) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {extraLedgers}
          <div className="vtotals">
            <div>
              <div className="row"><label>Narration</label><textarea ref={narrationRef} className="f" aria-label="Narration" rows={2} value={narration} onChange={(e) => setNarration(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (showEway || (books && PURCHASE_SIDE.includes(type))) focusNext(e.currentTarget); else askAccept(); } }} /></div>
              {type === 'sales' && (
                <div className="row"><label>Vehicle / distance</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="f" aria-label="Vehicle number" placeholder="Vehicle no." value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())} onKeyDown={enterNext} />
                    <input className="f num" aria-label="Distance km" placeholder="km" style={{ width: 80 }} value={distance} onChange={(e) => setDistance(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); askAccept(); } }} />
                  </div>
                </div>
              )}
              {showEway && <div className="hint"><span className="tag warn">e-Way Bill needed</span> This bill is over ₹{formatINR(company.ewb_threshold)}. Fill the vehicle and distance; make the e-Way Bill from GST Returns.</div>}
              <div className="hint" style={{ marginTop: 6 }}>
                {mode === 'accounting' ? 'Type ledgers and amounts; Ctrl+H goes back to items.' : `Enter on an empty item line finishes items.${(() => { const a = items.find((i) => i.alt_unit && lines.some((l) => l.itemId === i.id)) ?? items.find((i) => i.alt_unit); return a ? ` Type "2 ${a.alt_unit.toLowerCase()}" for the alternate unit.` : ''; })()}`} Ctrl+A saves.
              </div>
            </div>
            {totalsTable}
          </div>
        </>
      ) : (
        <>
          {!journal && (
            <div className="vparty">
              <div className="row"><label>Account</label>
                <Combo name="Account" title="Cash and Bank" value={accountId} options={cashBank} onChange={setAccountId} autoFocus={!id} onAlter={alterLedger} />
              </div>
              <div className="balance">{accountId ? `Current balance: ${drCr(ledgers.find((l) => l.id === accountId)?.balance ?? 0) || 'Nil'}` : ''}
                {cheque.no && ` · Cheque ${cheque.no}${cheque.date ? ` dated ${cheque.date}` : ''}`}</div>
            </div>
          )}
          {journal && type !== 'journal' && <p className="hint" style={{ margin: '8px 16px' }}>{type === 'memorandum' ? 'A Memorandum voucher is a note only. It never touches the ledgers until you alter it into a regular voucher.' : 'A Reversing Journal never posts to the books; it is for what-if figures. Put the date it applies until in More details (Ctrl+I).'}</p>}
          <table className="lines">
            <thead>
              <tr>{journal && <th style={{ width: 60 }}>Dr/Cr</th>}<th style={{ width: '45%' }}>Particulars</th><th>Bill-wise</th>{journal ? <><th className="num">Debit</th><th className="num">Credit</th></> : <th className="num">Amount</th>}</tr>
            </thead>
            <tbody>
              {acc.map((l, idx) => {
                const amt = toPaise(l.amount || 0);
                const bw = isBillWise(l.ledgerId);
                const alloc = bw && amt && !journal && type !== 'contra' ? (l.bills ?? autoAllocate(l.ledgerId!, amt)) : [];
                const onAcc = amt - alloc.reduce((a, b) => a + b.amount, 0);
                const options = type === 'contra' ? cashBank : allLedgerOptions;
                return (
                  <tr key={l.key} data-line={l.key}>
                    {journal && <td>
                      <select className="f" aria-label={`Side ${idx + 1}`} autoFocus={idx === 0 && !id} value={l.side} onChange={(e) => setAccLine(l.key, { side: e.target.value as 'Dr' | 'Cr' })} onKeyDown={enterNext}><option>Dr</option><option>Cr</option></select>
                    </td>}
                    <td>
                      <Combo name={`Particulars ${idx + 1}`} title="List of Ledger Accounts" value={l.ledgerId} options={options} autoFocus={false}
                        onChange={(v) => { setAccLine(l.key, { ledgerId: v, bills: null }); if (isBillWise(v)) loadPending(v).catch(() => {}); }}
                        onCreate={(typed) => nav.push({ name: 'ledger-form', props: { name: typed, onSaved: (x: any) => { reloadMasters(); setAccLine(l.key, { ledgerId: x.id }); } } })}
                        onAlter={alterLedger}
                        onEmptyEnter={() => narrationRef.current?.focus()} />
                    </td>
                    <td className="subtle">
                      {bw && amt > 0 && !journal && type !== 'contra' && (
                        <button className="btn small" onClick={() => setBillEdit(l.key)} title="Choose which bills this settles (Enter on the amount opens this too)">
                          {alloc.length ? `Agst ${alloc.map((b) => b.ref).join(', ')}` : 'On account'}{onAcc > 0 && alloc.length ? ` + ₹${formatINR(onAcc)} on acc` : ''}
                        </button>
                      )}
                    </td>
                    {journal ? <>
                      <td><input className="f num" aria-label={`Debit ${idx + 1}`} disabled={l.side !== 'Dr'} value={l.side === 'Dr' ? l.amount : ''} onChange={(e) => setAccLine(l.key, { amount: e.target.value })} onKeyDown={enterNext} /></td>
                      <td><input className="f num" aria-label={`Credit ${idx + 1}`} disabled={l.side !== 'Cr'} value={l.side === 'Cr' ? l.amount : ''} onChange={(e) => setAccLine(l.key, { amount: e.target.value })} onKeyDown={enterNext} /></td>
                    </> : <td><input className="f num" aria-label={`Amount ${idx + 1}`} value={l.amount} onChange={(e) => setAccLine(l.key, { amount: e.target.value, bills: null })}
                      onKeyDown={(e) => {
                        // As in Tally, Enter on the amount of a party opens its bill-wise details.
                        if (e.key === 'Enter' && bw && toPaise(l.amount || 0) > 0 && type !== 'contra') { e.preventDefault(); e.stopPropagation(); setBillEdit(l.key); return; }
                        enterNext(e);
                      }} onFocus={(e) => e.currentTarget.select()} /></td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="vtotals">
            <div className="row"><label>Narration</label><textarea ref={narrationRef} className="f" aria-label="Narration" rows={2} value={narration} onChange={(e) => setNarration(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askAccept(); } }} /></div>
            <table><tbody>
              {journal
                ? <><tr><td>Debit</td><td className="num">{formatINR(drTotal())}</td></tr><tr><td>Credit</td><td className="num">{formatINR(crTotal())}</td></tr>
                  <tr className="grand"><td>Difference</td><td className="num" style={{ color: drTotal() === crTotal() ? 'var(--good)' : 'var(--danger)' }}>{formatINR(drTotal() - crTotal())}</td></tr></>
                : <tr className="grand"><td>Total</td><td className="num">₹{formatINR(accTotal)}</td></tr>}
            </tbody></table>
          </div>
        </>
      )}
      {billEdit !== null && (() => {
        const line = acc.find((x) => x.key === billEdit);
        if (!line) return null;
        const close = (b: { ref: string; amount: number }[] | null) => {
          if (b) setAccLine(line.key, { bills: b });
          setBillEdit(null);
          // Back to the next line, so the keyboard flow carries on.
          setTimeout(() => {
            const row = formRef.current?.querySelector(`tr[data-line="${line.key}"]`);
            const nextRow = row?.nextElementSibling as HTMLElement | null;
            ((nextRow?.querySelector('input.f') as HTMLElement | null) ?? narrationRef.current)?.focus();
          }, 30);
        };
        return <BillAllocation
          bills={(pending[line.ledgerId!] ?? []).filter((b: any) => (type === 'receipt' ? b.pending > 0 : b.pending < 0))}
          amount={toPaise(line.amount || 0)}
          initial={line.bills ?? autoAllocate(line.ledgerId!, toPaise(line.amount || 0))}
          onDone={close}
        />;
      })()}
      {details && (
        <Modal title="More details (Ctrl+I)" onClose={() => setDetails(false)}>
          <div className="form" data-form>
            {inventory ? <>
              <div className="row"><label>{type === 'purchase' ? 'Supplier invoice no.' : 'Reference / order no.'}</label><input className="f" autoFocus aria-label="Reference" value={refNo} onChange={(e) => setRefNo(e.target.value)} onKeyDown={enterNext} /></div>
              <div className="row"><label>Reference date</label><input className="f" aria-label="Reference date" value={refDate} placeholder="dd-mm-yy" onChange={(e) => setRefDate(e.target.value)} onKeyDown={enterNext} /></div>
              <div className="row"><label>Transporter</label><input className="f" aria-label="Transporter" value={transporter} onChange={(e) => setTransporter(e.target.value)} onKeyDown={enterNext} /></div>
              <div className="row"><label>Vehicle no.</label><input className="f" aria-label="Vehicle" value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())} onKeyDown={enterNext} /></div>
              <div className="row"><label>Distance (km)</label><input className="f num" aria-label="Distance" value={distance} onChange={(e) => setDistance(e.target.value)} onKeyDown={enterNext} /></div>
            </> : journal ? <>
              <div className="row"><label>{type === 'reversing_journal' ? 'Applicable up to' : 'Reference date'}</label><input className="f" autoFocus aria-label="Reference date" value={refDate} placeholder="dd-mm-yy" onChange={(e) => setRefDate(e.target.value)} onKeyDown={enterNext} /></div>
              <div className="row"><label>Reference</label><input className="f" aria-label="Reference" value={refNo} onChange={(e) => setRefNo(e.target.value)} onKeyDown={enterNext} /></div>
            </> : <>
              <div className="row"><label>Cheque / UTR no.</label><input className="f" autoFocus aria-label="Cheque number" value={cheque.no} onChange={(e) => setCheque({ ...cheque, no: e.target.value })} onKeyDown={enterNext} /></div>
              <div className="row"><label>Cheque date</label><input className="f" aria-label="Cheque date" value={cheque.date} placeholder="dd-mm-yy" onChange={(e) => setCheque({ ...cheque, date: e.target.value })} onKeyDown={enterNext} /></div>
              <div className="row"><label>Bank name</label><input className="f" aria-label="Bank name" value={cheque.bank} onChange={(e) => setCheque({ ...cheque, bank: e.target.value })} onKeyDown={enterNext} /></div>
              <div className="row"><label>Post-dated (Ctrl+T)</label><select className="f" aria-label="Post-dated" value={pdc ? 'yes' : 'no'} onChange={(e) => setPdc(e.target.value === 'yes')} onKeyDown={enterNext}><option value="no">No</option><option value="yes">Yes</option></select></div>
            </>}
            <div className="row"><label>Optional (Ctrl+L)</label><select className="f" aria-label="Optional" value={optional ? 'yes' : 'no'} onChange={(e) => setOptional(e.target.value === 'yes')}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setDetails(false); } }}><option value="no">No</option><option value="yes">Yes</option></select></div>
          </div>
          <div className="actions"><button className="btn primary go" onClick={() => setDetails(false)}>Done</button></div>
        </Modal>
      )}
      {query !== null && <StockQuery itemId={query} asOf={date ?? nav.workDate} onClose={() => setQuery(null)} />}
      {showConfig && (
        <Modal title="Configure voucher entry (F12)" onClose={() => setShowConfig(false)}>
          {[['showFree', 'Show the Free quantity column'], ['showDisc', 'Show the Discount % column']].map(([k, text]) => (
            <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}>
              <input type="checkbox" checked={!!config[k]} onChange={(e) => {
                const next = { ...config, [k]: e.target.checked };
                setConfig(next);
                try { localStorage.setItem('stockwell-voucher-config', JSON.stringify(next)); } catch { /* storage blocked */ }
              }} />{text}
            </label>
          ))}
          <p className="hint">These settings are kept on this PC. Free and discount values already typed are still saved.</p>
          <div className="actions"><button className="btn primary" autoFocus onClick={() => setShowConfig(false)}>Done</button></div>
        </Modal>
      )}
    </div>
  );
}

/** A small pop-up that Esc closes without leaving the voucher. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-back" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="modal" data-form role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Alt+S: stock of the item by godown and batch, and its last purchase and sale rates. */
function StockQuery({ itemId, asOf, onClose }: { itemId: number; asOf: string; onClose: () => void }) {
  const [q, setQ] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`/api/items/${itemId}/query?asOf=${asOf}`).then(setQ).catch((e) => setErr(e.message)); }, [itemId, asOf]);
  return (
    <Modal title={q ? `Stock query: ${q.item.name}` : 'Stock query'} onClose={onClose}>
      {err && <div className="empty-state">{err}</div>}
      {q && <>
        <p><b>{q.stock}</b> in stock on {shortDate(asOf)} · GST {q.rate}%</p>
        {q.godowns.length > 1 && <table className="r"><thead><tr><th>Godown</th><th className="num">Quantity</th></tr></thead>
          <tbody>{q.godowns.map((g: any) => <tr key={g.id}><td>{g.name}</td><td className="num">{g.qty}</td></tr>)}</tbody></table>}
        {q.batches.length > 0 && <table className="r"><thead><tr><th>Batch</th><th>Expiry</th><th className="num">MRP</th><th className="num">Quantity</th></tr></thead>
          <tbody>{q.batches.map((b: any) => <tr key={b.id}><td>{b.batch_no}</td><td>{b.expiry_date ? shortDate(b.expiry_date) : ''}</td><td className="num">{b.mrp ? formatINR(b.mrp) : ''}</td><td className="num">{b.qty}</td></tr>)}</tbody></table>}
        <table className="r"><thead><tr><th>Last purchases</th><th>Party</th><th className="num">Rate</th></tr></thead>
          <tbody>{q.purchases.map((p: any, i: number) => <tr key={i}><td>{shortDate(p.date)} {p.number}</td><td>{p.party}</td><td className="num">{formatINR(p.rate)}</td></tr>)}
            {!q.purchases.length && <tr><td colSpan={3} className="subtle">None</td></tr>}</tbody></table>
        <table className="r"><thead><tr><th>Last sales</th><th>Party</th><th className="num">Rate</th></tr></thead>
          <tbody>{q.sales.map((p: any, i: number) => <tr key={i}><td>{shortDate(p.date)} {p.number}</td><td>{p.party}</td><td className="num">{formatINR(p.rate)}</td></tr>)}
            {!q.sales.length && <tr><td colSpan={3} className="subtle">None</td></tr>}</tbody></table>
      </>}
      <div className="actions"><button className="btn primary" autoFocus onClick={onClose}>Close (Esc)</button></div>
    </Modal>
  );
}

function BillAllocation({ bills, amount, initial, onDone }: { bills: any[]; amount: number; initial: { ref: string; amount: number }[]; onDone: (b: { ref: string; amount: number }[] | null) => void }) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(initial.map((b) => [b.ref, rupeesText(b.amount)])));
  const used = Object.values(vals).reduce((a, v) => a + toPaise(v || 0), 0);
  const finish = () => onDone(Object.entries(vals).filter(([, v]) => toPaise(v || 0) > 0).map(([ref, v]) => ({ ref, amount: toPaise(v) })));
  return (
    <div className="modal-back" onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === 'Escape') onDone(null);
      if ((e.ctrlKey && e.key.toLowerCase() === 'a')) { e.preventDefault(); finish(); }
    }}>
      <div className="modal" data-form>
        <h3>Bill-wise details · ₹{formatINR(amount)}</h3>
        <table className="lines">
          <thead><tr><th>Bill</th><th>Date</th><th className="num">Pending</th><th className="num">Settle now</th></tr></thead>
          <tbody>
            {bills.map((b, i) => (
              <tr key={b.ref}>
                <td>{b.ref}</td><td>{shortDate(b.bill_date)}</td><td className="num">{formatINR(Math.abs(b.pending))}</td>
                <td><input className="f num" autoFocus={i === 0} aria-label={`Settle ${b.ref}`} value={vals[b.ref] ?? ''} onChange={(e) => setVals((s) => ({ ...s, [b.ref]: e.target.value }))}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => { if (e.key === 'Enter' && i === bills.length - 1) { e.preventDefault(); finish(); } else enterNext(e); }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!bills.length && <div className="empty-state">No pending bills. The amount goes on account.</div>}
        <p className="hint">Allocated ₹{formatINR(used)} · On account ₹{formatINR(Math.max(0, amount - used))} · Enter on the last bill or Ctrl+A to finish, Esc to go back.</p>
        <div className="actions"><button className="btn" onClick={() => onDone(null)}>Cancel</button><button className="btn primary go" autoFocus={!bills.length} onClick={finish}>Done (Ctrl+A)</button></div>
      </div>
    </div>
  );
}
