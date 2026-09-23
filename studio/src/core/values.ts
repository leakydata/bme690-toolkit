/**
 * Measured values on specimens ("Caffeine [mg]" = 126): the numbers a
 * regression model learns to estimate. Property names follow AI-Studio: an
 * optional unit in square brackets at the end.
 */
import type { Project, Recording } from './types.ts';

/** "Caffeine [mg]" -> "mg"; "Ripeness" -> "". */
export function unitOf(name: string): string {
  return /\[([^\]]*)\]\s*$/.exec(name)?.[1].trim() ?? '';
}

/** "Caffeine [mg]" -> "Caffeine". */
export function baseName(name: string): string {
  return name.replace(/\s*\[[^\]]*\]\s*$/, '').trim() || name.trim();
}

/** Name and optional unit -> the stored property name, e.g. "Caffeine [mg]". */
export function propertyName(name: string, unit = ''): string {
  const n = name.trim().replace(/[[\]]/g, '');
  const u = unit.trim().replace(/[[\]]/g, '');
  return u ? `${n} [${u}]` : n;
}

/** Every property in the project -- the ones added on the Data page and any a specimen carries -- alphabetically. */
export function valueKeysIn(recs: Recording[], project?: Pick<Project, 'valueKeys'> | null): string[] {
  const out = new Set(project?.valueKeys ?? []);
  for (const r of recs) {
    for (const s of r.specimens) {
      for (const k of Object.keys(s.values ?? {})) out.add(k);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** A number for people: about three significant digits, with the unit. */
export function fmtValue(v: number, unit = '', digits?: number): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  const text = digits !== undefined ? v.toFixed(digits)
    : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : String(+v.toPrecision(2));
  return `${text}${unit ? ` ${unit}` : ''}`;
}

/** Keep only finite numbers; undefined when nothing is left. */
export function cleanValues(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
    if (k.trim() && Number.isFinite(n)) out[k] = n;
  }
  return Object.keys(out).length ? out : undefined;
}
