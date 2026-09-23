import { useState } from 'react';
import { useStudio } from '../../app/state.tsx';
import { fmtDate } from '../../ui/format.ts';
import { registerView } from '../registry.ts';

function Projects() {
  const s = useStudio();
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);

  const create = async () => {
    await s.createProject(name || 'My project');
    setName('');
    location.hash = '#data';
  };

  return (
    <>
      <div className="pagehead">
        <h1>Projects</h1>
        <p>A project holds recordings, the classes you sort them into, and the models you train. Everything stays in this
          browser on this computer; nothing is uploaded.</p>
      </div>

      <div className="card">
        <h2>New project</h2>
        <form className="row" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Coffee roasts" aria-label="Project name" />
          <button className="btn primary">Create</button>
        </form>
        <p className="muted small" style={{ marginTop: 10 }}>
          Then import recordings from your board's SD card, or open an existing BME AI-Studio project.
        </p>
      </div>

      <div className="card">
        <h2>Your projects</h2>
        {s.projects.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Classes</th><th>Models</th><th>Last changed</th><th /></tr></thead>
              <tbody>
                {s.projects.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.name}</b>{s.project?.id === p.id && <> <span className="pill ok">open</span></>}</td>
                    <td className="num">{p.classes.length}</td>
                    <td className="num">{p.models.length}</td>
                    <td className="muted">{fmtDate(p.updated)}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn small" onClick={async () => { await s.openProject(p.id); location.hash = '#data'; }}>Open</button>
                        {confirm === p.id ? (
                          <>
                            <button className="btn small danger" onClick={async () => { await s.deleteProject(p.id); setConfirm(null); s.toast(`Deleted ${p.name}`); }}>Delete for good</button>
                            <button className="btn small" onClick={() => setConfirm(null)}>Keep</button>
                          </>
                        ) : (
                          <button className="btn small danger" onClick={() => setConfirm(p.id)}>Delete</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

registerView({ id: 'projects', title: 'Projects', hint: 'Open or start one', order: 0, component: Projects });
