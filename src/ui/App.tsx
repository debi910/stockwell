import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { api, setToken, whenLoggedOut } from './api';
import { DepthContext, KeyAction, Nav, NavContext, Screen, keyName } from './nav';
import { parseDate, shortDate, todayISO } from './format';
import { SCREENS, screenTitle } from './screens';
import { LoginScreen } from './screens/Settings';

/** Checks whether logins are on and, if so, asks for one before opening the books. */
export function App() {
  const [session, setSession] = useState<{ usersEnabled: boolean; user: any } | null>(null);
  const [failed, setFailed] = useState('');
  const check = useCallback(() => api.get('/api/session').then(setSession).catch((e) => setFailed(e.message)), []);
  useEffect(() => { check(); whenLoggedOut(() => { setToken(null); check(); }); }, [check]);
  const toaster = <Toaster position="bottom-right" duration={3000} visibleToasts={3} gap={8} offset={{ bottom: 34, right: 196 }} toastOptions={{ className: 'sw-toast' }} />;
  if (failed) return <div className="empty-state">Cannot reach the Stockwell server: {failed}. If this is the second PC, check the main PC is on.</div>;
  if (!session) return <div className="empty-state">Opening Stockwell…</div>;
  if (session.usersEnabled && !session.user) {
    return <>{toaster}<LoginScreen onLogin={(user) => setSession({ usersEnabled: true, user })} /></>;
  }
  const logout = async () => { await api.post('/api/logout').catch(() => {}); setToken(null); check(); };
  return <>{toaster}<Books user={session.user} onLogout={session.usersEnabled ? logout : undefined} /></>;
}

function Books({ user, onLogout }: { user: any; onLogout?: () => void }) {
  const [stack, setStack] = useState<Screen[]>([{ name: 'gateway' }]);
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

  const nav: Nav = useMemo(() => ({
    stack,
    push: (s) => setStack((st) => [...st, s]),
    pop: () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)),
    replace: (s) => setStack((st) => [...st.slice(0, -1), s]),
    home: () => setStack((st) => st.slice(0, 1)),
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
    { key: 'Ctrl+F8', label: 'Credit Note', run: () => openVoucher('credit_note') },
    { key: 'Ctrl+F9', label: 'Debit Note', run: () => openVoucher('debit_note') },
    ...(onLogout ? [{ key: 'Ctrl+Q', label: 'Log out', run: onLogout }] : []),
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
              <DepthContext.Provider key={i + s.name} value={i}>
                <div style={{ display: i === top ? 'block' : 'none', height: '100%' }}>
                  {C ? <C {...(s.props ?? {})} active={i === top} /> : <div className="empty-state">Unknown screen {s.name}</div>}
                </div>
              </DepthContext.Provider>
            );
          })}
        </main>
        <aside className="keybar" aria-label="Keys">
          {globalKeys.map((k) => (
            <button key={k.key} onClick={k.run}><span className="k">{k.key}</span>{k.label}</button>
          ))}
          {localKeys.length > 0 && <div className="sep" />}
          {localKeys.map((k) => (
            <button key={k.key + k.label} onClick={k.run} disabled={k.disabled}><span className="k">{k.key}</span>{k.label}</button>
          ))}
          <div className="sep" />
          <button onClick={() => nav.pop()} disabled={stack.length < 2}><span className="k">Esc</span>Back</button>
        </aside>
        <footer className="statusbar">
          {conn ? (
            <button className="linkish" title="Change which PC keeps the books"
              onClick={() => { if (window.confirm('Change this PC\'s setup (main PC or connect to another PC)? Stockwell will restart.')) window.stockwell?.resetConnection(); }}>{conn}</button>
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
