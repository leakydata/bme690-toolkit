/** Small formatting and file helpers shared by the views. */

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

export function fmtOhm(v: number): string {
  if (!isFinite(v)) return '–';
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)} MΩ`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)} kΩ`;
  return `${v.toFixed(0)} Ω`;
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Offer a file to the user. */
export function download(name: string, data: string | Blob | Uint8Array, type = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** CSS colour for sensor 0..7. */
export function sensorColor(i: number): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--s${i % 8}`).trim() || '#888';
}
