import { createContext, useContext, useEffect, useRef } from 'react';

export interface Screen {
  name: string;
  props?: Record<string, any>;
  uid?: number;
}

export interface KeyAction {
  key: string; // shown in the key bar, e.g. "Ctrl+A"
  label: string;
  run?: () => void;
  disabled?: boolean;
  /** Works but is not listed in the key bar. */
  hidden?: boolean;
}

export interface Nav {
  stack: Screen[];
  push(s: Screen): void;
  pop(): void;
  replace(s: Screen): void;
  home(): void;
  toast(message: string, error?: boolean): void;
  /** Logged-in user, or null when logins are off (then everyone acts as Owner). */
  user: { id: number; name: string; role: 'owner' | 'operator' } | null;
  company: any;
  meta: any;
  refreshCompany(): Promise<void>;
  workDate: string;
  setWorkDate(d: string): void;
  setScreenKeys(depth: number, keys: KeyAction[]): void;
  setTitle(depth: number, title: string): void;
  registerHandler(depth: number, h: ((e: KeyboardEvent) => boolean | void) | null): void;
  depth: number;
}

export const NavContext = createContext<Nav>(null as never);
export const DepthContext = createContext(0);

export function useNav(): Nav & { depth: number } {
  const nav = useContext(NavContext);
  const depth = useContext(DepthContext);
  return { ...nav, depth };
}

/** Register a keyboard handler for the screen on top; return true when the key was used. */
export function useScreenKeys(handler: (e: KeyboardEvent) => boolean | void) {
  const nav = useContext(NavContext);
  const depth = useContext(DepthContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    nav.registerHandler(depth, (e) => ref.current(e));
    return () => nav.registerHandler(depth, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth]);
}

/** Buttons shown in the right-hand key bar for the current screen. */
export function useKeyBar(keys: KeyAction[], deps: unknown[]) {
  const nav = useContext(NavContext);
  const depth = useContext(DepthContext);
  useEffect(() => {
    nav.setScreenKeys(depth, keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useTitle(title: string) {
  const nav = useContext(NavContext);
  const depth = useContext(DepthContext);
  useEffect(() => nav.setTitle(depth, title), [title, depth]);
}

/** "Ctrl+A", "Alt+C", "F8", "Esc", "Enter" … from a keyboard event. */
export function keyName(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && e.key.length > 1) parts.push('Shift');
  let k = e.key;
  if (k === 'Escape') k = 'Esc';
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

/** True when the person may see owner-only things (profit, edit log, settings). */
export const isOwner = (nav: Nav) => !nav.user || nav.user.role === 'owner';
