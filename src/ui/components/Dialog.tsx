import { useEffect, useRef, useState } from 'react';

// In-app Yes/No and text questions, answered from the keyboard like Tally's "Accept? Yes or No".
// (Electron does not support window.prompt, and window.confirm looks foreign.)

type Ask =
  | { kind: 'confirm'; message: string; yes: string; no: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; message: string; value: string; secret?: boolean; resolve: (v: string | null) => void };

let show: (a: Ask) => void = () => {};

export function confirmBox(message: string, opts: { yes?: string; no?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => show({ kind: 'confirm', message, yes: opts.yes ?? 'Yes', no: opts.no ?? 'No', danger: opts.danger, resolve }));
}

export function promptBox(message: string, opts: { value?: string; secret?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => show({ kind: 'prompt', message, value: opts.value ?? '', secret: opts.secret, resolve }));
}

/** Mounted once in App. */
export function DialogHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [text, setText] = useState('');
  const prevFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    show = (a) => {
      prevFocus.current = document.activeElement as HTMLElement | null;
      if (a.kind === 'prompt') setText(a.value);
      setAsk(a);
    };
  }, []);

  const close = (value: boolean | string | null) => {
    if (!ask) return;
    (ask.resolve as (v: unknown) => void)(value);
    setAsk(null);
    setTimeout(() => prevFocus.current?.focus?.(), 0);
  };

  useEffect(() => {
    if (!ask) return;
    // Capture phase, so screen and global keys do not also act while the question is open.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(ask.kind === 'confirm' ? false : null); return; }
      if (ask.kind === 'confirm') {
        const k = e.key.toLowerCase();
        if (k === 'y' || e.key === 'Enter') { e.preventDefault(); close(true); }
        else if (k === 'n') { e.preventDefault(); close(false); }
        else if (e.key !== 'Tab') e.preventDefault();
      } else if (e.key === 'Enter') { e.preventDefault(); close(text); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!ask) return null;
  return (
    <div className="modal-back" role="presentation">
      <div className="modal dialog" role="alertdialog" aria-modal="true" aria-label={ask.message}>
        <p style={{ margin: '0 0 14px', whiteSpace: 'pre-line' }}>{ask.message}</p>
        {ask.kind === 'prompt' && (
          <input className="f boxed" autoFocus type={ask.secret ? 'password' : 'text'} aria-label={ask.message} value={text} onChange={(e) => setText(e.target.value)} />
        )}
        <div className="actions">
          {ask.kind === 'confirm' ? (
            <>
              <button className="btn" onClick={() => close(false)}><u>N</u>o{ask.no !== 'No' ? ` · ${ask.no}` : ''}</button>
              <button className={`btn ${ask.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => close(true)}><u>Y</u>es{ask.yes !== 'Yes' ? ` · ${ask.yes}` : ''}</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => close(null)}>Cancel (Esc)</button>
              <button className="btn primary" onClick={() => close(text)}>OK (Enter)</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
