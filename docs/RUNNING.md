# Running & verifying Agent IDE

Last updated: 2026-07-17 (macOS port).

## macOS (primary since 2026-07-17)

The app is fully supported on macOS (arm64, OrbStack for containers). The
Linux-only `--ozone-platform=x11` flag is applied automatically per platform
by `scripts/run-electron.js` / `e2e/launch.ts` — never pass it by hand.

- **Launch from a terminal:** `npm run dev` (live reload) or `npm start`.
- **Launch from Finder/Spotlight:** run once `bash scripts/install-macos-app.sh`
  → installs `~/Applications/Nacho's IDE.app`. The bundle builds its own PATH
  (homebrew, `~/.local/bin`, OrbStack) because Finder launches don't read your
  shell dotfiles; failures alert and log to `~/Library/Logs/nachos-ide/launch.log`.
- **Host terminals** use your `$SHELL` (zsh), not bash 3.2.
- **Cmd+C / Cmd+V** copy/paste in terminals (Ctrl+Shift+C/V still work).
- **Window close ≠ quit:** sessions keep running with the window closed; a
  reopened window re-attaches to live ptys (no forced reconnect).
- **Containers** run through OrbStack's docker. Host provider credentials are
  copied (one-way, never overwriting) into the container user's writable home
  on container start: codex `auth.json`/`config.toml`, gemini oauth/settings;
  claude files only with "import config". Nothing writes back to the host.
- **Claude in containers on macOS:** the host's claude OAuth lives in the
  Keychain (no `.credentials.json` file), so it cannot be copied in. Run
  `/login` inside the containerized session — the IDE port-forwards the OAuth
  loopback callback; the login persists in the container.
- **Library mount is writable** in containers (the devcontainer CLI's `--mount`
  grammar has no readonly flag) — in-container agents can edit your library.
- **Summarization (ticket generation)** runs a confined `claude -p` on the host
  (all tools disabled, no settings/MCP, fresh empty cwd, no session
  persistence), billed to your subscription login.
- **Library agents:** the 🤖 Agents pill lists `agents/*.md` files (frontmatter
  name/description + `# Instructions` / `# Data` / `# Context` layers); "New
  agent" creates one. The library is local-first — syncing a repo into a
  non-empty non-clone library folder is refused, never clobbered.
- **Container smoke (needs Docker, pulls images):**
  `npm rebuild node-pty && AGENT_IDE_CONTAINER_SMOKE=1 npx vitest run tests/integration --testTimeout=600000`
  (containers created by it are stopped, not removed). Provider smoke (three
  tiny billed turns): `npm rebuild node-pty && node scripts/provider-smoke.mjs`.
  After either, `npm run rebuild:electron` restores the app's native ABI.

## TL;DR for the developer (you)
This app also runs on a Linux desktop. The build agent verifies
everything that can be checked **headlessly** (build, type-check, unit tests, and
a node-level pty integration test). **Visual confirmation — that the window
opens and the Variant-A cockpit renders — is done by you** running:

```bash
cd agent-ide
npm run dev
```

## Blank window? (native-module ABI)
If the app opens to a blank window, it's almost always the dual-ABI trap: the app
runs on Electron's ABI, but `npm test` rebuilds better-sqlite3 for Node's ABI. The
launcher (`scripts/launch.sh`) and `npm run dev`/`start`/`e2e` all run
`rebuild:electron` first, so they self-heal. As a backstop, the main process now
constructs the store defensively — if better-sqlite3 fails to load, the app still
opens (persistence degraded, projects/sessions empty) rather than going blank.
Manual fix if needed: `npm run rebuild:electron`.

## Why visual checks are on you
When launched from the build agent's shell (even with `DISPLAY=:0`), Electron's
GUI process segfaults (SIGSEGV) at the GTK/windowing layer — a known limitation
of starting a GUI without a full login session (dbus, GTK schemas, compositor).
The Electron **runtime** itself is healthy (verified via `ELECTRON_RUN_AS_NODE`,
ABI 146 matches the rebuilt native modules). So the crash is environmental, not a
code defect. On your real desktop session it launches normally.

## What the agent verifies at each layer
- `npm run build` — all three targets (main/preload/renderer) compile.
- `npx tsc --noEmit` — no type errors.
- `npm test` — vitest unit tests for all main-process logic + renderer components (jsdom).
- Node pty integration — `node-pty` spawns a real shell and round-trips I/O.

## What you verify (visual checklist, per layer)
- **L1:** window opens, near-black Talentchain theme, project rail + cockpit render.
- **L2:** clicking a session shows a live, interactive bash terminal.
- **L3:** launch buttons open the model picker; picking spawns the real provider CLI.
- **L4:** the rail lists your GitHub repos; adding one clones + scopes the UI.
- **L5:** a devcontainer project runs sessions inside the container (auto-approve).
- **L6:** sessions persist/resume; ⌘ home shows all sessions across projects.

## Containerized sessions (NN2) — requirement
When a project has a devcontainer, sessions run **inside** it via
`docker exec -it <container> <provider> ...` (verified end-to-end against a real
Node + Python devcontainer, project mounted at `/workspaces/<name>`). For an
agent to actually run in-container, the **provider CLI must be installed inside
the container**, authenticated to your subscription. A well-formed devcontainer
does this in `postCreate` — e.g. installing `@anthropic-ai/claude-code`,
`@google/gemini-cli`, `@openai/codex` and bind-mounting `~/.claude` for
subscription OAuth. The IDE's job is to run the session inside the container;
provisioning the CLI is the devcontainer's job (same as the VS Code workflow).
First container bring-up is slow (image pull + feature compile); subsequent
launches reuse the built image.

## Commands
```bash
npm run dev      # launch with live reload (use this for visual checks)
npm run build    # production build into out/
npm start        # preview the production build
npm test         # unit tests (headless)
npm run e2e      # playwright-electron integration (needs a display)
npm run rebuild  # rebuild native modules against Electron ABI (if needed)
```
