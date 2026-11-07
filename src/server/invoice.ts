import QRCode from 'qrcode';
import type { Books } from './books';
import { VOUCHER_TYPES, type VoucherType } from './books';
import { amountInWords, formatINR } from '../core/money';
import { ddmmyyyy, shortDate, todayISO } from '../core/dates';
import { STATES } from '../core/gst';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function upiLink(upiId: string, payee: string, amountPaise: number, note: string) {
  const p = new URLSearchParams({ pa: upiId, pn: payee, am: (amountPaise / 100).toFixed(2), cu: 'INR', tn: note });
  return `upi://pay?${p.toString()}`;
}

/** Printable A4 tax invoice. Opened in a window and saved as PDF by the desktop app. */
export async function invoiceHtml(books: Books, voucherId: number): Promise<string> {
  const v = books.voucher(voucherId) as ReturnType<Books['voucher']> & Record<string, any>;
  const c = books.company();
  const party = v.party_id ? books.ledger(v.party_id) : null;
  const lines = v.lines as Record<string, any>[];
  const taxLines = (v.taxLines ?? []) as Record<string, any>[];
  const charges = (v.charges ?? []) as Record<string, any>[];
  const title = (v.optional ? 'OPTIONAL · ' : '') + (v.type === 'sales' ? 'TAX INVOICE' : v.type === 'delivery_note' ? 'DELIVERY CHALLAN' : VOUCHER_TYPES[v.type as VoucherType].label.toUpperCase());
  const showMrp = lines.some((l) => l.mrp > 0);
  let qr = '';
  if (c.upi_id && v.type === 'sales' && v.total > 0) {
    qr = await QRCode.toDataURL(upiLink(c.upi_id, c.name, v.total, `Bill ${v.number}`), { margin: 1, width: 220 });
  }
  const byRate = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of [...lines, ...taxLines]) {
    const r = byRate.get(l.gst_rate) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += l.taxable; r.cgst += l.cgst; r.sgst += l.sgst; r.igst += l.igst;
    byRate.set(l.gst_rate, r);
  }
  const intra = !!v.intra;
  const rows = lines.map((l, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(l.item_name)}${l.batch_no ? `<div class="sub">Batch ${esc(l.batch_no)}${l.expiry_date ? ` · Exp ${esc(shortDate(l.expiry_date))}` : ''}</div>` : ''}</td>
      <td class="c">${esc(l.hsn)}</td>
      ${showMrp ? `<td class="r">${l.mrp ? formatINR(l.mrp) : ''}</td>` : ''}
      <td class="r">${l.alt_qty ? `${esc(l.alt_qty)} ${esc(l.alt_unit)}<div class="sub">${esc(l.qty)} ${esc(l.unit)}</div>` : `${esc(l.qty)} ${esc(l.unit)}`}${l.free_qty ? `<div class="sub">+${esc(l.free_qty)} free</div>` : ''}</td>
      <td class="r">${l.alt_qty ? `${formatINR(Math.round(l.rate * l.alt_conv))}<div class="sub">per ${esc(l.alt_unit)}</div>` : formatINR(l.rate)}</td>
      <td class="r">${l.discount_pct ? esc(l.discount_pct) + '%' : ''}</td>
      <td class="r">${esc(l.gst_rate)}%</td>
      <td class="r">${formatINR(l.taxable)}</td>
    </tr>`).join('') + taxLines.map((t, i) => `
    <tr><td class="c">${lines.length + i + 1}</td><td>${esc(t.ledger_name)}</td><td class="c">${esc(t.hsn)}</td>${showMrp ? '<td></td>' : ''}<td></td><td></td><td></td>
      <td class="r">${esc(t.gst_rate)}%</td><td class="r">${formatINR(t.taxable)}</td></tr>`).join('');
  const taxRows = [...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, t]) => `
    <tr><td class="r">${esc(rate)}%</td><td class="r">${formatINR(t.taxable)}</td>
    ${intra ? `<td class="r">${formatINR(t.cgst)}</td><td class="r">${formatINR(t.sgst)}</td>` : `<td class="r">${formatINR(t.igst)}</td>`}</tr>`).join('');
  const outstanding = party && books.isBillWise(party.id)
    ? books.pendingBills({ ledgerId: party.id }).reduce((a, b) => a + b.pending, 0) : 0;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(v.number)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Inter', 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #1b2430; margin: 0; }
  .top { display: flex; justify-content: space-between; border-bottom: 2px solid #1f3a5f; padding-bottom: 8px; }
  .firm { font-size: 18px; font-weight: 700; color: #1f3a5f; }
  .title { text-align: right; font-size: 15px; font-weight: 700; letter-spacing: .05em; }
  .muted { color: #5a6573; }
  .boxes { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
  .box { border: 1px solid #c9d1db; border-radius: 4px; padding: 8px; }
  .label { font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; color: #5a6573; margin-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #1f3a5f; color: #fff; font-weight: 600; padding: 5px; font-size: 10px; }
  td { border-bottom: 1px solid #e3e8ee; padding: 5px; vertical-align: top; }
  .r { text-align: right; font-variant-numeric: tabular-nums; } .c { text-align: center; }
  .sub { font-size: 9.5px; color: #5a6573; }
  .totals { display: grid; grid-template-columns: 1.3fr 1fr; gap: 12px; margin-top: 10px; }
  .grand td { font-weight: 700; font-size: 13px; border-top: 2px solid #1f3a5f; }
  .foot { display: flex; justify-content: space-between; margin-top: 16px; align-items: flex-end; }
  .qr { text-align: center; } .qr img { width: 110px; height: 110px; }
  .sign { text-align: right; } .sign .line { margin-top: 42px; border-top: 1px solid #1b2430; padding-top: 3px; }
  ${v.cancelled ? '.cancel { color: #b42318; font-size: 28px; font-weight: 800; text-align: center; border: 3px solid #b42318; margin: 8px 0; }' : ''}
</style></head><body>
  <div class="top">
    <div>
      <div class="firm">${esc(c.name)}</div>
      <div class="muted">${esc(c.address).replace(/\n/g, '<br>')}${c.city ? `<br>${esc(c.city)} ${esc(c.pincode)}` : ''}</div>
      <div>${c.gstin ? `GSTIN ${esc(c.gstin)} · ` : ''}State ${esc(STATES[c.state_code] ?? '')} (${esc(c.state_code)})${c.phone ? ` · Ph ${esc(c.phone)}` : ''}</div>
    </div>
    <div class="title">${title}<div class="muted" style="font-size:11px;font-weight:400;margin-top:6px">No. <b>${esc(v.number)}</b><br>Date ${ddmmyyyy(v.date)}</div></div>
  </div>
  ${v.cancelled ? '<div class="cancel">CANCELLED</div>' : ''}
  <div class="boxes">
    <div class="box"><div class="label">Bill to</div>
      <b>${esc(party?.name ?? '')}</b><br>${esc(party?.address ?? '').replace(/\n/g, '<br>')}${party?.city ? `<br>${esc(party.city)} ${esc(party.pincode)}` : ''}
      ${party?.gstin ? `<br>GSTIN ${esc(party.gstin)}` : ''}${party?.phone ? `<br>Ph ${esc(party.phone)}` : ''}
    </div>
    <div class="box"><div class="label">Details</div>
      Place of supply: ${esc(STATES[v.place_of_supply] ?? '')} (${esc(v.place_of_supply)})<br>
      ${v.vehicle_no ? `Vehicle: ${esc(v.vehicle_no)}<br>` : ''}${v.ewb_no ? `e-Way Bill: ${esc(v.ewb_no)}<br>` : ''}
      ${party?.beat ? `Area: ${esc(party.beat)}<br>` : ''}${v.salesman ? `Salesman: ${esc(String(v.salesman))}<br>` : ''}${v.ref_no ? `Ref: ${esc(v.ref_no)}<br>` : ''}
    </div>
  </div>
  <table>
    <thead><tr><th>#</th><th style="text-align:left">Item</th><th>HSN</th>${showMrp ? '<th class="r">MRP</th>' : ''}<th class="r">Qty</th><th class="r">Rate</th><th class="r">Disc</th><th class="r">GST</th><th class="r">Taxable</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div>
      <table><thead><tr><th class="r">GST rate</th><th class="r">Taxable</th>${intra ? '<th class="r">CGST</th><th class="r">SGST</th>' : '<th class="r">IGST</th>'}</tr></thead><tbody>${taxRows}</tbody></table>
      <p><b>${esc(amountInWords(v.total))}</b></p>
      ${c.bank_details ? `<p class="muted">Bank: ${esc(c.bank_details)}</p>` : ''}
    </div>
    <table>
      ${charges.some((c) => c.assessable) ? `<tr><td>Value of goods</td><td class="r">${formatINR(v.taxable - charges.filter((c) => c.assessable).reduce((a, c) => a + c.amount, 0))}</td></tr>` : ''}
      ${charges.filter((c) => c.assessable).map((c) => `<tr><td>${esc(c.ledger_name)}</td><td class="r">${formatINR(c.amount)}</td></tr>`).join('')}
      <tr><td>Taxable value</td><td class="r">${formatINR(v.taxable)}</td></tr>
      ${intra ? `<tr><td>CGST</td><td class="r">${formatINR(v.cgst)}</td></tr><tr><td>SGST</td><td class="r">${formatINR(v.sgst)}</td></tr>` : `<tr><td>IGST</td><td class="r">${formatINR(v.igst)}</td></tr>`}
      ${charges.filter((c) => !c.assessable).map((c) => `<tr><td>${esc(c.ledger_name)}</td><td class="r">${formatINR(c.amount)}</td></tr>`).join('')}
      ${v.round_off ? `<tr><td>Round off</td><td class="r">${formatINR(v.round_off)}</td></tr>` : ''}
      <tr class="grand"><td>Total</td><td class="r">₹${formatINR(v.total)}</td></tr>
      ${outstanding && v.type === 'sales' ? `<tr><td class="muted">Total due from you (all bills)</td><td class="r muted">₹${formatINR(outstanding)}</td></tr>` : ''}
    </table>
  </div>
  <div class="foot">
    <div class="qr">${qr ? `<img src="${qr}" alt="UPI QR"><div class="sub">Scan to pay ₹${formatINR(v.total)} by UPI<br>${esc(c.upi_id)}</div>` : ''}</div>
    <div class="muted" style="max-width:45%">${esc(c.invoice_terms)}</div>
    <div class="sign">For ${esc(c.name)}<div class="line">Authorised signatory</div></div>
  </div>
</body></html>`;
}

/** Indian mobile number as WhatsApp expects it: 91 followed by 10 digits. */
export function whatsappNumber(phone: string): string | null {
  const d = (phone || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return null;
}

export function billMessage(books: Books, voucherId: number) {
  const v = books.voucher(voucherId) as ReturnType<Books['voucher']> & Record<string, any>;
  const c = books.company();
  const party = books.ledger(v.party_id ?? 0);
  const pending = books.isBillWise(party.id) ? books.pendingBills({ ledgerId: party.id }).reduce((a, b) => a + b.pending, 0) : 0;
  const text = [
    `Namaste ${party.name},`,
    `Your bill ${v.number} dated ${ddmmyyyy(v.date)} for ₹${formatINR(v.total)} is attached.`,
    pending > 0 ? `Total due from you now: ₹${formatINR(pending)}.` : '',
    c.upi_id ? `Pay by UPI to ${c.upi_id}.` : '',
    `Thank you,\n${c.name}${c.phone ? `\n${c.phone}` : ''}`,
  ].filter(Boolean).join('\n');
  return { phone: whatsappNumber(party.phone), partyName: party.name, text, fileName: `${v.number.replace(/[\\/:*?"<>|]/g, '-')}.pdf` };
}

export function reminderMessage(books: Books, ledgerId: number, asOf = todayISO()) {
  const c = books.company();
  const party = books.ledger(ledgerId);
  const bills = books.pendingBills({ ledgerId, asOf }).filter((b) => b.pending > 0);
  const total = bills.reduce((a, b) => a + b.pending, 0);
  const overdue = bills.filter((b) => b.overdue_days > 0);
  const lines = bills.map((b) => `• ${b.ref} of ${ddmmyyyy(b.bill_date)}: ₹${formatINR(b.pending)}${b.overdue_days ? ` (${b.overdue_days} days overdue)` : ''}`);
  const text = [
    `Namaste ${party.name},`,
    `This is a gentle reminder that ₹${formatINR(total)} is due to ${c.name}${overdue.length ? `, of which ${overdue.length} bill${overdue.length > 1 ? 's are' : ' is'} overdue` : ''}:`,
    ...lines,
    c.upi_id ? `Please pay by UPI to ${c.upi_id}${total > 0 ? ` (amount ₹${formatINR(total)})` : ''}.` : 'Please arrange the payment.',
    `Thank you,\n${c.name}${c.phone ? `\n${c.phone}` : ''}`,
  ].join('\n');
  return { phone: whatsappNumber(party.phone), partyName: party.name, total, text };
}
