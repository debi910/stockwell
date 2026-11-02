// Talks to the Stockwell server (on this PC or on the main office PC).

export class ApiError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

// The login token lives only as long as this window, like logging in to Tally each time it opens.
let token: string | null = null;
try { token = sessionStorage.getItem('stockwell-token'); } catch { /* storage blocked */ }
export function setToken(t: string | null) {
  token = t;
  try { if (t) sessionStorage.setItem('stockwell-token', t); else sessionStorage.removeItem('stockwell-token'); } catch { /* ignore */ }
}
/** Adds the login token to a link opened outside fetch, such as the printed bill. */
export const withToken = (url: string) => (token ? `${url}${url.includes('?') ? '&' : '?'}t=${token}` : url);

let onLoggedOut: () => void = () => {};
export const whenLoggedOut = (f: () => void) => { onLoggedOut = f; };

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['x-stockwell-token'] = token;
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) onLoggedOut();
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T = any>(url: string) => request<T>('DELETE', url),
};

/** Functions the Windows app adds; in a plain browser we fall back to downloads and new tabs. */
interface Bridge {
  savePdf(url: string, fileName: string): Promise<string>;
  saveFile(fileName: string, content: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  chooseFolder(): Promise<string | null>;
  connection(): Promise<{ mode: 'main' | 'client'; address: string; lanAddresses: string[]; dataDir?: string }>;
  resetConnection(): Promise<void>;
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
