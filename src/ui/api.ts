// Talks to the Stockwell server (on this PC or on the main office PC).

export class ApiError extends Error {
  constructor(message: string, public status = 0, public code?: string) { super(message); }
}

// The login token lives only as long as this window, like logging in to Tally each time it opens.
let token: string | null = null;
try { token = sessionStorage.getItem('stockwell-token'); } catch { /* storage blocked */ }
export function setToken(t: string | null) {
  token = t;
  try { if (t) sessionStorage.setItem('stockwell-token', t); else sessionStorage.removeItem('stockwell-token'); } catch { /* ignore */ }
}
export const getToken = () => token;

// Which company this PC works in (each company is its own folder on the main PC). Kept per PC, like Tally's last company.
let company: string | null = null;
try { company = localStorage.getItem('stockwell-company'); } catch { /* storage blocked */ }
export function setCompany(id: string | null) {
  company = id;
  try { if (id) localStorage.setItem('stockwell-company', id); else localStorage.removeItem('stockwell-company'); } catch { /* ignore */ }
}
export const getCompany = () => company;
let onNoCompany: () => void = () => {};
export const whenNoCompany = (f: () => void) => { onNoCompany = f; };

/** Headers that carry the login, for the odd fetch made outside api below. */
export const authHeaders = (): Record<string, string> => ({ ...(token ? { 'x-stockwell-token': token } : {}), ...(company ? { 'x-stockwell-company': company } : {}) });

/** A link to the printed bill for a new window or the PDF maker. It carries a one-use pass
 *  that lasts a minute, never the login token itself. */
export async function printUrl(id: number): Promise<string> {
  const q = new URLSearchParams();
  if (company) q.set('company', company);
  if (token) {
    const { ticket } = await api.post<{ ticket: string | null }>('/api/print-ticket');
    if (ticket) q.set('ticket', ticket);
  }
  const base = `${location.origin}/api/vouchers/${id}/print`;
  return q.toString() ? `${base}?${q}` : base;
}

let onLoggedOut: () => void = () => {};
export const whenLoggedOut = (f: () => void) => { onLoggedOut = f; };

async function request<T>(method: string, url: string, body?: unknown, timeoutMs?: number, inCompany?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['x-stockwell-token'] = token;
  if (inCompany || company) headers['x-stockwell-company'] = (inCompany || company)!;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs ?? (method === 'GET' ? 30000 : 20000)) });
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError';
    throw new ApiError(timedOut
      ? 'The main PC took too long to answer. Check the network, then look in the Day Book before saving again.'
      : 'Cannot reach Stockwell on the main PC. Check that it is on and connected to the office network.', 0);
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  // A refusal in another company (an import into a new one) must not log this PC out of its own company.
  if (res.status === 401 && !inCompany) onLoggedOut();
  if (res.status === 404 && data?.code === 'no-company' && !inCompany) onNoCompany();
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status, data?.code);
  return data as T;
}

/** Saves text as a file: a Save dialog on the desktop app, a download in a browser. */
export function downloadText(fileName: string, text: string, type = 'text/csv') {
  const blob = new Blob([type === 'text/csv' ? '\ufeff' + text : text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T = any>(url: string) => request<T>('DELETE', url),
  /** A big upload or a slow job (a Tally file of many years), with more time than a normal save. */
  slow: <T = any>(url: string, body: unknown, minutes = 10, inCompany?: string) => request<T>('POST', url, body, minutes * 60_000, inCompany),
};

/** Functions the Windows app adds; in a plain browser we fall back to downloads and new tabs. */
interface Bridge {
  savePdf(url: string, fileName: string): Promise<string>;
  saveFile(fileName: string, content: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  chooseFolder(): Promise<string | null>;
  connection(): Promise<{ mode: 'main' | 'client'; address: string; lanAddresses: string[]; dataDir?: string }>;
  /** Opens the setup page again (main PC or connect to it); on the main PC an Owner's login is needed. */
  resetConnection(token: string | null): Promise<void>;
  /** Only on the main PC. */
  restore?(token: string | null, company: string | null): Promise<boolean | void>;
}

declare global {
  interface Window { stockwell?: Bridge }
}

export const desktop = window.stockwell;

export async function saveTextFile(fileName: string, content: string): Promise<string | null> {
  if (desktop) return desktop.saveFile(fileName, content);
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  return fileName;
}

export async function openExternal(url: string) {
  if (desktop) return desktop.openExternal(url);
  window.open(url, '_blank');
}

/** Opens WhatsApp on the party's chat with the message typed in. */
export async function openWhatsApp(phone: string | null, text: string) {
  const q = new URLSearchParams({ text });
  if (phone) q.set('phone', phone);
  if (desktop) {
    // WhatsApp Desktop handles whatsapp:// links; if it is missing, the web version opens instead.
    try {
      await desktop.openExternal(`whatsapp://send?${q.toString()}`);
      return;
    } catch {
      /* fall through */
    }
  }
  await openExternal(`https://wa.me/${phone ?? ''}?text=${encodeURIComponent(text)}`);
}
