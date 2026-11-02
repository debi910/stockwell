import { useState } from 'react';
import { useScreenKeys } from '../nav';

export type MenuEntry =
  | { label: string; hot?: string; run: () => void }
  | { section: string }
  | { gap: true };

const isItem = (e: MenuEntry): e is { label: string; hot?: string; run: () => void } => 'label' in e;

/** Keyboard menu: arrows move, Enter opens, the highlighted letter jumps straight to an item. */
export function Menu({ title, entries }: { title: string; entries: MenuEntry[] }) {
  const items = entries.filter(isItem);
  const [sel, setSel] = useState(0);
  useScreenKeys((e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.key === 'ArrowDown') { setSel((s) => (s + 1) % items.length); return true; }
    if (e.key === 'ArrowUp') { setSel((s) => (s - 1 + items.length) % items.length); return true; }
    if (e.key === 'Enter') { items[sel]?.run(); return true; }
    if (e.key.length === 1) {
      const idx = items.findIndex((i) => (i.hot ?? i.label[0]).toLowerCase() === e.key.toLowerCase());
      if (idx >= 0) { setSel(idx); items[idx].run(); return true; }
    }
    return false;
  });
  let n = -1;
  return (
    <div className="menu" role="menu" aria-label={title}>
      <div className="head">{title}</div>
      {entries.map((e, i) => {
        if ('section' in e) return <div key={i} className="section">{e.section}</div>;
        if ('gap' in e) return <div key={i} className="gap" />;
        n++;
        const idx = n;
        const hot = e.hot ?? e.label[0];
        const at = e.label.toLowerCase().indexOf(hot.toLowerCase());
        return (
          <button key={i} role="menuitem" className={`item ${idx === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(idx)} onClick={() => e.run()}>
            {at >= 0 ? <>{e.label.slice(0, at)}<u>{e.label[at]}</u>{e.label.slice(at + 1)}</> : e.label}
          </button>
        );
      })}
    </div>
  );
}
