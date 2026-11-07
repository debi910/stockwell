import type { ReactNode } from 'react';
import { focusNext } from '../format';

/** One "label : value" line of a master form. Enter moves to the next field. */
export function Row({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`row ${wide ? 'wide' : ''}`}>
      <label>{label}</label>
      <div>{children}</div>
    </div>
  );
}

export function Text({ value, onChange, name, autoFocus, placeholder, num, upper, onBlur }: {
  value: string | number | null | undefined; onChange: (v: string) => void; name?: string; autoFocus?: boolean; placeholder?: string; num?: boolean; upper?: boolean;
  onBlur?: () => void;
}) {
  return (
    <input
      className={`f ${num ? 'num' : ''}`}
      name={name}
      aria-label={name}
      value={value ?? ''}
      autoFocus={autoFocus}
      placeholder={placeholder}
      autoComplete="off"
      onChange={(e) => onChange(upper ? e.target.value.toUpperCase() : e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={onBlur}
      onKeyDown={enterNext}
    />
  );
}

export function Select({ value, onChange, options, name, disabled }: {
  value: string | number; onChange: (v: string) => void; options: { value: string | number; label: string }[]; name?: string; disabled?: boolean;
}) {
  return (
    <select className="f" name={name} aria-label={name} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} onKeyDown={enterNext}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function YesNo({ value, onChange, name }: { value: boolean; onChange: (v: boolean) => void; name?: string }) {
  return (
    <select className="f" name={name} aria-label={name} value={value ? 'Yes' : 'No'} onChange={(e) => onChange(e.target.value === 'Yes')}
      onKeyDown={(e) => {
        if (e.key.toLowerCase() === 'y') { e.preventDefault(); onChange(true); }
        else if (e.key.toLowerCase() === 'n') { e.preventDefault(); onChange(false); }
        else enterNext(e);
      }}>
      <option>No</option><option>Yes</option>
    </select>
  );
}

export function enterNext(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
    if (e.currentTarget.tagName === 'TEXTAREA' && !e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    focusNext(e.currentTarget);
  }
}
