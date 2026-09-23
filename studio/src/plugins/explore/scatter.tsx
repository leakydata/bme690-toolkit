/**
 * A plain canvas scatter plot for a few thousand points, coloured by class,
 * with a hover (or tap) tooltip. uPlot is built for time series; for a 2-D
 * map with per-point tooltips a small canvas is simpler and just as fast.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useTheme, useWidth } from './chart-util.ts';

export interface ScatterProps {
  points: number[][];
  colors: string[];
  xLabel: string;
  yLabel: string;
  tooltip(i: number): ReactNode;
  /** dim everything (while recomputing) */
  faded?: boolean;
}

const PAD = { l: 22, r: 10, t: 10, b: 24 };

export function Scatter({ points, colors, xLabel, yLabel, tooltip, faded }: ScatterProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = useWidth(box);
  const theme = useTheme();
  const height = width < 560 ? Math.round(width * 0.9) : 420;
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    // Frame the middle 99% so a few stray cycles don't squash the rest into a
    // corner; the strays are pinned to the edge.
    const lim = (k: number) => {
      const v = points.map((p) => p[k]).filter(isFinite).sort((p, q) => p - q);
      if (!v.length) return [-1, 1];
      const cut = v.length > 200 ? Math.floor(v.length * 0.005) : 0;
      return [v[cut], v[v.length - 1 - cut]];
    };
    const [x0, x1] = lim(0);
    const [y0, y1] = lim(1);
    const px = (x1 - x0) * 0.04 || 1;
    const py = (y1 - y0) * 0.04 || 1;
    const w = Math.max(10, width - PAD.l - PAD.r);
    const h = Math.max(10, height - PAD.t - PAD.b);
    const sx = (v: number) => PAD.l + ((v - (x0 - px)) / (x1 - x0 + 2 * px)) * w;
    const sy = (v: number) => PAD.t + h - ((v - (y0 - py)) / (y1 - y0 + 2 * py)) * h;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const xy = points.map((p) => [clamp(sx(p[0]), PAD.l + 2, PAD.l + w - 2), clamp(sy(p[1]), PAD.t + 2, PAD.t + h - 2)]);
    // Draw in a scrambled but stable order so no class always sits on top.
    const order = points.map((_, i) => i).sort((a, b) => ((a * 2654435761) >>> 0) % 1009 - ((b * 2654435761) >>> 0) % 1009);
    return { xy, order, w, h };
  }, [points, width, height]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !width) return;
    const dpr = devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD.l + 0.5, PAD.t + 0.5, geom.w, geom.h);
    ctx.fillStyle = theme.muted;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(xLabel, PAD.l + geom.w / 2, height - 6);
    ctx.save();
    ctx.translate(12, PAD.t + geom.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
    ctx.globalAlpha = faded ? 0.25 : 0.75;
    const r = points.length > 2000 ? 2.2 : 2.8;
    for (const i of geom.order) {
      const [x, y] = geom.xy[i];
      ctx.fillStyle = colors[i];
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (hover !== null && geom.xy[hover]) {
      const [x, y] = geom.xy[hover];
      ctx.strokeStyle = theme.text;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [geom, colors, width, height, theme, xLabel, yLabel, hover, faded, points.length]);

  const pick = (e: PointerEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = -1;
    let bd = e.pointerType === 'touch' ? 400 : 100;
    geom.xy.forEach(([x, y], i) => {
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best >= 0 ? best : null);
  };

  const tip = hover !== null && geom.xy[hover] ? geom.xy[hover] : null;
  return (
    <div ref={box} className="ex-scatter">
      <canvas ref={canvas} onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)}
        role="img" aria-label={`Map of ${points.length} cycles, ${xLabel} against ${yLabel}`} />
      {tip && (
        <div className="ex-tip small" style={{ left: Math.min(tip[0] + 12, Math.max(0, width - 220)), top: tip[1] + 12 }}>
          {tooltip(hover!)}
        </div>
      )}
    </div>
  );
}
