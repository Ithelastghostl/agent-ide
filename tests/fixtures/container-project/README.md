# Container smoke fixture

Tracked devcontainer project used by `tests/integration/containerSmoke.test.ts`
(B4): each run copies this folder into a fresh temp workspace so every smoke
gets a brand-new container with the app's real seed mounts. The postCreate
installs the codex CLI so the in-container provider session is real.
