# Backlog v2 (round 2) — Agent IDE v2: backlog-driven development harness

Scope unchanged (user-approved): backlog core + Linear (secure per-project MCP) + uniform
harness + all 10 cockpit features; subagents on worktree branches; consolidate on dev; push.
This revision folds in ALL 21 round-1 findings. Dispositions at the end.

## Phase 0 — Shared foundation (main agent; FROZEN after gate)

### P0.A Architecture seams (collision safety — C-2)
- src/main/launchService.ts — THE canonical session launcher. All entry points (fresh
  launch, resume/reconnect, model swap, queue, agent preset, linear/backlog launch) call
  launchSession(opts)/relaunchSession(sessionId, overrides). It owns: validation (main-
  resolved project root — renderer cwd is IGNORED, resolved from Store.projectRoot, C-5),
  argv build, container context, spawn→persist atomicity (spawn, then session+join rows
  in ONE transaction; on persistence failure kill the pty — C-6), primer assembly, port
  watch, stage policy. ipc.ts session:launch/session:resume become thin delegates.
- Auto-approve policy (C-3): computed ONLY here as
  storedStage === 'fix' && useContainer — from the STORE row, never renderer payloads.
- Stage model (C-4): stages are adjacent-only (discussion→playback→fix) via
  session:setStage. Because approval flags are fixed at spawn, entering 'fix' on a
  RUNNING container session triggers an automatic engine relaunch through
  relaunchSession (same id, history primer — the existing resume mechanics), surfaced in
  UI as "restarting in fix mode". Host sessions never get auto-approve; stage is labeling.
- Feature IPC registrars: registerIpc becomes a composition root calling
  registerBacklogIpc/registerGitIpc/registerQueueIpc/registerSearchIpc/registerLinearIpc/
  registerAttentionIpc/registerHarnessIpc(deps) — each in its own src/main/ipc/<area>.ts.
  Foundation creates ALL registrar files with typed handlers (implemented or typed
  {error:'not-implemented'}); streams edit ONLY their own registrar + their own modules.
- Session event bus (C-2): src/main/sessionEvents.ts — EventEmitter for
  {spawned, output(id, chunk), exit(id, reason), archived, stageChanged} emitted by
  launchService/store; consumed by attention (S5), queue (S6), cost (S5), snapshots (S4).
  recordOutput moves into launchService and emits output events.
- Renderer composition seam: main.ts gains a small view-registry (route: 'cockpit' |
  'board' | 'backlog' | 'search-overlay' ...) and a per-feature panel mount contract so
  stream UIs are separate components with minimal main.ts diffs.
- Verification seam (C-21): NO window hooks exposing argv/tokens. Gating and primer
  verified via main-process integration tests against FakeTerminalRuntime (spawns[] and
  primed[] already recorded). e2e always sets AGENT_IDE_DB/HISTORY/LIBRARY/HARNESS/
  PROJECTS/LINEAR_AUTH temp overrides.

### P0.B Schema (all additive; every stream field present — C-1)
- backlog_items(id PK, projectId NOT NULL, kind CHECK in epic|goal|task|ticket,
  title NOT NULL, bodyMd, status CHECK in icebox|planned|in-session|done,
  source CHECK in manual|agent|linear|generated, parentId NULL, linearId NULL,
  linearUrl NULL, contentHash NULL, createdAt, updatedAt).
  Hierarchy rules (C-8), enforced in Store methods (app-level; SQLite FKs off by default):
  parent must exist, same project; allowed nesting: epic→(goal|task|ticket),
  goal→(task|ticket); task/ticket are leaves; self/cycle rejected (walk-up check).
  Delete: children re-parent to the deleted node's parent (never cascade-delete).
  Indexes: (projectId,status), (parentId); UNIQUE(projectId,linearId) WHERE linearId
  NOT NULL. migrateProjectIds cascade extended to backlog_items/session_queue/snapshots.
- Tickets unification (C-7): one-time migration copies existing tickets rows into
  backlog_items (kind 'ticket', source 'generated', id 'bl-'+ticketId, status 'done',
  contentHash for idempotency); finalizeTicket() extends its EXISTING transaction to also
  upsert the backlog row. tickets table remains provenance/log-view; Backlog tab reads
  ONLY backlog_items; generated items are read-only in the UI (edit/delete disabled).
- session_backlog(sessionId, itemId, PK both). Item status auto-moves: →'in-session' on
  bind at launch; back to 'planned' when its ONLY bound session archives un-ticketed;
  'done' when a bound session tickets it (multi-session: any tickets → done).
  Unlink allowed from UI; launch failure rolls back joins (same transaction).
- session_queue(id PK, projectId, objective, provider, model, useContainer, taskKind,
  taskSubkind, agentRelPath NULL, backlogItemIds JSON, position, state CHECK in
  pending|launching|launched|failed, attempts, launchedSessionId NULL, lastError NULL,
  createdAt). projects gains autoAdvance INT default 0. Claim protocol (C-11):
  claimNext(projectId) = single UPDATE ... SET state='launching' WHERE id = (SELECT id
  ... state='pending' ORDER BY position LIMIT 1) RETURNING — atomic in SQLite;
  completion trigger is EXACTLY sessionEvents 'archived' (nothing else); boot recovery:
  state='launching' rows older than 5min → 'failed' (attempts+1); attempts>=2 stays
  failed with lastError. Queue launches carry required task labels (validate.ts reused).
- snapshots(id PK, projectId, sessionId NULL, treeSha, commitSha, createdAt).
  Snapshot semantics (C-12): PROJECT-scoped baseline captured non-mutating via temp
  index: GIT_INDEX_FILE=<tmp> git add -A (temp index only) → write-tree → commit-tree →
  tag refs/agentide/snap-<id>. Captures staged+unstaged+untracked; working tree never
  touched. Diff pane is labeled "project changes since snapshot" (concurrent sessions
  share the tree — documented, per-session attribution is out of scope this run).
  Rollback (C-12): preview-first IPC git:rollbackPreview(snapId) lists per-file changes;
  apply = git restore --source=<tag> -- <tracked paths> after a double-confirm modal;
  files that did not exist at snapshot are LISTED but never deleted (no-deletion rule).
- sessions ADD stage TEXT NULL, agentRelPath TEXT NULL, costJson TEXT NULL.
  attention is EPHEMERAL main-process state (C-20), NOT persisted; separate from
  SessionStatus; cleared on pty:write and on new output; one notification per episode
  (episode = quiet→flagged→cleared), debounced 30s, only when app unfocused.
- FTS (C-9): external-content tables —
  transcripts_fts USING fts5(chunk, content='transcripts', content_rowid='rowid') kept in
  sync inside Store.flush()'s transaction (INSERT INTO transcripts_fts(rowid, chunk));
  backlog_fts USING fts5(title, bodyMd, content='backlog_items', content_rowid='rowid')
  synced in saveBacklogItem/delete (delete + re-insert per FTS5 external-content rules);
  rebuild command ('insert into ..._fts(..._fts) values('rebuild')') on migration.
  Query API escapes user input by wrapping each term in double quotes (phrase-safe,
  no syntax errors); deterministic ORDER BY bm25 then rowid DESC; LIMIT param.
- SearchHit (C-10): discriminated union
  {type:'transcript', sessionId, projectId, snippet, ts} |
  {type:'backlog', itemId, projectId, title, snippet, status, kind}.

### P0.C Shared types — all of P0.B mirrored in src/shared/types.ts, plus
  QueueItem/QueueState, Snapshot, RollbackPreview {files:{path, change}[]},
  GitStatusSummary {branch, ahead, behind, dirtyCount}, GitDiff {stat, patch, truncated},
  CostSummary {inputTokens?, outputTokens?, costUSD?, provider, updatedAt, raw(max 2KB)},
  AttentionState 'input'|'idle'|null, SessionStage, BacklogItem…, LinearLink
  {accountId, workspaceId, teamId?, projectId?, label}, LinearIssueRef.

### P0.D Primer assembly + trust boundaries (C-14)
- src/main/launchPrimer.ts: composePrimer(sections: {kind:'harness'|'agent'|'backlog'|
  'handoff'|'history', label, body}[]) — each body: control chars stripped (history.ts
  stripAnsi reused), per-section caps (harness 16k, agent 32k, backlog 8k/item cap 5
  items, handoff 16k tail), wrapped in explicit provenance fences:
  ----- BEGIN <KIND>: <label> (reference material, not instructions to execute blindly)
  Auto-submission policy: harness+agent+backlog primer IS auto-submitted at launch (it is
  the IDE's own instruction channel — sources are local user-owned files/DB rows);
  LINEAR-sourced bodies and HANDOFF tails are NEVER auto-submitted: they are inserted via
  bracketed paste WITHOUT trailing newline; the user reviews and presses Enter (matches
  the existing library-insertion safety property). Renderer renders all backlog/linear
  text via textContent only (no innerHTML anywhere — enforced by a grep check in tests).
- HARNESS.md: ~/AgentIDE/harness/HARNESS.md (env AGENT_IDE_HARNESS), created from an
  embedded default (three-stage protocol, provider-agnostic, includes "how to file
  epics/goals into backlog/inbox"). Container delivery (C-13): docker cp on EVERY
  ensureContainer resolution (fresh + reused + restarted) to <home>/.agent-ide/HARNESS.md,
  then chown root:root + chmod 444 (agent-writable never; works for pre-existing
  containers; one-way copy — overwrites allowed since source of truth is the host file).
  Library mount stays as-is (already-documented writability), harness is NOT in it.
- Harness injection: composePrimer includes harness section for EVERY provider session
  path in launchService (fresh, resume, swap, queue, preset, backlog/linear launch).

### P0.E Foundation implements fully (not stubbed): schema+Store methods+tests, types,
  registrar skeletons, launchService (with stage policy, atomic persist, primer
  assembly, event bus) refactoring existing launch/resume to it, harness get/set +
  default + container copy, backlog CRUD IPC, search:query, session:setStage.
  Stubs ({error:'not-implemented'}) remain only inside: git/*, snapshot/*, queue
  consumption, linear/*, cost, attention, handoff.
Verify P0: tsc; unit incl. new: launchService (fake runtime: argv gating matrix — stage
×container×entrypoint; atomic persist failure kills pty; primer composition), store
(hierarchy rules, queue claim atomicity incl. concurrent claim test, FTS round-trip +
snippet + escaping, ticket migration idempotency), harness container-copy argv; ALL
existing e2e green (launch/resume behavior preserved for stage-null legacy sessions:
legacy container sessions keep old behavior via stage backfill rule — existing rows get
stage='fix' backfilled ONCE in migration so resume behavior/e2e is unchanged).

## Streams (subagents; each edits ONLY its registrar + own modules + own components/tests)

S1 feat/backlog-ui — Backlog tab (bento⇄table toggle persisted, CRUD modals, hierarchy
  grouping, status moves, read-only generated rows), "work on now" selection feeding
  launchService (backlogItemIds in validated launch request), inbox ingestion
  (src/main/backlogInbox.ts): fs.watch+interval rescan of <project>/backlog/inbox,
  frontmatter {kind, title, parent-title?}, settle delay 500ms, 256KB cap, symlink-
  confined (confinedPath), contentHash dedupe (edited file = NEW item only if hash new;
  ingested files moved to inbox/ingested/, malformed to inbox/rejected/ with .reason.txt
  — moves not deletes) (C-18). e2e: CRUD via UI; inbox file → item appears; select →
  launch (terminal) → join row + status 'in-session'.
S2 feat/linear-mcp — full protocol client (C-15/16/17):
  src/main/linear/{oauth.ts,mcpClient.ts,linearService.ts,ipc}. OAuth 2.1: protected-
  resource metadata discovery → auth-server metadata → DYNAMIC CLIENT REGISTRATION →
  PKCE authorization-code on loopback 127.0.0.1:<random high port> exact-URI, state+
  verifier bound single-use, 120s timeout, listener teardown; tokens at
  ~/AgentIDE/linear/<accountId>.json — dir 0700, atomic write then chmod 0600, symlink-
  rejected; refresh with rotation + in-process mutex; logout=file removal + revocation
  call if advertised. ALL logging redacts headers/tokens/URLs/error bodies.
  MCP: Streamable HTTP (POST + optional SSE responses), initialize/version negotiation,
  notifications/initialized, Mcp-Session-Id header handling, tools/list discovery with
  an ALLOWLIST (list/search issues, get issue, update state, create comment — matched by
  name pattern + schema validation), pagination via cursor, request timeout+cancel,
  reinitialize on session-expiry. linear:link stores LinearLink (account+workspace+team/
  project ids) in projects.linearRef JSON (column added in P0). Pull: paginated issue
  list → upsert by UNIQUE(projectId,linearId) (update title/body/url/state-mapped
  status; local manual edits to linear rows disallowed in UI). Write-back: explicit
  per-action UI with PREVIEW modal (exact state target/comment text shown), idempotent
  (comment includes session id marker; state change no-ops if already there), typed
  result envelope surfaced. Tests: fake MCP server fixture implementing the full
  handshake (auth challenge, registration, token, initialize, tools/list, paginated
  tools/call, session-expiry reinit) — protocol-path coverage, not just happy path.
  Live OAuth = user-acceptance checklist.
S3 feat/harness-ux — stage chips + adjacent-only advance UI (fix advance on a running
  container session triggers the relaunch flow with confirm "Playback approved → restart
  engine in fix mode"), guarded/yolo indicator on session rows, harness editor modal.
  Integration tests on the launchService gating matrix UI paths; e2e: stage chips,
  advance discussion→playback, fix confirm dialog appears.
S4 feat/git-supervision — implement git registrar: status/diff (porcelain v2 parsers,
  diff --stat + bounded patch 512KB truncated flag), snapshot create on provider-session
  launch (event-bus 'spawned', skip non-repos silently), rollbackPreview/apply as per
  P0.B contract; renderer: rail badges, Diff tab (plain <pre>, textContent), snapshot
  list + preview modal + double-confirm apply. Unit: parsers on fixtures; e2e: temp git
  repo → badge/diff/snapshot ref exists; rollback preview lists seeded change.
S5 feat/attention-cost — attention monitor on event bus (per-session line buffer;
  quiet>=8s AND last non-empty cleaned line matches prompt heuristics OR provider idle
  banners; ephemeral state + renderer badges + Electron Notification per episode when
  unfocused, cleared on input/output); cost parser on same buffered lines (per-provider
  regex table, last-summary-wins, raw capped 2KB, absent → chip hidden not $0).
  Unit-tested on fixture transcripts (true/false-positive matrix); e2e badge via echo.
S6 feat/orchestration — queue drawer UI + registrar consumption: on 'archived' event,
  if project.autoAdvance and no other running session for project → claimNext →
  launchService (full task labels); failure surfaces lastError chip; boot recovery per
  P0.B. Split view (two-pane cockpit toggle, second terminal mount) + session:handoff:
  cleaned tail → target via bracketed paste, NO trailing newline, never auto-submitted
  (C-14); target in fix mode shows a warning banner first. e2e: two terminals + auto-
  advance; handoff text lands unsubmitted (history file shows paste markers, no exec).
S7 feat/search-ui — ⌘K overlay on the renderer seam: debounced search:query, grouped
  union results (transcript/backlog), Enter navigates (session select / backlog tab
  focus). e2e: seeded transcript + backlog item both findable; syntax chars don't error.
S8 feat/agent-presets — "Launch session" on agent items → ModelPicker prefill +
  agentRelPath through launchService; session chip shows agent name; primer content
  verified via FakeTerminalRuntime integration test (primed[] contains fenced agent
  body after harness section). e2e: flow chrome (picker opens prefilled, chip renders).

## Consolidation (main agent)
Branch feat/v2-foundation first. Merge order: S1→S3→S7→S5→S4→S8→S6→S2; tsc+unit after
each; full gate at end (build/tsc/unit/native-gate/e2e/container smoke) → merge dev →
push dev + all stream branches. Conflicts resolved by me; no force-push.

## Round-2 revisions (all folded in)
R2-1: fresh provider sessions get a MAIN-OWNED default stage='discussion' assigned inside
launchService before spawn; fresh launches NEVER get auto-approve (discussion≠fix by
construction). Yolo flags are only reachable via relaunchSession, which reads stage from
the Store row. Legacy rows backfilled stage='fix' once (P0.E) so existing behavior holds.
R2-2: relaunch exit safety is already provided by PtyManager's per-id generation tokens
(a replaced proc's exit is dropped before any callback). Made an explicit acceptance
criterion: integration test proves relaunch-to-fix neither archives the session nor
emits 'archived' to the queue.
R2-3: session_queue gains claimedAt; claimNext sets state='launching', claimedAt=now,
attempts=attempts+1 in the same atomic UPDATE...RETURNING. Recovery: state='launching'
AND claimedAt < now-5min → 'failed' (attempts already counted at claim).
R2-4: backlog status = transactional recomputeItemStatus(itemId): 'done' if ANY bound
session is ticketed; else 'in-session' if ANY bound session is running; else 'planned'.
Invoked (inside the owning transaction) on session archive, ticket finalize, unlink,
and bind. Deleting a bound item: refused while any bound session is running; otherwise
the delete transaction also removes its session_backlog rows.
R2-5: rollback apply uses `git restore --source=<tag> --staged --worktree -- <paths>`
(index AND worktree restored together); paths absent from the snapshot are listed,
never deleted.
R2-6: composePrimer sections carry a MAIN-DERIVED trust field ('trusted'|'review'):
harness/agent/manual+agent+generated-backlog/history → trusted; linear-sourced backlog
and handoff → review. It returns {submitText, reviewText}: submitText is auto-submitted
at launch; reviewText is delivered as bracketed paste with NO trailing newline (user
reviews + presses Enter). history section cap 16k (buildPrimer's existing cap), trusted,
auto-submitted (unchanged resume behavior). Mixed selections therefore split cleanly.
R2-7: agentRelPath is validated in launchService: confinedPath(libraryDir(), relPath)
(already symlink-hardened) AND membership in scanLibrary(libraryDir()).agents (registry
check) — absolute paths, traversal, and non-agent files rejected before any read.

## Round-3 revisions (all folded in)
R3-1: P0 PREDECLARES the complete v2 bridge surface — every stream's methods and event
subscriptions land in preload/bridge.ts + vite-env.d.ts during foundation (frozen with
the IPC names). Streams touch neither file.
R3-2: serialized primer delivery. ptyManager gains deliverAfterQuiet(id, data, opts)
(generation-scoped, chainable). launchService protocol: (1) primeWhenReady submits
submitText; (2) ONLY after that write has fired and a subsequent quiet window (≥800ms,
hard cap 15s) elapses, reviewText is bracket-pasted with no newline. Integration test
with FakeTerminalRuntime scripted output proves strict ordering (review text never
interleaves the trusted primer processing).
R3-3: exactly-once queue advancement:
  - Store.archiveSession becomes a guarded transition (UPDATE...WHERE status!='archived',
    returns changed) and the 'archived' event is emitted post-commit ONLY on a real
    transition — duplicate archive paths (explicit + pty exit) collapse to one event.
  - Suppression set covers relaunch kills AND persistence-compensation kills (flag before
    kill; pty generation already drops replaced-proc exits).
  - Advancement serialized per project via a promise chain keyed by projectId.
  - Boot reconciliation: persisted 'running' sessions without a live pty → 'idle' at
    startup; queue advancement's "no other running session" check = store status AND
    mgr.has() both.
R3-4: e2e provider shims. Foundation adds e2e/fixtures/provider-shims/{claude,codex,
gemini} (inert scripts: print banner, echo stdin, idle) and an e2e helper that prepends
the shim dir to PATH in every electron.launch env. ALL specs that launch provider
sessions (existing tasklog + all new v2 specs) use it — no e2e can ever reach a real
authenticated CLI or submit a billed prompt.
R3-5: git command hardening: rollback = `git --literal-pathspecs restore --source=<tag>
--staged --worktree --pathspec-from-file=<tmpfile> --pathspec-file-nul` restricted to
paths PRESENT in the snapshot tree (absent paths listed, never touched). Snapshot
capture: GIT_INDEX_FILE=<fresh nonexistent tmp path>; seed `git read-tree HEAD` (or
--empty on unborn HEAD); `git add -A`; `write-tree`; `commit-tree <tree> -m <msg>` with
explicit GIT_AUTHOR_*/GIT_COMMITTER_* env (agent-ide identity) — no hangs, no identity
dependence; tmp index removed after.
R3-minors: FTS term escaping doubles embedded double-quotes before wrapping; the harness
0444 in-container guarantee is documented as applying to non-root sessions (sessions
exec as the non-root remoteUser by design; a root agent could bypass — accepted +
documented); Linear protocol approach confirmed against Linear's own MCP docs.

## Round-4 revisions (all folded in)
R4-1: composePrimer gains an 'objective' section kind (trusted, 2KB cap, fenced) included
for EVERY provider launch (fresh, queued, preset, backlog/linear) — the typed objective
is auto-submitted so no launch starts task-less. Integration test asserts submission.
R4-2: queue-launch atomicity is a P0 launchService contract: launchSession(opts) accepts
internal queueItemId; the spawn→persist transaction ALSO executes UPDATE session_queue
SET state='launched', launchedSessionId=<sessionId> WHERE id=? AND state='launching';
any launch failure durably marks the row 'failed' with lastError in the same error path.
S6 only wires the trigger; it never touches the transition itself.
R4-3: in-container harness lives at /opt/agent-ide/HARNESS.md — docker cp + chown -R
root:root /opt/agent-ide + chmod 0755 dir / 0444 file. Root-owned parent OUTSIDE any
user-writable home: a non-root session cannot unlink/rename/recreate it (root-agent
bypass remains the documented accepted risk). The harness text references this path.

## Round-5 revisions (all folded in)
R5-1: backlog_items gains remoteStatus TEXT NULL (Linear's state-mapped value, written
ONLY by pull) alongside the local lifecycle status (written ONLY by recomputeItemStatus/
manual moves — pull never touches it). Display precedence for linear-sourced rows:
local 'done' wins; else remoteStatus shown as the badge with the local status as the
session-binding state. No single-column contention remains; both authorities persist.
R5-2: startup queue reconciliation extended: after stale-claim recovery, for every
project with autoAdvance=1, no running session (store status AND live pty), and pending
rows → run the normal serialized advancement (atomic claimNext). Combined with the
guarded archive transition this yields at-least-once wakeup with exactly-once claim
across restarts (claim atomicity dedupes; a crash post-commit pre-event is healed at
next boot; accepted residual: advancement waits for next app start if the app dies in
that window — inherent to a desktop app without a daemon, recorded).

## Round-6 revisions (all folded in)
R6-1: P0.B adds projects.linearRef TEXT NULL (additive migration) — S2 consumes only.
R6-2: v2 e2e NEVER launches container sessions (explicit constraint in every stream's
spec; the e2e helper asserts useContainer===false on launch payloads). Container-path
behavior is covered by FakeContainerRuntime integration tests and the gated container
smoke (which intentionally uses the real codex CLI, as today). Host-side shims still
guard every host e2e launch.
R6-3: snapshot capture is an AWAITED pre-spawn launch hook: launchService exposes a
registered beforeSpawn hook seam (foundation: default no-op; S4 registers the snapshot
implementation). The hook completes (or resolves null on non-repo/failure, logged)
BEFORE the pty spawns — the baseline can never be contaminated by session output, and
primer delivery starts strictly after.
R6-4: reviewText is NEVER auto-delivered on any timer. It is surfaced in the renderer as
a pending "Review & insert" panel on the session (count badge); the user clicks to
bracket-paste it (no trailing newline) at a moment of their choosing — the same
interaction contract as library insertion today. deliverAfterQuiet is dropped from the
plan; no readiness heuristic gates untrusted text.

## Round-7 revisions — consistency sweep (supersedes contradicted earlier text)
The following earlier-round text is REMOVED/superseded; where later rounds conflict with
earlier ones, the LATEST round governs:
- R3-2's timed reviewText delivery and deliverAfterQuiet are DROPPED (R6-4 governs):
  primer delivery = submitText only via primeWhenReady; reviewText exists solely behind
  the pending-review API below. S6 handoff = pending-review, never direct insertion.
- P0.A/S4 snapshot-on-'spawned' is DROPPED (R6-3 governs): snapshots register ONLY the
  awaited beforeSpawn hook; test asserts pty spawn cannot precede hook resolution.
- Canonical pending-review contract (frozen in the P0 bridge): review:pending(sessionId)
  → {sections:{label, chars}[], totalChars}; review:insert(sessionId) → bracket-pastes
  the pending text (no trailing newline) and clears it; event review:changed(sessionId).
  Integration test: no pty write of review material occurs without review:insert.
- Objective REQUIRED non-empty (trimmed) for provider launches in main validation
  (validate.ts) — the no-task-less-launch guarantee is literal.
- No-container-e2e enforced at the canonical launcher: when AGENT_IDE_E2E=1 is set (all
  e2e specs set it), launchService/relaunch refuse useContainer for every entry point
  (fresh/resume/swap/stage-relaunch/queue/preset) with a typed error.
- innerHTML check narrowed: forbid assignment of any non-empty value ('' clearing
  assignments in existing code stay); new code uses replaceChildren()/textContent.

## Round-8 revisions (all folded in)
R8-1 queue ownership across restarts/instances:
- Electron single-instance lock (app.requestSingleInstanceLock(), second instance exits
  and focuses the first) added in P0 — one app owns ptys and queue claims.
- session_queue gains ownerBootId TEXT; a per-app-start random bootId is stamped in the
  claimNext UPDATE. Startup reconciliation: EVERY 'launching' row with ownerBootId !=
  current bootId is dead-owner work regardless of age → attempts<2 ? back to 'pending'
  (attempts preserved; they increment at claim) : 'failed' (lastError 'owner died').
- In-process watchdog (60s interval): 'launching' rows owned by THIS boot with
  claimedAt < now-5min → 'failed' (hung launch), replacing boot-only aging.
- No overtaking: claimNext claims the oldest pending row ONLY when the project has no
  'launching' row; ordering (projectId,state,position,id) with a matching index.
- Tests: restart 1s after claim (re-pended, no dup launch), no overtaking, watchdog
  recovery without restart, second-instance lock exits.
R8-minors: pending-review material is ephemeral (does not survive restart — documented);
review:insert clears only after confirming a live pty (mgr.has) and a successful write;
Linear accountId/workspaceId come from the post-auth identity surface (server metadata /
an allowlisted viewer-style tool at link time) and the token filename is
sha256(accountId) hex — no raw identifier in filesystem names.

## Round-9 revisions (all folded in)
R9-1: advancement precondition (runtime AND startup): a project may claim a pending row
only when it has (a) no 'launching' row AND (b) no 'launched' row whose
launchedSessionId references a non-archived session. An interrupted queued session
(idle after crash/restart) therefore BLOCKS advancement; the queue drawer surfaces it
as "interrupted — resume or abandon" (abandon = archive that session, which triggers
normal advancement; resume re-runs it). Completion stays exactly archive-only.
R9-2: per-attempt lease. session_queue gains leaseToken TEXT; claimNext writes a fresh
random token (returned to the launch flow). During launch: claimedAt heartbeat renewed
every 60s; immediately before spawn the flow re-reads the row and aborts unless
state='launching' AND leaseToken matches. Success/failure transitions are
UPDATE ... WHERE id=? AND leaseToken=? — and the success path requires exactly 1
changed row, else the surrounding transaction rolls back and the pty is killed.
Watchdog revocation (claimedAt stale > 15min despite heartbeats = truly hung) sets
state='failed' AND leaseToken=NULL, fencing any stale async continuation (its
conditioned UPDATEs match 0 rows; its pre-spawn check aborts).
R9-3: recomputeItemStatus fires transactionally on EVERY bound-session transition
across the running boundary, in both directions: crash exit (running→idle), startup
running→idle reconciliation, resume/relaunch success (→running), relaunch/persistence
failure, archive, ticket finalize, bind, unlink. Implemented centrally: the Store's
session status writers (saveSession/setSessionStatus/archiveSession) detect a
running-boundary crossing and run the recompute for all bound items inside the same
transaction — call sites cannot forget it.

## Round-10 revision (folded in) — durable launch intent
The launch protocol is REORDERED (supersedes "spawn first, persist after"):
1) TRANSACTION (durable intent): create the session row with NEW status 'starting'
   (SessionStatus gains 'starting'), session_backlog joins, and — for queue launches —
   the lease-conditioned queue transition to 'launched' + launchedSessionId. Commit.
2) Spawn the pty.
3) Conditioned UPDATE session 'starting'→'running' (emits 'spawned').
Failure/crash handling:
- Spawn throws → transaction marks session 'idle' (interrupted) — queue row stays
  'launched' bound to a non-archived session, so advancement is blocked (R9-1) and the
  drawer shows resume-or-abandon. No auto-retry can double-spawn.
- Crash after intent, before/after spawn → boot reconciliation: 'starting' or 'running'
  rows without a live pty → 'idle' (interrupted, non-archived) → advancement blocked;
  the R8 dead-owner re-pending rule now applies ONLY to 'launching' rows (claims whose
  intent transaction never committed — no session exists, so nothing can be orphaned;
  host ptys die with the app, and a docker exec client's death HUPs the in-container
  process — residual container-side survivors are documented).
- The old ghost-row concern (Codex P2, spawn-first rationale) is superseded: 'starting'/
  interrupted rows are first-class UI states, not ghosts.
Failpoint tests: crash-after-intent-before-spawn and crash-after-spawn-before-running
both yield ONE interrupted session, ZERO automatic relaunches, advancement blocked
until resume/abandon; plus the existing restart-1s-after-claim test now expects
re-pending only for uncommitted intents.

## Round-11 revision (folded in) — promotion boundary
The 'starting'→'running' promotion is UPDATE ... WHERE id=? AND status='starting' and
MUST affect exactly one row. On exception OR zero rows (e.g. a concurrent
archive/abandon won the race): suppress + kill that exact pty (generation-scoped),
then best-effort transactional 'starting'→'idle' (same conditioned form — a
concurrently archived row is NEVER overwritten), with backlog recomputation inside
that transaction. 'spawned' is emitted only after the promotion commits. The old
spawn-first persistence-compensation rule is fully superseded by this boundary.
Tests: promotion DB failure → pty killed, session idle/interrupted, advancement
BLOCKED until resume or abandon (consistent with R9-1 — no silent auto-unblock);
zero-row archive race → pty killed, archived state preserved, queue advances
normally off the archive.

## Round-12 consistency corrections (folded in)
- R9-2's pre-spawn check is updated for the R10 ordering: after the intent transaction
  the queue row is 'launched'; the pre-spawn verification therefore requires
  state='launched' AND leaseToken match (the 'launching' wording is struck).
- Watchdog scope likewise: 'launching' aging applies only to pre-intent claims; a hung
  post-intent launch resolves through the interrupted-session path, never re-pending.

## Round-13 revision (folded in) — bounded launch pipeline
- The beforeSpawn hook (snapshot) runs BEFORE the durable-intent transaction, bounded
  by an explicit 60s timeout (timeout/failure → null snapshot, logged; launch proceeds).
- The complete post-intent sequence (container ensure → spawn → promotion) runs under a
  10-minute overall deadline with cancellation: on timeout/cancel the pipeline stops the
  lease heartbeat, kills the generation-scoped pty if one was created, and performs the
  conditioned 'starting'→'idle' transition (never overwriting a concurrent archive) with
  backlog recomputation. The queue row stays 'launched' → interrupted resume-or-abandon
  path (R9-1) — no silent auto-unblock, matching R12.
- Resume/relaunch predicates (minor): existing sessions transition via conditioned
  UPDATE status IN ('idle','running') → 'starting', then spawn, then the same
  'starting'→'running' promotion; all R11 boundary rules apply identically.
- Tests: hung container ensure (fake runtime never resolves) → deadline fires, session
  interrupted, heartbeat stopped, no pty leak; hung beforeSpawn → launch proceeds
  snapshot-less after 60s.

## Round-14 revisions (folded in)
R14-1 relaunch quiesce: for a running session, the relaunch pipeline suppresses and
KILLS the old pty (generation-scoped, exit swallowed) immediately after the
'running'→'starting' transition commits and BEFORE any long post-intent work
(container ensure/spawn). If the pipeline then times out before a replacement spawns,
the session is already engine-less and the 'starting'→'idle' cleanup is truthful.
Test: relaunch timeout before replacement spawn → old pty dead, session interrupted,
no orphan engine.
R14-2 snapshot publication fence: the beforeSpawn hook receives a cancellation token;
its DB row + ref publication is token-gated INSIDE the hook's final step — after the
60s timeout fires the token is revoked, so a late-resolving capture may not publish
(no snapshots row, ref deleted if already created, tmp index removed). Tests cover
both never-resolving AND late-resolving hooks (late one leaves zero visible artifacts).

## Round-15 revisions (folded in)
R15-1 per-project admission: launchService owns a per-project admission gate acquired
at the very start of EVERY provider launch pipeline (manual, preset, backlog, linear,
queue, resume, relaunch) and released at pipeline end. Queue advancement's eligibility
check (no running/starting/launching/interrupted-launched work) runs INSIDE the same
serialized per-project operation as claimNext, and 'starting' sessions count as
active. Tests: advancement attempted during (a) a hung pre-intent hook and (b) a
post-intent 'starting' launch — both refuse to claim.
R15-2 (minor folded): the snapshot cancellation token also aborts the underlying git
subprocess (child.kill) and tmp-index cleanup runs unconditionally (finally).

## Round-16 revision (folded in) — single critical section for queued launches
launchService.launchNextQueued(projectId) acquires the per-project admission gate ONCE
and, within that single non-nested critical section, runs eligibility → claimNext →
the FULL queued launch pipeline via an internal already-admitted path
(launchAdmitted(opts)); public launchSession/relaunchSession are thin wrappers doing
acquire → launchAdmitted → release. No nested acquisition, no release-then-relaunch
window. Tests: a manual/resume launch racing into the claim-to-launch boundary neither
overtakes (blocked on the gate) nor deadlocks (queued path never re-acquires).

## Round-17 revision (folded in) — main-enforced backlog source authority
The generic backlog CRUD IPC enforces provenance in MAIN, not the UI:
- Create: main assigns id, projectId (ownership-validated), and source='manual'; any
  renderer-supplied source/linearId/linearUrl/remoteStatus/contentHash is rejected.
- Update/delete: the existing row is loaded first; rows with source IN
  ('linear','generated') are refused entirely; for manual/agent rows only
  title/bodyMd/status/parentId are writable — identity, provenance, contentHash, and
  all Linear fields are immutable through the generic path.
- Inbox ingestion, Linear pull, and ticket finalization use SEPARATE internal Store
  methods with explicit field whitelists (never the generic CRUD), so trust labels
  (R2-6) cannot be forged from the renderer to smuggle remote text into the
  auto-submitted primer.
- Direct IPC tests: forged update/delete of linear/generated rows, source changes, and
  Linear-field mutations are all rejected.

## Round-18 revisions (folded in)
R18-1 rollback TOCTOU: git:rollbackPreview returns an opaque previewToken — a digest of
(snapshotId, sorted path set, per-path index+worktree blob hashes at preview time).
Apply: (1) acquires the per-project admission gate (no session can launch mid-apply)
plus a per-project git-op lock; (2) FIRST publishes a recovery snapshot of the exact
pre-apply state (same non-mutating write-tree capture, stored as a snapshots row
flagged 'recovery'); (3) recomputes the fingerprint and REJECTS on any mismatch
("stale preview — changes occurred, re-preview"); (4) only then restores. Tests: a
mutation between preview and apply is rejected; recovery snapshot exists before any
restore write.
R18-2 (minor): S3's host e2e asserts the labeling-only stage transition; the
fix-restart confirmation flow is covered by FakeContainerRuntime/UI integration tests
(consistent with the no-container-e2e rule).

## Round-19 revisions (all folded in)
R19-1: P0 contract additions — snapshots.kind CHECK in ('baseline','recovery');
Snapshot.kind; RollbackPreview.previewToken; git:rollbackApply(previewToken) signature.
R19-2: review insertions are wrapped (inside the bracketed paste) in unique sentinels
⟦AGENTIDE-REVIEW-<id>⟧…⟦/AGENTIDE-REVIEW-<id>⟧ which persist in the transcript itself;
composePrimer/buildPrimer STRIP all review-sentinel spans when assembling any history
primer, so an inserted-but-unsubmitted (or even submitted) review block can never be
auto-resubmitted after restart. Test: insert → no Enter → restart → resume primer
contains no review text.
R19-3: rollback apply REFUSES while any project session has a live pty in
{starting, running} (error lists the sessions to close first) — quiesce is explicit
user action; external-editor writes during apply are a RECORDED accepted limitation
(mitigated by the recovery snapshot, which is captured after the refusal check).
R19-4: the ACTIVE session set is {starting, running} EVERYWHERE it matters — backlog
recomputation ('in-session'), item delete/unlink guards, queue eligibility, and the
admission checks — with tests covering bind-during-intent, relaunch, timeout cleanup,
and delete-during-'starting'.

## Round-20 revisions (folded in)
R20-1 relaunch ordering: for RUNNING-session relaunches (model swap, fix restart) the
pipeline is: (1) atomic 'running'→'starting'; (2) suppress+kill the old generation;
(3) bounded cancellable snapshot hook; (4) ensure/spawn/promote. Fresh launches and
idle resumes keep the pre-intent snapshot ordering. Test: old runtime writing during
capture is dead before the hook starts.
R20-minors (folded): previewToken resolves via a short-lived main-process registry
(token → {snapshotId, path set, fingerprint}, 10-min TTL, single use); fingerprints
include path existence + object type + file mode, not only blob hashes; review-
sentinel stripping runs over the FULL history before the 16KB tail cap and fails
closed (an unmatched opening sentinel drops everything after it).

## Round-21 revisions (folded in)
R21-1 non-completion wake-ups: launchNextQueued(projectId) is ALSO invoked (same
admission-gated path) on: enqueue into an eligible idle project, autoAdvance false→true,
and an explicit "Start next" button in the queue drawer. 'archived' remains the sole
session-COMPLETION trigger. Tests: idle enqueue launches; enabling autoAdvance with
pending work launches; simultaneous manual-launch race neither double-launches nor
deadlocks.
R21-minors (folded): R4 queue-failure wording consolidated (pre-intent failures fail/
recover the CLAIM; every post-intent failure leaves a 'launched' row bound to an
interrupted session); binding more than the 5-item primer cap is REJECTED at selection
time with a clear error (never silently unbound); inbox moves use collision-safe
destination names (name + short hash suffix) and hash-dedup is transactional
(ingest-or-skip decided inside one DB transaction keyed on contentHash).

## Round-22 revisions (all folded in)
R22-1 dual-tree snapshots: every snapshot records TWO trees — indexTreeSha (write-tree
of the REAL index; read-only) and workTreeSha (temp-index add -A capture) — schema:
snapshots(id, projectId, sessionId, kind, indexTreeSha, workTreeSha, commitSha,
createdAt). Rollback restores index from indexTree (--staged --source) and worktree
from workTree (--worktree --source) independently; capture and rollback REJECT
repositories with unmerged index entries ("resolve the merge first"). Recovery
restoration is therefore exact for staged-vs-unstaged divergence.
R22-2 terminals under the gate: terminal:open acquires the same per-project admission
gate around its spawn, and the rollback quiesce check counts plain terminals (term-*)
as live writers. Test: terminal-open racing rollback-apply is blocked.
R22-3 durable review-trust metadata: review:insert records, in MAIN, a
session_review_log row (sessionId, insertedAt, contentHash, normalizedText ≤16KB)
(P0 schema). Primer assembly strips history spans by (a) sentinel match AND (b)
normalized-containment match against the session's review log; if a logged insertion
exists and cannot be confidently located, the ENTIRE history section for that session
is DEMOTED to review delivery (fail-closed — nothing auto-submits). Tests include a
non-cooperative fake TUI that redraws pasted text without sentinels.

## Round-23 revisions (folded in)
R23-1: session_review_log is a WRITE-AHEAD log with NO size cap on normalizedText (it
stores the complete normalized payload; the 16KB figure applied to primer sections,
not the log). The log row commits BEFORE any pty write; if logging fails, insertion is
refused. Containment matching runs against complete logged payloads; any logged
insertion not fully accounted for in history → whole-history demotion (fail-closed,
unchanged). Test: >16KB payload + sentinel-stripping TUI + restart/resume.
R23-minors (folded): Linear comment idempotency = remote lookup of the session-id
marker BEFORE any retry after an unknown outcome; idle-project ENQUEUE auto-launches
only when autoAdvance is enabled, while the explicit "Start next" button launches
regardless of the setting.

## Round-24 revisions (folded in)
R24-1 snapshot reachability: the index tree is committed first (commit-tree indexTree),
then the worktree commit is created WITH that commit as its parent, and the single
snapshot ref refs/agentide/snap-<id> points at the worktree commit — both trees are
reachable from one atomically-published, cancellation-gated ref. Test runs
`git gc --prune=now` before restore and verifies exact staged/worktree divergence
round-trips.
R24-minor (folded): the index capture uses a byte-for-byte COPY of the real index via
GIT_INDEX_FILE (never touching the real index, not even metadata refresh), with
unconditional cleanup.

## Round-25 revisions (folded in)
R25-1 setStage under the gate: session:setStage acquires the per-project admission gate,
then reloads and CAS-updates stage+status inside it. While the session is 'starting' the
transition is REJECTED ("wait for launch to finish"). A running-container playback→fix
transition invokes the internal already-admitted relaunch path WITHOUT releasing the gate
(no release/reacquire window, so a concurrent model swap can neither relaunch on a
half-applied fix nor cause a double relaunch). Host sessions: stage is pure labeling,
CAS-updated under the gate. Tests: direct-IPC setStage racing a hung 'starting' launch is
rejected; setStage racing a model swap yields exactly one relaunch.
R25-2 recovery snapshots get their OWN semantics (baseline rollback keeps no-deletion):
a rollback-apply writes a persisted undo manifest = the exact set of paths it MODIFIES,
CREATES, or (staged/worktree) content it changes, keyed to the recovery snapshot.
"Undo rollback" restores index+worktree from the recovery trees for every manifest path
AND removes paths the rollback itself CREATED that are absent from the recovery snapshot
(scoped strictly to the manifest — never arbitrary deletion). Ordinary baseline rollback
is unchanged (absent paths listed, never touched). Tests cover staged-deletion and
index-present/worktree-absent states, verified after `git gc --prune=now`.

## Round-26 revisions (folded in)
R26-1 [CORE] relaunch coordinator + op-version: each session row gains opVersion INT
(bumped on every stage/status/relaunch mutation, under the gate). session:setStage
acquires the gate with a session-op-version CAS: it captures opVersion on entry and, once
holding the gate, REJECTS if opVersion changed (a launch/swap/cleanup ran meanwhile) —
the caller re-reads and retries against fresh state, so a stale 'starting'→ (now 'idle')
request can never silently apply a fix. Model-swap and stage-relaunch route through ONE
relaunchCoordinator(sessionId) that, under the gate, reads the CURRENT desired
(stage, provider, model) from the row and performs a SINGLE relaunch reconciling all
pending overrides — two racing requests coalesce to one relaunch, never two. Tests:
setStage racing hung-'starting' launch → rejected-and-retried against 'idle' (no fix
applied); model-swap racing playback→fix → exactly one relaunch carrying both.

## SNAPSHOT scope decision (recorded)
The git snapshot/rollback/undo feature (#9) has generated a fresh correctness edge case
in six consecutive review rounds (R18/R19/R22/R24/R25/R26) — the concurrent-writer +
staged/unstaged + reachability + undo surface is a research problem, not a cockpit
feature. To keep the plan shippable, S4 is REDUCED this run to what is provably safe:
- KEEP: #1 git awareness (branch/dirty badge) and #2 diff pane (read-only:
  `git status`/`git diff` display, no mutation) — zero rollback risk.
- DEFER: pre-session snapshots, rollback, and undo (#9) to a dedicated follow-up run.
  The snapshots table + beforeSpawn hook seam stay in P0 (schema/seam frozen, capture
  is a no-op default) so the feature can land later without re-freezing the foundation.
This removes every open [SNAPSHOT] blocker (R26-2 and its lineage) from THIS run.
The launchService beforeSpawn hook remains (unused) so nothing downstream changes.

## Round-27 revision (folded in) — desired-state mailbox
R26-1's "one relaunch carrying both" is replaced with a pre-gate DESIRED-STATE model that
is simple and correct:
- session:setStage and session:changeModel are DECLARATIVE: each persists the caller's
  desired (stage) / (provider, model) into the session row's DESIRED fields (a small CAS
  write, NOT under the launch gate — just an atomic UPDATE ... WHERE opVersion=? bumping
  opVersion), then requests a reconcile.
- reconcile(sessionId) runs under the per-project gate; on entry it reads the row's
  CURRENT desired fields (whatever the latest writers left) and, if desired != live,
  performs ONE relaunch to converge. Multiple declarative writes that land before
  reconcile acquires the gate collapse naturally — the coordinator always converges to
  the latest persisted desire. A write that lands WHILE a reconcile is mid-flight bumps
  opVersion and enqueues exactly one more reconcile pass (idempotent: if already
  converged, it no-ops).
- No stale 'starting' hazard: reconcile is a no-op while status='starting' (the launch
  pipeline itself performs the final convergence check before promotion) and re-runs
  after the pipeline completes. Tests: two racing declarative writes → at most one
  net relaunch to the final desired state; write during reconcile → one extra converging
  pass, never divergent; setStage while 'starting' → deferred, applied post-launch.

## Round-28 revision (folded in) — desired vs applied contract
P0 schema: sessions gains desiredStage, desiredProvider, desiredModel (what the user
wants) AND appliedStage, appliedProvider, appliedModel (the exact tuple the LIVE pty was
spawned with) plus opVersion. Rules:
- Declarative writes set the desired* fields (CAS on opVersion).
- Promotion ('starting'→'running') sets applied* = the EXACT tuple used for THAT spawn,
  atomically in the promotion transaction — so applied* always describes the running proc.
- reconcile compares desired* vs applied* and classifies the delta:
  * RELAUNCH-REQUIRED: provider/model change; OR a stage change that flips the
    auto-approve computation (i.e. →fix or fix→ when useContainer) — because approval
    flags are baked at spawn.
  * LABEL-ONLY: any stage change that does NOT flip auto-approve (all host-session stage
    changes; container discussion↔playback) → update appliedStage=desiredStage in place,
    NO relaunch.
  Only a relaunch-required delta triggers exactly one relaunch, which resets applied* to
  desired* at its own promotion. A desired change arriving mid-spawn is safe: promotion
  writes applied* for the tuple it actually spawned, so the subsequent reconcile sees the
  true delta and converges (never a false no-op).
Tests: host discussion→fix = label-only (no relaunch); container playback→fix =
one relaunch, applied*==fix after; model swap mid-'starting' → post-promotion reconcile
performs exactly one converging relaunch.

## Round-29 revisions (folded in)
R29-1 clean invariant split: the spawn-baked field is renamed spawnedApprovalMode
('guarded'|'auto') — the ACTUAL approval mode the live pty was spawned with; it changes
ONLY at promotion, never by label reconciliation. The effective label is a separate
field effectiveStage. Reconcile logic: RELAUNCH-REQUIRED iff desiredProvider/Model differ
from spawnedProvider/spawnedModel, OR the approval mode computed from
(desiredStage, useContainer) differs from spawnedApprovalMode. LABEL-ONLY: a desiredStage
change whose approval mode equals spawnedApprovalMode → update effectiveStage in place,
no relaunch, spawnedApprovalMode untouched. Promotion sets spawnedProvider/spawnedModel/
spawnedApprovalMode AND effectiveStage=desiredStage for the tuple actually spawned. Both
invariants now hold independently.
R29-2 migration/backfill (in the additive migration): existing rows initialize
desiredStage=effectiveStage=COALESCE(legacy stage, 'fix') (legacy container sessions were
backfilled to 'fix' earlier — preserved); desiredProvider/spawnedProvider=provider;
desiredModel/spawnedModel=model; spawnedApprovalMode = ('auto' if useContainer AND
effectiveStage='fix' else 'guarded'). Resume/reconcile are therefore well-defined on
upgraded DBs with no behavior change for pre-v2 sessions.

## Round-30 revisions (folded in)
R30-1 archive wake-up: the guarded archive transition and its 'archived' emission occur
AFTER the pty's generation has actually terminated — archiveSession awaits the exit
callback (the generation is gone, mgr.has(id) false) before committing+emitting, so the
advancement listener never rejects on a still-live pty. A latch+retry backstop re-runs
launchNextQueued once more after any pty removal for the project. Test: asynchronous kill
completion still yields exactly one advancement.
R30-2 harness dir provisioning: before docker cp, run (as root) a create+validate step —
mkdir -p /opt/agent-ide, then verify /opt/agent-ide is a real directory, not a symlink,
owned by root (reject + notice otherwise); then cp HARNESS.md, chown root:root, chmod 444.
Tests cover absent parent and symlinked-parent (refused).
R30-minor (folded): renderer stage chips read effectiveStage; the guarded/auto indicator
reads spawnedApprovalMode; legacy stage/provider/model columns become deprecated read
mirrors (kept in sync from desired* on write for any external reader, never authoritative).

## Round-31 revisions (folded in)
R31-1 scoped wake-up: there is NO generic per-pty-removal retry. The ONLY advancement
triggers stay: a committed 'archived' event, enqueue into an eligible idle project,
autoAdvance false→true, and explicit "Start next" — plus a single re-check that fires
strictly after a SUCCESSFULLY COMMITTED archive whose session held a non-archived
queue row (the R30-1 latch is scoped to that specific committed wake-up, not to any
pty exit). Ordinary crash/exit of a manual session triggers nothing.
R31-2 bounded archive termination: archiveSession awaits generation termination with a
bounded escalation — request kill, wait ≤5s, then SIGKILL, wait ≤5s more. If the exit
callback still hasn't confirmed removal, the archive FAILS VISIBLY (surfaced error, no
commit, no 'archived' emission) so the queue is never silently blocked by a wedged pty;
the session stays in its prior state for the user to retry. Test: never-exiting pty →
archive reports failure, no advancement, no corruption.

## Round-32 revision (folded in) — confirmed in-container termination
(Note: this hardens a PRE-EXISTING gap — today's code kills only the local docker-exec
client. P0 fixes it as part of launchService since queue/relaunch now depend on it.)
- Every containerized session spawns with a unique per-session marker in its argv/env
  (AGENTIDE_SESSION=<sessionId>) so its in-container process tree is identifiable:
  the exec runs `env AGENTIDE_SESSION=<id> exec <provider> ...` (or a tiny wrapper) so
  the marker is on the process' own environ, discoverable via
  `docker exec <cid> sh -c "grep -l AGENTIDE_SESSION=<id> /proc/*/environ"`.
- Termination (used by archive AND relaunch quiesce): (1) kill the local client;
  (2) `docker exec <cid> pkill` (or kill of the resolved PIDs) with TERM to the marker's
  process group, wait ≤5s, then KILL; (3) CONFIRM no matching process remains
  (grep returns empty) before the archive commit/'archived' emission or replacement
  spawn. If confirmation fails within the bound, archive/relaunch FAILS VISIBLY (no
  commit, no advancement, no replacement) — same fail-closed contract as R31-2.
- Host sessions keep the simpler local-kill path (no container hop).
- Tests use an in-container exec process that SURVIVES client disconnect (e.g. a
  detached sleep child) and assert confirmed remote termination before advancement;
  the container smoke exercises the real docker path.
- Accepted residual (recorded): a process that re-parents away from the group AND
  scrubs its environ marker cannot be tracked — out of scope; documented.

## Round-33 revisions (folded in)
R33-1 termination-uncertain fence across restarts: sessions gain termState
('live'|'terminating'|'terminated'|'uncertain'). Any container session whose confirmed
in-container termination did not complete (crash mid-terminate, app exit, timeout) is
'uncertain'. Rules:
- Startup: a container session without a live local pty is set 'uncertain' (NOT blithely
  'idle'); the UI shows "container process state unknown — reconnect to verify / stop".
- Resume/reconcile/replacement spawn PREFLIGHT: refuse to spawn a new engine for an
  'uncertain' container session until a marker-based check confirms no surviving
  in-container process (grep by AGENTIDE_SESSION); if survivors exist, TERM/KILL-confirm
  them first (R32 path); only on confirmed cleanup does termState→'terminated' and the
  spawn proceed. Advancement/queue treats 'uncertain' as ACTIVE (blocks, like starting/
  running) until resolved.
- Relaunch wording corrected: the 'running'→'starting' commit happens, THEN confirmed
  termination; if termination can't be confirmed the session goes to 'uncertain' (not a
  false "no commit"), fencing any replacement until resolved — consistent, not a rollback.
R33-2 status authority split: backlog_items separates manualStatus (user/CRUD-set:
icebox|planned|done) from sessionState (derived: none|in-session|done-by-ticket).
recomputeItemStatus writes ONLY sessionState; generic CRUD writes ONLY manualStatus
(and never for linear/generated rows). The displayed/effective status precedence:
done-by-ticket > in-session > manualStatus. Neither authority can erase the other.
FTS/board read the effective value. (Supersedes the single-status contention.)

## Round-34 revisions (folded in)
R34-1 complete termState fence: the invariant is "termState='terminated' is the ONLY
state permitting a replacement/resume spawn." Every unconfirmed PTY loss (crash, client
disconnect, exit without a completed terminate-confirm) atomically sets
termState='uncertain' AT THE MOMENT OF LOSS (in the exit callback / kill path), not only
at startup — so an in-run resume also hits the preflight. Startup does NOT blanket-mark:
it sets 'uncertain' only for sessions whose termState is not already 'terminated' AND
whose runtime status was 'starting'/'running' without a live pty; 'terminated' and
'archived' sessions are left untouched (never re-block the queue). Resume/reconcile/
replacement REQUIRE termState='terminated' (else run the R32 marker-confirm first).
R34-2 status field separation (final): backlog rows carry manualStatus,
sessionState (derived), and remoteStatus (Linear-pull only). Two consumers, explicit:
- localEffectiveStatus (board placement, queue lifecycle, FTS status) =
  done-by-ticket > in-session > manualStatus. remoteStatus does NOT enter this.
- the Linear BADGE (linear-sourced rows only) shows remoteStatus unless
  localEffectiveStatus is done-by-ticket (local completion wins, per R5).
S1 reads localEffectiveStatus; S2 owns remoteStatus; no single field is overloaded.

## Round-35 revision (folded in) — pre-spawn runtime reservation
termState gains 'spawning'. The durable-intent transaction (before any pty/exec spawn)
performs a committed CAS termState: 'terminated' → 'spawning' (fresh sessions start
'spawning'); ONLY then is the process spawned; promotion sets 'spawning'→'live'.
Startup: a session in 'spawning' OR 'live' without a live local pty → 'uncertain'
(a reservation with no proc = crash-after-reserve, possibly a surviving detached
container process). 'terminated'/'archived' stay trusted (no reservation outstanding, so
no orphan possible). Replacement/resume still requires a marker-confirmed
'terminated' before spawning. Test: crash-after-spawn-before-promotion with a surviving
detached in-container process → startup marks 'uncertain' → resume runs marker cleanup
(confirmed kill) BEFORE any replacement spawn.

## Round-36 revision (folded in) — termState fence is container-only
The termState uncertain-fence and marker preflight apply to CONTAINER sessions only
(useContainer=true). HOST sessions are direct child ptys that die with the app (recorded
assumption, already relied on elsewhere): at startup a host session left
'spawning'/'live' without a live pty is restored to 'idle' with termState='terminated'
(no marker scan, no permanent fence) — resume/reconcile proceed normally. Only container
sessions can leave an orphan, so only they carry the uncertain state and the confirmed-
cleanup requirement. Tests split host (restart → idle, resumable immediately) vs
container (restart → uncertain → marker-confirm before resume).

## Round-37 revision (folded in) — archive under the admission gate
archiveSession is a launchService operation that HOLDS the per-project admission gate
across its entire sequence: session reload + opVersion capture → bounded termination and
confirmation (R32/R33) → guarded archive commit (CAS on opVersion AND expected status) →
'archived' emission → advancement — all inside one gate hold. This mutually excludes it
from resume/reconcile/queue launches, so a replacement can never be promoted between
archive's termination check and its commit (closes the R11-opposite ordering). Test:
resume racing archive → serialized, never an 'archived' session with a live pty, never
premature advancement.

## Round-38 revisions (folded in)
R38-1 archive CAS scope: opVersion is SPLIT into runtimeVersion (bumped only by
runtime/status transitions under the gate: spawn, promotion, relaunch, archive) and
desiredVersion (bumped by declarative setStage/changeModel writes, outside the gate).
Archive's guarded commit CAS is against runtimeVersion + expected status ONLY — a
concurrent desired-state write bumps desiredVersion and cannot make archive's CAS fail.
Runtime replacement is still fenced (any replacement is itself a gated runtime transition
bumping runtimeVersion, serialized by the gate archive holds). No zero-row/wedged-active
outcome. reconcile still reads the latest desired fields after archive releases.
R38-2 no gate re-entry: launchNextQueuedAdmitted(projectId) is the ALREADY-HOLDING-GATE
advancement path; archive calls it directly within its gate hold (no re-acquire → no
deadlock, R37's atomic sequence preserved). Public launchNextQueued (used by enqueue/
autoAdvance-enable/Start-next) acquires the gate then calls the admitted path. The
'archived' listener does NOT itself advance (archive already did, in-gate); it is only a
backstop that no-ops if advancement already ran for that committed archive.

## Round-39 minors (folded in) — GATE CLEAN at round 39 (no blocking findings)
- Primer auto-submission (submitText) occurs ONLY after a successful 'starting'→'running'
  promotion commits (never against a starting/killed pty).
- After marker-confirmed cleanup, an 'uncertain' container session normalizes to
  termState='terminated', status='idle' BEFORE resume proceeds.
- The 'archived'-event backstop is scheduled asynchronously AFTER the gate is released and
  never synchronously re-enters the admission gate (it re-acquires via the public path
  only if it finds advancement genuinely didn't run).
- Superseded snapshot/rollback wording in S4/P0.B is struck at implementation time: S4 =
  git awareness + read-only diff pane ONLY this run (per the SNAPSHOT scope decision);
  the snapshots table + beforeSpawn hook remain as inert frozen seams.

## Round-1 dispositions
1→P0.B/C complete fields. 2→P0.A registrars+launchService+event bus+renderer seam.
3→P0.A store-derived policy. 4→P0.A relaunch-on-fix + adjacent-only. 5→P0.A main-resolved
cwd + per-handler Store ownership checks (explicit acceptance criterion of every stream).
6→P0.A atomic persist + items in validated request + status lifecycle defined.
7→P0.B tickets unification. 8→P0.B hierarchy+indexes+unique+migration cascade.
9/10→P0.B FTS external-content + union SearchHit. 11→P0.B queue state machine, single
trigger, boot recovery. 12→P0.B write-tree snapshots, project-scoped label, preview-first
non-deleting rollback. 13→P0.D docker-cp per ensure, root-owned 444. 14→P0.D provenance
fences/caps/no-auto-submit for linear+handoff/textContent-only. 15/16/17→S2 full contract.
18→S1 inbox spec. 19→S5 buffered lines/unknown display. 20→P0.B ephemeral attention rules.
21→P0.A verification seams. Accepted-risk (recorded): per-session diff attribution with
concurrent sessions is project-scoped this run; Linear live OAuth is user-acceptance.
