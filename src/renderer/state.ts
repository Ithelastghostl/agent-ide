import type { Project, Session } from '@shared/types'

/** App state. Projects/sessions are loaded from the main-process store at boot. */
export interface AppState {
  projects: Project[]
  sessions: Session[]
  currentProjectId: string | null
  activeSessionId: string | null
  view: 'cockpit' | 'home' | 'backlog'
}

// B13: sample/mock data moved to tests/fixtures/mockData.ts — it was unused at
// runtime and only bloated the renderer bundle.

/** Boot empty: open on the home board with no project loaded (item 1).
 *  Real projects/sessions are hydrated from the store at startup. */
export function initialState(): AppState {
  return {
    projects: [],
    sessions: [],
    currentProjectId: null,
    activeSessionId: null,
    view: 'home'
  }
}

/** Live (non-archived) sessions for a project — what the cockpit shows. */
export function liveSessionsFor(sessions: Session[], projectId: string): Session[] {
  return sessions.filter((s) => s.projectId === projectId && s.status !== 'archived')
}

/** Count of running/idle (non-archived) sessions per project — drives rail badges. */
export function liveCounts(sessions: Session[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of sessions) {
    if (s.status === 'archived') continue
    out[s.projectId] = (out[s.projectId] ?? 0) + 1
  }
  return out
}
