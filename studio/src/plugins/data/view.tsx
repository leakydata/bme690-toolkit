/**
 * Getting data in and organised: import recordings, rename them, and sort
 * specimens into classes -- the groundwork every other view builds on.
 */
import { useMemo, useRef, useState } from 'react';
import { useStudio } from '../../app/state.tsx';
import { groupFiles, parseSession, writeRecording, type InputFile } from '../../core/bmerawdata.ts';
import type { Recording } from '../../core/types.ts';
import { download, fmtDuration } from '../../ui/format.ts';
import { registerView } from '../registry.ts';

async function loadSqlJs() {
  const [{ default: init }, { default: wasmUrl }] = await Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm.wasm?url'),
  ]);
  return init({ locateFile: () => wasmUrl });
}

function Importer() {
  const s = useStudio();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const handle = async (list: FileList | File[]) => {
    const files = [...list];
    if (files.length === 0) return;
    try {
      const dbFile = files.find((f) => /\.db$/i.test(f.name));
      if (dbFile) {
        setBusy(`Opening ${dbFile.name}…`);
        const [{ openAiStudioProject }, SQL] = await Promise.all([import('../../core/aistudio-project.ts'), loadSqlJs()]);
        const p = openAiStudioProject(SQL, new Uint8Array(await dbFile.arrayBuffer()));
        await s.addRecordings(p.recordings, p.classes);
        s.toast(`Imported ${p.recordings.length} session(s) and ${p.classes.length} class(es) from the AI-Studio project.`);
      }
      const texts: InputFile[] = [];
      for (const f of files) {
        if (/\.(bmerawdata|bmelabelinfo)$/i.test(f.name)) {
          setBusy(`Reading ${f.name}…`);
          texts.push({ name: f.name, text: await f.text() });
        }
      }
      const sessions = groupFiles(texts);
      if (!dbFile && sessions.length === 0) {
        s.toast('Nothing to import. Choose .bmerawdata files (with their .bmelabelinfo), or an AI-Studio project.db.', 'error');
        return;
      }
      const recs = [];
      for (const g of sessions) {
        setBusy(`Building cycles for ${g.stem}…`);
        await new Promise((r) => setTimeout(r));
        recs.push(parseSession(g.stem, g.raw, g.labels));
      }
      if (recs.length) {
        await s.addRecordings(recs);
        const cycles = recs.reduce((n, r) => n + r.cycles.length, 0);
        s.toast(`Imported ${recs.length} recording(s), ${cycles.toLocaleString()} complete cycles.`);
      }
    } catch (e) {
      s.toast((e as Error).message, 'error');
    } finally {
      setBusy('');
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="card">
      <h2>Import</h2>
      <div
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); handle(e.dataTransfer.files); }}
      >
        {busy ? <p>{busy}</p> : (
          <>
            <p><b>Drop files here</b> or</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => input.current?.click()}>Choose files…</button>
            </div>
            <input ref={input} type="file" multiple hidden accept=".bmerawdata,.bmelabelinfo,.db"
              onChange={(e) => e.target.files && handle(e.target.files)} />
          </>
        )}
      </div>
      <ul className="muted small" style={{ margin: '10px 0 0', paddingLeft: 18 }}>
        <li><b>From the board's SD card:</b> select every file of a session from the <code>bme690</code> folder, both the
          <code>.bmerawdata</code> and the <code>.bmelabelinfo</code> files. Chunks of one session join up automatically.</li>
        <li><b>From BME AI-Studio:</b> choose the <code>project.db</code> file inside a <code>.bmeproject</code> folder. Its
          sessions, specimens and classes come across.</li>
      </ul>
    </div>
  );
}

function Recordings() {
  const s = useStudio();
  const [confirm, setConfirm] = useState<string | null>(null);

  if (s.recordings.length === 0) {
    return <div className="card empty">No recordings yet. Import some above.</div>;
  }
  const exportRec = (r: Recording) => {
    const out = writeRecording(r);
    download(`${r.name}.bmerawdata`, out.raw, 'application/json');
    download(`${r.name}.bmelabelinfo`, out.labels, 'application/json');
  };
  return (
    <div className="card">
      <h2>Recordings</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Name</th><th>Board</th><th className="num">Length</th><th className="num">Sensors</th>
              <th className="num">Cycles</th><th className="num">Specimens</th><th /></tr>
          </thead>
          <tbody>
            {s.recordings.map((r) => {
              const len = r.points.length ? r.points.t[r.points.length - 1] - r.points.t[0] : 0;
              const sensors = new Set(r.cycles.map((c) => c.sensor)).size;
              return (
                <tr key={r.id}>
                  <td>
                    <input defaultValue={r.name} aria-label="Recording name" style={{ minWidth: 140 }}
                      onBlur={(e) => e.target.value !== r.name && s.renameRecording(r.id, e.target.value)} />
                  </td>
                  <td className="small">{r.config.boardType === 'board_690' ? 'BME690 8x' : r.config.boardType === 'board_8' ? 'BME688 kit' : r.config.boardType}
                    {r.boardId && <div className="muted">{r.boardId}</div>}</td>
                  <td className="num">{fmtDuration(len)}</td>
                  <td className="num">{sensors}</td>
                  <td className="num">{r.cycles.length.toLocaleString()}
                    {r.droppedCycles > 0 && <div className="muted small" title="Incomplete cycles at the edges of a recording are normal">+{r.droppedCycles} incomplete</div>}</td>
                  <td className="num">{r.specimens.length}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button className="btn small" onClick={() => exportRec(r)} title="Download as .bmerawdata for AI-Studio">Export</button>
                      {confirm === r.id ? (
                        <>
                          <button className="btn small danger" onClick={async () => { await s.deleteRecording(r.id); setConfirm(null); }}>Remove</button>
                          <button className="btn small" onClick={() => setConfirm(null)}>Keep</button>
                        </>
                      ) : (
                        <button className="btn small danger" onClick={() => setConfirm(r.id)}>Remove</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Classes() {
  const s = useStudio();
  const [name, setName] = useState('');
  const p = s.project!;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of s.recordings) for (const sp of r.specimens) if (sp.classId) m.set(sp.classId, (m.get(sp.classId) ?? 0) + 1);
    return m;
  }, [s.recordings]);

  return (
    <div className="card">
      <h2>Classes</h2>
      <p className="muted small">What your specimens <i>are</i>: "Coffee", "Air", "Espresso". Models learn to tell classes apart.
        Assign each specimen a class in the table below.</p>
      <div className="stack">
        {p.classes.map((c) => (
          <div key={c.id} className="row">
            <input type="color" value={c.color} aria-label={`Colour of ${c.name}`} onChange={(e) => s.updateClass(c.id, { color: e.target.value })}
              style={{ width: 36, padding: 2, height: 30 }} />
            <input defaultValue={c.name} aria-label="Class name" onBlur={(e) => e.target.value !== c.name && s.updateClass(c.id, { name: e.target.value })} />
            <span className="muted small num">{counts.get(c.id) ?? 0} specimens</span>
            <button className="btn small danger" onClick={() => s.deleteClass(c.id)}>Delete</button>
          </div>
        ))}
      </div>
      <form className="row" style={{ marginTop: 12 }} onSubmit={async (e) => { e.preventDefault(); if (name.trim()) { await s.addClass(name); setName(''); } }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New class, e.g. Coffee" aria-label="New class name" />
        <button className="btn">Add class</button>
      </form>
    </div>
  );
}

function Specimens() {
  const s = useStudio();
  const p = s.project!;
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => {
    const out: { r: Recording; sp: Recording['specimens'][number]; cycles: number }[] = [];
    for (const r of s.recordings) {
      const perSpec = new Map<number, number>();
      for (const c of r.cycles) perSpec.set(c.specimen, (perSpec.get(c.specimen) ?? 0) + 1);
      r.specimens.forEach((sp, i) => out.push({ r, sp, cycles: perSpec.get(i) ?? 0 }));
    }
    const f = filter.trim().toLowerCase();
    return f ? out.filter((x) => x.sp.name.toLowerCase().includes(f) || x.r.name.toLowerCase().includes(f)) : out;
  }, [s.recordings, filter]);

  if (s.recordings.length === 0) return null;
  return (
    <div className="card">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>Specimens</h2>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" aria-label="Filter specimens" />
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>A specimen is one labelled stretch of a recording. Its cycles are what models train on.</p>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Recording</th><th>Specimen</th><th className="num">Length</th><th className="num">Cycles</th><th>Class</th></tr></thead>
          <tbody>
            {rows.map(({ r, sp, cycles }) => {
              const cls = p.classes.find((c) => c.id === sp.classId);
              return (
                <tr key={r.id + sp.id}>
                  <td className="muted small">{r.name}</td>
                  <td><input defaultValue={sp.name} aria-label="Specimen name"
                    onBlur={(e) => e.target.value !== sp.name && s.updateSpecimen(r.id, sp.id, { name: e.target.value })} /></td>
                  <td className="num">{fmtDuration(sp.end - sp.start)}</td>
                  <td className="num">{cycles}</td>
                  <td>
                    {cls && <span className="swatch" style={{ background: cls.color }} />}
                    <select value={sp.classId ?? ''} aria-label={`Class of ${sp.name}`}
                      onChange={(e) => s.updateSpecimen(r.id, sp.id, { classId: e.target.value || null })}>
                      <option value="">— none —</option>
                      {p.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Data() {
  return (
    <>
      <div className="pagehead">
        <h1>Data</h1>
        <p>Import recordings, then sort their specimens into classes.</p>
      </div>
      <Importer />
      <Recordings />
      <div className="grid split">
        <Classes />
        <Specimens />
      </div>
    </>
  );
}

registerView({ id: 'data', title: 'Data', hint: 'Import, specimens, classes', order: 10, needsProject: true, component: Data });
