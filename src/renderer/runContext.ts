// Pure launch-path helpers, split out of main.ts so they are unit-testable
// (main.ts self-boots on import: it registers IPC listeners and calls boot()).

/** Turn a launch failure into something the user can act on.
 *
 *  IPC errors arrive wrapped ("Error invoking remote method '…': Error: real
 *  message"), so the useful part is the last "Error:" segment. The missing
 *  devcontainer CLI is called out by name because it is the one failure with an
 *  obvious fix, and it throws BEFORE any session row exists — so without a
 *  message the launch looks like it silently did nothing. */
export function launchErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const tail = raw.split(/Error:\s*/).pop()?.trim() || raw
  if (/devcontainer CLI not found/i.test(tail)) {
    return 'Container session needs the devcontainer CLI — run: npm i -g @devcontainers/cli'
  }
  return `Launch failed: ${tail}`
}

/** Decide where a session runs, WITHOUT prompting.
 *
 *  Precedence, highest first:
 *    1. An explicit Connect/Disconnect for this project (`mode`). The user said
 *       it; nothing may silently downgrade it.
 *    2. No devcontainer at all → host.
 *    3. Otherwise undecided — the caller prompts.
 *
 *  Order 1-before-2 is the bug fix: hasDevcontainer is a CACHED column that can
 *  lag the filesystem, and checking it first sent Connected projects to the host.
 */
export function decideRunContext(
  proj: { hasDevcontainer: boolean },
  mode: boolean | undefined
): { useContainer: boolean; importConfig: boolean } | 'ask' {
  if (mode !== undefined) return { useContainer: mode, importConfig: false }
  if (!proj.hasDevcontainer) return { useContainer: false, importConfig: false }
  return 'ask'
}
