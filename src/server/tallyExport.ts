// A company's data as TallyPrime XML (the same layout Tally uses for Alt+E export and for Import Data):
// Masters.xml (groups, ledgers with openings and pending bills, units, stock groups, godowns, items with openings)
// and DayBook.xml (every voucher). Each company goes into a folder of its own, as Tally keeps them.
import fs from 'node:fs';
import path from 'node:path';
import type { Books } from './books';
import { VOUCHER_TYPES, type VoucherType } from './books';
import { STATES } from '../core/gst';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const tag = (name: string, value: unknown) => `<${name}>${esc(value)}</${name}>`;
const tdate = (iso: string | null | undefined) => (iso ? iso.replace(/-/g, '') : '');
/** Stockwell keeps debit as positive paise; Tally writes debit as a negative rupee amount. */
const tamt = (paise: number) => (-paise / 100).toFixed(2);
const rupees = (paise: number) => (paise / 100).toFixed(2);
const qtyText = (q: number, unit: string) => ` ${Number(q.toFixed(3))} ${unit}`;
const yesNo = (b: unknown) => (b ? 'Yes' : 'No');

const envelope = (report: string, company: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE>\n<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>\n<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME>` +
  `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>\n<REQUESTDATA>\n${body}</REQUESTDATA></IMPORTDATA></BODY>\n</ENVELOPE>\n`;
const msg = (inner: string) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${inner}</TALLYMESSAGE>\n`;

const TALLY_TYPE: Record<VoucherType, string> = {
  sales: 'Sales', purchase: 'Purchase', credit_note: 'Credit Note', debit_note: 'Debit Note', receipt: 'Receipt', payment: 'Payment',
  contra: 'Contra', journal: 'Journal', sales_order: 'Sales Order', purchase_order: 'Purchase Order', rejection_in: 'Rejections In',
  rejection_out: 'Rejections Out', stock_journal: 'Stock Journal', physical_stock: 'Stock Journal', delivery_note: 'Delivery Note',
  receipt_note: 'Receipt Note', memorandum: 'Memorandum', reversing_journal: 'Reversing Journal',
};

export function tallyMastersXml(books: Books): string {
  const db = books.db;
  const company = books.company().name;
  const parts: string[] = [];
  const groups = db.prepare(`SELECT g.name, p.name AS parent FROM groups g LEFT JOIN groups p ON p.id=g.parent_id WHERE g.builtin=0 ORDER BY g.id`).all() as { name: string; parent: string | null }[];
  for (const g of groups) parts.push(msg(`<GROUP NAME="${esc(g.name)}">${tag('NAME', g.name)}${tag('PARENT', g.parent ?? '')}</GROUP>`));

  for (const u of db.prepare(`SELECT symbol FROM units ORDER BY id`).all() as { symbol: string }[]) {
    parts.push(msg(`<UNIT NAME="${esc(u.symbol)}">${tag('NAME', u.symbol)}<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT></UNIT>`));
  }
  for (const g of db.prepare(`SELECT name FROM stock_groups ORDER BY id`).all() as { name: string }[]) {
    parts.push(msg(`<STOCKGROUP NAME="${esc(g.name)}">${tag('NAME', g.name)}<PARENT></PARENT></STOCKGROUP>`));
  }
  for (const g of db.prepare(`SELECT name FROM godowns WHERE id<>1 ORDER BY id`).all() as { name: string }[]) {
    parts.push(msg(`<GODOWN NAME="${esc(g.name)}">${tag('NAME', g.name)}</GODOWN>`));
  }

  const ledgers = db.prepare(`SELECT l.*, g.name AS grp FROM ledgers l JOIN groups g ON g.id=l.group_id ORDER BY l.id`).all() as Record<string, any>[];
  const openBills = db.prepare(`SELECT ref, amount, date, due_date FROM bills WHERE ledger_id=? AND voucher_id IS NULL ORDER BY date, id`);
  for (const l of ledgers) {
    const head = l.tax_kind === 'cgst' ? 'Central Tax' : l.tax_kind === 'sgst' ? 'State Tax' : l.tax_kind === 'igst' ? 'Integrated Tax' : '';
    const billWise = books.isBillWise(l.id);
    const bills = billWise ? (openBills.all(l.id) as { ref: string; amount: number; date: string; due_date: string }[]) : [];
    const addr = String(l.address ?? '').split(/\r?\n/).filter(Boolean).map((a) => tag('ADDRESS', a)).join('');
    parts.push(msg(`<LEDGER NAME="${esc(l.name)}">${tag('NAME', l.name)}${tag('PARENT', l.grp)}` +
      `${tag('OPENINGBALANCE', tamt(l.opening))}${tag('ISBILLWISEON', yesNo(billWise))}` +
      (l.credit_days ? tag('BILLCREDITPERIOD', `${l.credit_days} Days`) : '') +
      (l.gstin ? `${tag('PARTYGSTIN', l.gstin)}<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` : '') +
      (l.state_code && STATES[l.state_code] ? tag('LEDSTATENAME', STATES[l.state_code]) : '') +
      (addr ? `<ADDRESS.LIST TYPE="String">${addr}</ADDRESS.LIST>` : '') +
      (l.pincode ? tag('PINCODE', l.pincode) : '') + (l.phone ? tag('LEDGERMOBILE', l.phone) : '') +
      (head ? `<TAXTYPE>GST</TAXTYPE>${tag('GSTDUTYHEAD', head)}` : '') +
      bills.map((b) => `<BILLALLOCATIONS.LIST>${tag('NAME', b.ref)}${tag('BILLDATE', tdate(b.date))}${tag('OPENINGBALANCE', tamt(b.amount))}</BILLALLOCATIONS.LIST>`).join('') +
      `</LEDGER>`));
  }

  const items = db.prepare(`SELECT i.*, u.symbol AS unit, sg.name AS sgroup FROM items i JOIN units u ON u.id=i.unit_id LEFT JOIN stock_groups sg ON sg.id=i.stock_group_id ORDER BY i.id`).all() as Record<string, any>[];
  const itemBatches = db.prepare(`SELECT batch_no, expiry_date, mfg_date, opening_qty FROM batches WHERE item_id=? AND opening_qty<>0`);
  for (const i of items) {
    const rate = i.opening_qty ? Math.round(i.opening_value / i.opening_qty) : 0;
    const batches = i.track_batch ? (itemBatches.all(i.id) as { batch_no: string; expiry_date: string | null; mfg_date: string | null; opening_qty: number }[]) : [];
    parts.push(msg(`<STOCKITEM NAME="${esc(i.name)}">${tag('NAME', i.name)}${tag('PARENT', i.sgroup ?? '')}${tag('BASEUNITS', i.unit)}` +
      `<GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE><GSTDETAILS.LIST>${tag('HSNCODE', i.hsn ?? '')}<TAXABILITY>Taxable</TAXABILITY>` +
      `<STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>` +
      `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD>${tag('GSTRATE', i.gst_rate / 2)}</RATEDETAILS.LIST>` +
      `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD>${tag('GSTRATE', i.gst_rate / 2)}</RATEDETAILS.LIST>` +
      `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD>${tag('GSTRATE', i.gst_rate)}</RATEDETAILS.LIST>` +
      `</STATEWISEDETAILS.LIST></GSTDETAILS.LIST>` +
      `${tag('OPENINGBALANCE', qtyText(i.opening_qty, i.unit))}${tag('OPENINGVALUE', tamt(i.opening_value))}${tag('OPENINGRATE', `${rupees(rate)}/${i.unit}`)}` +
      batches.map((b) => `<BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME>${tag('BATCHNAME', b.batch_no)}` +
        (b.mfg_date ? tag('MFDON', tdate(b.mfg_date)) : '') + (b.expiry_date ? tag('EXPIRYPERIOD', tdate(b.expiry_date)) : '') +
        `${tag('OPENINGBALANCE', qtyText(b.opening_qty, i.unit))}${tag('OPENINGVALUE', tamt(Math.round(b.opening_qty * rate)))}</BATCHALLOCATIONS.LIST>`).join('') +
      `</STOCKITEM>`));
  }
  return envelope('All Masters', company, parts.join(''));
}

export function tallyDayBookXml(books: Books, from = '0000-01-01', to = '9999-12-31'): { xml: string; count: number } {
  const db = books.db;
  const company = books.company().name;
  const vouchers = db.prepare(`SELECT v.*, p.name AS party FROM vouchers v LEFT JOIN ledgers p ON p.id=v.party_id WHERE v.date BETWEEN ? AND ? ORDER BY v.date, v.id`).all(from, to) as Record<string, any>[];
  const entriesOf = db.prepare(`SELECT e.ledger_id, e.amount, l.name FROM entries e JOIN ledgers l ON l.id=e.ledger_id WHERE e.voucher_id=? ORDER BY e.id`);
  const linesOf = db.prepare(`SELECT iv.*, i.name AS item, u.symbol AS unit, b.batch_no, b.expiry_date, g.name AS godown
    FROM inventory iv JOIN items i ON i.id=iv.item_id JOIN units u ON u.id=i.unit_id LEFT JOIN batches b ON b.id=iv.batch_id LEFT JOIN godowns g ON g.id=iv.godown_id
    WHERE iv.voucher_id=? ORDER BY iv.line_no, iv.id`);
  const billsOf = db.prepare(`SELECT ledger_id, ref, kind, amount FROM bills WHERE voucher_id=? ORDER BY id`);
  const numberOf = db.prepare(`SELECT number FROM vouchers WHERE id=?`);
  const out: string[] = [];
  for (const v of vouchers) {
    const vt = VOUCHER_TYPES[v.type as VoucherType];
    if (!vt) continue;
    const tType = TALLY_TYPE[v.type as VoucherType];
    const entries = entriesOf.all(v.id) as { ledger_id: number; amount: number; name: string }[];
    const lines = linesOf.all(v.id) as Record<string, any>[];
    const bills = billsOf.all(v.id) as { ledger_id: number; ref: string; kind: string; amount: number }[];
    const against = v.against_id ? (numberOf.get(v.against_id) as { number: string } | undefined)?.number ?? '' : '';
    const stockOnly = !!vt.stock;
    const invoice = vt.inventory && lines.length > 0;
    // In an invoice the Sales/Purchase ledger is shown inside the item lines (as Tally does), shared by value.
    const accountEntry = invoice && v.account_id ? entries.find((e) => e.ledger_id === v.account_id) : undefined;
    const rest = accountEntry ? entries.filter((e) => e !== accountEntry) : entries;
    const shares: number[] = [];
    if (accountEntry) {
      const base = lines.reduce((a, l) => a + Number(l.taxable), 0);
      lines.forEach((l, i) => shares.push(base ? Math.trunc((accountEntry.amount * Number(l.taxable)) / base) : i === 0 ? accountEntry.amount : 0));
      if (shares.length) shares[shares.length - 1] += accountEntry.amount - shares.reduce((a, s) => a + s, 0);
    }
    const kindName = (k: string) => (k === 'agst' ? 'Agst Ref' : k === 'onacc' ? 'On Account' : 'New Ref');
    const ledgerXml = rest.map((e) => {
      const bl = bills.filter((b) => b.ledger_id === e.ledger_id);
      return `<ALLLEDGERENTRIES.LIST>${tag('LEDGERNAME', e.name)}${tag('ISDEEMEDPOSITIVE', yesNo(e.amount > 0))}${tag('AMOUNT', tamt(e.amount))}` +
        bl.map((b) => `<BILLALLOCATIONS.LIST>${tag('NAME', b.ref)}${tag('BILLTYPE', kindName(b.kind))}${tag('AMOUNT', tamt(b.amount))}</BILLALLOCATIONS.LIST>`).join('') +
        `</ALLLEDGERENTRIES.LIST>`;
    }).join('');
    const lineXml = lines.map((l, i) => {
      const inward = Number(l.direction) > 0 || (Number(l.direction) === 0 && vt.move > 0);
      const amt = Number(l.taxable);
      const q = qtyText(Number(l.qty) + Number(l.free_qty || 0), l.unit);
      const tracking = Number(l.direction) === 0 && against && vt.books ? tag('TRACKINGNUMBER', against) : '';
      const batch = `<BATCHALLOCATIONS.LIST>${tag('GODOWNNAME', l.godown ?? 'Main Location')}${tag('BATCHNAME', l.batch_no ?? 'Primary Batch')}` +
        (l.expiry_date ? tag('EXPIRYPERIOD', tdate(l.expiry_date)) : '') + tracking +
        `${tag('AMOUNT', inward ? tamt(amt) : rupees(amt))}${tag('ACTUALQTY', q)}${tag('BILLEDQTY', qtyText(Number(l.qty), l.unit))}</BATCHALLOCATIONS.LIST>`;
      const acc = accountEntry ? `<ACCOUNTINGALLOCATIONS.LIST>${tag('LEDGERNAME', accountEntry.name)}${tag('ISDEEMEDPOSITIVE', yesNo(shares[i] > 0))}${tag('AMOUNT', tamt(shares[i]))}</ACCOUNTINGALLOCATIONS.LIST>` : '';
      const listName = stockOnly ? (inward ? 'INVENTORYENTRIESIN.LIST' : 'INVENTORYENTRIESOUT.LIST') : 'ALLINVENTORYENTRIES.LIST';
      return `<${listName}>${tag('STOCKITEMNAME', l.item)}${tag('ISDEEMEDPOSITIVE', yesNo(inward))}${tag('RATE', `${rupees(Number(l.rate))}/${l.unit}`)}` +
        (Number(l.discount_pct) ? tag('DISCOUNT', l.discount_pct) : '') +
        `${tag('AMOUNT', inward ? tamt(amt) : rupees(amt))}${tag('ACTUALQTY', q)}${tag('BILLEDQTY', qtyText(Number(l.qty), l.unit))}${batch}${acc}</${listName}>`;
    }).join('');
    const guid = v.tally_id || `stockwell-${books.company().name.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}-${v.id}`;
    out.push(msg(`<VOUCHER VCHTYPE="${esc(tType)}" ACTION="Create" OBJVIEW="${invoice ? 'Invoice Voucher View' : 'Accounting Voucher View'}">` +
      `${tag('DATE', tdate(v.date))}${tag('GUID', guid)}${tag('VOUCHERTYPENAME', tType)}${tag('VOUCHERNUMBER', v.number)}` +
      (v.party ? tag('PARTYLEDGERNAME', v.party) : '') + (v.narration ? tag('NARRATION', v.narration) : '') +
      (v.ref_no ? tag('REFERENCE', v.ref_no) : '') + (v.ref_date ? tag('REFERENCEDATE', tdate(v.ref_date)) : '') +
      (v.party_gstin ? tag('PARTYGSTIN', v.party_gstin) : '') + (v.place_of_supply && STATES[v.place_of_supply] ? tag('PLACEOFSUPPLY', STATES[v.place_of_supply]) : '') +
      `${tag('ISINVOICE', yesNo(invoice))}${tag('ISOPTIONAL', yesNo(v.optional && !vt.memo))}${tag('ISCANCELLED', yesNo(v.cancelled))}` +
      lineXml + ledgerXml + `</VOUCHER>`));
  }
  return { xml: envelope('Vouchers', company, out.join('')), count: vouchers.length };
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/[. ]+$/, '').trim().slice(0, 80);

/** Writes one company's Masters.xml and DayBook.xml into <dir>\<Company name (id)>\. */
export function exportCompanyFolder(books: Books, id: string, dir: string) {
  const name = books.company().name || `Company ${id}`;
  const folder = path.join(dir, `${safeName(name) || 'Company'} (${id})`);
  fs.mkdirSync(folder, { recursive: true });
  const masters = tallyMastersXml(books);
  const day = tallyDayBookXml(books);
  const write = (file: string, text: string) => { fs.writeFileSync(`${file}.part`, text); fs.renameSync(`${file}.part`, file); };
  write(path.join(folder, 'Masters.xml'), masters);
  write(path.join(folder, 'DayBook.xml'), day.xml);
  return { folder, vouchers: day.count };
}
