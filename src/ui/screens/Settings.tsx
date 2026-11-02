import { useCallback, useEffect, useState } from 'react';
import { api, desktop, openExternal, saveTextFile, setToken, getToken } from '../api';
import { Row, Select, Text } from '../components/Field';
import { promptBox } from '../components/Dialog';
import { useKeyBar, useNav, useScreenKeys, useTitle } from '../nav';
import { formatINR, rupeesText, shortDate, toPaise } from '../format';

function useSave(save: () => void | Promise<void>) {
  useScreenKeys((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { save(); return true; }
    return false;
  });
  useKeyBar([{ key: 'Ctrl+A', label: 'Accept', run: save }], [save]);
}

// ---------------- Company settings (F3) ----------------
export function CompanySettings() {
  const nav = useNav();
  const [c, setC] = useState<any>({ ...nav.company, ewb_rupees: rupeesText(nav.company.ewb_threshold) });
  useTitle('Company Alteration');
  const set = (k: string) => (v: any) => setC((x: any) => ({ ...x, [k]: v }));
  const save = useCallback(async () => {
    try {
      const { fy, ewb_rupees, ...rest } = c;
      await api.put('/api/company', {
        ...rest,
        ewb_threshold: toPaise(Number(ewb_rupees) || 0),
        msme_interest_rate: Number(c.msme_interest_rate) || 0,
        expiry_alert_days: Number(c.expiry_alert_days) || 0,
      });
      await nav.refreshCompany();
      nav.toast('Company details saved');
      nav.pop();
    } catch (e: any) { nav.toast(e.message, true); }
  }, [c, nav]);
  useSave(save);
  const pickFolder = async () => { const d = await desktop?.chooseFolder(); if (d) set('backup_dir')(d); };
  return (
    <div className="form" data-form>
      <h2>Company details</h2>
      <div className="grid">
        <Row label="Name" wide><Text name="Company name" value={c.name} onChange={set('name')} autoFocus /></Row>
        <Row label="Address" wide><Text name="Address" value={c.address} onChange={set('address')} /></Row>
        <Row label="City"><Text name="City" value={c.city} onChange={set('city')} /></Row>
        <Row label="PIN code"><Text name="PIN code" value={c.pincode} onChange={set('pincode')} /></Row>
        <Row label="Phone"><Text name="Phone" value={c.phone} onChange={set('phone')} /></Row>
        <Row label="E-mail"><Text name="E-mail" value={c.email} onChange={set('email')} /></Row>
        <div className="section-title">GST and MSME</div>
        <Row label="GSTIN"><Text name="GSTIN" value={c.gstin} onChange={set('gstin')} upper /></Row>
        <Row label="State">
          <Select name="State" value={c.state_code} onChange={set('state_code')} options={Object.entries(nav.meta.states as Record<string, string>).map(([code, n]) => ({ value: code, label: `${code} ${n}` }))} />
        </Row>
        <Row label="Udyam number"><Text name="Udyam number" value={c.udyam_no} onChange={set('udyam_no')} upper /></Row>
        <Row label="MSME interest % a year"><Text name="MSME interest" num value={c.msme_interest_rate} onChange={set('msme_interest_rate')} /></Row>
        <Row label="e-Way Bill above ₹"><Text name="e-Way Bill limit" num value={c.ewb_rupees} onChange={set('ewb_rupees')} /></Row>
        <Row label="Expiry alert (days)"><Text name="Expiry alert days" num value={c.expiry_alert_days} onChange={set('expiry_alert_days')} /></Row>
        <div className="section-title">On the bill</div>
        <Row label="UPI ID (for QR)"><Text name="UPI ID" value={c.upi_id} onChange={set('upi_id')} placeholder="name@bank" /></Row>
        <Row label="Bank details"><Text name="Bank details" value={c.bank_details} onChange={set('bank_details')} /></Row>
        <Row label="Terms" wide><Text name="Terms" value={c.invoice_terms} onChange={set('invoice_terms')} /></Row>
        <div className="section-title">Books and backup</div>
        <Row label="Books begin from"><Text name="Books from" value={c.books_from} onChange={set('books_from')} placeholder="YYYY-MM-DD" /></Row>
        <Row label="Backup folder">
          <div style={{ display: 'flex', gap: 6 }}>
            <Text name="Backup folder" value={c.backup_dir} onChange={set('backup_dir')} placeholder="e.g. D:\Stockwell Backup" />
            {desktop && <button className="btn small" onClick={pickFolder}>Choose…</button>}
          </div>
        </Row>
      </div>
      <p className="hint">
        The interest rate is three times the RBI bank rate under the MSMED Act; Stockwell uses it to show interest on late MSME bills.
        Odisha needs an e-Way Bill above ₹50,000 for movement inside the state, so keep that limit unless the rule changes.
      </p>
      <div className="actions">
        <button className="btn" onClick={() => nav.push({ name: 'users' })}>Users and passwords</button>
        <button className="btn primary go" onClick={save}>Accept (Ctrl+A)</button>
      </div>
    </div>
  );
}

// ---------------- Users and passwords ----------------
export function UsersScreen({ active }: { active: boolean }) {
  const nav = useNav();
  const [users, setUsers] = useState<any[]>([]);
  const [n, setN] = useState({ name: '', role: 'operator', password: '' });
  useTitle('Users and Passwords');
  const load = useCallback(() => api.get('/api/users').then(setUsers).catch((e) => nav.toast(e.message, true)), []);
  useEffect(() => { if (active) load(); }, [active, load]);
  const first = users.length === 0;
  const create = useCallback(async () => {
    try {
      await api.post('/api/users', { ...n, role: first ? 'owner' : n.role });
      nav.toast(first ? `${n.name} is the Owner. Log in with this name from now on.` : `User ${n.name} added`);
      setN({ name: '', role: 'operator', password: '' });
      if (first) { setToken(null); location.reload(); } else load();
    } catch (e: any) { nav.toast(e.message, true); }
  }, [n, first, load]);
  useSave(create);
  const update = async (id: number, patch: any) => {
    try { await api.put(`/api/users/${id}`, patch); load(); nav.toast('Saved'); } catch (e: any) { nav.toast(e.message, true); }
  };
  const resetPassword = async (u: any) => {
    const p = await promptBox(`New password for ${u.name}`, { secret: true });
    if (p) update(u.id, { password: p });
  };
  return (
    <div className="report">
      {first && (
        <div className="panel" style={{ padding: 14, marginBottom: 14 }}>
          <b>Logins are off.</b> <span className="subtle">Anyone who opens Stockwell can do everything. Make the Owner's login first; after that, Stockwell asks for a name and password when it opens.</span>
        </div>
      )}
      {!first && (
        <table className="r" style={{ marginBottom: 16 }}>
          <thead><tr><th>Name</th><th>Role</th><th>Status</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.role === 'owner' ? 'Owner' : 'Billing operator'}</td>
                <td>{u.active ? <span className="tag good">Active</span> : <span className="tag bad">Disabled</span>}</td>
                <td className="num">
                  <button className="btn small" onClick={() => resetPassword(u)}>Change password</button>{' '}
                  <button className="btn small" onClick={() => update(u.id, { active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form" data-form style={{ margin: 0, maxWidth: 560 }}>
        <h2>{first ? 'Create the Owner login' : 'Add a user'}</h2>
        <Row label="Name"><Text name="User name" value={n.name} onChange={(v) => setN({ ...n, name: v })} autoFocus /></Row>
        {!first && (
          <Row label="Role">
            <Select name="Role" value={n.role} onChange={(v) => setN({ ...n, role: v })}
              options={[{ value: 'operator', label: 'Billing operator' }, { value: 'owner', label: 'Owner' }]} />
          </Row>
        )}
        <Row label="Password"><PasswordField value={n.password} onChange={(v) => setN({ ...n, password: v })} /></Row>
        <ul className="steps">
          <li><b>Owner</b> can do everything: alter or cancel any voucher, see profit, balance sheet and the edit log, change settings.</li>
          <li><b>Billing operator</b> can make bills, receipts and payments, and create parties and items, but cannot delete, cancel, change entries from earlier days, or see profit reports.</li>
        </ul>
        <div className="actions"><button className="btn primary go" onClick={create}>Accept (Ctrl+A)</button></div>
      </div>
    </div>
  );
}

function PasswordField({ value, onChange, name = 'Password' }: { value: string; onChange: (v: string) => void; name?: string }) {
  return (
    <input className="f" type="password" name={name} aria-label={name} value={value} autoComplete="off" onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget.closest('[data-form]')?.querySelector('button.go') as HTMLElement)?.focus(); } }} />
  );
}

// ---------------- Login ----------------
export function LoginScreen({ onLogin }: { onLogin: (user: any) => void }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    try {
      const r = await api.post('/api/login', { name, password });
      setToken(r.token);
      onLogin(r.user);
    } catch (e: any) { setErr(e.message); setPassword(''); }
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="brand-big"><img src="./logo.svg" alt="" />Stockwell</div>
        <label>Name of user<input className="f" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Name of user" autoComplete="username" /></label>
        <label>Password<input className="f" type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" autoComplete="current-password" /></label>
        <div className="err" role="alert">{err}</div>
        <button className="btn primary" type="submit">Log in</button>
        <p className="hint">Forgot your password? Ask the Owner to set a new one in Company settings → Users and passwords.</p>
      </form>
    </div>
  );
}

// ---------------- GST ----------------
const monthOf = (d: string) => d.slice(0, 7);
const monthLabel = (p: string) => new Date(`${p}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const shiftMonth = (p: string, by: number) => {
  const d = new Date(`${p}-01T00:00:00`);
  d.setMonth(d.getMonth() + by);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export function GstScreen({ active }: { active: boolean }) {
  const nav = useNav();
  // Returns are usually filed for the month that just ended.
  const [period, setPeriod] = useState(shiftMonth(monthOf(nav.workDate), -1));
  const [tab, setTab] = useState<'gstr1' | 'gstr3b' | 'ewb'>('gstr1');
  const [g1, setG1] = useState<any>(null);
  const [g3, setG3] = useState<any>(null);
  const [ewb, setEwb] = useState<any[]>([]);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  useTitle(`GST Returns · ${monthLabel(period)}`);

  const load = useCallback(async () => {
    const from = `${period}-01`;
    const to = `${shiftMonth(period, 1)}-01`;
    const [a, b, c] = await Promise.all([
      api.get(`/api/gst/gstr1?period=${period}`),
      api.get(`/api/gst/gstr3b?period=${period}`),
      api.get(`/api/gst/eway-candidates?from=${from}&to=${to}&all=1`),
    ]);
    setG1(a); setG3(b);
    const pending = c.filter((v: any) => v.date < to);
    setEwb(pending);
    setChosen(new Set(pending.filter((v: any) => !v.ewb_no).map((v: any) => v.id)));
  }, [period]);
  useEffect(() => { if (active) load().catch((e) => nav.toast(e.message, true)); }, [active, load]);

  const saveGstr1 = async () => {
    if (g1.missingGstin) { nav.toast('Add the company GSTIN first (F3).', true); return; }
    const where = await saveTextFile(`GSTR1_${nav.company.gstin}_${period.replace('-', '')}.json`, JSON.stringify(g1.json, null, 1));
    if (where) nav.toast(`GSTR-1 file saved: ${where}`);
  };
  const saveEwb = async () => {
    if (!chosen.size) { nav.toast('Tick at least one bill.', true); return; }
    try {
      const json = await api.post('/api/gst/eway-json', { ids: [...chosen] });
      const where = await saveTextFile(`EWB_${period.replace('-', '')}_${chosen.size}bills.json`, JSON.stringify(json, null, 1));
      if (where) nav.toast(`e-Way Bill file saved: ${where}`);
    } catch (e: any) { nav.toast(e.message, true); }
  };
  const setEwbNo = async (id: number, ewbNo: string) => {
    try { await api.put(`/api/vouchers/${id}/ewb`, { ewbNo }); load(); } catch (e: any) { nav.toast(e.message, true); }
  };

  useKeyBar([
    { key: 'F2', label: 'Earlier month', run: () => setPeriod((p) => shiftMonth(p, -1)) },
    { key: 'Shift+F2', label: 'Next month', run: () => setPeriod((p) => shiftMonth(p, 1)) },
    { key: '1', label: 'GSTR-1', run: () => setTab('gstr1') },
    { key: '3', label: 'GSTR-3B', run: () => setTab('gstr3b') },
    { key: 'E', label: 'e-Way Bills', run: () => setTab('ewb') },
    { key: 'Ctrl+E', label: 'Export file', run: () => (tab === 'ewb' ? saveEwb() : saveGstr1()) },
  ], [tab, g1, chosen, period]);
  useScreenKeys((e) => {
    if (e.target instanceof HTMLInputElement) return false;
    if (e.key === 'F2' && !e.shiftKey) { setPeriod((p) => shiftMonth(p, -1)); return true; }
    if (e.key === 'F2' && e.shiftKey) { setPeriod((p) => shiftMonth(p, 1)); return true; }
    if (e.key === '1') { setTab('gstr1'); return true; }
    if (e.key === '3') { setTab('gstr3b'); return true; }
    if (e.key.toLowerCase() === 'e' && !e.ctrlKey) { setTab('ewb'); return true; }
    if (e.ctrlKey && e.key.toLowerCase() === 'e') { tab === 'ewb' ? saveEwb() : saveGstr1(); return true; }
    return false;
  });

  const rs = (p: number) => formatINR(p);
  return (
    <div className="report">
      <div className="toolbar">
        <button className="btn small" onClick={() => setPeriod(shiftMonth(period, -1))}>‹</button>
        <b style={{ minWidth: 130, textAlign: 'center' }}>{monthLabel(period)}</b>
        <button className="btn small" onClick={() => setPeriod(shiftMonth(period, 1))}>›</button>
        <div className="tabs" role="tablist">
          {([['gstr1', 'GSTR-1 (sales)'], ['gstr3b', 'GSTR-3B (tax to pay)'], ['ewb', `e-Way Bills${ewb.filter((v) => !v.ewb_no).length ? ` · ${ewb.filter((v) => !v.ewb_no).length} due` : ''}`]] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
      </div>

      {tab === 'gstr1' && g1 && (
        <>
          <div className="cards">
            <div className="card"><div className="subtle">Sales bills</div><div className="v">{g1.summary.invoices}</div></div>
            <div className="card"><div className="subtle">To GST-registered shops (B2B)</div><div className="v">{g1.summary.b2b}</div></div>
            <div className="card"><div className="subtle">Credit notes</div><div className="v">{g1.summary.creditNotes}</div></div>
            <div className="card"><div className="subtle">Taxable value</div><div className="v">₹{rs(g1.summary.taxable)}</div></div>
          </div>
          {g1.missingGstin && <p className="tag bad">The company GSTIN is missing. Press F3 to add it before making the file.</p>}
          {g1.problems?.length > 0 && (
            <div className="panel" style={{ padding: 12, marginTop: 10 }} role="alert">
              <b>Fix these before uploading:</b>
              <ul className="steps">{g1.problems.slice(0, 20).map((p: string) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn primary" onClick={saveGstr1}>Save GSTR-1 file (Ctrl+E)</button>
          </div>
          <div className="panel" style={{ marginTop: 14, padding: '4px 14px 12px' }}>
            <h3 style={{ padding: '10px 0' }}>How to file it (free, about 5 minutes)</h3>
            <ol className="steps">
              <li>Open the GST portal and log in. <button className="btn small" onClick={() => openExternal('https://services.gst.gov.in/services/login')}>Open GST portal</button></li>
              <li>Go to Returns Dashboard, choose {monthLabel(period)}, then GSTR-1 → Prepare Offline.</li>
              <li>Under Upload, choose the file you just saved and wait for "Processed".</li>
              <li>Go back to GSTR-1 → Prepare Online, check the totals match the cards above, then Generate Summary and File with EVC or DSC.</li>
            </ol>
          </div>
        </>
      )}

      {tab === 'gstr3b' && g3 && (
        <>
          <table className="r">
            <thead><tr><th>Section</th><th className="num">Taxable value</th><th className="num">IGST</th><th className="num">CGST</th><th className="num">SGST</th></tr></thead>
            <tbody>
              <tr><td>3.1(a) Outward taxable supplies</td><td className="num">{rs(g3.outward.taxable)}</td><td className="num">{rs(g3.outward.igst)}</td><td className="num">{rs(g3.outward.cgst)}</td><td className="num">{rs(g3.outward.sgst)}</td></tr>
              <tr><td>3.1(c) Nil-rated and exempt supplies</td><td className="num">{rs(g3.nilExempt.taxable)}</td><td /><td /><td /></tr>
              {g3.nonGst.taxable !== 0 && <tr><td>3.1(e) Non-GST supplies</td><td className="num">{rs(g3.nonGst.taxable)}</td><td /><td /><td /></tr>}
              <tr><td>4(A)(5) Input tax credit (from registered suppliers, per books)</td><td className="num">{rs(g3.itc.taxable)}</td><td className="num">{rs(g3.itc.igst)}</td><td className="num">{rs(g3.itc.cgst)}</td><td className="num">{rs(g3.itc.sgst)}</td></tr>
              <tr><td>5. Exempt and nil-rated purchases (inter-state / intra-state)</td><td className="num">{rs(g3.inwardExempt.inter)} / {rs(g3.inwardExempt.intra)}</td><td /><td /><td /></tr>
              <tr className="total"><td>Cash to pay after using credit (Rule 88A order)</td><td /><td className="num">{rs(g3.payable.igst)}</td><td className="num">{rs(g3.payable.cgst)}</td><td className="num">{rs(g3.payable.sgst)}</td></tr>
              <tr><td>Credit carried forward</td><td /><td className="num">{rs(g3.carryForward.igst)}</td><td className="num">{rs(g3.carryForward.cgst)}</td><td className="num">{rs(g3.carryForward.sgst)}</td></tr>
            </tbody>
          </table>
          {g3.interStateB2C.length > 0 && (
            <table className="r" style={{ marginTop: 12 }}>
              <thead><tr><th>3.2 Inter-state supplies to unregistered persons · place of supply</th><th className="num">Taxable value</th><th className="num">IGST</th></tr></thead>
              <tbody>{g3.interStateB2C.map((x: any) => <tr key={x.pos}><td>{x.pos} {nav.meta.states[x.pos] ?? ''}</td><td className="num">{rs(x.taxable)}</td><td className="num">{rs(x.igst)}</td></tr>)}</tbody>
            </table>
          )}
          <p className="hint" style={{ marginTop: 10 }}>
            Type these figures into GSTR-3B on the portal. Before filing, match the input credit with GSTR-2B (and accept or reject invoices in IMS): only credit shown there can be claimed,
            so use the portal's figure if it is lower. Set-off follows the legal order: IGST credit first, then CGST and SGST credit.
          </p>
        </>
      )}

      {tab === 'ewb' && (
        <>
          <p className="hint" style={{ marginTop: 0 }}>Sales bills above ₹{formatINR(nav.company.ewb_threshold)} this month. Tick the ones going out, save the file, and upload it on the e-Way Bill portal under e-Waybill → Generate Bulk.</p>
          <table className="r">
            <thead><tr><th /><th>Date</th><th>Bill no.</th><th>Party</th><th>Vehicle</th><th className="num">Value</th><th>EWB no.</th></tr></thead>
            <tbody>
              {ewb.map((v) => (
                <tr key={v.id}>
                  <td><input type="checkbox" aria-label={`Include ${v.number}`} checked={chosen.has(v.id)} onChange={(e) => { const s = new Set(chosen); e.target.checked ? s.add(v.id) : s.delete(v.id); setChosen(s); }} /></td>
                  <td>{shortDate(v.date)}</td><td>{v.number}</td><td>{v.party_name}</td>
                  <td>{v.vehicle_no || <span className="tag warn">add in bill</span>}</td>
                  <td className="num">{formatINR(v.total)}</td>
                  <td><EwbInput value={v.ewb_no} onSave={(no) => setEwbNo(v.id, no)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!ewb.length && <div className="empty-state">No sales bill this month needs an e-Way Bill.</div>}
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn primary" onClick={saveEwb} disabled={!chosen.size}>Save e-Way Bill file ({chosen.size})</button>
            <button className="btn" onClick={() => openExternal('https://ewaybillgst.gov.in/')}>Open e-Way Bill portal</button>
          </div>
        </>
      )}
    </div>
  );
}

function EwbInput({ value, onSave }: { value: string | null; onSave: (v: string) => void }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  return (
    <input className="f" style={{ width: 130 }} aria-label="EWB number" placeholder="12 digits" value={v}
      onChange={(e) => setV(e.target.value.replace(/\D/g, '').slice(0, 12))}
      onBlur={() => v !== (value ?? '') && onSave(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
  );
}

// ---------------- Import from Tally ----------------
export function ImportTally() {
  const nav = useNav();
  const [url, setUrl] = useState('http://localhost:9000');
  const [xml, setXml] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  useTitle('Import from Tally');
  const run = async (fromText: boolean) => {
    setBusy(true);
    try {
      const r = await api.post('/api/import/tally', fromText ? { xml } : { url });
      setResult(r);
      nav.toast('Import finished');
    } catch (e: any) { nav.toast(e.message, true); } finally { setBusy(false); }
  };
  const pickFile = (f: File | undefined) => f && f.text().then(setXml);
  return (
    <div className="form" data-form style={{ maxWidth: 760 }}>
      <h2>Bring masters across from TallyPrime</h2>
      <p className="hint" style={{ marginTop: 0 }}>Copies groups, ledgers (with GSTIN, address, opening balance), units, stock groups and stock items. Names that already exist in Stockwell are skipped, so running it twice is safe.</p>
      <div className="section-title" style={{ marginTop: 6 }}>Way 1: straight from Tally (Tally open on this PC)</div>
      <ol className="steps">
        <li>In TallyPrime press F1 (Help) → Settings → Connectivity, set "TallyPrime acts as" to Both and Port to 9000.</li>
        <li>Open the company in Tally and keep it open.</li>
      </ol>
      <Row label="Tally address"><Text name="Tally address" value={url} onChange={setUrl} /></Row>
      <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="btn primary" disabled={busy} onClick={() => run(false)}>{busy ? 'Importing…' : 'Import from Tally'}</button></div>
      <div className="section-title" style={{ marginTop: 14 }}>Way 2: from an exported file</div>
      <ol className="steps">
        <li>In Tally: Alt+E (Export) → Masters → Format XML (Data Interchange) → Export.</li>
        <li>Choose that Master.xml file here.</li>
      </ol>
      <input type="file" accept=".xml,text/xml" aria-label="Tally XML file" onChange={(e) => pickFile(e.target.files?.[0])} />
      {xml && <span className="subtle"> {Math.round(xml.length / 1024)} KB loaded</span>}
      <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="btn" disabled={busy || !xml} onClick={() => run(true)}>Import this file</button></div>
      {result && (
        <div className="panel" style={{ marginTop: 14, padding: 12 }}>
          <b>Added:</b> {result.groups} groups, {result.ledgers} ledgers, {result.units} units, {result.stockGroups} stock groups, {result.items} items.
          {result.skipped.length > 0 && <div className="subtle" style={{ marginTop: 6 }}>Skipped {result.skipped.length}: {result.skipped.slice(0, 12).join(', ')}{result.skipped.length > 12 ? '…' : ''}</div>}
          <div className="subtle" style={{ marginTop: 6 }}>Next: check the Trial Balance (opening balances should match Tally's), then start billing.</div>
        </div>
      )}
    </div>
  );
}

// ---------------- Backup ----------------
export function BackupScreen() {
  const nav = useNav();
  const [dataDir, setDataDir] = useState<string>('');
  useEffect(() => { desktop?.connection().then((c) => setDataDir(c.dataDir ?? '')); }, []);
  const [last, setLast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useTitle('Backup');
  const run = useCallback(async () => {
    setBusy(true);
    try { const r = await api.post('/api/backup', {}); setLast(r.file); nav.toast('Backup done'); } catch (e: any) { nav.toast(e.message, true); } finally { setBusy(false); }
  }, []);
  const restore = useCallback(async () => {
    try { await desktop!.restore!(getToken()); } catch (e: any) { nav.toast(e.message?.replace(/^Error invoking remote method '\w+': (Error: )?/, '') ?? String(e), true); }
  }, []);
  useKeyBar([{ key: 'Ctrl+A', label: 'Back up now', run }], [run]);
  useScreenKeys((e) => { if (e.ctrlKey && e.key.toLowerCase() === 'a') { run(); return true; } return false; });
  const dir = nav.company.backup_dir || nav.company.default_backup_dir;
  return (
    <div className="form" style={{ maxWidth: 640 }}>
      <h2>Backup</h2>
      <Row label="Backup folder">{dir ? <b>{dir}</b> : <span className="tag warn">Not chosen. Set it in Company settings (F3).</span>}</Row>
      <Row label="Last backup">{nav.company.last_backup ? <b>{new Date(nav.company.last_backup).toLocaleString('en-IN')}</b> : <span className="tag warn">Never</span>}</Row>
      <p className="hint">Stockwell backs up by itself once a day on the main PC and when it closes. Each copy is checked after it is made. It keeps the last 30 copies plus one per month for two years.
        {!nav.company.backup_dir && ' The copies are on this same hard disk now; choose a pen drive or a Google Drive folder in Company settings so a dead disk does not take the books with it.'}</p>
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary go" disabled={busy || !dir} onClick={run} autoFocus>{busy ? 'Backing up…' : 'Back up now (Ctrl+A)'}</button>
        {!dir && <button className="btn" onClick={() => nav.push({ name: 'company' })}>Open Company settings</button>}
      </div>
      {last && <p className="hint">Saved as <b>{last}</b></p>}
      <div className="section-title" style={{ gridColumn: 'auto', marginTop: 16 }}>To restore</div>
      {desktop?.restore ? (
        <>
          <p className="hint">Close Stockwell on the second PC first. Restoring replaces today's books with the backup. The current books are kept as a safety copy in the data folder{dataDir ? <> (<b>{dataDir}</b>)</> : ''}, so nothing is lost.</p>
          <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="btn danger" onClick={restore}>Restore from a backup…</button></div>
        </>
      ) : (
        <p className="hint">Restoring is done on the main PC: open this screen there.</p>
      )}
    </div>
  );
}

