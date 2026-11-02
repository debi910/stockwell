// Dates are stored as ISO strings "YYYY-MM-DD" and shown as "DD-MM-YYYY" or "2-Nov-26" like Indian books.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** "02-11-2026" for GST portal JSON. */
export function ddmmyyyy(iso: string, sep = '-'): string {
  const [y, m, d] = iso.split('-');
  return `${d}${sep}${m}${sep}${y}`;
}

/** "2-Nov-26" for screens. */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(d)}-${MONTHS[Number(m) - 1]}-${y.slice(2)}`;
}

/** Accepts "2-11-26", "02/11/2026", "2.11", "2026-11-02"; missing parts come from the reference date. */
export function parseDate(text: string, ref: string = todayISO()): string | null {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const parts = t.split(/[-/.\s]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;
  const [ry, rm] = ref.split('-').map(Number);
  const d = Number(parts[0]);
  let m = parts[1] !== undefined ? Number(parts[1]) : rm;
  if (parts[1] !== undefined && Number.isNaN(m)) {
    const idx = MONTHS.findIndex((x) => x.toLowerCase() === parts[1].slice(0, 3).toLowerCase());
    m = idx + 1;
  }
  let y = parts[2] !== undefined ? Number(parts[2]) : ry;
  if (y < 100) y += 2000;
  if (!d || !m || m < 1 || m > 12 || d < 1 || d > 31 || !y) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (check.getUTCDate() !== d) return null;
  return iso;
}

/** Indian financial year that contains the date, e.g. 2026-11-02 → { start: 2026-04-01, end: 2027-03-31, label: '2026-27' }. */
export function financialYear(iso: string): { start: string; end: string; label: string } {
  const [y, m] = iso.split('-').map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return {
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
  };
}

/** First and last day of a "YYYY-MM" period. */
export function monthRange(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}
