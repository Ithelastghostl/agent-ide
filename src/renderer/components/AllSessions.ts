import {
  isTerminalSession,
  type AttentionState,
  type CostSummary,
  type Project,
  type Session
} from '@shared/types'
import { stageChip, approvalIndicator, effectiveStageOf } from './StageChip'
import { attentionBadge, costChip, formatCost } from './costChip'

export type BoardMode = 'live' | 'archived'

export interface AllSessionsProps {
  projects: Project[]
  sessions: Session[]
  /** S5: ephemeral attention flags, per session id (flagged sessions only). */
  attention?: Map<string, Exclude<AttentionState, null>>
  /** S5: last-known cost summary, per session id (absent → no chip). */
  costs?: Map<string, CostSummary>
  /** Which set to show: live (default board) or archived (for cleanup). */
  mode: BoardMode
  onSetMode: (mode: BoardMode) => void
  onOpen: (projectId: string, sessionId: string) => void
  /** B8: commit+push the IDE-owned history repo; resolves per-step results. */
  onSyncHistory?: () => Promise<{ step: string; ok: boolean; skipped?: boolean; error?: string }[]>
  /** Permanently delete an archived session (shown only in archived mode). */
  onDelete?: (session: Session) => void
}

/** Sum the dollar cost across a project's sessions for the home-board rollup.
 *  Returns undefined when NO session has any cost figure (rollup hidden, never
 *  "$0"). Token-only summaries (no dollar figure) don't contribute a dollar
 *  total, so a project with only those shows no rollup. */
function projectCostRollup(
  costs: Map<string, CostSummary> | undefined,
  sessionIds: string[]
): string | undefined {
  if (!costs) return undefined
  let total = 0
  let any = false
  for (const id of sessionIds) {
    const c = costs.get(id)
    if (c?.costUSD != null) {
      total += c.costUSD
      any = true
    }
  }
  if (!any) return undefined
  return `Σ ${formatCost({ costUSD: total } as CostSummary)}`
}

/** ⌘ home: sessions across every project, grouped by project, newest first (NN4).
 *  A Live | Archived toggle switches between the live board and the archived
 *  sessions (where they can be permanently deleted). Live sessions show S5
 *  attention badges + cost chips. */
export function AllSessions(p: AllSessionsProps): HTMLElement {
  const el = document.createElement('div')
  el.className = 'allsessions'

  const archived = p.mode === 'archived'
  const shown = p.sessions
    .filter((s) => (archived ? s.status === 'archived' : s.status !== 'archived'))
    .sort((a, b) => b.createdAt - a.createdAt)

  const h2 = document.createElement('h2')
  h2.textContent = 'All sessions'
  el.appendChild(h2)

  // Live | Archived toggle.
  const seg = document.createElement('div')
  seg.className = 'as-toggle'
  for (const m of ['live', 'archived'] as const) {
    const b = document.createElement('button')
    b.className = 'as-seg' + (p.mode === m ? ' on' : '')
    b.textContent = m === 'live' ? 'Live' : 'Archived'
    b.onclick = () => {
      if (p.mode !== m) p.onSetMode(m)
    }
    seg.appendChild(b)
  }
  el.appendChild(seg)

  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = archived
    ? `${shown.length} archived across ${p.projects.length} projects`
    : `${shown.length} live across ${p.projects.length} projects`
  el.appendChild(sub)

  if (p.onSyncHistory) {
    const actions = document.createElement('div')
    actions.className = 'as-actions'
    const btn = document.createElement('button')
    btn.className = 'hsync'
    btn.textContent = 'Sync history'
    const result = document.createElement('span')
    result.className = 'hsync-result'
    btn.onclick = async () => {
      btn.disabled = true
      result.className = 'hsync-result'
      result.textContent = 'syncing…'
      try {
        const steps = await p.onSyncHistory!()
        const bad = steps.find((s) => !s.ok)
        if (bad) {
          result.className = 'hsync-result err'
          result.textContent = `${bad.step} failed: ${bad.error ?? 'unknown error'}`
        } else {
          result.textContent = steps.some((s) => s.skipped) ? 'already up to date' : 'history pushed'
        }
      } catch (err) {
        result.className = 'hsync-result err'
        result.textContent = (err as Error).message
      }
      btn.disabled = false
    }
    actions.append(btn, result)
    el.appendChild(actions)
  }

  if (shown.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'as-empty'
    empty.textContent = archived ? 'No archived sessions.' : 'No live sessions.'
    el.appendChild(empty)
    return el
  }

  for (const proj of p.projects) {
    const projSessions = shown.filter((s) => s.projectId === proj.id)
    if (projSessions.length === 0) continue

    const group = document.createElement('div')
    group.className = 'as-proj'
    const head = document.createElement('div')
    head.className = 'h'
    head.textContent = proj.name
    // S5: per-project cost rollup on the home board (hidden when no dollar cost).
    const rollup = projectCostRollup(
      p.costs,
      projSessions.map((s) => s.id)
    )
    if (rollup) {
      const r = document.createElement('span')
      r.className = 'as-rollup'
      r.textContent = rollup
      r.title = 'Total session cost this project'
      head.appendChild(r)
    }
    group.appendChild(head)

    for (const s of projSessions) {
      const row = document.createElement('div')
      row.className = 'as-row' + (archived ? ' arch' : '')
      const pv = document.createElement('span')
      pv.className = `pv ${s.provider}`
      const nm = document.createElement('span')
      nm.className = 'nm'
      nm.textContent = s.objective
      const mdl = document.createElement('span')
      mdl.className = 'mdl'
      mdl.textContent = s.model
      // M-LOG-a (§4.5.2): task label chip + lifecycle status. Terminals/unlabeled
      // sessions have no taskKind → no chip.
      const chips: HTMLElement[] = []
      // S3: read-only stage chip (effectiveStage) + guarded/auto indicator
      // (spawnedApprovalMode) for provider sessions. Terminals have no stage.
      if (!isTerminalSession(s.id)) {
        chips.push(stageChip(effectiveStageOf(s)))
        const ind = approvalIndicator(s.spawnedApprovalMode, s.status)
        if (ind) chips.push(ind)
      }
      if (s.taskKind) {
        const chip = document.createElement('span')
        chip.className = `task-chip ${s.taskKind}`
        chip.textContent = s.taskKind === 'product' && s.taskSubkind ? s.taskSubkind : s.taskKind
        chips.push(chip)
        if (s.taskStatus && s.taskStatus !== 'open') {
          const ts = document.createElement('span')
          ts.className = `task-status ${s.taskStatus}`
          ts.textContent = s.taskStatus
          chips.push(ts)
        }
      }
      const stt = document.createElement('span')
      stt.className = 'stt'
      stt.textContent = s.status
      // S5: attention badge + cost chip (each hidden when absent).
      const att = attentionBadge(p.attention?.get(s.id))
      const cost = costChip(p.costs?.get(s.id))
      row.append(pv, nm, ...chips, ...(att ? [att] : []), mdl, ...(cost ? [cost] : []), stt)

      if (archived && p.onDelete) {
        // Delete action — opening the row is not useful for archived chats; the
        // primary action here is cleanup.
        const del = document.createElement('span')
        del.className = 'as-del'
        del.textContent = '🗑'
        del.title = 'Delete permanently'
        del.onclick = (e) => {
          e.stopPropagation()
          p.onDelete!(s)
        }
        row.appendChild(del)
      } else {
        row.onclick = () => p.onOpen(proj.id, s.id)
      }
      group.appendChild(row)
    }
    el.appendChild(group)
  }

  return el
}
