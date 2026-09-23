/**
 * Opens a BME AI-Studio project (the project.db SQLite file inside a
 * .bmeproject folder) so existing work carries over: measurement sessions,
 * specimens, heater profiles and the classes specimens were sorted into.
 *
 * AI-Studio keeps classes per algorithm; here they are per project, so
 * classes with the same name are merged. Specimen metadata ("Caffeine [mg]"
 * = 126, what its regression algorithms learn) comes across as
 * Specimen.values, taken from the original specimens.
 */
import type { Database, SqlJsStatic } from 'sql.js';
import { buildCycles, emptyPoints } from './assemble.ts';
import { newId } from './ids.ts';
import { cleanValues } from './values.ts';
import type { BoardConfig, Recording, Specimen, SpecimenClass } from './types.ts';

export interface ProjectImport {
  recordings: Omit<Recording, 'projectId'>[];
  classes: SpecimenClass[];
}

function rows<T = Record<string, any>>(db: Database, sql: string, params: any[] = []): T[] {
  const st = db.prepare(sql);
  st.bind(params);
  const out: T[] = [];
  while (st.step()) {
    out.push(st.getAsObject() as T);
  }
  st.free();
  return out;
}

const PALETTE = ['#4c8dff', '#f59e0b', '#10b981', '#ef4444', '#a855f7', '#14b8a6', '#f97316', '#64748b'];

export function openAiStudioProject(SQL: SqlJsStatic, bytes: Uint8Array): ProjectImport {
  let db: Database;
  try {
    db = new SQL.Database(bytes);
    rows(db, 'select count(*) from measurement_sessions');
  } catch {
    throw new Error('This is not an AI-Studio project database. Choose the project.db file inside a .bmeproject folder.');
  }

  try {
    // Classes, merged by name across algorithms.
    const classByName = new Map<string, SpecimenClass>();
    const specimenClass = new Map<number, string>();
    for (const c of rows(db, 'select id, name, color from specimen_classes order by id')) {
      const name = String(c.name ?? '').trim() || 'class';
      if (!classByName.has(name)) {
        classByName.set(name, {
          id: newId('cls'),
          name,
          color: c.color || PALETTE[classByName.size % PALETTE.length],
        });
      }
    }
    // AI-Studio copies a specimen for every algorithm that uses it, and each
    // algorithm may class it differently ("Coffee" in one, "Espresso" in
    // another). Keep the original specimen and give it the class from the
    // algorithm with the most classes, then the class covering the fewest
    // specimens -- the most specific one. Models can
    // group classes back together when training.
    const classCount = new Map<number, number>();
    for (const r of rows(db, 'select algorithm_id a, count(*) n from specimen_classes group by algorithm_id')) {
      classCount.set(Number(r.a), Number(r.n));
    }
    const links = rows(db,
      `select coalesce(o.id, s.id) orig, c.name name, c.algorithm_id alg
       from specimen_classes_specimen_data l
       join specimen_classes c on c.id = l.specimen_class_id
       join specimen_data s on s.id = l.specimen_data_id
       left join specimen_data o on o.uuid = s.clone_of_uuid
       order by l.id`).map((l) => ({
      orig: Number(l.orig),
      cls: classByName.get(String(l.name ?? '').trim() || 'class'),
      alg: Number(l.alg),
    }));
    // How many specimens a class covers: fewer means more specific.
    const covers = new Map<string, Set<number>>();
    for (const l of links) {
      if (l.cls) {
        (covers.get(l.cls.id) ?? covers.set(l.cls.id, new Set()).get(l.cls.id)!).add(l.orig);
      }
    }
    const best = new Map<number, { cls: string; classes: number; covers: number }>();
    for (const l of links) {
      if (!l.cls) continue;
      const cand = { cls: l.cls.id, classes: classCount.get(l.alg) ?? 0, covers: covers.get(l.cls.id)!.size };
      const cur = best.get(l.orig);
      if (!cur || cand.classes > cur.classes || (cand.classes === cur.classes && cand.covers < cur.covers)) {
        best.set(l.orig, cand);
      }
    }
    for (const [orig, b] of best) {
      specimenClass.set(orig, b.cls);
    }

    const valuesOf = specimenValues(db);

    const recordings: Omit<Recording, 'projectId'>[] = [];
    for (const s of rows(db, 'select id, name, board_id from measurement_sessions order by id')) {
      const config = sessionConfig(db, Number(s.id));
      const specs = rows(db,
        'select id, name, comment, start_time, end_time from specimen_data where measurement_session_id = ? and clone_of_uuid is null order by start_time',
        [s.id]);
      const pts = rows(db,
        `select p.time t, p.gas_resistance g, p.temperature te, p.pressure pr, p.humidity h,
                p.initial_real_time r, p.cycle_step_index st, p.error_code e, se.idx sensor
         from specimen_data_points p
         join cycles c on c.id = p.cycle_id
         join sensors se on se.id = c.sensor_id
         where c.measurement_session_id = ?
         order by p.time, se.idx`, [s.id]);
      if (pts.length === 0) {
        continue;
      }

      const specimens: Specimen[] = specs.map((sp, i) => ({
        id: `sp${i}`,
        tag: i + 1,
        name: String(sp.name ?? `specimen ${i + 1}`),
        comment: String(sp.comment ?? ''),
        start: Number(sp.start_time),
        end: Number(sp.end_time),
        classId: specimenClass.get(Number(sp.id)) ?? null,
        ...(valuesOf.has(Number(sp.id)) ? { values: valuesOf.get(Number(sp.id)) } : {}),
      }));

      const points = emptyPoints(pts.length);
      let k = 0;
      for (const [i, p] of pts.entries()) {
        const t = Number(p.t);
        while (k + 1 < specimens.length && specimens[k + 1].start <= t) {
          k++;
        }
        points.sensor[i] = Number(p.sensor);
        points.t[i] = t;
        points.rtc[i] = Number(p.r) || 0;
        points.temp[i] = Number(p.te);
        points.press[i] = Number(p.pr);
        points.hum[i] = Number(p.h);
        points.gas[i] = Number(p.g);
        points.step[i] = Number(p.st);
        points.tag[i] = specimens.length && t >= specimens[k].start && t <= specimens[k].end ? specimens[k].tag : 0;
        points.error[i] = Number(p.e) ? 1 : 0;
      }

      const { cycles, dropped } = buildCycles(points, config, specimens);
      recordings.push({
        id: newId('rec'),
        name: String(s.name ?? `session ${s.id}`),
        sources: ['project.db'],
        importedAt: Date.now(),
        boardId: String(s.board_id ?? ''),
        firmware: '',
        config,
        points,
        cycles,
        droppedCycles: dropped,
        specimens,
      });
    }
    return { recordings, classes: [...classByName.values()] };
  } finally {
    db.close();
  }
}

/**
 * Numeric metadata of the original specimens (not the per-algorithm copies),
 * keyed by property name. Empty or non-numeric values are skipped. Older
 * projects without the metadata tables yield nothing.
 */
function specimenValues(db: Database): Map<number, Record<string, number>> {
  const out = new Map<number, Record<string, number>>();
  let found: Record<string, any>[];
  try {
    found = rows(db,
      `select m.specimen_data_id sid, k.name name, m.value value
       from specimen_meta_data m
       join specimen_meta_data_keys k on k.id = m.specimen_meta_data_key_id
       join specimen_data s on s.id = m.specimen_data_id
       where s.clone_of_uuid is null`);
  } catch {
    return out;
  }
  const raw = new Map<number, Record<string, unknown>>();
  for (const r of found) {
    const name = String(r.name ?? '').trim();
    if (!name) continue;
    const e = raw.get(Number(r.sid)) ?? {};
    e[name] = r.value === null ? '' : String(r.value);
    raw.set(Number(r.sid), e);
  }
  for (const [sid, v] of raw) {
    const clean = cleanValues(v);
    if (clean) out.set(sid, clean);
  }
  return out;
}

function sessionConfig(db: Database, sessionId: number): BoardConfig {
  const bc = rows(db,
    `select b.id, b.board_mode, t.uid from board_configs b
     left join board_types t on t.id = b.board_type_id
     where b.measurement_session_id = ? limit 1`, [sessionId])[0];
  const sensors = bc ? rows(db,
    `select se.idx, h.uid hp, d.uid dc from sensor_configs sc
     join sensors se on se.id = sc.sensor_id
     join heater_profiles h on h.id = sc.heater_profile_id
     join duty_cycle_profiles d on d.id = sc.duty_cycle_profile_id
     where sc.board_config_id = ? order by se.idx`, [bc.id]) : [];

  const hpIds = new Set(sensors.map((s) => s.hp));
  const dcIds = new Set(sensors.map((s) => s.dc));
  const heaterProfiles = rows(db, 'select uid, name, time_base, steps from heater_profiles')
    .filter((h) => hpIds.has(h.uid))
    .map((h) => ({
      id: String(h.uid),
      name: h.name ? String(h.name) : undefined,
      timeBase: Number(h.time_base),
      steps: (JSON.parse(String(h.steps || '[]')) as { temperature: number; duration: number }[])
        .map((s) => [s.temperature, s.duration] as [number, number]),
    }));
  const dutyCycleProfiles = rows(db, 'select uid, name, scanning_cycles, sleeping_cycles from duty_cycle_profiles')
    .filter((d) => dcIds.has(d.uid))
    .map((d) => ({
      id: String(d.uid),
      name: d.name ? String(d.name) : undefined,
      scanningCycles: Number(d.scanning_cycles),
      sleepingCycles: Number(d.sleeping_cycles),
    }));

  return {
    boardType: bc?.uid ?? 'board_8',
    boardMode: bc?.board_mode ?? '',
    heaterProfiles,
    dutyCycleProfiles,
    sensors: sensors.map((s) => ({
      sensorIndex: Number(s.idx),
      active: true,
      heaterProfile: String(s.hp),
      dutyCycleProfile: String(s.dc),
    })),
  };
}
