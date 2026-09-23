/**
 * Everything is kept in the browser's IndexedDB: nothing leaves the
 * computer. Typed arrays are stored as they are, so large recordings stay
 * compact.
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { Project, Recording } from './types.ts';

const DB_NAME = 'bme-studio';
const VERSION = 1;

let dbp: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, VERSION, {
      upgrade(d) {
        d.createObjectStore('projects', { keyPath: 'id' });
        const r = d.createObjectStore('recordings', { keyPath: 'id' });
        r.createIndex('projectId', 'projectId');
      },
    });
  }
  return dbp;
}

export async function listProjects(): Promise<Project[]> {
  const all = (await (await db()).getAll('projects')) as Project[];
  return all.sort((a, b) => b.updated - a.updated);
}

export async function putProject(p: Project): Promise<void> {
  await (await db()).put('projects', p);
}

export async function deleteProject(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['projects', 'recordings'], 'readwrite');
  const keys = await tx.objectStore('recordings').index('projectId').getAllKeys(id);
  await Promise.all([...keys.map((k) => tx.objectStore('recordings').delete(k)), tx.objectStore('projects').delete(id)]);
  await tx.done;
}

export async function listRecordings(projectId: string): Promise<Recording[]> {
  const all = (await (await db()).getAllFromIndex('recordings', 'projectId', projectId)) as Recording[];
  return all.sort((a, b) => a.importedAt - b.importedAt);
}

export async function putRecording(r: Recording): Promise<void> {
  await (await db()).put('recordings', r);
}

export async function deleteRecording(id: string): Promise<void> {
  await (await db()).delete('recordings', id);
}
