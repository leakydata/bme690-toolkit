/**
 * A small React wrapper around uPlot: builds the chart once per `options`
 * key, feeds new data without rebuilding, and follows the container width
 * and the light/dark theme.
 */
import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';

export function cssVar(name: string, fallback = '#888'): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Axis styling that follows the app's colours. */
export function axis(extra: uPlot.Axis = {}): uPlot.Axis {
  const muted = cssVar('--muted');
  const line = cssVar('--line');
  return {
    stroke: muted,
    grid: { stroke: line, width: 1 },
    ticks: { stroke: line, width: 1 },
    ...extra,
  };
}

function useThemeKey(): string {
  const [key, setKey] = useState(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setKey(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return key;
}

export function Chart({
  options,
  data,
  optionsKey,
  height = 240,
  label,
}: {
  /** called to build options; width and height are filled in */
  options: () => Omit<uPlot.Options, 'width' | 'height'>;
  data: uPlot.AlignedData;
  /** rebuild the chart when this changes */
  optionsKey: string;
  height?: number;
  /** accessible description of the chart */
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const latest = useRef(data);
  latest.current = data;
  const theme = useThemeKey();

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
    // options() is rebuilt whenever optionsKey or the theme changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey, theme, height]);

  useEffect(() => {
    plot.current?.setData(data);
  }, [data]);

  return <div ref={box} className="chart live-chart" role="img" aria-label={label} />;
}
