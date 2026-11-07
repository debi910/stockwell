import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { api, downloadText, saveTextFile, desktop, getToken, setToken, whenLoggedOut } from './api';
import { DepthContext, KeyAction, Nav, NavContext, Screen, keyName, reportList } from './nav';
import { VOUCHER_LABEL, parseDate, shortDate, todayISO } from './format';
import { TYPE_KEYS } from './screens/Voucher';
import { SCREENS, screenTitle } from './screens';
import { LoginScreen } from './screens/Settings';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DialogHost, confirmBox } from './components/Dialog';

/** Checks whether logins are on and, if so, asks for one before opening the books. */
export function App() {
  const [session, setSession] = useState<{ usersEnabled: boolean; user: any; needsOwnerSetup?: boolean } | null>(null);
  const [failed, setFailed] = useState('');
  const check = useCallback(() => api.get('/api/session').then(setSession).catch((e) => setFailed(e.message)), []);
  useEffect(() => { check(); whenLoggedOut(() => { setToken(null); check(); }); }, [check]);
  useEffect(() => {
    // A failed request that a screen forgot to handle still shows a message instead of failing silently.
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = e.reason?.message ?? String(e.reason);
      toast.error(/fetch|network/i.test(msg) ? 'Cannot reach the Stockwell server. If this is the second PC, check the main PC is on.' : msg);
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);
  const toaster = <><DialogHost /><Toaster position="bottom-right" duration={3000} visibleToasts={3} gap={8} offset={{ bottom: 40, right: 196 }} toastOptions={{ className: 'sw-toast' }} /></>;
  if (failed) return <div className="empty-state">Cannot reach the Stockwell server: {failed}. If this is the second PC, check the main PC is on.</div>;
  if (!session) return <div className="empty-state">Opening Stockwell…</div>;
  if (session.needsOwnerSetup) {
    return (
      <div className="empty-state">
        The books are locked to other PCs until the Owner's login is set up. On the main PC, open Stockwell and go to
        Settings &gt; Users, create the Owner login, then come back here and press F5.
        <div style={{ marginTop: 12 }}><button className="btn" onClick={check}>Try again</button></div>
      </div>
    );
  }
  if (session.usersEnabled && !session.user) {
    return <>{toaster}<LoginScreen onLogin={(user) => setSession({ usersEnabled: true, user })} /></>;
  }
  const logout = async () => { await api.post('/api/logout').catch(() => {}); setToken(null); check(); };
  return <>{toaster}<Books user={session.user} onLogout={session.usersEnabled ? logout : undefined} /></>;
}

/** Each opened screen gets its own id, so a replaced screen always starts fresh. */
let screenSeq = 0;

function Books({ user, onLogout }: { user: any; onLogout?: () => void }) {
  const [stack, setStack] = useState<Screen[]>([{ name: 'gateway' }]);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const [company, setCompany] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
  const [workDate, setWorkDate] = useState(todayISO());
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [screenKeys, setScreenKeysState] = useState<Record<number, KeyAction[]>>({});
  const [askDate, setAskDate] = useState(false);
  const [calc, setCalc] = useState(false);
  const [conn, setConn] = useState<string>('');
  const [pcs, setPcs] = useState(0);
  const handlers = useRef<Record<number, ((e: KeyboardEvent) => boolean | void) | null>>({});

  const refreshCompany = useCallback(async () => setCompany(await api.get('/api/company')), []);
  useEffect(() => {
    refreshCompany();
    api.get('/api/meta').then(setMeta);
    window.stockwell?.connection().then((c) => setConn(c.mode === 'main' ? `Main PC · others connect to ${c.lanAddresses[0] ?? 'this PC'}:7400` : `Connected to ${c.address}`));
  }, [refreshCompany]);

  // A screen's keys and title belong to that screen only: forget them the moment it closes or is
  // replaced, so the next screen never inherits (say) the closed voucher's Ctrl+A.
  const forgetFrom = (depth: number) => {
    const drop = <T,>(o: Record<number, T>) => Object.fromEntries(Object.entries(o).filter(([d]) => Number(d) < depth)) as Record<number, T>;
    setScreenKeysState(drop);
    setTitles(drop);
    for (const d of Object.keys(handlers.current)) if (Number(d) >= depth) handlers.current[Number(d)] = null;
  };
  const nav: Nav = useMemo(() => ({
    stack,
    push: (s) => { forgetFrom(stackRef.current.length); setStack((st) => [...st, { ...s, uid: ++screenSeq }]); },
    pop: () => { if (stackRef.current.length > 1) forgetFrom(stackRef.current.length - 1); setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)); },
    replace: (s) => { forgetFrom(stackRef.current.length - 1); setStack((st) => [...st.slice(0, -1), { ...s, uid: ++screenSeq }]); },
    home: () => { forgetFrom(1); setStack((st) => st.slice(0, 1)); },
    // One error at a time: a new refusal replaces the last one instead of piling up over the next bill.
    toast: (text, error) => (error ? toast.error(text, { id: 'sw-error', duration: 6000 }) : (toast.dismiss('sw-error'), toast.success(text))),
    user,
    company, meta, refreshCompany, workDate, setWorkDate,
    setScreenKeys: (d, k) => setScreenKeysState((s) => ({ ...s, [d]: k })),
    setTitle: (d, t) => setTitles((s) => (s[d] === t ? s : { ...s, [d]: t })),
    registerHandler: (d, h) => { handlers.current[d] = h; },
    depth: 0,
  }), [stack, company, meta, refreshCompany, workDate, user]);

  const navRef = useRef(nav);
  navRef.current = nav;

  const openVoucher = (type: string) => navRef.current.push({ name: 'voucher', props: { type } });
  // Go To pressed while Go To is open goes back to its search box instead of opening a second one.
  const openGoTo = () => {
    const st = stackRef.current;
    if (st[st.length - 1]?.name === 'goto') (document.querySelector('[data-depth] [aria-label="Go To"]') as HTMLInputElement | null)?.select();
    else navRef.current.push({ name: 'goto' });
  };

  // Keep the cursor in the screen: after a line is removed, a pop-up closes or a screen comes back to the top,
  // the cursor returns to where it was (or the nearest field), so the keyboard flow never stalls.
  const lastFocus = useRef<Record<number, HTMLElement>>({});
  useEffect(() => {
    const remember = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      const host = el.closest?.('[data-depth]');
      if (host && !el.closest('.modal') && el.matches('input, select, textarea, button, [tabindex]')) lastFocus.current[Number(host.getAttribute('data-depth'))] = el;
    };
    // A click on a report's row puts the cursor on the list, so Enter then opens that row (not the period box).
    const onRow = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest?.('.report table.r tbody tr') || el.closest('input, select, textarea, button')) return;
      const host = el.closest('[data-depth]');
      const list = host ? reportList(host) : null;
      if (list) setTimeout(() => list.focus(), 0);
    };
    document.addEventListener('focusin', remember);
    document.addEventListener('mousedown', onRow);
    return () => { document.removeEventListener('focusin', remember); document.removeEventListener('mousedown', onRow); };
  }, []);
  const restoreFocus = useCallback(() => {
    const a = document.activeElement;
    if (a && a !== document.body && (a as HTMLElement).offsetParent !== null) return;
    if (document.querySelector('.modal-back, [role=dialog], [role=alertdialog]')) return;
    const depth = stackRef.current.length - 1;
    const host = document.querySelector(`[data-depth="${depth}"]`);
    if (!host) return;
    const usable = (el: Element | null | undefined): el is HTMLElement => !!el && host.contains(el) && (el as HTMLElement).offsetParent !== null && !(el as HTMLInputElement).disabled;
    let target: HTMLElement | null = null;
    const last = lastFocus.current[depth];
    if (usable(last)) target = last;
    else if (last) {
      // The field went away (Ctrl+D removed its line): take the same field on the line above, e.g. "Item 3" → "Item 2".
      const label = (last as HTMLElement).getAttribute('aria-label') ?? '';
      const m = /^(.*?)(\d+)$/.exec(label);
      for (let n = m ? Number(m[2]) : 0; m && n >= 1 && !target; n--) {
        const el = host.querySelector(`[aria-label="${m[1]}${n}"]`);
        if (usable(el)) target = el;
      }
    }
    // A report opens on its list, as in Tally (Alt+F2 or a click reaches the period), so Enter opens the selected row.
    if (!target) target = reportList(host);
    if (!target) target = Array.from(host.querySelectorAll<HTMLElement>('input.f, select.f, textarea.f, [role=menu], [tabindex="0"]')).find((el) => usable(el)) ?? null;
    target?.focus();
  }, []);
  useEffect(() => {
    const later = () => setTimeout(restoreFocus, 30);
    document.addEventListener('focusout', later);
    const t = setInterval(restoreFocus, 400); // a field removed while focused does not always send focusout
    return () => { document.removeEventListener('focusout', later); clearInterval(t); };
  }, [restoreFocus]);
  useEffect(() => { const t = setTimeout(restoreFocus, 60); return () => clearTimeout(t); }, [stack.length, restoreFocus]);

  // Another PC (or this one) changed the books: tell open reports and vouchers so they show current figures.
  useEffect(() => {
    let seen = -1;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const { v, pcs } = await api.get('/api/changes');
        setPcs(pcs ?? 0);
        if (seen >= 0 && v !== seen) window.dispatchEvent(new Event('stockwell:changed'));
        seen = v;
      } catch { /* the server is busy or restarting; try again next time */ } finally { busy = false; }
    };
    poll(); // know where the books stand from the start, so the first change is not missed
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, []);

  const globalKeys: KeyAction[] = [
    { key: 'F2', label: 'Date', run: () => setAskDate(true) },
    { key: 'F3', label: 'Company', run: () => (user && user.role !== 'owner' ? toast.error('Only an Owner can change company settings.', { id: 'owner-only-f3' }) : navRef.current.push({ name: 'company' })) },
    { key: 'F4', label: 'Contra', run: () => openVoucher('contra') },
    { key: 'F5', label: 'Payment', run: () => openVoucher('payment') },
    { key: 'F6', label: 'Receipt', run: () => openVoucher('receipt') },
    { key: 'F7', label: 'Journal', run: () => openVoucher('journal') },
    { key: 'F8', label: 'Sales', run: () => openVoucher('sales') },
    { key: 'F9', label: 'Purchase', run: () => openVoucher('purchase') },
    { key: 'F10', label: 'Other Vouchers', run: () => navRef.current.push({ name: 'voucher-types' }) },
    // TallyPrime's other voucher keys work everywhere but are not listed, as in Tally's button bar.
    ...Object.entries(TYPE_KEYS).filter(([k]) => !/^F\d$/.test(k)).map(([key, type]) => ({ key, label: VOUCHER_LABEL[type], run: () => openVoucher(type), hidden: true })),
    { key: 'F11', label: 'Features', run: () => (user && user.role !== 'owner' ? toast.error('Only an Owner can change company features.', { id: 'owner-only-f11' }) : navRef.current.push({ name: 'features' })) },
    { key: 'Ctrl+E', label: 'Export', hidden: true, run: () => exportVisibleTable(titles[stack.length - 1] ?? screenTitle(stack[stack.length - 1])) },
    { key: 'Ctrl+N', label: 'Calculator', hidden: true, run: () => setCalc(true) },
    { key: 'Alt+G', label: 'Go To', run: () => openGoTo() },
    { key: 'Ctrl+G', label: 'Go To', hidden: true, run: () => openGoTo() },
    { key: 'F12', label: 'Configure', hidden: true, run: () => toast.info('F12 configures voucher entry. Open a voucher (F4 to F9) and press F12 there.') },
    // Ctrl+Q leaves a screen, and on the Gateway quits (logs out), as in TallyPrime.
    { key: 'Ctrl+Q', label: onLogout ? 'Quit / Log out' : 'Quit screen', run: () => {
      if (stackRef.current.length > 1) navRef.current.pop();
      else if (onLogout) confirmBox('Log out of Stockwell?', { yes: 'Log out', no: 'Stay' }).then((y) => { if (y) onLogout(); });
    } },
  ];
  const top = stack.length - 1;
  const localKeys = screenKeys[top] ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (askDate || calc) return;
      const name = keyName(e);
      const h = handlers.current[stack.length - 1];
      if (h && h(e)) { e.preventDefault(); return; }
      const local = (screenKeys[stack.length - 1] ?? []).find((k) => k.key === name && !k.disabled);
      if (local?.run) { e.preventDefault(); local.run(); return; }
      if (name === 'Esc') { e.preventDefault(); navRef.current.pop(); return; }
      const g = globalKeys.find((k) => k.key === name);
      if (g?.run) { e.preventDefault(); g.run(); return; }
      if (/^F\d+$/.test(e.key) || name === 'Ctrl+R') e.preventDefault(); // keep the browser from reloading on F5
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!company || !meta) return <div className="empty-state">Opening Stockwell…</div>;

  return (
    <NavContext.Provider value={nav}>
      <div className="shell">
        <header className="topbar">
          <div className="brand"><img src="./logo.svg" alt="" />Stockwell</div>
          <div className="company">{company.name}</div>
          <div className="date">Date: {shortDate(workDate)} · FY {company.fy.label}</div>
          {user && <div className="user" title={user.role === 'owner' ? 'Owner' : 'Billing operator'}>{user.name}</div>}
        </header>
        <div className="titlebar">
          <span>{titles[top] ?? screenTitle(stack[top])}</span>
          <span className="crumbs">{stack.slice(0, -1).map((s, i) => titles[i] ?? screenTitle(s)).join('  ›  ')}</span>
        </div>
        <main className="main">
          {stack.map((s, i) => {
            const C = SCREENS[s.name];
            return (
              <DepthContext.Provider key={`${i}-${s.name}-${s.uid ?? 0}`} value={i}>
                <div data-depth={i} style={{ display: i === top ? 'block' : 'none', height: '100%' }}>
                  <ErrorBoundary onBack={() => nav.pop()}>
                    {C ? <C {...(s.props ?? {})} active={i === top} /> : <div className="empty-state">Unknown screen {s.name}</div>}
                  </ErrorBoundary>
                </div>
              </DepthContext.Provider>
            );
          })}
        </main>
        <aside className="keybar" aria-label="Keys">
          {globalKeys.filter((k) => !k.hidden).map((k) => (
            <button key={k.key} onClick={k.run}><span className="k">{k.key}</span>{k.label}</button>
          ))}
          {localKeys.length > 0 && <div className="sep" />}
          {localKeys.filter((k) => !k.hidden).map((k) => (
            <button key={k.key + k.label} onClick={k.run} disabled={k.disabled}><span className="k">{k.key}</span>{k.label}</button>
          ))}
          <div className="sep" />
          <button onClick={() => nav.pop()} disabled={stack.length < 2}><span className="k">Esc</span>Back</button>
        </aside>
        <footer className="statusbar">
          {conn ? (
            <button className="linkish" title="Change which PC keeps the books"
              onClick={async () => { if (await confirmBox('Change this PC\'s setup (main PC, or connect to another PC)?\nStockwell will restart.')) window.stockwell?.resetConnection(getToken()).catch((e) => nav.toast(String(e.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, ''), true)); }}>{conn}{pcs > 1 ? ` · ${pcs} PCs working` : ''}</button>
          ) : <span>Stockwell {meta.version ?? '0.2'}</span>}
          <span>Enter: next field · Ctrl+A: save · Alt+C: create · Esc: back</span>
        </footer>
      </div>
      {calc && <Calculator onClose={() => setCalc(false)} />}
      {askDate && <DatePrompt current={workDate} onDone={(d) => { if (d) setWorkDate(d); setAskDate(false); }} />}
    </NavContext.Provider>
  );
}

function DatePrompt({ current, onDone }: { current: string; onDone: (d: string | null) => void }) {
  const [text, setText] = useState(shortDate(current));
  const [err, setErr] = useState('');
  return (
    <div className="modal-back">
      <div className="modal">
        <h3>Change current date</h3>
        <input
          className="f" autoFocus value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            // This box owns these keys: Enter must not also open whatever is selected behind it.
            if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); }
            if (e.key === 'Escape') onDone(null);
            if (e.key === 'Enter') {
              const d = parseDate(text, current);
              if (d) onDone(d); else setErr('Type a date like 2-11-26');
            }
          }}
        />
        <div className="hint">{err || 'New vouchers will use this date. Type 5 for the 5th of this month.'}</div>
      </div>
    </div>
  );
}

/** Ctrl+E: saves the table on the open screen as a CSV file that opens in Excel. */
function exportVisibleTable(title: string) {
  const table = Array.from(document.querySelectorAll<HTMLTableElement>('.main table')).find((t) => t.offsetParent !== null);
  if (!table) { toast.info('There is no table on this screen to export.'); return; }
  const cell = (c: Element) => {
    const input = c.querySelector('input, select') as HTMLInputElement | null;
    const v = (input ? input.value : (c as HTMLElement).innerText).replace(/\s+/g, ' ').trim();
    return /[",\n]/.test(v) || /^[=+\-@]/.test(v) && !/^-?[\d,.]+$/.test(v) ? `"${v.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : v;
  };
  const rows = Array.from(table.rows).map((r) => Array.from(r.cells).map(cell).join(','));
  const name = `${title.replace(/[^\w\- ]+/g, '').trim() || 'Stockwell'} ${todayISO()}.csv`;
  const text = rows.join('\r\n');
  if (desktop) saveTextFile(name, '\ufeff' + text).then((p) => { if (p) toast.success(`Saved ${p}`); }).catch((e) => toast.error(e.message));
  else { downloadText(name, text); toast.success(`Exported ${name}`); }
}

/** Evaluates + - * / % and brackets on plain numbers, without eval. Returns null for anything else. */
export function calculate(expr: string): number | null {
  const src = expr.replace(/,/g, '').replace(/\s+/g, '').replace(/x/gi, '*');
  if (!src || !/^[\d.+\-*/%()]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const num = (): number | null => {
    if (peek() === '(') { i++; const v = sum(); if (peek() !== ')') return null; i++; return v; }
    if (peek() === '-') { i++; const v = num(); return v === null ? null : -v; }
    if (peek() === '+') { i++; return num(); }
    const m = /^\d*\.?\d+|^\d+\.?/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    let v = Number(m[0]);
    if (peek() === '%') { i++; v = v / 100; }
    return v;
  };
  const product = (): number | null => {
    let v = num();
    while (v !== null && (peek() === '*' || peek() === '/')) {
      const op = src[i++]; const r = num();
      if (r === null) return null;
      if (op === '/' && r === 0) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number | null => {
    let v = product();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = src[i++]; const r = product();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return v !== null && i === src.length && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null;
}

function Calculator({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [tape, setTape] = useState<string[]>([]);
  const value = calculate(text);
  return (
    <div className="modal-back">
      <div className="modal" data-testid="calculator">
        <h3>Calculator</h3>
        <div className="hint" style={{ minHeight: 18 }}>{tape.slice(-5).map((t, k) => <div key={k}>{t}</div>)}</div>
        <input
          className="f" autoFocus value={text} aria-label="Calculation" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); }
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && value !== null) {
              setTape((t) => [...t, `${text} = ${value.toLocaleString('en-IN')}`]);
              setText(String(value));
              navigator.clipboard?.writeText(String(value)).catch(() => {});
            }
          }}
        />
        <div className="hint">{text ? (value === null ? 'Type a sum like 1250*12 + 18%' : `= ${value.toLocaleString('en-IN')}`) : 'Type a sum and press Enter. The answer is copied. Esc closes.'}</div>
      </div>
    </div>
  );
}
