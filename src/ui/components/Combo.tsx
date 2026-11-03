import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { focusNext } from '../format';

export interface ComboOption {
  id: number | string;
  label: string;
  meta?: string;
}

interface Props {
  value: number | string | null | undefined;
  options: ComboOption[];
  onChange: (id: any, opt: ComboOption | null) => void;
  title: string;
  placeholder?: string;
  /** Shown as "+ Create" in the list (Alt+C) and called with what was typed. */
  onCreate?: (typed: string) => void;
  autoFocus?: boolean;
  name?: string;
  onEnterDone?: () => void;
  /** Enter on an empty field (e.g. to finish the item list). */
  onEmptyEnter?: () => void;
  disabled?: boolean;
  /** Ctrl+Enter: alter the chosen master (Tally's "alter master on the fly"). */
  onAlter?: (id: any) => void;
}

/**
 * A type-ahead field with a pop-up list, like picking a ledger or item in Tally.
 * Typing filters, arrows move, Enter picks, Alt+C creates a new master.
 */
export const Combo = forwardRef<HTMLInputElement, Props>(function Combo(
  { value, options, onChange, title, placeholder, onCreate, autoFocus, name, onEnterDone, onEmptyEnter, disabled, onAlter },
  ref,
) {
  const current = options.find((o) => String(o.id) === String(value ?? ''));
  const [text, setText] = useState(current?.label ?? '');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setRefs = (el: HTMLInputElement | null) => {
    inputRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  useEffect(() => { if (!open) setText(current?.label ?? ''); }, [current?.label, open]);

  const filtered = useMemo(() => {
    const t = text.trim().toLowerCase();
    if (!open || !t || t === current?.label.toLowerCase()) return options;
    const starts = options.filter((o) => o.label.toLowerCase().startsWith(t));
    const has = options.filter((o) => !o.label.toLowerCase().startsWith(t) && o.label.toLowerCase().includes(t));
    return [...starts, ...has];
  }, [text, options, open, current?.label]);

  useEffect(() => {
    const el = listRef.current?.querySelector('.opt.sel');
    (el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [sel, open]);

  const pick = (o: ComboOption | undefined) => {
    if (!o) return;
    onChange(o.id, o);
    setText(o.label);
    setOpen(false);
    if (onEnterDone) onEnterDone();
    else setTimeout(() => focusNext(inputRef.current), 0);
  };

  return (
    <div className="combo">
      <input
        ref={setRefs}
        name={name}
        aria-label={name ?? title}
        disabled={disabled}
        className="f"
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        onFocus={(e) => { setOpen(true); e.currentTarget.select(); const i = options.findIndex((o) => o.id === current?.id); setSel(i >= 0 ? i : 0); }}
        onBlur={() => {
          // Typed a whole name (or narrowed the list to one) and left with Tab: take it, as Enter would.
          const t = text.trim().toLowerCase();
          if (open && t && t !== (current?.label.toLowerCase() ?? '')) {
            const exact = options.find((o) => o.label.toLowerCase() === t) ?? (filtered.length === 1 ? filtered[0] : undefined);
            if (exact) onChange(exact.id, exact);
          }
          setTimeout(() => setOpen(false), 120);
        }}
        onChange={(e) => { setText(e.target.value); setOpen(true); setSel(0); }}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === 'Enter' && onAlter) {
            e.preventDefault(); e.stopPropagation();
            const target = open && filtered[sel] ? filtered[sel] : current;
            if (target) { setOpen(false); onAlter(target.id); }
            return;
          }
          if (e.altKey && (e.key === 'c' || e.key === 'C') && onCreate) { e.preventDefault(); e.stopPropagation(); setOpen(false); onCreate(text === current?.label ? '' : text); return; }
          if (!open) {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!text.trim() && onEmptyEnter) onEmptyEnter(); else focusNext(inputRef.current); }
            return;
          }
          if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setSel((s) => Math.max(s - 1, 0)); }
          else if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation();
            if (!text.trim() && onEmptyEnter) { setOpen(false); onEmptyEnter(); return; }
            if (filtered.length) pick(filtered[sel]);
            else if (onCreate && text.trim()) { setOpen(false); onCreate(text.trim()); }
          } else if (e.key === 'Escape' && text !== (current?.label ?? '')) {
            e.stopPropagation(); setText(current?.label ?? '');
          }
        }}
      />
      {open && (
        <div className="picker" ref={listRef} role="listbox" aria-label={title}>
          <div className="ph"><span>{title}</span><span>{onCreate ? 'Alt+C Create' : ''}{onCreate && onAlter ? ' · ' : ''}{onAlter ? 'Ctrl+Enter Alter' : ''}</span></div>
          {filtered.slice(0, 300).map((o, i) => (
            <div key={o.id} role="option" aria-selected={i === sel} className={`opt ${i === sel ? 'sel' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
              <span>{o.label}</span>{o.meta && <span className="meta">{o.meta}</span>}
            </div>
          ))}
          {!filtered.length && (
            <div className="opt create" onMouseDown={(e) => { e.preventDefault(); if (onCreate) onCreate(text.trim()); }}>
              {onCreate ? `+ Create "${text.trim()}" (Enter)` : 'Nothing matches'}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
