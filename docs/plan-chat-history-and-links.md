# Plan — Chat history replay + link/OAuth fixes

Two independent bugs sharing the surface symptom "links / sessions don't work".
Diagnosed from the actual code + this machine's state (not assumed).

## Bug 1 — No chat history

Transcripts ARE persisted (`store.appendTranscript` on every pty path) but NEVER
replayed: no `transcript:get` IPC, no bridge method, and `SessionTerminal` only
subscribes to live `pty:data`. Open/reconnect/cold-start → blank terminal.

**Changes**
1. `store.ts` — `getTranscript(id, maxBytes = 256*1024)`: return only the tail so a
   huge log can't freeze xterm on mount.
2. `ipc.ts` — add `ipcMain.handle('transcript:get', (_e, id) => store?.getTranscript(id) ?? '')`.
3. `bridge.ts` + `vite-env.d.ts` — expose `transcriptGet(id): Promise<string>`.
4. `SessionTerminal.ts` — on mount, `await transcriptGet(id)`, `term.write(history)`
   BEFORE wiring the live `onPtyData` listener (so replay + live bytes don't interleave).
5. Fix frozen `now` → `Date.now()` in the `appendTranscript` calls in `terminal:open`
   and `session:launch` (latent ordering bug; rowid currently saves it).

## Bug 2 — Links + OpenAI OAuth (decision: "Both")

Facts verified on this host:
- App runs on the HOST (no `/.dockerenv`); Chrome IS the default browser.
- `shell:openExternal` swallows errors (`void shell.openExternal`) → silent no-op.
- `codex` is installed on host (`/usr/local/bin/codex`) and `~/.codex/auth.json`
  already exists. `codex login` has NO port flag — 1455 is fixed.
- Sessions + login currently run INSIDE the container (`provider:login` uses
  `containerExecArgv` when a container is up). The 1455 listener is trapped there;
  `docker ps` shows no forwarded ports → host browser callback can't reach it.
- Only `~/.claude` is bind-mounted (gated by importConfig); `~/.codex` is NOT, so
  in-container Codex sessions can't see host creds.

**Changes**
6. `ipc.ts` — `shell:openExternal` becomes `async`, `await`s `shell.openExternal`,
   returns real `true/false`. Renderer (`SessionTerminal`) falls back to
   copy-to-clipboard + a small notice when it returns false.
7. `provider:login` — for **codex**, always run on the HOST (skip `containerExecArgv`),
   so the 1455 listener + browser callback are both host-side. Login works immediately
   using the existing host install. (claude/gemini unchanged.)
8. `devcontainer.ts` + `ensureContainer` — also bind-mount `~/.codex` read-only
   (alongside `~/.claude`) so a containerized Codex SESSION is already authenticated
   from host creds. No port forwarding needed for the normal path.
9. `devcontainer.ts` — add `127.0.0.1:1455:1455` publish on `devcontainer up` as the
   fallback for users who insist on logging in *inside* the container (only affects
   freshly (re)built containers; existing ones unaffected until rebuilt).

## Verify
- Unit tests: `getTranscript` tail-cap; `transcript:get` returns persisted bytes;
  `provider:login` codex path stays on host; mount list includes `~/.codex`.
- `npm test` (existing 55) stays green.
- GUI smoke via `xvfb-run` per the Electron-37 pin: open a session, confirm prior
  output replays; confirm a printed URL opens host Chrome.

## Out of scope / untouched
- The uncommitted `setWindowOpenHandler` / `will-navigate` diff in `index.ts`
  (renderer-anchor links) — left as-is.
- Library (D14), Monaco — still deferred.

## File-deletion policy
- Any removed file → `Bin/`, never `rm`.
