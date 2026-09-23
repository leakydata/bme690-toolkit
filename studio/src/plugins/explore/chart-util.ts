/** Small helpers the Explore charts share: theme colours, sizing, time axis. */
import { useEffect, useState, type RefObject } from 'react';
import type uPlot from 'uplot';

export interface Theme {
  text: string;
  muted: string;
  line: string;
  panel: string;
  dark: boolean;
}

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  return {
    text: v('--text', '#1c1e21'),
    muted: v('--muted', '#5f6368'),
    line: v('--line', '#e1e1dc'),
    panel: v('--panel', '#ffffff'),
    dark: cs.colorScheme === 'dark' || v('color-scheme', '') === 'dark',
  };
}

/** Current theme colours; changes when the OS or the app switches light/dark. */
export function useTheme(): Theme {
  const [t, setT] = useState(readTheme);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setT(readTheme());
    mq.addEventListener('change', on);
    const mo = new MutationObserver(on);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => {
      mq.removeEventListener('change', on);
      mo.disconnect();
    };
  }, []);
  return t;
}

/** Width of an element in CSS pixels, kept up to date. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.floor(el.clientWidth));
    const ro = new ResizeObserver(() => setW(Math.floor(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Seconds since the start of a recording as "1:05" (h:mm) or "4:30" (m:ss). */
export function fmtElapsed(sec: number, span: number): string {
  const s = Math.round(sec);
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(s);
  if (span >= 3 * 3600) {
    const h = Math.floor(a / 3600);
    const m = Math.floor((a % 3600) / 60);
    return `${sign}${h}:${String(m).padStart(2, '0')}`;
  }
  if (span >= 600) {
    const h = Math.floor(a / 3600);
    const m = Math.floor((a % 3600) / 60);
    const ss = a % 60;
    return h ? `${sign}${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${sign}${m}:${String(ss).padStart(2, '0')}`;
  }
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

export const TIME_INCRS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

export function axisStyle(t: Theme): Pick<uPlot.Axis, 'stroke' | 'grid' | 'ticks' | 'font' | 'labelFont'> {
  return {
    stroke: t.muted,
    grid: { stroke: t.line, width: 1 },
    ticks: { stroke: t.line, width: 1 },
    font: '11px system-ui, sans-serif',
    labelFont: '600 11px system-ui, sans-serif',
  };
}

/** Hex colour with alpha, for fills. Falls back to the input for non-hex colours. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Width for a y axis that fits its longest tick label (11px font). */
export function ySize(_u: uPlot, values: string[] | null): number {
  const longest = values ? Math.max(0, ...values.map((v) => (v ?? '').length)) : 6;
  return Math.max(40, Math.ceil(longest * 6.3) + 14);
}
