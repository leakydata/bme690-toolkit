/**
 * The extension points. A feature is a file that calls one of the register
 * functions below, plus one import line in plugins/index.ts. Nothing else
 * needs to change -- see CONTRIBUTING.md.
 */
import type { ComponentType } from 'react';

/** A page in the sidebar. */
export interface ViewPlugin {
  id: string;
  title: string;
  /** position in the sidebar, low first */
  order: number;
  /** one line shown under the title */
  hint?: string;
  /** hide until a project is open */
  needsProject?: boolean;
  component: ComponentType;
}

const views: ViewPlugin[] = [];

export function registerView(v: ViewPlugin): void {
  if (views.some((x) => x.id === v.id)) {
    throw new Error(`view "${v.id}" registered twice`);
  }
  views.push(v);
  views.sort((a, b) => a.order - b.order);
}

export function getViews(): readonly ViewPlugin[] {
  return views;
}
