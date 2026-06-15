# Running & verifying Agent IDE

## TL;DR for the developer (you)
This is a GUI Electron app for **your** Linux desktop. The build agent verifies
everything that can be checked **headlessly** (build, type-check, unit tests, and
a node-level pty integration test). **Visual confirmation — that the window
opens and the Variant-A cockpit renders — is done by you** running:

```bash
cd agent-ide
npm run dev
```

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
