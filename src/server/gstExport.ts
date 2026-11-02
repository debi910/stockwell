import type { Books } from './books';
import { ddmmyyyy, monthRange } from '../core/dates';
import { isValidGstin } from '../core/gst';

const r2 = (paise: number) => Math.round(paise) / 100;

interface InvLine { item_id: number; hsn: string; item_name: string; uqc: string; qty: number; free_qty: number; gst_rate: number; taxable: number; cgst: number; sgst: number; igst: number }
interface Inv {
  id: number; type: string; number: string; date: string; total: number; place_of_supply: string; intra: number;
  party_gstin: string; party_name: string; cancelled: number; lines: InvLine[];
}

function invoices(books: Books, from: string, to: string, types: string[]): Inv[] {
  const vs = books.db.prepare(`
    SELECT v.id, v.type, v.number, v.date, v.total, v.place_of_supply, v.intra, v.cancelled, COALESCE(p.gstin,'') AS party_gstin, p.name AS party_name
    FROM vouchers v LEFT JOIN ledgers p ON p.id=v.party_id
    WHERE v.type IN (${types.map(() => '?').join(',')}) AND v.date BETWEEN ? AND ? ORDER BY v.date, v.seq`).all(...types, from, to) as Omit<Inv, 'lines'>[];
  const lineQ = books.db.prepare(`
    SELECT iv.item_id, i.hsn, i.name AS item_name, u.uqc, iv.qty, iv.free_qty, iv.gst_rate, iv.taxable, iv.cgst, iv.sgst, iv.igst
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

/**
 * GSTR-1 in the GST portal's offline JSON layout (Returns > GSTR-1 > Prepare Offline > Upload).
 * Covers B2B, B2C large, B2C small, credit notes, HSN summary (split B2B/B2C) and documents issued.
 */
export function gstr1(books: Books, period: string) {
  const company = books.company();
  const { from, to } = monthRange(period);
  const all = invoices(books, from, to, ['sales', 'credit_note']);
  const live = all.filter((v) => !v.cancelled);
  const isB2B = (v: Inv) => isValidGstin(v.party_gstin);

  const b2bMap = new Map<string, unknown[]>();
  const b2cl: Map<string, unknown[]> = new Map();
  const b2cs = new Map<string, { sply_ty: string; pos: string; typ: string; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  const cdnrMap = new Map<string, unknown[]>();
  const hsnB2B = new Map<string, Record<string, number | string>>();
  const hsnB2C = new Map<string, Record<string, number | string>>();

  for (const v of live) {
    const sign = v.type === 'credit_note' ? -1 : 1;
    const itms = byRate(v.lines).map(([rt, x], i) => ({
      num: i + 1,
      itm_det: { txval: r2(x.txval), rt, iamt: r2(x.iamt), camt: r2(x.camt), samt: r2(x.samt), csamt: 0 },
    }));
    const hsnTarget = isB2B(v) ? hsnB2B : hsnB2C;
    for (const l of v.lines) {
      const key = `${l.hsn}|${l.gst_rate}|${l.uqc}`;
      const h = hsnTarget.get(key) ?? { hsn_sc: l.hsn, desc: l.item_name.slice(0, 30), uqc: l.uqc, qty: 0, rt: l.gst_rate, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      h.qty = (h.qty as number) + sign * (l.qty + l.free_qty);
      h.txval = (h.txval as number) + sign * l.taxable;
      h.iamt = (h.iamt as number) + sign * l.igst;
      h.camt = (h.camt as number) + sign * l.cgst;
      h.samt = (h.samt as number) + sign * l.sgst;
      hsnTarget.set(key, h);
    }
    if (v.type === 'sales' && isB2B(v)) {
      const list = b2bMap.get(v.party_gstin) ?? [];
      list.push({ inum: v.number, idt: ddmmyyyy(v.date), val: r2(v.total), pos: v.place_of_supply, rchrg: 'N', inv_typ: 'R', itms });
      b2bMap.set(v.party_gstin, list);
    } else if (v.type === 'credit_note' && isB2B(v)) {
      const list = cdnrMap.get(v.party_gstin) ?? [];
      list.push({ ntty: 'C', nt_num: v.number, nt_dt: ddmmyyyy(v.date), val: r2(v.total), pos: v.place_of_supply, rchrg: 'N', inv_typ: 'R', itms });
      cdnrMap.set(v.party_gstin, list);
    } else if (v.type === 'sales' && !v.intra && v.total > 1_00_000_00) {
      // Inter-state sale to an unregistered buyer above ₹1 lakh.
      const list = b2cl.get(v.place_of_supply) ?? [];
      list.push({ inum: v.number, idt: ddmmyyyy(v.date), val: r2(v.total), itms: itms.map((x) => ({ num: x.num, itm_det: { txval: x.itm_det.txval, rt: x.itm_det.rt, iamt: x.itm_det.iamt, csamt: 0 } })) });
      b2cl.set(v.place_of_supply, list);
    } else {
      // B2C small, net of credit notes to unregistered buyers.
      for (const [rt, x] of byRate(v.lines)) {
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

  const docRange = (type: string) => {
    const list = all.filter((v) => v.type === type);
    if (!list.length) return null;
    const cancelled = list.filter((v) => v.cancelled).length;
    return { num: 1, from: list[0].number, to: list[list.length - 1].number, totnum: list.length, cancel: cancelled, net_issue: list.length - cancelled };
  };
  const docDet = [
    { doc_num: 1, range: docRange('sales') },
    { doc_num: 5, range: docRange('credit_note') },
  ].filter((d) => d.range).map((d) => ({ doc_num: d.doc_num, docs: [d.range] }));

  const out: Record<string, unknown> = {
    gstin: company.gstin,
    fp: `${period.slice(5, 7)}${period.slice(0, 4)}`,
    version: 'GST3.2.2',
    hash: 'hash',
  };
  if (b2bMap.size) out.b2b = [...b2bMap.entries()].map(([ctin, inv]) => ({ ctin, inv }));
  if (b2cl.size) out.b2cl = [...b2cl.entries()].map(([pos, inv]) => ({ pos, inv }));
  if (b2cs.size) out.b2cs = [...b2cs.values()].filter((s) => s.txval !== 0).map((s) => ({ ...s, txval: r2(s.txval), iamt: r2(s.iamt), camt: r2(s.camt), samt: r2(s.samt) }));
  if (cdnrMap.size) out.cdnr = [...cdnrMap.entries()].map(([ctin, nt]) => ({ ctin, nt }));
  if (hsnB2B.size || hsnB2C.size) out.hsn = { ...(hsnB2B.size ? { hsn_b2b: hsnList(hsnB2B) } : {}), ...(hsnB2C.size ? { hsn_b2c: hsnList(hsnB2C) } : {}) };
  if (docDet.length) out.doc_issue = { doc_det: docDet };

  const summary = {
    invoices: live.filter((v) => v.type === 'sales').length,
    b2b: [...b2bMap.values()].reduce((a, l) => a + l.length, 0),
    creditNotes: live.filter((v) => v.type === 'credit_note').length,
    taxable: live.reduce((a, v) => a + (v.type === 'credit_note' ? -1 : 1) * v.lines.reduce((s, l) => s + l.taxable, 0), 0),
  };
  return { json: out, summary, missingGstin: !company.gstin };
}

/** Figures to type into GSTR-3B: outward supplies (3.1a) and input tax credit (4A5). */
export function gstr3b(books: Books, period: string) {
  const { from, to } = monthRange(period);
  const sum = (types: string[]) => books.db.prepare(`
    SELECT COALESCE(SUM(taxable),0) taxable, COALESCE(SUM(igst),0) igst, COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst
    FROM vouchers WHERE cancelled=0 AND type IN (${types.map(() => '?').join(',')}) AND date BETWEEN ? AND ?`).get(...types, from, to) as
    { taxable: number; igst: number; cgst: number; sgst: number };
  const sales = sum(['sales']);
  const cn = sum(['credit_note']);
  const purchase = sum(['purchase']);
  const dn = sum(['debit_note']);
  const net = (a: typeof sales, b: typeof sales) => ({ taxable: a.taxable - b.taxable, igst: a.igst - b.igst, cgst: a.cgst - b.cgst, sgst: a.sgst - b.sgst });
  const outward = net(sales, cn);
  const itc = net(purchase, dn);
  return {
    period, outward, itc,
    payable: { igst: outward.igst - itc.igst, cgst: outward.cgst - itc.cgst, sgst: outward.sgst - itc.sgst },
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
    if (v.type !== 'sales') throw new Error(`${v.number} is not a sales invoice.`);
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
export function ewayCandidates(books: Books, from: string, to: string) {
  const t = books.company().ewb_threshold;
  return books.db.prepare(`
    SELECT v.id, v.number, v.date, v.total, v.vehicle_no, v.distance_km, v.ewb_no, p.name AS party_name
    FROM vouchers v JOIN ledgers p ON p.id=v.party_id
    WHERE v.type='sales' AND v.cancelled=0 AND v.date BETWEEN ? AND ? AND v.total>? ORDER BY v.date, v.seq`).all(from, to, t);
}
