// Companies (each in its own folder on the main PC), bringing books across from TallyPrime, and exporting them.
import { useEffect, useRef, useState } from 'react';
import { api, desktop } from '../api';
import { Row, Text } from '../components/Field';
import { isOwner, useKeyBar, useNav, useTitle } from '../nav';
import { parseDate, shortDate, todayISO } from '../format';

export interface CompanyRow { id: string; name: string; books_from: string; gstin: string; city: string; folder: string; vouchers: number; last_entry: string | null; error?: string }

const fyStart = (iso: string) => { const [y, m] = iso.split('-').map(Number); return `${m >= 4 ? y : y - 1}-04-01`; };

/** The company list, as TallyPrime shows it: arrows move, Enter opens, Alt+C makes a new one. */
export function CompanyList({ companies, current, onOpen, onCreated, canCreate }: {
  companies: CompanyRow[]; current?: string | null; onOpen: (id: string) => void; onCreated?: (c: CompanyRow) => void; canCreate: boolean;
}) {
  const [sel, setSel] = useState(() => Math.max(0, companies.findIndex((c) => c.id === current)));
  const [making, setMaking] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!making) listRef.current?.focus(); }, [making]);
  const onKey = (e: React.KeyboardEvent) => {
    const own = () => { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown') { own(); setSel((s) => Math.min(companies.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { own(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { own(); const c = companies[sel]; if (c && !c.error) onOpen(c.id); }
    else if (e.altKey && e.key.toLowerCase() === 'c' && canCreate) { own(); setMaking(true); }
  };
  return (
    <div>
      <div className="report" ref={listRef} tabIndex={0} role="listbox" aria-label="Companies" onKeyDown={onKey} style={{ outline: 'none' }}>
        <table className="r">
          <thead><tr><th>Company</th><th>Folder</th><th>Books from</th><th className="num">Vouchers</th><th>Last entry</th></tr></thead>
          <tbody>
            {companies.map((c, i) => (
              <tr key={c.id} role="option" aria-selected={i === sel} className={`click ${i === sel ? 'sel' : ''}`}
                onMouseDown={() => setSel(i)} onDoubleClick={() => !c.error && onOpen(c.id)} onClick={() => setSel(i)}>
                <td><b>{c.name || `Company ${c.id}`}</b>{c.id === current && <span className="tag" style={{ marginLeft: 8 }}>open</span>}
                  {c.error && <div className="subtle" style={{ color: 'var(--bad)' }}>{c.error}</div>}</td>
                <td className="subtle" title={c.folder}>{c.id}</td>
                <td>{c.books_from ? shortDate(c.books_from) : ''}</td>
                <td className="num">{c.vouchers}</td>
                <td>{c.last_entry ? shortDate(c.last_entry) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" onClick={() => companies[sel] && onOpen(companies[sel].id)}>Open (Enter)</button>
        {canCreate && <button className="btn" onClick={() => setMaking(true)}>Create company (Alt+C)</button>}
      </div>
      {making && <NewCompany onDone={(c) => { setMaking(false); if (c) onCreated?.(c); }} />}
    </div>
  );
}

function NewCompany({ onDone }: { onDone: (c: CompanyRow | null) => void }) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState(shortDate(fyStart(todayISO())));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    const d = parseDate(from);
    if (!name.trim()) { setErr('Type the company name.'); return; }
    if (!d) { setErr(`"${from}" is not a date. Type it like 1-4-26.`); return; }
    setBusy(true);
    try { onDone(await api.post<CompanyRow>('/api/companies', { name: name.trim(), books_from: d })); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="panel" style={{ marginTop: 12, padding: 12, maxWidth: 560 }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onDone(null); }
        if (e.key === 'Enter' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); save(); }
      }}>
      <div className="section-title" style={{ marginTop: 0 }}>New company (gets a folder of its own)</div>
      <Row label="Company name"><Text name="Company name" value={name} onChange={setName} autoFocus /></Row>
      <Row label="Books begin from"><Text name="Books begin from" value={from} onChange={setFrom} /></Row>
      {err && <div className="hint" style={{ color: 'var(--bad)' }}>{err}</div>}
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" disabled={busy} onClick={save}>Create (Ctrl+A)</button>
        <button className="btn" onClick={() => onDone(null)}>Cancel (Esc)</button>
      </div>
    </div>
  );
}

/** Before any company is open: shown when this PC has not picked one yet (or its company was removed). */
export function CompanyPicker({ companies, current, onOpen }: { companies: CompanyRow[]; current: string | null; onOpen: (id: string) => void }) {
  return (
    <div className="form" style={{ maxWidth: 900, margin: '40px auto' }}>
      <h2>Select company</h2>
      <p className="hint" style={{ marginTop: 0 }}>Each company keeps its own books in its own folder on the main PC. Pick one with the arrow keys and press Enter.</p>
      <CompanyList companies={companies} current={current} onOpen={onOpen} canCreate={false} />
      <p className="hint">To make a new company or bring one from Tally, open any company as Owner, then use the Gateway (Select Company, or Import from Tally).</p>
    </div>
  );
}

/** Gateway → Select Company: switch to another company, or make a new one. */
export function CompaniesScreen() {
  const nav = useNav();
  const [list, setList] = useState<{ companies: CompanyRow[]; current: string; multi: boolean } | null>(null);
  useTitle('Select Company');
  const load = () => api.get('/api/companies/list').then(setList).catch((e) => nav.toast(e.message, true));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useKeyBar([], []);
  if (!list) return <div className="empty-state">Loading companies…</div>;
  return (
    <div className="form" style={{ maxWidth: 960 }}>
      <h2>Companies on the main PC</h2>
      {!list.multi && <p className="hint">This Stockwell keeps a single company. More companies can be made in the desktop app on the main PC.</p>}
      <CompanyList companies={list.companies} current={list.current} canCreate={list.multi && isOwner(nav)}
        onOpen={(id) => (id === list.current ? nav.pop() : nav.openCompany(id))}
        onCreated={(c) => { nav.toast(`Company "${c.name}" made in folder ${c.id}`); load(); }} />
    </div>
  );
}

// ---------------- Import from Tally ----------------

/** Text of a Tally file: TallyPrime writes UTF-8 or UTF-16 ("Unicode"). */
function decodeTally(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b.length > 3 && b[1] === 0 && b[3] === 0) return new TextDecoder('utf-16le').decode(b);
  return new TextDecoder('utf-8').decode(b);
}

interface FileGroup { folder: string; files: File[]; tallyData: boolean; name: string }

/** A chosen folder: each sub-folder is one company (as Tally keeps them); files straight inside it are one company. */
export function groupTallyFiles(files: File[]): FileGroup[] {
  const groups = new Map<string, File[]>();
  for (const f of files) {
    const parts = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).split('/');
    const key = parts.length > 2 ? parts[parts.length - 2] : parts.length === 2 ? parts[0] : '';
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.entries()].map(([folder, list]) => ({
    folder, name: folder,
    files: list.filter((f) => /\.xml$/i.test(f.name)),
    // TallyPrime's own data files (Company.1800, Tran.1800, *.TSF): only TallyPrime can read them.
    tallyData: list.some((f) => /\.(\d{3,4}|tsf)$/i.test(f.name)),
  })).filter((g) => g.files.length || g.tallyData).sort((a, b) => a.folder.localeCompare(b.folder));
}

type Job = { id: number; state: 'running' | 'done' | 'failed'; step: string; done: number; total: number; error?: string;
  companies: { tally: string; id: string; name: string; masters?: any; vouchers?: any; error?: string }[] };

function ImportSummary({ masters, vouchers }: { masters?: any; vouchers?: any }) {
  return (
    <div className="subtle">
      {masters && <>Masters: {masters.ledgers} ledgers ({masters.bills ?? 0} pending bills), {masters.items} items, {masters.groups} groups, {masters.godowns ?? 0} godowns. </>}
      {vouchers && <>Vouchers: {vouchers.vouchers} brought in{vouchers.already ? `, ${vouchers.already} were already here` : ''}{vouchers.from ? ` (${shortDate(vouchers.from)} to ${shortDate(vouchers.to)})` : ''}.
        {Object.keys(vouchers.byType ?? {}).length > 0 && <> {Object.entries(vouchers.byType).map(([k, n]) => `${k} ${n}`).join(', ')}.</>}</>}
      {[...(masters?.skipped ?? []), ...(vouchers?.skipped ?? [])].length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ color: 'var(--bad)' }}>{[...(masters?.skipped ?? []), ...(vouchers?.skipped ?? [])].length} not brought in. See why</summary>
          <ul>{[...(masters?.skipped ?? []), ...(vouchers?.skipped ?? [])].slice(0, 200).map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

export function ImportTally() {
  const nav = useNav();
  useTitle('Import from Tally');
  const [url, setUrl] = useState('http://localhost:9000');
  const [found, setFound] = useState<{ name: string; booksFrom: string | null }[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [into, setInto] = useState<'new' | 'current'>('new');
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [fileInto, setFileInto] = useState<'new' | 'current'>('new');
  const [fileLog, setFileLog] = useState<{ folder: string; id?: string; name: string; status: string; masters?: any; vouchers?: any; error?: string }[]>([]);
  const [multi, setMulti] = useState(true);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  useEffect(() => { api.get('/api/companies/list').then((l) => setMulti(!!l.multi)).catch(() => {}); }, []);
  useEffect(() => { if (!multi) { setInto('current'); setFileInto('current'); } }, [multi]);

  const findCompanies = async () => {
    setBusy(true);
    try {
      const list = await api.get<{ name: string; booksFrom: string | null }[]>(`/api/tally/companies?url=${encodeURIComponent(url)}`);
      setFound(list);
      setPick(new Set(list.length === 1 ? [list[0].name] : []));
      if (!list.length) nav.toast('TallyPrime has no company open. Open the companies there (Alt+F3 > Select Company) and try again.', true);
    } catch (e: any) { nav.toast(e.message, true); } finally { setBusy(false); }
  };
  const start = async () => {
    try {
      const j = await api.post<Job>('/api/tally/import', { url, companies: [...pick], into });
      setJob(j);
    } catch (e: any) { nav.toast(e.message, true); }
  };
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    const t = setInterval(() => api.get<Job>(`/api/tally/jobs/${job.id}`).then((j) => {
      setJob(j);
      if (j.state !== 'running') { nav.toast(j.state === 'done' ? 'Brought across from Tally' : j.error ?? 'The import stopped', j.state !== 'done'); if (into === 'current') nav.refreshCompany(); }
    }).catch(() => {}), 1000);
    return () => clearInterval(t);
  }, [job?.id, job?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const importFiles = async () => {
    if (groups.some((g) => g.tallyData && !g.files.length)) return;
    setBusy(true);
    const log: typeof fileLog = groups.map((g) => ({ folder: g.folder, name: g.name, status: 'Waiting' }));
    setFileLog([...log]);
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const row = log[i];
      try {
        let target: string | undefined;
        if (fileInto === 'new') {
          row.status = 'Making the company…'; setFileLog([...log]);
          const c = await api.post<CompanyRow>('/api/companies', { name: g.name || `From Tally ${i + 1}` });
          target = c.id; row.id = c.id; row.name = c.name;
        }
        // Masters first, so every voucher finds its ledgers and items.
        const texts = await Promise.all(g.files.map(async (f) => ({ f, xml: decodeTally(await f.arrayBuffer()) })));
        texts.sort((a, b) => Number(/<VOUCHER\b/.test(a.xml)) - Number(/<VOUCHER\b/.test(b.xml)));
        for (const t of texts) {
          row.status = `Reading ${t.f.name}…`; setFileLog([...log]);
          const r = await api.slow('/api/import/tally', { xml: t.xml }, 15, target);
          if (r.ledgers || r.items || r.groups || r.skipped?.length) row.masters = r;
          if (r.vouchers) row.vouchers = row.vouchers ? { ...r.vouchers, vouchers: row.vouchers.vouchers + r.vouchers.vouchers, already: row.vouchers.already + r.vouchers.already, skipped: [...row.vouchers.skipped, ...r.vouchers.skipped] } : r.vouchers;
        }
        row.status = 'Done';
      } catch (e: any) { row.status = 'Stopped'; row.error = e.message; }
      setFileLog([...log]);
    }
    setBusy(false);
    if (fileInto === 'current') nav.refreshCompany();
  };

  const onlyTallyData = groups.length > 0 && groups.every((g) => g.tallyData && !g.files.length);
  const pct = job && job.total ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div className="form" data-form style={{ maxWidth: 900 }}>
      <h2>Bring books across from TallyPrime</h2>
      <p className="hint" style={{ marginTop: 0 }}>Brings everything: groups, ledgers with opening balances and pending bills, stock items with opening stock, batches and godowns, and every voucher (sales, purchases, receipts, payments, journals, notes and stock journals) exactly as in Tally. Each Tally company becomes a Stockwell company in its own folder. Running it again later brings in only new vouchers.</p>

      <div className="section-title">Way 1: straight from TallyPrime (best)</div>
      <ol className="steps">
        <li>Open TallyPrime on this PC (or another office PC). Its data folder (for example D:\Tally data) is where it reads the companies from.</li>
        <li>In TallyPrime press F1 (Help) → Settings → Connectivity: "TallyPrime acts as" = Both, Port = 9000.</li>
        <li>Open the companies you want (Alt+F3 → Select Company; Shift+Enter picks more than one).</li>
      </ol>
      <Row label="Tally address"><Text name="Tally address" value={url} onChange={setUrl} /></Row>
      <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="btn" disabled={busy} onClick={findCompanies}>Find companies open in Tally</button></div>
      {found && found.length > 0 && (
        <div className="panel" style={{ padding: 12 }}>
          {found.map((c) => (
            <label key={c.name} style={{ display: 'block', padding: '2px 0' }}>
              <input type="checkbox" aria-label={`Tally company ${c.name}`} checked={pick.has(c.name)}
                onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(c.name); else n.delete(c.name); return n; })} />
              {' '}<b>{c.name}</b>{c.booksFrom && <span className="subtle"> · books from {shortDate(c.booksFrom)}</span>}
            </label>
          ))}
          <div style={{ marginTop: 8 }}>
            {multi && <label><input type="radio" checked={into === 'new'} onChange={() => setInto('new')} /> Make a new Stockwell company for each</label>}
            <label style={{ marginLeft: multi ? 16 : 0 }}><input type="radio" checked={into === 'current'} disabled={pick.size > 1} onChange={() => setInto('current')} /> Add into this company ({nav.company.name || 'open now'})</label>
          </div>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn primary" disabled={!pick.size || job?.state === 'running'} onClick={start}>Bring across ({pick.size})</button>
          </div>
        </div>
      )}
      {job && (
        <div className="panel" style={{ padding: 12, marginTop: 8 }} aria-label="Import progress">
          <div><b>{job.state === 'running' ? job.step : job.state === 'done' ? 'Finished' : 'Stopped'}</b> {job.state === 'running' && <span className="subtle">({pct}%)</span>}</div>
          <div style={{ height: 6, background: 'var(--line-soft)', borderRadius: 3, margin: '6px 0' }}><div style={{ width: `${pct}%`, height: 6, background: 'var(--navy)', borderRadius: 3, transition: 'width 300ms ease-out' }} /></div>
          {job.error && <div className="hint" style={{ color: 'var(--bad)' }}>{job.error}</div>}
          {job.companies.map((c) => (
            <div key={c.tally} style={{ marginTop: 8 }}>
              <b>{c.name}</b>{c.id && <span className="subtle"> · folder {c.id}</span>}
              {c.error ? <div className="hint" style={{ color: 'var(--bad)' }}>{c.error}</div> : <ImportSummary masters={c.masters} vouchers={c.vouchers} />}
              {job.state !== 'running' && c.id && !c.error && into === 'new' && <button className="btn" style={{ marginTop: 4 }} onClick={() => nav.openCompany(c.id)}>Open this company</button>}
            </div>
          ))}
          {job.state !== 'running' && <div className="subtle" style={{ marginTop: 8 }}>Next: open the company and compare its Trial Balance and Stock Summary with Tally's for the same date.</div>}
        </div>
      )}

      <div className="section-title" style={{ marginTop: 18 }}>Way 2: from XML files exported from Tally</div>
      <ol className="steps">
        <li>In TallyPrime, for each company: Alt+E (Export) → Masters → Format XML → Export, then Alt+E → Transactions → Day Book (period: from the books start to today) → Format XML → Export.</li>
        <li>Keep each company's files in a folder of its own (one folder per company), then choose the folder that holds them.</li>
      </ol>
      <input ref={folderInput} type="file" aria-label="Tally export folder" multiple hidden {...{ webkitdirectory: '', directory: '' } as any}
        onChange={(e) => { setGroups(groupTallyFiles(Array.from(e.target.files ?? []))); setFileLog([]); e.target.value = ''; }} />
      <input ref={filesInput} type="file" aria-label="Tally XML files" multiple hidden accept=".xml,text/xml,.1800,.tsf"
        onChange={(e) => { setGroups(groupTallyFiles(Array.from(e.target.files ?? []))); setFileLog([]); e.target.value = ''; }} />
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn" onClick={() => folderInput.current?.click()}>Choose the folder…</button>
        <button className="btn" onClick={() => filesInput.current?.click()}>Choose files of one company…</button>
      </div>
      {onlyTallyData && (
        <div className="panel" style={{ padding: 12, marginTop: 8, borderColor: 'var(--bad)' }} role="alert">
          <b>This is TallyPrime's own data folder.</b> Its files (Company.1800, TranMgr.1800…) are kept in Tally's private format, and only TallyPrime can read them.
          Use Way 1 above: open TallyPrime with this folder as its data folder, open the companies, and bring them across. Or export XML files from Tally as in Way 2.
        </div>
      )}
      {groups.length > 0 && !onlyTallyData && (
        <div className="panel" style={{ padding: 12, marginTop: 8 }}>
          <table className="r" style={{ width: '100%' }}>
            <thead><tr><th>Folder</th><th>New company name</th><th>Files</th><th>Status</th></tr></thead>
            <tbody>
              {groups.map((g, i) => {
                const log = fileLog[i];
                return (
                  <tr key={g.folder + i}>
                    <td>{g.folder || '(chosen files)'}</td>
                    <td>{fileInto === 'new'
                      ? <input className="f" aria-label={`Company name ${i + 1}`} value={g.name} onChange={(e) => setGroups((gs) => gs.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                      : nav.company.name}</td>
                    <td>{g.files.map((f) => f.name).join(', ') || <span className="subtle">Tally data files only (use Way 1)</span>}</td>
                    <td>{log ? <>{log.status}{log.error && <div className="hint" style={{ color: 'var(--bad)' }}>{log.error}</div>}<ImportSummary masters={log.masters} vouchers={log.vouchers} />
                      {log.status === 'Done' && log.id && <button className="btn" onClick={() => nav.openCompany(log.id!)}>Open</button>}</> : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 8 }}>
            {multi && <label><input type="radio" checked={fileInto === 'new'} onChange={() => setFileInto('new')} /> A new Stockwell company for each folder</label>}
            <label style={{ marginLeft: multi ? 16 : 0 }}><input type="radio" checked={fileInto === 'current'} disabled={groups.length > 1} onChange={() => setFileInto('current')} /> Into this company ({nav.company.name || 'open now'})</label>
          </div>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn primary" disabled={busy || groups.every((g) => !g.files.length)} onClick={importFiles}>{busy ? 'Importing…' : 'Import these files'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Export ----------------
export function ExportCompanies() {
  const nav = useNav();
  useTitle('Export to Tally XML');
  const [all, setAll] = useState(false);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ dir: string; companies: { id: string; name: string; folder: string; vouchers: number }[] } | null>(null);
  const [main, setMain] = useState(false);
  useEffect(() => { desktop?.connection().then((c) => setMain(c.mode === 'main')).catch(() => {}); }, []);
  const run = async () => {
    setBusy(true);
    try { const r = await api.slow<typeof done>('/api/export/companies', { all, dir: dir || undefined }, 10); setDone(r); nav.toast('Export finished'); } catch (e: any) { nav.toast(e.message, true); } finally { setBusy(false); }
  };
  // Ctrl+A always exports what is chosen on screen now, even when pressed straight after a click.
  const runRef = useRef(run);
  runRef.current = run;
  useKeyBar([{ key: 'Ctrl+A', label: 'Export', run: () => runRef.current() }], []);
  return (
    <div className="form" data-form style={{ maxWidth: 820 }}>
      <h2>Export to Tally XML</h2>
      <p className="hint" style={{ marginTop: 0 }}>Each company goes into a folder of its own, named after the company, with two files: Masters.xml (ledgers, items and opening balances) and DayBook.xml (every voucher). TallyPrime can take these files in (Alt+O Import → Masters, then Transactions), and Stockwell's own Import from Tally reads them too.</p>
      <div>
        <label><input type="radio" checked={!all} onChange={() => setAll(false)} /> This company ({nav.company.name})</label>
        <label style={{ marginLeft: 16 }}><input type="radio" checked={all} onChange={() => setAll(true)} /> All companies</label>
      </div>
      <Row label="Folder">
        <span>{dir || (main ? 'Documents\\Stockwell\\Exports (on this PC)' : "Documents\\Stockwell\\Exports on the main PC")}</span>
        {main && desktop && <button className="btn" style={{ marginLeft: 8 }} onClick={async () => { const d = await desktop!.chooseFolder(); if (d) setDir(d); }}>Browse…</button>}
      </Row>
      <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="btn primary" disabled={busy} onClick={run}>{busy ? 'Exporting…' : 'Export (Ctrl+A)'}</button></div>
      {done && (
        <div className="panel" style={{ padding: 12 }}>
          {done.companies.map((c) => <div key={c.id}><b>{c.name || c.id}</b>: {c.vouchers} vouchers → <span className="subtle">{c.folder}</span></div>)}
        </div>
      )}
    </div>
  );
}
