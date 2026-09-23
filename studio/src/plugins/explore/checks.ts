/**
 * Plain-English checks on a project's data: the problems that make a model
 * look better (or worse) than it is, found before any training.
 */
import type { Project, Recording } from '../../core/types.ts';

export interface Check {
  level: 'warn' | 'info';
  title: string;
  /** why it matters and what to do */
  detail: string;
}

export function median(v: number[]): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function profileName(recs: Recording[], id: string): string {
  for (const r of recs) {
    const hp = r.config.heaterProfiles.find((h) => h.id === id);
    if (hp?.name) return hp.name;
  }
  return id;
}

export function dataChecks(project: Project, recs: Recording[]): Check[] {
  const out: Check[] = [];
  const className = new Map(project.classes.map((c) => [c.id, c.name]));

  // Per class: specimens with cycles, cycles, environment.
  interface Agg { specimens: number; cycles: number; hum: number[]; temp: number[] }
  const agg = new Map<string, Agg>();
  const thin: string[] = [];
  let unclassed = 0;
  for (const r of recs) {
    const per = new Map<number, number>();
    for (const c of r.cycles) per.set(c.specimen, (per.get(c.specimen) ?? 0) + 1);
    const sensors = Math.max(1, new Set(r.cycles.map((c) => c.sensor)).size);
    r.specimens.forEach((sp, i) => {
      const n = per.get(i) ?? 0;
      if (!sp.classId) {
        if (n > 0) unclassed++;
        return;
      }
      if (!className.has(sp.classId)) return;
      const a = agg.get(sp.classId) ?? { specimens: 0, cycles: 0, hum: [], temp: [] };
      if (n > 0) a.specimens++;
      a.cycles += n;
      agg.set(sp.classId, a);
      if (n / sensors < 10) thin.push(`${sp.name} in ${r.name} (${plural(Math.round(n / sensors), 'cycle')} per sensor)`);
    });
    for (const c of r.cycles) {
      const cls = r.specimens[c.specimen]?.classId;
      const a = cls ? agg.get(cls) : undefined;
      if (a) {
        if (isFinite(c.hum)) a.hum.push(c.hum);
        if (isFinite(c.temp)) a.temp.push(c.temp);
      }
    }
  }

  const used = [...agg.entries()].filter(([, a]) => a.cycles > 0);

  const empty = project.classes.filter((c) => !agg.get(c.id)?.cycles).map((c) => c.name);
  if (empty.length && used.length) {
    out.push({
      level: 'info',
      title: `${list(empty)} ${empty.length > 1 ? 'have' : 'has'} no data`,
      detail: 'No specimen with cycles belongs to this class, so it plays no part in training. Assign specimens to it on the Data page, or delete it.',
    });
  }

  const few = used.filter(([, a]) => a.specimens < 3);
  if (few.length) {
    out.push({
      level: 'warn',
      title: `Too few specimens: ${list(few.map(([id, a]) => `${className.get(id)} (${a.specimens})`))}`,
      detail:
        'A model can only be tested honestly on specimens it has not seen. With fewer than 3 specimens of a class there is too little left over to test on, ' +
        'so any accuracy figure for it is a guess. Record more specimens of it, ideally on different days.',
    });
  }

  if (used.length >= 2) {
    const sorted = [...used].sort((p, q) => q[1].cycles - p[1].cycles);
    const [bigId, big] = sorted[0];
    const [smallId, small] = sorted[sorted.length - 1];
    if (big.cycles >= 3 * small.cycles) {
      out.push({
        level: 'warn',
        title: `Unbalanced classes: ${className.get(bigId)} has ${Math.round(big.cycles / Math.max(small.cycles, 1))}× as many cycles as ${className.get(smallId)}`,
        detail:
          'A model can score well just by guessing the biggest class. Record more of the smaller classes, or judge the model by its per-class results rather than the overall accuracy.',
      });
    }
  }

  if (thin.length) {
    out.push({
      level: 'warn',
      title: `${plural(thin.length, 'specimen')} with very few cycles`,
      detail: `${list(thin.slice(0, 6))}${thin.length > 6 ? ' and more' : ''}. A handful of cycles says little about a specimen, and the first cycles after a change are often still settling. Record each specimen for longer, or leave these out.`,
    });
  }

  // Confounding: a class recorded in different conditions than the rest.
  if (used.length >= 2) {
    const envCheck = (key: 'hum' | 'temp', unit: string, what: string, minGap: number) => {
      for (const [id, a] of used) {
        const own = [...a[key]].sort((p, q) => p - q);
        const rest = used.filter(([o]) => o !== id).flatMap(([, b]) => b[key]).sort((p, q) => p - q);
        if (own.length < 5 || rest.length < 5) continue;
        const m1 = quantile(own, 0.5);
        const m2 = quantile(rest, 0.5);
        const gap = m1 - m2;
        // Clearly different: a real gap, and the middle halves don't overlap.
        const apart = quantile(own, 0.25) > quantile(rest, 0.75) || quantile(own, 0.75) < quantile(rest, 0.25);
        if (Math.abs(gap) >= minGap && apart) {
          out.push({
            level: 'warn',
            title: `${className.get(id)} was recorded ${key === 'temp' ? (gap > 0 ? 'warmer' : 'cooler') : gap > 0 ? 'more humid' : 'drier'} than the other classes (${what} ${m1.toFixed(1)} vs ${m2.toFixed(1)} ${unit})`,
            detail:
              'Gas sensors react to humidity and temperature too, so a model may learn the weather instead of the smell and then fail when conditions change. ' +
              'Record every class under similar conditions (same room, same time of day, interleaved), or at least include some specimens of each class in both conditions.',
          });
        }
      }
    };
    envCheck('hum', '%RH', 'median humidity', 2);
    envCheck('temp', '°C', 'median temperature', 1);
  }

  // Sensors missing or dropping cycles.
  for (const r of recs) {
    const counts = new Map<number, number>();
    for (const c of r.cycles) counts.set(c.sensor, (counts.get(c.sensor) ?? 0) + 1);
    const silent = r.config.sensors.filter((s) => s.active && !counts.has(s.sensorIndex)).map((s) => `sensor ${s.sensorIndex}`);
    if (silent.length) {
      out.push({
        level: 'warn',
        title: `${r.name}: ${list(silent)} recorded nothing`,
        detail: 'The board was set up to use it, but no complete cycle came back. Check that the sensor is seated and not damaged; models that expect all sensors cannot use this recording.',
      });
    }
    // Sensors on the same heater profile should complete about as many cycles.
    const byProfile = new Map<string, number[]>();
    for (const s of r.config.sensors) {
      if (!counts.has(s.sensorIndex)) continue;
      (byProfile.get(s.heaterProfile) ?? byProfile.set(s.heaterProfile, []).get(s.heaterProfile)!).push(s.sensorIndex);
    }
    const lagging: string[] = [];
    for (const sensors of byProfile.values()) {
      const best = Math.max(...sensors.map((s) => counts.get(s)!));
      for (const s of sensors) {
        const n = counts.get(s)!;
        if (n < best * 0.8) lagging.push(`sensor ${s} (${n} of ${best})`);
      }
    }
    if (lagging.length) {
      out.push({
        level: 'warn',
        title: `${r.name}: ${list(lagging)} lost many cycles`,
        detail: 'It completed far fewer cycles than the sensors running the same heater profile. A loose connection or a failing sensor is the usual cause; its data may be patchy.',
      });
    }
    const total = r.cycles.length + r.droppedCycles;
    if (total > 0 && r.droppedCycles / total > 0.05) {
      out.push({
        level: 'warn',
        title: `${r.name}: ${Math.round((100 * r.droppedCycles) / total)}% of cycles were incomplete`,
        detail: 'A few incomplete cycles at the start and end are normal; this many suggests readings were interrupted (power, cable, or SD card). Those cycles are left out.',
      });
    }
  }

  // Heater profiles not used by every recording.
  if (recs.length > 1) {
    const users = new Map<string, Set<string>>();
    for (const r of recs) for (const c of r.cycles) (users.get(c.heaterProfile) ?? users.set(c.heaterProfile, new Set()).get(c.heaterProfile)!).add(r.id);
    for (const [hp, rs] of users) {
      if (rs.size < recs.length) {
        out.push({
          level: 'info',
          title: `Heater profile ${profileName(recs, hp)} is in only ${rs.size} of ${recs.length} recordings`,
          detail: 'A model is built for one heater profile, so it only learns from the recordings that used it. If those recordings miss some classes or conditions, so will the model.',
        });
      }
    }
  }

  if (unclassed > 0) {
    out.push({
      level: 'info',
      title: `${plural(unclassed, 'specimen')} ${unclassed === 1 ? 'has' : 'have'} no class`,
      detail: 'Specimens without a class (a warm-up, for example) are left out of fingerprints, maps and training. That is fine if intended; otherwise assign a class on the Data page.',
    });
  }
  return out;
}
