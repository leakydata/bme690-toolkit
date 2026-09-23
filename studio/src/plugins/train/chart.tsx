/**
 * uPlot in React for the Train page: built once per `optionsKey` (and on a
 * light/dark switch), new data is fed without rebuilding, and it follows the
 * width of its box.
 */
import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';

export function cssVar(name: string, fallback = '#888'): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function axis(extra: uPlot.Axis = {}): uPlot.Axis {
  const line = cssVar('--line');
  return { stroke: cssVar('--muted'), grid: { stroke: line, width: 1 }, ticks: { stroke: line, width: 1 }, ...extra };
}

function useTheme(): string {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark ? 'dark' : 'light';
}

export function Plot({ options, data, optionsKey, height = 220, label }: {
  options: () => Omit<uPlot.Options, 'width' | 'height'>;
  data: uPlot.AlignedData;
  optionsKey: string;
  height?: number;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const latest = useRef(data);
  latest.current = data;
  const theme = useTheme();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const u = new uPlot({ ...options(), width: Math.max(200, el.clientWidth), height }, latest.current, el);
    plot.current = u;
    const ro = new ResizeObserver(() => {
      const w = Math.max(200, el.clientWidth);
      if (Math.abs(w - u.width) > 1) u.setSize({ width: w, height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
    // options() is rebuilt when optionsKey or the theme changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey, theme, height]);

  useEffect(() => {
    plot.current?.setData(data);
  }, [data]);

  return <div ref={box} className="train-plot" role="img" aria-label={label} />;
}
