export { formatINR, drCr, toPaise, amountInWords } from '../core/money';
export { shortDate, parseDate, ddmmyyyy, financialYear, addDays, monthRange, todayISO } from '../core/dates';
export { isValidGstin, computeInvoice, computeBill, rateOn, isIntraState, schemeFreeQty } from '../core/gst';

/** Paise to an editable rupee string without grouping, blank for zero. */
export function rupeesText(paise: number | null | undefined): string {
  if (!paise) return '';
  return (paise / 100).toFixed(2).replace(/\.00$/, '');
}

export const VOUCHER_LABEL: Record<string, string> = {
  sales: 'Sales', purchase: 'Purchase', credit_note: 'Credit Note', debit_note: 'Debit Note',
  receipt: 'Receipt', payment: 'Payment', contra: 'Contra', journal: 'Journal',
  sales_order: 'Sales Order', purchase_order: 'Purchase Order', rejection_in: 'Rejection In', rejection_out: 'Rejection Out',
  stock_journal: 'Stock Journal', physical_stock: 'Physical Stock',
  delivery_note: 'Delivery Note', receipt_note: 'Receipt Note', memorandum: 'Memorandum', reversing_journal: 'Reversing Journal',
};

/** Moves focus to the next input in the form, like pressing Enter through Tally fields. */
export function focusNext(from: HTMLElement | null, back = false) {
  if (!from) return;
  const root = from.closest('[data-form]') ?? document;
  const els = Array.from(root.querySelectorAll<HTMLElement>('input.f, select.f, textarea.f, button.go')).filter((el) => !(el as HTMLInputElement).disabled && el.offsetParent !== null);
  const i = els.indexOf(from);
  const next = els[i + (back ? -1 : 1)];
  next?.focus();
}
