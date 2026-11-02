import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { api, setToken, whenLoggedOut } from './api';
import { DepthContext, KeyAction, Nav, NavContext, Screen, keyName } from './nav';
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
  const toaster = <><DialogHost /><Toaster position="bottom-right" duration={3000} visibleToasts={3} gap={8} offset={{ bottom: 34, right: 196 }} toastOptions={{ className: 'sw-toast' }} /></>;
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
  const [conn, setConn] = useState<string>('');
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
    toast: (text, error) => (error ? toast.error(text, { duration: 6000 }) : toast.success(text)),
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

  const globalKeys: KeyAction[] = [
    { key: 'F2', label: 'Date', run: () => setAskDate(true) },
    { key: 'F3', label: 'Company', run: () => (user && user.role !== 'owner' ? toast.error('Only an Owner can change company settings.') : navRef.current.push({ name: 'company' })) },
    { key: 'F4', label: 'Contra', run: () => openVoucher('contra') },
    { key: 'F5', label: 'Payment', run: () => openVoucher('payment') },
    { key: 'F6', label: 'Receipt', run: () => openVoucher('receipt') },
    { key: 'F7', label: 'Journal', run: () => openVoucher('journal') },
    { key: 'F8', label: 'Sales', run: () => openVoucher('sales') },
    { key: 'F9', label: 'Purchase', run: () => openVoucher('purchase') },
    { key: 'F10', label: 'Other Vouchers', run: () => navRef.current.push({ name: 'voucher-types' }) },
    // TallyPrime's other voucher keys work everywhere but are not listed, as in Tally's button bar.
    ...Object.entries(TYPE_KEYS).filter(([k]) => !/^F\d$/.test(k)).map(([key, type]) => ({ key, label: VOUCHER_LABEL[type], run: () => openVoucher(type), hidden: true })),
    { key: 'Alt+F8', label: 'Delivery Note', hidden: true, run: () => toast.info('Delivery Note is not in Stockwell yet. Make the Sales bill (F8) directly.') },
    { key: 'Alt+F9', label: 'Receipt Note', hidden: true, run: () => toast.info('Receipt Note is not in Stockwell yet. Enter the Purchase (F9) directly.') },
    { key: 'Alt+G', label: 'Go To', run: () => navRef.current.push({ name: 'goto' }) },
    { key: 'Ctrl+G', label: 'Go To', hidden: true, run: () => navRef.current.push({ name: 'goto' }) },
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
      if (askDate) return;
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
                <div style={{ display: i === top ? 'block' : 'none', height: '100%' }}>
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
              onClick={async () => { if (await confirmBox('Change this PC\'s setup (main PC, or connect to another PC)?\nStockwell will restart.')) window.stockwell?.resetConnection(); }}>{conn}</button>
          ) : <span>Stockwell 0.1</span>}
          <span>Enter: next field · Ctrl+A: save · Alt+C: create · Esc: back</span>
        </footer>
      </div>
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
