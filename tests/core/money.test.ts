import { describe, expect, it } from 'vitest';
import { amountInWords, drCr, formatINR, toPaise } from '../../src/core/money';

describe('money', () => {
  it('parses rupees to paise', () => {
    expect(toPaise('1,234.50')).toBe(123450);
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(toPaise('')).toBe(0);
  });
  it('formats with Indian grouping', () => {
    expect(formatINR(123456789)).toBe('12,34,567.89');
    expect(formatINR(-50000)).toBe('-500.00');
    expect(formatINR(99)).toBe('0.99');
    expect(drCr(-150000)).toBe('1,500.00 Cr');
  });
  it('writes amounts in words', () => {
    expect(amountInWords(12050000)).toBe('Rupees One Lakh Twenty Thousand Five Hundred Only');
    expect(amountInWords(1234567850)).toBe('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only');
  });
});
