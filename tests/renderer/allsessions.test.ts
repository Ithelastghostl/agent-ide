// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { AllSessions, type BoardMode, type AllSessionsProps } from '../../src/renderer/components/AllSessions'
import type { Project, Session } from '@shared/types'

const projects: Project[] = [
  { id: 'p1', name: 'sample-api', repo: 'example/sample-api', localPath: '/a', hasDevcontainer: true },
  { id: 'p2', name: 'sample-cli', repo: 'example/sample-cli', localPath: '/b', hasDevcontainer: false }
]
const sessions: Session[] = [
  {
    id: 's1',
    projectId: 'p1',
    provider: 'codex',
    model: 'gpt-5-codex',
    objective: 'Fix auth',
    status: 'running',
    createdAt: 1,
    updatedAt: 1
  },
  {
    id: 's2',
    projectId: 'p1',
    provider: 'claude',
    model: 'sonnet',
    objective: 'Tests',
    status: 'running',
    createdAt: 2,
    updatedAt: 2
  },
  {
    id: 's3',
    projectId: 'p2',
    provider: 'gemini',
    model: 'pro',
    objective: 'Parse',
    status: 'idle',
    createdAt: 3,
    updatedAt: 3
  },
  {
    id: 's4',
    projectId: 'p1',
    provider: 'claude',
    model: 'haiku',
    objective: 'Old archived',
    status: 'archived',
    createdAt: 0,
    updatedAt: 0
  }
]

describe('AllSessions (NN4 global board)', () => {
  it('renders only LIVE sessions across projects, grouped by project (archived hidden)', () => {
    const el = AllSessions({
      projects,
      sessions,
      mode: 'live',
      onSetMode: () => {},
      onOpenProject: () => {},
      onOpen: () => {}
    })
    expect(el.querySelectorAll('.as-proj').length).toBe(2)
    // 3 live sessions; the archived s4 is excluded.
    expect(el.querySelectorAll('.as-row').length).toBe(3)
    expect(el.textContent).not.toContain('Old archived')
    expect(el.querySelector('.sub')?.textContent).toContain('3 live')
  })

  it('orders sessions most-recent first within a project', () => {
    let opened: { projectId: string; sessionId: string } | null = null
    const el = AllSessions({
      projects,
      sessions,
      mode: 'live',
      onSetMode: () => {},
      onOpenProject: () => {},
      onOpen: (projectId, sessionId) => {
        opened = { projectId, sessionId }
      }
    })
    // Within p1, s2 (createdAt 2) is newer than s1 (createdAt 1) → s2 renders first.
    const firstRow = el.querySelector('.as-row') as HTMLElement
    firstRow.click()
    expect(opened!.sessionId).toBe('s2')
    expect(opened!.projectId).toBe('p1')
  })

  it('S3: renders a read-only stage chip per provider row from effectiveStage', () => {
    const staged: Session[] = [
      {
        id: 's1',
        projectId: 'p1',
        provider: 'codex',
        model: 'x',
        objective: 'a',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        effectiveStage: 'fix',
        spawnedApprovalMode: 'guarded'
      }
    ]
    const el = AllSessions({
      projects,
      sessions: staged,
      mode: 'live',
      onSetMode: () => {},
      onOpenProject: () => {},
      onOpen: () => {}
    })
    const chip = el.querySelector('.as-row .stage-chip.fix')
    expect(chip).toBeTruthy()
    expect(chip!.textContent).toBe('Fix')
  })

  it('S3: guarded/auto indicator reads spawnedApprovalMode independently of stage', () => {
    // effectiveStage=fix but the pty still runs guarded (container not yet relaunched).
    const staged: Session[] = [
      {
        id: 's1',
        projectId: 'p1',
        provider: 'codex',
        model: 'x',
        objective: 'a',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        useContainer: true,
        effectiveStage: 'fix',
        spawnedApprovalMode: 'guarded'
      }
    ]
    const el = AllSessions({
      projects,
      sessions: staged,
      mode: 'live',
      onSetMode: () => {},
      onOpenProject: () => {},
      onOpen: () => {}
    })
    expect(el.querySelector('.as-row .stage-chip.fix')).toBeTruthy()
    expect(el.querySelector('.as-row .approval-ind.guarded')!.textContent).toBe('guarded')
  })

  it('S3: terminal sessions get no stage chip', () => {
    const withTerm: Session[] = [
      {
        id: 'term-1-x',
        projectId: 'p1',
        provider: 'codex',
        model: 'shell',
        objective: 't',
        status: 'running',
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const el = AllSessions({
      projects,
      sessions: withTerm,
      mode: 'live',
      onSetMode: () => {},
      onOpenProject: () => {},
      onOpen: () => {}
    })
    expect(el.querySelector('.stage-chip')).toBeNull()
  })
})

describe('AllSessions — archived mode (view + delete)', () => {
  it('shows ONLY archived sessions, with a delete action and no open-on-click', () => {
    let opened = false
    const el = AllSessions({
      projects,
      sessions,
      mode: 'archived',
      onSetMode: () => {},
      onOpenProject: () => {},
      onOpen: () => {
        opened = true
      },
      onDelete: () => {}
    })
    // Only the archived s4 shows; the 3 live ones are excluded.
    expect(el.querySelectorAll('.as-row').length).toBe(1)
    expect(el.textContent).toContain('Old archived')
    expect(el.querySelector('.sub')?.textContent).toContain('1 archived')
    const row = el.querySelector('.as-row') as HTMLElement
    expect(row.classList.contains('arch')).toBe(true)
    expect(el.querySelector('.as-del')).not.toBeNull()
    // Clicking an archived row must NOT open it (cleanup view).
    row.click()
    expect(opened).toBe(false)
  })

  it('delete button fires onDelete with the session (and not onOpen)', () => {
    let deleted: string | null = null
    let opened = false
    const el = AllSessions({
      projects,
      sessions,
      mode: 'archived',
      onSetMode: () => {},
      onOpenProject: () => {},
      onOpen: () => {
        opened = true
      },
      onDelete: (s) => {
        deleted = s.id
      }
    })
    ;(el.querySelector('.as-del') as HTMLElement).click()
    expect(deleted).toBe('s4')
    expect(opened).toBe(false)
  })

  it('the Live | Archived toggle reports a mode change', () => {
    const seen: string[] = []
    const el = AllSessions({
      projects,
      sessions,
      mode: 'live',
      onSetMode: (m) => seen.push(m),
      onOpenProject: () => {},
      onOpen: () => {}
    })
    const segs = el.querySelectorAll('.as-seg')
    expect(segs.length).toBe(2)
    ;(segs[1] as HTMLElement).click() // "Archived"
    expect(seen).toEqual(['archived'])
  })

  it('shows an empty-state when there are no archived sessions', () => {
    const liveOnly = sessions.filter((s) => s.status !== 'archived')
    const el = AllSessions({
      projects,
      sessions: liveOnly,
      mode: 'archived',
      onSetMode: () => {},
      onOpenProject: () => {},
      onOpen: () => {}
    })
    expect(el.querySelector('.as-empty')?.textContent).toContain('No archived')
    expect(el.querySelectorAll('.as-row').length).toBe(0)
  })
})

describe('AllSessions — themed header + labeled sections', () => {
  const mk = (mode: BoardMode, sess: Session[] = sessions, extra: Partial<AllSessionsProps> = {}) =>
    AllSessions({
      projects,
      sessions: sess,
      mode,
      onSetMode: () => {},
      onOpenProject: () => {},
      onOpen: () => {},
      ...extra
    })

  it('keeps exactly one board h2 "All sessions" (boot.spec strict-locator contract)', () => {
    const el = mk('live')
    const h2s = el.querySelectorAll('.allsessions h2, h2')
    // The board itself has no .allsessions ancestor in this fragment, so match h2 directly.
    expect(el.querySelectorAll('h2').length).toBe(1)
    expect(h2s[0].textContent).toBe('All sessions')
    // The h2 lives inside the themed header, alongside the action cluster.
    expect(el.querySelector('.as-header h2')).not.toBeNull()
  })

  it('labels the live board "Live Sessions" and the archived board "Project History"', () => {
    expect(mk('live').querySelector('h3.as-section')?.textContent).toBe('Live Sessions')
    expect(mk('archived').querySelector('h3.as-section')?.textContent).toBe('Project History')
  })

  it('renders the section heading even when the board is empty', () => {
    // Archived heading must survive the empty-state early return.
    const liveOnly = sessions.filter((s) => s.status !== 'archived')
    const el = mk('archived', liveOnly)
    expect(el.querySelector('h3.as-section')?.textContent).toBe('Project History')
    expect(el.querySelector('.as-empty')).not.toBeNull()
  })

  it('hosts the Open Project CTA in the header and reports its anchor rect', () => {
    let anchor: DOMRectReadOnly | null = null
    const el = mk('live', sessions, { onOpenProject: (a) => (anchor = a) })
    const cta = el.querySelector('.as-header-actions .open-cta') as HTMLElement
    expect(cta).not.toBeNull()
    expect(cta.textContent).toContain('Open project')
    cta.click()
    expect(anchor).not.toBeNull()
  })

  it('groups the Live | Archived toggle and Sync history inside the header actions', () => {
    let synced = false
    const el = mk('live', sessions, {
      onSyncHistory: async () => {
        synced = true
        return [{ step: 'push', ok: true }]
      }
    })
    expect(el.querySelector('.as-header-actions .as-toggle')).not.toBeNull()
    const sync = el.querySelector('.as-header-actions .as-sync .hsync') as HTMLElement
    expect(sync).not.toBeNull()
    sync.click()
    expect(synced).toBe(true)
  })
})
