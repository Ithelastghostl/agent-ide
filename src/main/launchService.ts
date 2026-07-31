import { randomUUID } from 'node:crypto'
import type { Provider, Session, SessionStage, ApprovalMode, Effort } from '@shared/types'
import type { Store } from './store'
import type { Runtime, TerminalRuntime } from './runtime'
import { launchArgv, resolveEffort } from './providers'
import { sessionEvents } from './sessionEvents'
import { composeLaunchPrimer } from './agentPreset'
import { stripAnsi } from './history'

// The canonical session launcher (P0.A). Every provider-session entry point —
// fresh launch, resume, model swap, stage relaunch, queue, preset — flows
// through here so the concurrency contract (admission gate, durable intent,
// promotion CAS, desired/applied reconcile, confirmed termination) is enforced
// in exactly one place. See docs/plans/v2-backlog-harness-PLAN.md.

// -------------------- pure policy helpers (unit-tested) --------------------

/** Auto-approve (container yolo flags) unlocks ONLY at stage 'fix' inside a
 *  container (P0.A/C-3). Computed from the STORE row, never renderer input. */
export function approvalMode(stage: SessionStage | null | undefined, useContainer: boolean): ApprovalMode {
  return useContainer && stage === 'fix' ? 'auto' : 'guarded'
}

/** Adjacent-only stage transitions (C-4): discussion↔playback↔fix. */
export function isAdjacentStage(from: SessionStage, to: SessionStage): boolean {
  const order: SessionStage[] = ['discussion', 'playback', 'fix']
  return Math.abs(order.indexOf(from) - order.indexOf(to)) === 1
}

/** Reconcile classification (R28/R29): does desired vs spawned require a
 *  relaunch, or is it a label-only stage change? */
export function reconcileKind(
  desired: { stage: SessionStage; provider: Provider; model: string },
  spawned: { provider: Provider; model: string; approvalMode: ApprovalMode },
  useContainer: boolean
): 'relaunch' | 'label-only' | 'none' {
  if (desired.provider !== spawned.provider || desired.model !== spawned.model) return 'relaunch'
  if (approvalMode(desired.stage, useContainer) !== spawned.approvalMode) return 'relaunch'
  return 'label-only'
}

/** Per-session container marker so an in-container process tree is identifiable
 *  for confirmed termination (R32). */
export function sessionMarker(sessionId: string): string {
  return `AGENTIDE_SESSION=${sessionId}`
}

// -------------------- admission gate (per-project) -------------------------

/** Serializes every launch/relaunch/archive/advance for a project so the
 *  concurrency invariants hold. One promise chain per projectId (R15/R16/R37). */
export class AdmissionGate {
  private chains = new Map<string, Promise<unknown>>()
  run<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(projectId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    // keep the chain alive but swallow rejection so one failure doesn't poison it
    this.chains.set(
      projectId,
      next.catch(() => undefined)
    )
    return next
  }
}

// -------------------- launch options ---------------------------------------

export interface LaunchOpts {
  projectId: string
  provider: Provider
  model: string
  objective: string
  workspace: string // main-resolved project root (renderer cwd ignored)
  useContainer: boolean
  stage?: SessionStage // fresh sessions default to 'discussion'
  agentRelPath?: string | null
  /** Per-session reasoning effort; AGENT_IDE_EFFORT outranks it at spawn. */
  effort?: Effort | null
  backlogItemIds?: string[]
  taskKind?: Session['taskKind']
  taskSubkind?: Session['taskSubkind']
  /** internal: a queue row this launch fulfils (R4-2). */
  queueItemId?: string
  queueLeaseToken?: string
}

let seq = 0
function newSessionId(): string {
  seq += 1
  return `sess-${seq}-${process.pid}`
}

/** A single per-app-run boot id — owns queue claims (R8). */
export const BOOT_ID = randomUUID()

export interface LaunchServiceDeps {
  runtime: Runtime
  store: Store
  /** Emit a pty:data-style event to the renderer. */
  onData: (id: string, chunk: string) => void
  /** Emit a session:exit-style event to the renderer. */
  onExit: (id: string, reason: 'closed' | 'crashed') => void
  /** Container is unavailable in e2e (R6-2) — refuse container launches. */
  e2eMode?: boolean
}

/** The launcher. Public methods acquire the gate; *Admitted variants assume the
 *  caller already holds it (R16/R38). */
export class LaunchService {
  readonly gate = new AdmissionGate()
  private readonly mgr: TerminalRuntime
  constructor(private readonly deps: LaunchServiceDeps) {
    this.mgr = deps.runtime.terminal
  }

  /** Fresh provider-session launch (default stage discussion → never auto-approve). */
  launchSession(opts: LaunchOpts): Promise<Session> {
    return this.gate.run(opts.projectId, () => this.launchAdmitted(opts))
  }

  /** Internal already-admitted launch. Durable intent → spawn → promote (R10/R11). */
  async launchAdmitted(opts: LaunchOpts): Promise<Session> {
    if (opts.useContainer && this.deps.e2eMode) throw new Error('container launches are disabled in e2e mode')
    const stage: SessionStage = opts.stage ?? 'discussion'
    const id = newSessionId()
    const now = Date.now()
    const mode = approvalMode(stage, opts.useContainer)

    // 1) DURABLE INTENT (before spawn): persist the row as 'starting'/'spawning'
    //    with desired == applied for this launch, plus backlog joins + queue row.
    const session: Session = {
      id,
      projectId: opts.projectId,
      provider: opts.provider,
      model: opts.model,
      objective: opts.objective || `${opts.provider} session`,
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      taskKind: opts.taskKind ?? null,
      taskSubkind: opts.taskSubkind ?? null,
      taskStatus: opts.taskKind ? 'open' : null,
      useContainer: opts.useContainer,
      desiredStage: stage,
      desiredProvider: opts.provider,
      desiredModel: opts.model,
      effectiveStage: stage,
      spawnedProvider: opts.provider,
      spawnedModel: opts.model,
      spawnedApprovalMode: mode,
      termState: 'spawning',
      runtimeVersion: 0,
      desiredVersion: 0,
      agentRelPath: opts.agentRelPath ?? null,
      cost: null,
      effort: opts.effort ?? null
    }
    this.deps.store.saveSession(session)
    if (opts.backlogItemIds?.length) this.deps.store.bindSessionBacklog(id, opts.backlogItemIds)
    if (opts.queueItemId && opts.queueLeaseToken) {
      // mark the queue row launched, bound to this session (R4-2)
      this.deps.store.markQueueLaunched(opts.queueItemId, opts.queueLeaseToken, id)
    }

    // 2) SPAWN
    try {
      this.spawnEngine(session, opts, mode)
    } catch (err) {
      // spawn failed → interrupted (idle), no auto-retry can double-spawn (R10)
      this.deps.store.setSessionStatus(id, 'idle')
      this.deps.store.saveSession({
        ...this.deps.store.getSession(id)!,
        termState: opts.useContainer ? 'uncertain' : 'terminated'
      })
      throw new Error(`failed to start ${opts.provider} session: ${(err as Error).message}`)
    }

    // 3) PROMOTE (starting → running), CAS exactly-one-row (R11)
    const promoted = this.promote(id, mode)
    if (!promoted) {
      // lost a race (archive/abandon) — kill and settle idle without overwriting
      this.mgr.kill(id)
      const cur = this.deps.store.getSession(id)
      if (cur && cur.status === 'starting') this.deps.store.setSessionStatus(id, 'idle')
      throw new Error('session was cancelled during launch')
    }
    // 4) trusted primer (auto-submitted after promotion, R39)
    this.deliverPrimer(id, opts, stage)
    sessionEvents.emitEvent('spawned', { id, projectId: opts.projectId })
    return this.deps.store.getSession(id)!
  }

  /** Promotion CAS: starting→running + termState live + applied* set, exactly one
   *  row or fail (R11). Returns success. */
  private promote(id: string, mode: ApprovalMode): boolean {
    const s = this.deps.store.getSession(id)
    if (!s || s.status !== 'starting') return false
    this.deps.store.saveSession({
      ...s,
      status: 'running',
      termState: 'live',
      spawnedApprovalMode: mode,
      runtimeVersion: (s.runtimeVersion ?? 0) + 1
    })
    return true
  }

  private spawnEngine(session: Session, opts: LaunchOpts, mode: ApprovalMode): void {
    const { cmd, args } = launchArgv({
      provider: opts.provider,
      model: opts.model,
      autoApprove: mode === 'auto',
      effort: resolveEffort(opts.effort ?? session.effort)
    })
    // Mark the process with the session marker so a container process tree is
    // identifiable for confirmed termination (R32). Container id/user/home
    // resolution + docker-exec argv are the caller's (ipc.ts) responsibility in
    // production; the marker travels on the env either way.
    this.mgr.spawn(
      { id: session.id, shell: cmd, args, cwd: opts.workspace, env: { AGENTIDE_SESSION: session.id } },
      (data) => {
        this.deps.onData(session.id, data)
        this.record(session.id, data)
      },
      ({ reason }) => this.onEngineExit(session.id, session.projectId, reason)
    )
  }

  private record(id: string, chunk: string): void {
    this.deps.store.appendTranscript(id, chunk, Date.now())
    sessionEvents.emitEvent('output', { id, chunk })
  }

  /** Engine exit: a crash/close of a live session. Marks idle (interrupted) for a
   *  crash; container sessions become termState 'uncertain' on unconfirmed loss
   *  (R34). Emits exit. Archive is a separate gated path. */
  private onEngineExit(id: string, projectId: string, reason: 'closed' | 'crashed'): void {
    const s = this.deps.store.getSession(id)
    if (!s) {
      this.deps.onExit(id, reason)
      return
    }
    if (reason === 'closed') {
      this.deps.store.saveSession({ ...s, status: 'archived', termState: 'terminated' })
      sessionEvents.emitEvent('archived', { id, projectId })
    } else {
      // unexpected loss → interrupted; container sessions are termination-uncertain
      this.deps.store.saveSession({
        ...s,
        status: 'idle',
        termState: s.useContainer ? 'uncertain' : 'terminated'
      })
    }
    sessionEvents.emitEvent('exit', { id, reason })
  }

  private deliverPrimer(id: string, opts: LaunchOpts, stage: SessionStage): void {
    // Canonical harness→agent→objective primer (gate 1): a queued/preset launch
    // gets the same uniform harness + agent body every provider launch does.
    const submitText = composeLaunchPrimer({
      objective: opts.objective,
      stage,
      agentRelPath: opts.agentRelPath
    })
    if (submitText.trim()) this.mgr.primeWhenReady(id, submitText + '\n')
  }

  // -------------------- resume / reconcile (existing sessions) --------------

  /** Reconcile a session's live engine toward its desired config (R27/R28/R29).
   *  Runs under the gate. Label-only stage moves update in place; provider/model
   *  or approval-mode deltas trigger exactly one relaunch. */
  reconcile(sessionId: string): Promise<void> {
    const s = this.deps.store.getSession(sessionId)
    if (!s) return Promise.resolve()
    return this.gate.run(s.projectId, () => this.reconcileAdmitted(sessionId))
  }

  async reconcileAdmitted(sessionId: string): Promise<void> {
    const s = this.deps.store.getSession(sessionId)
    if (!s || s.status === 'archived') return
    if (s.status === 'starting') return // deferred; the launch will settle it (R27)
    const desired = {
      stage: (s.desiredStage ?? 'discussion') as SessionStage,
      provider: (s.desiredProvider ?? s.provider) as Provider,
      model: s.desiredModel ?? s.model
    }
    const spawned = {
      provider: (s.spawnedProvider ?? s.provider) as Provider,
      model: s.spawnedModel ?? s.model,
      approvalMode: (s.spawnedApprovalMode ?? 'guarded') as ApprovalMode
    }
    const kind = reconcileKind(desired, spawned, !!s.useContainer)
    if (kind === 'none' || kind === 'label-only') {
      // label-only: update effectiveStage, no relaunch, spawned* untouched
      this.deps.store.saveSession({ ...s, effectiveStage: desired.stage })
      sessionEvents.emitEvent('stageChanged', { id: sessionId })
      return
    }
    await this.relaunchAdmitted(sessionId, desired)
  }

  /** Relaunch a running session in place (model swap / fix restart). Quiesce the
   *  old engine first (R14/R20), then re-run the durable-intent→spawn→promote. */
  private async relaunchAdmitted(
    sessionId: string,
    desired: { stage: SessionStage; provider: Provider; model: string }
  ): Promise<void> {
    const s0 = this.deps.store.getSession(sessionId)
    if (!s0) return
    // running → starting (bump runtimeVersion), then kill old generation
    this.deps.store.saveSession({
      ...s0,
      status: 'starting',
      termState: 'spawning',
      runtimeVersion: (s0.runtimeVersion ?? 0) + 1
    })
    if (this.mgr.has(sessionId)) this.mgr.kill(sessionId)
    const mode = approvalMode(desired.stage, !!s0.useContainer)
    const opts: LaunchOpts = {
      projectId: s0.projectId,
      provider: desired.provider,
      model: desired.model,
      objective: s0.objective,
      workspace: '',
      useContainer: !!s0.useContainer,
      stage: desired.stage,
      agentRelPath: s0.agentRelPath
    }
    try {
      this.respawnSameId(sessionId, s0, opts, mode)
    } catch {
      this.deps.store.saveSession({
        ...this.deps.store.getSession(sessionId)!,
        status: 'idle',
        termState: s0.useContainer ? 'uncertain' : 'terminated'
      })
      return
    }
    const s1 = this.deps.store.getSession(sessionId)!
    this.deps.store.saveSession({
      ...s1,
      status: 'running',
      termState: 'live',
      spawnedProvider: desired.provider,
      spawnedModel: desired.model,
      spawnedApprovalMode: mode,
      effectiveStage: desired.stage,
      runtimeVersion: (s1.runtimeVersion ?? 0) + 1
    })
    this.seedHistoryPrimer(sessionId)
    sessionEvents.emitEvent('spawned', { id: sessionId, projectId: s0.projectId })
  }

  private respawnSameId(id: string, s: Session, opts: LaunchOpts, mode: ApprovalMode): void {
    const { cmd, args } = launchArgv({
      provider: opts.provider,
      model: opts.model,
      autoApprove: mode === 'auto',
      effort: resolveEffort(opts.effort ?? s.effort)
    })
    this.mgr.spawn(
      { id, shell: cmd, args, cwd: opts.workspace, env: { AGENTIDE_SESSION: id } },
      (data) => {
        this.deps.onData(id, data)
        this.record(id, data)
      },
      ({ reason }) => this.onEngineExit(id, s.projectId, reason)
    )
  }

  private seedHistoryPrimer(id: string): void {
    // A relaunch (model-swap / fix restart) re-injects the FULL canonical primer —
    // harness → agent → objective → prior history — so the uniform protocol is
    // present after the engine restarts, not just the raw transcript (gate 1).
    const s = this.deps.store.getSession(id)
    const raw = stripAnsi(this.deps.store.getTranscript(id))
    const submitText = composeLaunchPrimer({
      objective: s?.objective ?? '',
      stage: s?.effectiveStage ?? s?.desiredStage ?? 'discussion',
      agentRelPath: s?.agentRelPath,
      history: raw,
      // Fail-closed: if a previously-inserted review block is in history, its
      // section is demoted so it's never auto-resubmitted (R19/R22-3).
      reviewPayloads: this.deps.store.reviewPayloadsForSession(id)
    })
    if (submitText.trim()) this.mgr.primeWhenReady(id, submitText + '\n')
  }

  // -------------------- declarative desired-state writes (R27/R38) ----------

  /** Declarative: set the desired stage (adjacent-only), bump desiredVersion,
   *  then request a reconcile. NOT under the gate (a small CAS write). */
  setDesiredStage(sessionId: string, stage: SessionStage): { ok?: true; error?: string } {
    const s = this.deps.store.getSession(sessionId)
    if (!s) return { error: 'unknown session' }
    const from = (s.desiredStage ?? 'discussion') as SessionStage
    if (from !== stage && !isAdjacentStage(from, stage)) return { error: `cannot jump ${from}→${stage}` }
    this.deps.store.saveSession({ ...s, desiredStage: stage, desiredVersion: (s.desiredVersion ?? 0) + 1 })
    void this.reconcile(sessionId)
    return { ok: true }
  }

  setDesiredModel(sessionId: string, provider: Provider, model: string): { ok?: true; error?: string } {
    const s = this.deps.store.getSession(sessionId)
    if (!s) return { error: 'unknown session' }
    this.deps.store.saveSession({
      ...s,
      desiredProvider: provider,
      desiredModel: model,
      desiredVersion: (s.desiredVersion ?? 0) + 1
    })
    void this.reconcile(sessionId)
    return { ok: true }
  }

  // -------------------- queue advancement (R16/R21/R38) ---------------------

  /** Public advancement: acquire the gate, then advance (used by enqueue,
   *  autoAdvance-enable, Start-next). */
  launchNextQueued(projectId: string): Promise<Session | null> {
    return this.gate.run(projectId, () => this.launchNextQueuedAdmitted(projectId))
  }

  /** Already-holding-gate advancement (archive calls this in-gate, R38). */
  async launchNextQueuedAdmitted(projectId: string): Promise<Session | null> {
    if (!this.deps.store.canAdvanceQueue(projectId)) return null
    const claimed = this.deps.store.claimNextQueue(projectId, BOOT_ID)
    if (!claimed) return null
    try {
      return await this.launchAdmitted({
        projectId,
        provider: claimed.provider,
        model: claimed.model,
        objective: claimed.objective,
        workspace: '',
        useContainer: claimed.useContainer,
        taskKind: claimed.taskKind,
        taskSubkind: claimed.taskSubkind,
        agentRelPath: claimed.agentRelPath,
        backlogItemIds: claimed.backlogItemIds,
        queueItemId: claimed.id,
        queueLeaseToken: claimed.leaseToken ?? undefined
      })
    } catch (err) {
      this.deps.store.markQueueFailed(claimed.id, claimed.leaseToken ?? null, (err as Error).message)
      return null
    }
  }

  // -------------------- boot reconciliation (R8/R34/R36) --------------------

  /** On startup: dead-owner queue claims re-pended/failed; host sessions left
   *  starting/running without a pty → idle/terminated; container sessions →
   *  uncertain. Then attempt advancement for autoAdvance projects. */
  reconcileOnBoot(): void {
    this.deps.store.reconcileQueueOnBoot(BOOT_ID)
    for (const s of this.deps.store.allSessions()) {
      if ((s.status === 'starting' || s.status === 'running') && !this.mgr.has(s.id)) {
        if (s.termState === 'terminated') continue // no reservation outstanding
        if (s.useContainer) this.deps.store.saveSession({ ...s, status: 'idle', termState: 'uncertain' })
        else this.deps.store.saveSession({ ...s, status: 'idle', termState: 'terminated' })
      }
    }
  }
}
