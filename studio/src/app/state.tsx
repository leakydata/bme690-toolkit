/**
 * App-wide state: the open project, its recordings, and the actions views
 * use to change them. Views call useStudio(); every change is saved to
 * IndexedDB straight away.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { newId } from '../core/ids.ts';
import * as store from '../core/store.ts';
import type { ModelRecord, Project, Recording, Specimen, SpecimenClass } from '../core/types.ts';

export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'error';
}

export interface Studio {
  projects: Project[];
  project: Project | null;
  recordings: Recording[];
  loading: boolean;
  toasts: Toast[];

  openProject(id: string | null): Promise<void>;
  createProject(name: string): Promise<Project>;
  renameProject(name: string): Promise<void>;
  deleteProject(id: string): Promise<void>;

  /** Add recordings (already parsed) to the open project. */
  addRecordings(recs: Omit<Recording, 'projectId'>[], classes?: SpecimenClass[]): Promise<void>;
  deleteRecording(id: string): Promise<void>;
  renameRecording(id: string, name: string): Promise<void>;
  updateSpecimen(recordingId: string, specimenId: string, patch: Partial<Pick<Specimen, 'name' | 'comment' | 'classId'>>): Promise<void>;

  addClass(name: string): Promise<SpecimenClass>;
  updateClass(id: string, patch: Partial<Omit<SpecimenClass, 'id'>>): Promise<void>;
  deleteClass(id: string): Promise<void>;

  saveModel(m: ModelRecord): Promise<void>;
  deleteModel(id: string): Promise<void>;

  /** Add or replace a saved board configuration (matched by id). */
  saveConfig(c: NonNullable<Project['savedConfigs']>[number]): Promise<void>;
  deleteConfig(id: string): Promise<void>;

  toast(text: string, kind?: 'ok' | 'error'): void;
}

const Ctx = createContext<Studio | null>(null);

export function useStudio(): Studio {
  const s = useContext(Ctx);
  if (!s) {
    throw new Error('useStudio outside StudioProvider');
  }
  return s;
}

export const CLASS_COLORS = ['#4c8dff', '#f59e0b', '#10b981', '#ef4444', '#a855f7', '#14b8a6', '#f97316', '#64748b', '#ec4899', '#84cc16'];

const LAST_KEY = 'bme-studio:last-project';

export function StudioProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProjectState] = useState<Project | null>(null);
  const projRef = useRef<Project | null>(null);
  const setProject = useCallback((p: Project | null) => {
    projRef.current = p;
    setProjectState(p);
  }, []);
  const [recordings, setRecordingsState] = useState<Recording[]>([]);
  // The latest recordings, readable by actions that run back to back before
  // React re-renders -- e.g. classing many specimens in a row -- so one
  // change never starts from a stale copy and undoes another.
  const recsRef = useRef<Recording[]>([]);
  const setRecordings = useCallback((next: Recording[] | ((all: Recording[]) => Recording[])) => {
    recsRef.current = typeof next === 'function' ? next(recsRef.current) : next;
    setRecordingsState(recsRef.current);
  }, []);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  const saveProject = useCallback(async (p: Project) => {
    const next = { ...p, updated: Date.now() };
    setProject(next);   // before the write, so a change right after builds on this one
    await store.putProject(next);
    setProjects((all) => [next, ...all.filter((x) => x.id !== next.id)]);
    return next;
  }, [setProject]);

  const openProject = useCallback(async (id: string | null) => {
    setLoading(true);
    try {
      if (!id) {
        setProject(null);
        setRecordings([]);
        localStorage.removeItem(LAST_KEY);
        return;
      }
      const p = (await store.listProjects()).find((x) => x.id === id) ?? null;
      setProject(p);
      setRecordings(p ? await store.listRecordings(p.id) : []);
      if (p) {
        localStorage.setItem(LAST_KEY, p.id);
      }
    } finally {
      setLoading(false);
    }
  }, [setProject, setRecordings]);

  useEffect(() => {
    (async () => {
      const all = await store.listProjects();
      setProjects(all);
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_KEY);
      } catch {
        // storage may be blocked; start without a project
      }
      if (last && all.some((p) => p.id === last)) {
        await openProject(last);
      } else {
        setLoading(false);
      }
    })().catch((e) => {
      toast(`Could not open the local database: ${e.message}`, 'error');
      setLoading(false);
    });
  }, [openProject, toast]);

  const need = () => {
    if (!projRef.current) {
      throw new Error('Open a project first.');
    }
    return projRef.current;
  };

  const studio = useMemo<Studio>(() => ({
    projects, project, recordings, loading, toasts, toast, openProject,

    async createProject(name) {
      const now = Date.now();
      const p: Project = { id: newId('prj'), name: name.trim() || 'Untitled project', created: now, updated: now, classes: [], models: [] };
      await store.putProject(p);
      setProjects((all) => [p, ...all]);
      await openProject(p.id);
      return p;
    },
    async renameProject(name) {
      await saveProject({ ...need(), name: name.trim() || need().name });
    },
    async deleteProject(id) {
      await store.deleteProject(id);
      setProjects((all) => all.filter((p) => p.id !== id));
      if (project?.id === id) {
        await openProject(null);
      }
    },

    async addRecordings(recs, classes = []) {
      const p = need();
      // Merge imported classes into the project's by name.
      const merged = [...p.classes];
      const remap = new Map<string, string>();
      for (const c of classes) {
        const same = merged.find((m) => m.name.toLowerCase() === c.name.toLowerCase());
        if (same) {
          remap.set(c.id, same.id);
        } else {
          merged.push(c);
          remap.set(c.id, c.id);
        }
      }
      const full: Recording[] = recs.map((r) => ({
        ...r,
        projectId: p.id,
        specimens: r.specimens.map((s) => ({ ...s, classId: s.classId ? remap.get(s.classId) ?? null : null })),
      }));
      for (const r of full) {
        await store.putRecording(r);
      }
      setRecordings((all) => [...all, ...full]);
      await saveProject({ ...p, classes: merged });
    },
    async deleteRecording(id) {
      await store.deleteRecording(id);
      setRecordings((all) => all.filter((r) => r.id !== id));
    },
    async renameRecording(id, name) {
      const r = recsRef.current.find((x) => x.id === id);
      if (!r) return;
      const next = { ...r, name: name.trim() || r.name };
      setRecordings((all) => all.map((x) => (x.id === id ? next : x)));
      await store.putRecording(next);
    },
    async updateSpecimen(recordingId, specimenId, patch) {
      const r = recsRef.current.find((x) => x.id === recordingId);
      if (!r) return;
      const next = { ...r, specimens: r.specimens.map((s) => (s.id === specimenId ? { ...s, ...patch } : s)) };
      setRecordings((all) => all.map((x) => (x.id === recordingId ? next : x)));
      await store.putRecording(next);
    },

    async addClass(name) {
      const p = need();
      const c: SpecimenClass = { id: newId('cls'), name: name.trim() || 'New class', color: CLASS_COLORS[p.classes.length % CLASS_COLORS.length] };
      await saveProject({ ...p, classes: [...p.classes, c] });
      return c;
    },
    async updateClass(id, patch) {
      const p = need();
      await saveProject({ ...p, classes: p.classes.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
    },
    async deleteClass(id) {
      const p = need();
      for (const r of recsRef.current) {
        if (r.specimens.some((s) => s.classId === id)) {
          const next = { ...r, specimens: r.specimens.map((s) => (s.classId === id ? { ...s, classId: null } : s)) };
          await store.putRecording(next);
          setRecordings((all) => all.map((x) => (x.id === r.id ? next : x)));
        }
      }
      await saveProject({ ...p, classes: p.classes.filter((c) => c.id !== id) });
    },

    async saveModel(m) {
      const p = need();
      await saveProject({ ...p, models: [...p.models.filter((x) => x.id !== m.id), m] });
    },
    async deleteModel(id) {
      const p = need();
      await saveProject({ ...p, models: p.models.filter((x) => x.id !== id) });
    },

    async saveConfig(c) {
      const p = need();
      const all = p.savedConfigs ?? [];
      await saveProject({ ...p, savedConfigs: [...all.filter((x) => x.id !== c.id), c] });
    },
    async deleteConfig(id) {
      const p = need();
      await saveProject({ ...p, savedConfigs: (p.savedConfigs ?? []).filter((x) => x.id !== id) });
    },
  }), [projects, project, recordings, loading, toasts, toast, openProject, saveProject, setRecordings]);

  return <Ctx.Provider value={studio}>{children}</Ctx.Provider>;
}
