import { Paise, roundHalfUp } from './money';

export const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Checks format and the check digit of a 15-character GSTIN. */
export function isValidGstin(gstin: string): boolean {
  const g = gstin.trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  if (!STATES[g.slice(0, 2)]) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(g[i]);
    const product = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const check = (36 - (sum % 36)) % 36;
  return GSTIN_CHARS[check] === g[14];
}

export function stateFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null;
  const code = gstin.slice(0, 2);
  return STATES[code] ? code : null;
}

/** Same-state supply attracts CGST + SGST; anything else attracts IGST. */
export function isIntraState(companyState: string, placeOfSupply: string | null | undefined): boolean {
  return !placeOfSupply || placeOfSupply === companyState;
}

export interface LineInput {
  qty: number;
  rate: Paise; // per unit, before tax
  discountPct?: number;
  gstRate: number; // percent, e.g. 5, 12, 18
}

export interface LineTotals {
  gross: Paise;
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  total: Paise;
}

export function computeLine(line: LineInput, intra: boolean): LineTotals {
  const gross = roundHalfUp(line.qty * line.rate);
  const discount = roundHalfUp((gross * (line.discountPct ?? 0)) / 100);
  const taxable = gross - discount;
  let cgst = 0, sgst = 0, igst = 0;
  if (intra) {
    cgst = roundHalfUp((taxable * line.gstRate) / 200);
    sgst = cgst;
  } else {
    igst = roundHalfUp((taxable * line.gstRate) / 100);
  }
  return { gross, discount, taxable, cgst, sgst, igst, total: taxable + cgst + sgst + igst };
}

export interface InvoiceTotals {
  lines: LineTotals[];
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  beforeRound: Paise;
  roundOff: Paise; // added to reach a whole rupee
  total: Paise;
  byRate: { rate: number; taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise }[];
}

export function computeInvoice(lines: LineInput[], intra: boolean, roundToRupee = true): InvoiceTotals {
  const totals = lines.map((l) => computeLine(l, intra));
  const sum = (k: keyof LineTotals) => totals.reduce((a, t) => a + t[k], 0);
  const taxable = sum('taxable');
  const cgst = sum('cgst');
  const sgst = sum('sgst');
  const igst = sum('igst');
  const beforeRound = taxable + cgst + sgst + igst;
  const total = roundToRupee ? roundHalfUp(beforeRound / 100) * 100 : beforeRound;
  const rateMap = new Map<number, { rate: number; taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise }>();
  lines.forEach((l, i) => {
    const r = rateMap.get(l.gstRate) ?? { rate: l.gstRate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += totals[i].taxable;
    r.cgst += totals[i].cgst;
    r.sgst += totals[i].sgst;
    r.igst += totals[i].igst;
    rateMap.set(l.gstRate, r);
  });
  return {
    lines: totals, taxable, cgst, sgst, igst, beforeRound,
    roundOff: total - beforeRound, total,
    byRate: [...rateMap.values()].sort((a, b) => a.rate - b.rate),
  };
}

/** Free quantity from an item's "buy X get Y free" scheme. */
export function schemeFreeQty(qty: number, buy: number | null | undefined, free: number | null | undefined): number {
  if (!buy || !free || buy <= 0 || qty < buy) return 0;
  return Math.floor(qty / buy) * free;
}
