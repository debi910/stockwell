// All money is held as whole paise (integers) so totals never drift.

export type Paise = number;

/** Convert a rupee amount (number or text such as "1,234.50") to paise. */
export function toPaise(rupees: number | string): Paise {
  if (typeof rupees === 'string') {
    const clean = rupees.replace(/[,₹\s]/g, '');
    if (clean === '' || clean === '-') return 0;
    rupees = Number(clean);
  }
  if (!Number.isFinite(rupees)) throw new Error(`Not a valid amount: ${rupees}`);
  // Go through the decimal text so 1.005 becomes 101 paise, not 100 (binary floating point).
  const [whole, frac = ''] = Math.abs(rupees).toFixed(6).split('.');
  const paise = Number(whole) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2] ?? 0) >= 5 ? 1 : 0);
  return rupees < 0 ? -paise : paise;
}

export function toRupees(paise: Paise): number {
  return paise / 100;
}

/** Round half away from zero, the way invoice arithmetic is usually done. */
export function roundHalfUp(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/** Indian digit grouping: 12,34,567.89 */
export function formatINR(paise: Paise, opts: { symbol?: boolean; blankZero?: boolean } = {}): string {
  if (opts.blankZero && paise === 0) return '';
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  const s = String(rupees);
  let grouped: string;
  if (s.length <= 3) grouped = s;
  else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  }
  return `${neg ? '-' : ''}${opts.symbol ? '₹' : ''}${grouped}.${fraction}`;
}

/** Dr/Cr display of a signed balance (+ is debit). */
export function drCr(paise: Paise): string {
  if (paise === 0) return '';
  return `${formatINR(Math.abs(paise))} ${paise > 0 ? 'Dr' : 'Cr'}`;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`;
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ');
}

/** Amount in words, Indian system: "Rupees One Lakh Twenty Thousand Only". */
export function amountInWords(paise: Paise): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const p = Math.abs(paise) % 100;
  if (rupees === 0 && p === 0) return 'Rupees Zero Only';
  const parts: string[] = [];
  const crore = Math.floor(rupees / 1_00_00_000);
  const lakh = Math.floor((rupees % 1_00_00_000) / 1_00_000);
  const thousand = Math.floor((rupees % 1_00_000) / 1000);
  const rest = rupees % 1000;
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  let words = rupees ? `Rupees ${parts.join(' ')}` : 'Rupees Zero';
  if (p) words += ` and ${twoDigits(p)} Paise`;
  return `${words} Only`;
}
