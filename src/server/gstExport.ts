import { BooksError, type Books } from './books';
import { ddmmyyyy, monthRange } from '../core/dates';
import { isValidGstin } from '../core/gst';

const r2 = (paise: number) => Math.round(paise) / 100;

interface InvLine {
  item_id: number; hsn: string; item_name: string; uqc: string; qty: number; free_qty: number; gst_rate: number;
  taxable: number; cgst: number; sgst: number; igst: number; taxability: string;
}
interface Inv {
  id: number; type: string; number: string; seq: number; date: string; total: number; place_of_supply: string; intra: number;
  party_gstin: string; party_name: string; cancelled: number; ref_no: string; lines: InvLine[];
}

/** Bills of a period with the party's GSTIN and state as they were on the bill (not as the master is today). */
function invoices(books: Books, from: string, to: string, types: string[]): Inv[] {
  const vs = books.db.prepare(`
    SELECT v.id, v.type, v.number, v.seq, v.date, v.total, v.place_of_supply, v.intra, v.cancelled, v.ref_no,
      COALESCE(v.party_gstin,'') AS party_gstin, p.name AS party_name
    FROM vouchers v LEFT JOIN ledgers p ON p.id=v.party_id
    WHERE v.type IN (${types.map(() => '?').join(',')}) AND v.date BETWEEN ? AND ? ORDER BY v.date, v.seq`).all(...types, from, to) as Omit<Inv, 'lines'>[];
  const lineQ = books.db.prepare(`
    SELECT iv.item_id, i.hsn, i.name AS item_name, u.uqc, iv.qty, iv.free_qty, iv.gst_rate, iv.taxable, iv.cgst, iv.sgst, iv.igst, i.taxability
    FROM inventory iv JOIN items i ON i.id=iv.item_id JOIN units u ON u.id=i.unit_id WHERE iv.voucher_id=?`);
  return vs.map((v) => ({ ...v, place_of_supply: v.place_of_supply || books.company().state_code, lines: lineQ.all(v.id) as InvLine[] }));
}

function byRate(lines: InvLine[]) {
  const m = new Map<number, { txval: number; iamt: number; camt: number; samt: number }>();
  for (const l of lines) {
    const x = m.get(l.gst_rate) ?? { txval: 0, iamt: 0, camt: 0, samt: 0 };
    x.txval += l.taxable; x.iamt += l.igst; x.camt += l.cgst; x.samt += l.sgst;
    m.set(l.gst_rate, x);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

/** 0% lines are nil-rated, exempt or non-GST supplies: they go to Table 8, not to B2B/B2C. */
const isTaxed = (l: InvLine) => l.gst_rate > 0;
const zeroKind = (l: InvLine) => (l.taxability === 'exempt' ? 'expt_amt' : l.taxability === 'nongst' ? 'ngsup_amt' : 'nil_amt');

/** "S/2026-27/12" → series "S/2026-27/" and number 12, for the documents-issued table. */
function series(number: string) {
  const m = /^(.*?)(\d+)$/.exec(number);
  return m ? { prefix: m[1], n: Number(m[2]) } : { prefix: number, n: 0 };
}

/**
 * GSTR-1 in the GST portal's offline JSON layout (Returns > GSTR-1 > Prepare Offline > Upload).
 * Covers B2B, B2C large, B2C small, credit notes (registered and unregistered), nil/exempt (Table 8),
 * HSN summary (split B2B/B2C) and documents issued.
 */
export function gstr1(books: Books, period: string) {
  const company = books.company();
  const { from, to } = monthRange(period);
  const all = invoices(books, from, to, ['sales', 'credit_note']);
  const live = all.filter((v) => !v.cancelled);
  const isB2B = (v: Inv) => isValidGstin(v.party_gstin);
  // The invoice a credit note was raised against, to tell whether it was a B2C large invoice.
  const original = books.db.prepare(`
    SELECT v.total, v.intra, COALESCE(v.party_gstin,'') AS party_gstin, v.number, v.date FROM vouchers v
    WHERE v.type='sales' AND v.number=? AND v.party_id=(SELECT party_id FROM vouchers WHERE id=?)`);

  const b2bMap = new Map<string, unknown[]>();
  const b2cl: Map<string, unknown[]> = new Map();
  const b2cs = new Map<string, { sply_ty: string; pos: string; typ: string; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  const cdnrMap = new Map<string, unknown[]>();
  const cdnur: unknown[] = [];
  const nil = new Map<string, { sply_ty: string; nil_amt: number; expt_amt: number; ngsup_amt: number }>();
  const hsnB2B = new Map<string, Record<string, number | string>>();
  const hsnB2C = new Map<string, Record<string, number | string>>();
  const problems: string[] = [];

  for (const v of live) {
    const sign = v.type === 'credit_note' ? -1 : 1;
    const taxed = v.lines.filter(isTaxed);
    const itms = byRate(taxed).map(([rt, x], i) => ({
      num: i + 1,
      itm_det: { txval: r2(x.txval), rt, iamt: r2(x.iamt), camt: r2(x.camt), samt: r2(x.samt), csamt: 0 },
    }));
    const hsnTarget = isB2B(v) ? hsnB2B : hsnB2C;
    for (const l of v.lines) {
      if (!/^\d{4,8}$/.test(l.hsn || '')) problems.push(`${v.number}: item "${l.item_name}" has no valid HSN code.`);
      const key = `${l.hsn}|${l.gst_rate}|${l.uqc}`;
      const h = hsnTarget.get(key) ?? { hsn_sc: l.hsn, desc: l.item_name.slice(0, 30), uqc: l.uqc, qty: 0, rt: l.gst_rate, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      h.qty = (h.qty as number) + sign * (l.qty + l.free_qty);
      h.txval = (h.txval as number) + sign * l.taxable;
      h.iamt = (h.iamt as number) + sign * l.igst;
      h.camt = (h.camt as number) + sign * l.cgst;
      h.samt = (h.samt as number) + sign * l.sgst;
      hsnTarget.set(key, h);
    }
    // Table 8: nil-rated, exempt and non-GST lines.
    for (const l of v.lines.filter((x) => !isTaxed(x))) {
      const sply = `${v.intra ? 'INTRA' : 'INTR'}${isB2B(v) ? 'B2B' : 'B2C'}`;
      const n = nil.get(sply) ?? { sply_ty: sply, nil_amt: 0, expt_amt: 0, ngsup_amt: 0 };
      n[zeroKind(l)] += sign * l.taxable;
      nil.set(sply, n);
    }
    if (!taxed.length) continue;

    if (v.type === 'sales' && isB2B(v)) {
      const list = b2bMap.get(v.party_gstin) ?? [];
      list.push({ inum: v.number, idt: ddmmyyyy(v.date), val: r2(v.total), pos: v.place_of_supply, rchrg: 'N', inv_typ: 'R', itms });
      b2bMap.set(v.party_gstin, list);
    } else if (v.type === 'credit_note' && isB2B(v)) {
      const list = cdnrMap.get(v.party_gstin) ?? [];
      list.push({ ntty: 'C', nt_num: v.number, nt_dt: ddmmyyyy(v.date), val: r2(v.total), pos: v.place_of_supply, rchrg: 'N', inv_typ: 'R', itms });
      cdnrMap.set(v.party_gstin, list);
    } else if (v.type === 'sales' && !v.intra && v.total > 1_00_000_00) {
      // Inter-state sale to an unregistered buyer above ₹1 lakh (B2C large, from 1 Aug 2024).
      const list = b2cl.get(v.place_of_supply) ?? [];
      list.push({ inum: v.number, idt: ddmmyyyy(v.date), val: r2(v.total), itms: itms.map((x) => ({ num: x.num, itm_det: { txval: x.itm_det.txval, rt: x.itm_det.rt, iamt: x.itm_det.iamt, csamt: 0 } })) });
      b2cl.set(v.place_of_supply, list);
    } else {
      const orig = v.type === 'credit_note' && v.ref_no ? original.get(v.ref_no, v.id) as { total: number; intra: number; party_gstin: string } | undefined : undefined;
      if (orig && !orig.intra && !isValidGstin(orig.party_gstin) && orig.total > 1_00_000_00) {
        // Credit note on a B2C large invoice is reported on its own (CDNUR, type B2CL).
        cdnur.push({
          typ: 'B2CL', ntty: 'C', nt_num: v.number, nt_dt: ddmmyyyy(v.date), val: r2(v.total), pos: v.place_of_supply,
          itms: itms.map((x) => ({ num: x.num, itm_det: { txval: x.itm_det.txval, rt: x.itm_det.rt, iamt: x.itm_det.iamt, csamt: 0 } })),
        });
        continue;
      }
      // B2C small, net of credit notes to unregistered buyers.
      for (const [rt, x] of byRate(taxed)) {
        const sply = v.intra ? 'INTRA' : 'INTER';
        const key = `${sply}|${v.place_of_supply}|${rt}`;
        const s = b2cs.get(key) ?? { sply_ty: sply, pos: v.place_of_supply, typ: 'OE', rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
        s.txval += sign * x.txval; s.iamt += sign * x.iamt; s.camt += sign * x.camt; s.samt += sign * x.samt;
        b2cs.set(key, s);
      }
    }
  }

  const hsnList = (m: Map<string, Record<string, number | string>>) => [...m.values()].map((h, i) => ({
    num: i + 1, hsn_sc: h.hsn_sc, desc: h.desc, uqc: h.uqc, qty: Math.round((h.qty as number) * 100) / 100, rt: h.rt,
    txval: r2(h.txval as number), iamt: r2(h.iamt as number), camt: r2(h.camt as number), samt: r2(h.samt as number), csamt: 0,
  }));

  // Table 13: one range per numbering series (typed numbers form their own series).
  const docRanges = (type: string) => {
    const groups = new Map<string, Inv[]>();
    for (const v of all.filter((x) => x.type === type)) {
      const sr = series(v.number).prefix;
      groups.set(sr, [...(groups.get(sr) ?? []), v]);
    }
    return [...groups.values()].map((list, i) => {
      const sorted = [...list].sort((a, b) => series(a.number).n - series(b.number).n);
      const cancelled = list.filter((v) => v.cancelled).length;
      // Numbers missing inside the range (deleted vouchers) count as cancelled, as the portal expects.
      const first = series(sorted[0].number).n;
      const last = series(sorted[sorted.length - 1].number).n;
      const span = Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first + 1 : list.length;
      const totnum = Math.max(span, list.length);
      const net = list.length - cancelled;
      return { num: i + 1, from: sorted[0].number, to: sorted[sorted.length - 1].number, totnum, cancel: totnum - net, net_issue: net };
    });
  };
  const docDet = [
    { doc_num: 1, docs: docRanges('sales') },
    { doc_num: 5, docs: docRanges('credit_note') },
  ].filter((d) => d.docs.length);

  const out: Record<string, unknown> = {
    gstin: company.gstin,
    fp: `${period.slice(5, 7)}${period.slice(0, 4)}`,
    version: 'GST3.2.2',
    hash: 'hash',
  };
  if (b2bMap.size) out.b2b = [...b2bMap.entries()].map(([ctin, inv]) => ({ ctin, inv }));
  if (b2cl.size) out.b2cl = [...b2cl.entries()].map(([pos, inv]) => ({ pos, inv }));
  const b2csList = [...b2cs.values()].filter((x) => x.txval !== 0);
  if (b2csList.length) out.b2cs = b2csList.map((x) => ({ ...x, txval: r2(x.txval), iamt: r2(x.iamt), camt: r2(x.camt), samt: r2(x.samt) }));
  if (cdnrMap.size) out.cdnr = [...cdnrMap.entries()].map(([ctin, nt]) => ({ ctin, nt }));
  if (cdnur.length) out.cdnur = cdnur;
  const nilList = [...nil.values()].filter((n) => n.nil_amt || n.expt_amt || n.ngsup_amt);
  if (nilList.length) out.nil = { inv: nilList.map((n) => ({ sply_ty: n.sply_ty, nil_amt: r2(n.nil_amt), expt_amt: r2(n.expt_amt), ngsup_amt: r2(n.ngsup_amt) })) };
  if (hsnB2B.size || hsnB2C.size) out.hsn = { ...(hsnB2B.size ? { hsn_b2b: hsnList(hsnB2B) } : {}), ...(hsnB2C.size ? { hsn_b2c: hsnList(hsnB2C) } : {}) };
  if (docDet.length) out.doc_issue = { doc_det: docDet };
  if (b2csList.some((x) => x.txval < 0)) problems.push('Credit notes to unregistered buyers are more than this month\'s B2C sales at one rate and state; check them before filing.');

  const summary = {
    invoices: live.filter((v) => v.type === 'sales').length,
    b2b: [...b2bMap.values()].reduce((a, l) => a + l.length, 0),
    creditNotes: live.filter((v) => v.type === 'credit_note').length,
    taxable: live.reduce((a, v) => a + (v.type === 'credit_note' ? -1 : 1) * v.lines.filter(isTaxed).reduce((x, l) => x + l.taxable, 0), 0),
    nilExempt: live.reduce((a, v) => a + (v.type === 'credit_note' ? -1 : 1) * v.lines.filter((l) => !isTaxed(l)).reduce((x, l) => x + l.taxable, 0), 0),
  };
  return { json: out, summary, missingGstin: !company.gstin, problems: [...new Set(problems)] };
}

type Heads = { igst: number; cgst: number; sgst: number };

/**
 * Pays tax from input credit in the order the law sets (s.49(5) and Rule 88A):
 * IGST credit first (IGST, then CGST/SGST where it saves cash), then CGST credit (CGST, then IGST),
 * then SGST credit (SGST, then IGST). CGST credit never pays SGST, nor the other way round.
 */
export function setOff(liability: Heads, credit: Heads) {
  const due = { ...liability };
  const left = { igst: Math.max(0, credit.igst), cgst: Math.max(0, credit.cgst), sgst: Math.max(0, credit.sgst) };
  const used = { igstOnIgst: 0, igstOnCgst: 0, igstOnSgst: 0, cgstOnCgst: 0, cgstOnIgst: 0, sgstOnSgst: 0, sgstOnIgst: 0 };
  const take = (from: keyof Heads, to: keyof Heads, cap = Infinity) => {
    const x = Math.max(0, Math.min(left[from], due[to], cap));
    left[from] -= x; due[to] -= x;
    return x;
  };
  used.igstOnIgst = take('igst', 'igst');
  // Spend leftover IGST credit where the head's own credit falls short first, so no cash is paid needlessly.
  const shortC = Math.max(0, due.cgst - left.cgst);
  const shortS = Math.max(0, due.sgst - left.sgst);
  used.igstOnCgst = take('igst', 'cgst', shortC);
  used.igstOnSgst = take('igst', 'sgst', shortS);
  used.igstOnCgst += take('igst', 'cgst');
  used.igstOnSgst += take('igst', 'sgst');
  used.cgstOnCgst = take('cgst', 'cgst');
  used.cgstOnIgst = take('cgst', 'igst');
  used.sgstOnSgst = take('sgst', 'sgst');
  used.sgstOnIgst = take('sgst', 'igst');
  return { cash: { igst: Math.max(0, due.igst), cgst: Math.max(0, due.cgst), sgst: Math.max(0, due.sgst) }, carryForward: left, used };
}

/** Figures to type into GSTR-3B. */
export function gstr3b(books: Books, period: string) {
  const { from, to } = monthRange(period);
  const lines = (types: string[], extra = '') => books.db.prepare(`
    SELECT v.type, v.intra, v.place_of_supply, COALESCE(v.party_gstin,'') AS party_gstin, iv.gst_rate, i.taxability,
      iv.taxable, iv.igst, iv.cgst, iv.sgst
    FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id JOIN items i ON i.id=iv.item_id
    WHERE v.cancelled=0 AND v.type IN (${types.map(() => '?').join(',')}) AND v.date BETWEEN ? AND ? ${extra}`).all(...types, from, to) as
    { type: string; intra: number; place_of_supply: string; party_gstin: string; gst_rate: number; taxability: string; taxable: number; igst: number; cgst: number; sgst: number }[];
  const zero = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0 });
  const add = (acc: ReturnType<typeof zero>, l: { taxable: number; igst: number; cgst: number; sgst: number }, sign: number) => {
    acc.taxable += sign * l.taxable; acc.igst += sign * l.igst; acc.cgst += sign * l.cgst; acc.sgst += sign * l.sgst;
  };

  const outward = zero();       // 3.1(a)
  const nilExempt = zero();     // 3.1(c)
  const nonGst = zero();        // 3.1(e)
  const interB2C = new Map<string, { pos: string; taxable: number; igst: number }>(); // 3.2
  for (const l of lines(['sales', 'credit_note'])) {
    const sign = l.type === 'credit_note' ? -1 : 1;
    if (l.gst_rate > 0) add(outward, l, sign);
    else if (l.taxability === 'nongst') add(nonGst, l, sign);
    else add(nilExempt, l, sign);
    if (l.gst_rate > 0 && !l.intra && !isValidGstin(l.party_gstin)) {
      const x = interB2C.get(l.place_of_supply) ?? { pos: l.place_of_supply, taxable: 0, igst: 0 };
      x.taxable += sign * l.taxable; x.igst += sign * l.igst;
      interB2C.set(l.place_of_supply, x);
    }
  }
  // Input credit only from registered suppliers; check it against GSTR-2B before filing.
  const itc = zero();
  const inwardExempt = { inter: 0, intra: 0 }; // Table 5
  for (const l of lines(['purchase', 'debit_note'])) {
    const sign = l.type === 'debit_note' ? -1 : 1;
    if (l.gst_rate > 0 && isValidGstin(l.party_gstin)) add(itc, l, sign);
    else if (l.gst_rate === 0) inwardExempt[l.intra ? 'intra' : 'inter'] += sign * l.taxable;
  }
  const s = setOff({ igst: outward.igst, cgst: outward.cgst, sgst: outward.sgst }, { igst: itc.igst, cgst: itc.cgst, sgst: itc.sgst });
  return {
    period, outward, nilExempt, nonGst, interStateB2C: [...interB2C.values()].filter((x) => x.taxable), itc, inwardExempt,
    payable: s.cash, carryForward: s.carryForward, setOff: s.used,
  };
}

/**
 * Bulk e-Way Bill JSON for the e-Way Bill portal (Generate Bulk upload).
 * Includes only the chosen sales invoices.
 */
export function ewayBillJson(books: Books, voucherIds: number[]) {
  const c = books.company();
  const billLists = voucherIds.map((id) => {
    const v = books.voucher(id) as ReturnType<Books['voucher']> & Record<string, any>;
    if (v.type !== 'sales') throw new BooksError(`${v.number} is not a sales invoice.`);
    if (v.cancelled) throw new BooksError(`${v.number} is cancelled, so it needs no e-Way Bill.`);
    const party = books.ledger(v.party_id!);
    const lines = v.lines as Record<string, any>[];
    const main = [...lines].sort((a, b) => b.taxable - a.taxable)[0];
    const toState = Number(party.state_code || c.state_code);
    return {
      userGstin: c.gstin,
      supplyType: 'O',
      subSupplyType: 1,
      subSupplyDesc: '',
      docType: 'INV',
      docNo: v.number,
      docDate: ddmmyyyy(v.date, '/'),
      fromGstin: c.gstin,
      fromTrdName: c.name,
      fromAddr1: c.address.split('\n')[0] ?? '',
      fromAddr2: c.address.split('\n')[1] ?? '',
      fromPlace: c.city,
      fromPincode: Number(c.pincode) || 0,
      fromStateCode: Number(c.state_code),
      actFromStateCode: Number(c.state_code),
      toGstin: party.gstin || 'URP',
      toTrdName: party.name,
      toAddr1: party.address.split('\n')[0] ?? '',
      toAddr2: party.address.split('\n')[1] ?? '',
      toPlace: party.city,
      toPincode: Number(party.pincode) || 0,
      toStateCode: toState,
      actToStateCode: toState,
      transactionType: 1,
      totalValue: r2(v.taxable as number),
      cgstValue: r2(v.cgst as number),
      sgstValue: r2(v.sgst as number),
      igstValue: r2(v.igst as number),
      cessValue: 0,
      cessNonAdvolValue: 0,
      otherValue: r2(v.round_off as number),
      totInvValue: r2(v.total),
      transMode: 1,
      transDistance: v.distance_km || 0,
      transporterId: v.transporter_id || '',
      transporterName: v.transporter_name || '',
      transDocNo: '',
      transDocDate: '',
      vehicleNo: v.vehicle_no || '',
      vehicleType: 'R',
      mainHsnCode: Number(main?.hsn) || 0,
      itemList: lines.map((l, i) => ({
        itemNo: i + 1,
        productName: l.item_name,
        productDesc: l.item_name,
        hsnCode: Number(l.hsn) || 0,
        quantity: l.qty + l.free_qty,
        qtyUnit: l.uqc,
        taxableAmount: r2(l.taxable),
        cgstRate: v.intra ? l.gst_rate / 2 : 0,
        sgstRate: v.intra ? l.gst_rate / 2 : 0,
        igstRate: v.intra ? 0 : l.gst_rate,
        cessRate: 0,
        cessNonadvol: 0,
      })),
    };
  });
  return { version: '1.0.0621', billLists };
}

/** Sales invoices in a date range that need an e-Way Bill (value over the threshold) and do not have one yet. */
export function ewayCandidates(books: Books, from: string, to: string, includeDone = false) {
  const t = books.company().ewb_threshold;
  return books.db.prepare(`
    SELECT v.id, v.number, v.date, v.total, v.vehicle_no, v.distance_km, v.ewb_no, p.name AS party_name
    FROM vouchers v JOIN ledgers p ON p.id=v.party_id
    WHERE v.type='sales' AND v.cancelled=0 AND (? OR COALESCE(v.ewb_no,'')='') AND v.date BETWEEN ? AND ? AND v.total>? ORDER BY v.date, v.seq`).all(includeDone ? 1 : 0, from, to, t);
}
