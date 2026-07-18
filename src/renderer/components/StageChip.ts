import type { ApprovalMode, Session, SessionStage, SessionStatus } from '@shared/types'

// S3 (feat/harness-ux): stage chips + adjacent-only advance UI. The renderer
// reads two INDEPENDENT fields off the session row (R28/R29/R30-minor):
//   - effectiveStage       → the current label (discussion/playback/fix)
//   - spawnedApprovalMode  → the ACTUAL mode the LIVE pty was spawned with
//                            ('guarded'/'auto'). A container session stays
//                            'guarded' until it RELAUNCHES in fix mode, so the
//                            two can legitimately disagree between an advance and
//                            the reconcile that applies it.

const STAGE_ORDER: SessionStage[] = ['discussion', 'playback', 'fix']

const STAGE_LABEL: Record<SessionStage, string> = {
  discussion: 'Discussion',
  playback: 'Playback',
  fix: 'Fix'
}

/** The next adjacent stage (discussion→playback→fix), or null at the top. */
export function nextStage(stage: SessionStage): SessionStage | null {
  const i = STAGE_ORDER.indexOf(stage)
  return i >= 0 && i < STAGE_ORDER.length - 1 ? STAGE_ORDER[i + 1] : null
}

/** Auto-approve unlocks ONLY at stage 'fix' inside a container — mirrors the
 *  main-process approvalMode policy (launchService) so the renderer can predict
 *  whether an advance is label-only or triggers an engine relaunch. */
export function approvalModeFor(stage: SessionStage, useContainer: boolean): ApprovalMode {
  return useContainer && stage === 'fix' ? 'auto' : 'guarded'
}

/** Does advancing this session to `to` require an engine RELAUNCH (vs a pure
 *  label change)? A relaunch happens only when the session has a LIVE engine
 *  (starting/running) in a container AND the target stage flips the approval
 *  mode the pty was spawned with. Host sessions are always label-only. */
export function advanceRequiresRelaunch(session: Session, to: SessionStage): boolean {
  const live = session.status === 'running' || session.status === 'starting'
  if (!live || !session.useContainer) return false
  const spawned = (session.spawnedApprovalMode ?? 'guarded') as ApprovalMode
  return approvalModeFor(to, true) !== spawned
}

/** The current effective stage (falls back to 'discussion' for legacy/null rows). */
export function effectiveStageOf(session: Session): SessionStage {
  return (session.effectiveStage ?? session.desiredStage ?? 'discussion') as SessionStage
}

/** A read-only stage chip (effectiveStage) — used on session rows. */
export function stageChip(stage: SessionStage): HTMLElement {
  const chip = document.createElement('span')
  chip.className = `stage-chip ${stage}`
  chip.textContent = STAGE_LABEL[stage]
  chip.title = `Stage: ${STAGE_LABEL[stage]}`
  return chip
}

/** A guarded/auto indicator reading spawnedApprovalMode — the mode the LIVE pty
 *  actually runs with. Hidden for sessions with no spawned engine yet. */
export function approvalIndicator(
  mode: ApprovalMode | null | undefined,
  status: SessionStatus
): HTMLElement | null {
  // Only meaningful once an engine has been spawned (not archived).
  if (!mode || status === 'archived') return null
  const el = document.createElement('span')
  el.className = `approval-ind ${mode}`
  el.textContent = mode === 'auto' ? 'auto' : 'guarded'
  el.title =
    mode === 'auto'
      ? 'Engine running with auto-approve (fix mode, container)'
      : 'Engine running guarded (approval required)'
  return el
}

export interface StageControlProps {
  session: Session
  /** Advance the session to the next adjacent stage (declarative setStage). */
  onAdvance: (to: SessionStage) => void
  /** Omit the advance button (read-only contexts like list rows). */
  readOnly?: boolean
}

/** The confirmation prompt shown before a fix-mode engine relaunch (R28/R18-2). */
export const FIX_RESTART_CONFIRM = 'Playback approved → restart engine in fix mode'

export interface AdvanceFlowDeps {
  /** Ask the user to confirm a fix-mode relaunch. Resolves true to proceed. */
  confirm: (message: string) => Promise<boolean>
  /** The declarative session:setStage bridge call. */
  setStage: (sessionId: string, stage: SessionStage) => Promise<{ ok?: true; error?: string }>
}

/** Advance a session to `to`, confirming FIRST when the advance would relaunch a
 *  running container engine in fix mode. Returns the setStage result, or null if
 *  the user cancelled the confirm. Pure of any specific UI/IPC — callers inject
 *  the confirm dialog and the bridge call, so this is directly testable. */
export async function runAdvanceFlow(
  session: Session,
  to: SessionStage,
  deps: AdvanceFlowDeps
): Promise<{ ok?: true; error?: string } | null> {
  if (advanceRequiresRelaunch(session, to)) {
    const proceed = await deps.confirm(FIX_RESTART_CONFIRM)
    if (!proceed) return null
  }
  return deps.setStage(session.id, to)
}

/** The full stage control for the cockpit header: the effective-stage chip, the
 *  live guarded/auto indicator, and an adjacent-only advance button. */
export function stageControl(p: StageControlProps): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'stage-control'

  const stage = effectiveStageOf(p.session)
  wrap.appendChild(stageChip(stage))

  const ind = approvalIndicator(p.session.spawnedApprovalMode, p.session.status)
  if (ind) wrap.appendChild(ind)

  const next = nextStage(stage)
  if (!p.readOnly && next) {
    const btn = document.createElement('button')
    btn.className = 'stage-advance'
    btn.textContent = `→ ${STAGE_LABEL[next]}`
    btn.title = advanceRequiresRelaunch(p.session, next)
      ? `Advance to ${STAGE_LABEL[next]} — restarts the engine in fix mode`
      : `Advance to ${STAGE_LABEL[next]}`
    btn.onclick = (e) => {
      e.stopPropagation()
      p.onAdvance(next)
    }
    wrap.appendChild(btn)
  }

  return wrap
}
