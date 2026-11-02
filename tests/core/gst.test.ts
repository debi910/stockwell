import { describe, expect, it } from 'vitest';
import { computeInvoice, computeLine, isIntraState, isValidGstin, schemeFreeQty, stateFromGstin } from '../../src/core/gst';

describe('gst', () => {
  it('validates GSTIN check digits', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZX')).toBe(false);
    expect(isValidGstin('99AAPFU0939F1ZV')).toBe(false);
    expect(stateFromGstin('21AAPFU0939F1ZV')).toBe('21');
  });
  it('splits CGST and SGST inside the state', () => {
    const t = computeLine({ qty: 10, rate: 4500, discountPct: 10, gstRate: 5 }, true);
    expect(t).toMatchObject({ gross: 45000, discount: 4500, taxable: 40500, cgst: 1013, sgst: 1013, igst: 0, total: 42526 });
  });
  it('charges IGST across states', () => {
    const t = computeLine({ qty: 3, rate: 10000, gstRate: 18 }, false);
    expect(t).toMatchObject({ taxable: 30000, igst: 5400, cgst: 0 });
  });
  it('rounds the invoice to whole rupees', () => {
    const inv = computeInvoice([
      { qty: 10, rate: 4500, discountPct: 10, gstRate: 5 },
      { qty: 2, rate: 12399, gstRate: 18 },
    ], true);
    expect(inv.beforeRound).toBe(42526 + 24798 + 2232 + 2232);
    expect(inv.total % 100).toBe(0);
    expect(inv.total - inv.beforeRound).toBe(inv.roundOff);
    expect(inv.byRate.map((r) => r.rate)).toEqual([5, 18]);
  });
  it('knows same-state supply', () => {
    expect(isIntraState('21', '21')).toBe(true);
    expect(isIntraState('21', '19')).toBe(false);
    expect(isIntraState('21', null)).toBe(true);
  });
  it('works out scheme free quantity', () => {
    expect(schemeFreeQty(25, 10, 1)).toBe(2);
    expect(schemeFreeQty(9, 10, 1)).toBe(0);
    expect(schemeFreeQty(10, 0, 1)).toBe(0);
  });
});
