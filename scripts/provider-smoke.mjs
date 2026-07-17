// C1 smoke: launch each provider CLI interactively (host pty, picker model),
// submit a marker prompt, and prove the marker survives the IDE's transcript
// cleaning (stripAnsi) AND reconnect primer (buildPrimer) — the R2-5 check.
// Costs three tiny subscription turns; run deliberately, not in CI:
//   npm rebuild node-pty && node scripts/provider-smoke.mjs [codex claude gemini]
import { spawn } from 'node-pty'
import { execFileSync } from 'node:child_process'

// The transcript helpers live in TS; bundle them on the fly via esbuild (a
// devDependency of the toolchain) so this script always tests current code.
execFileSync('npx', ['--no-install', 'esbuild', 'src/main/history.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=/tmp/agent-ide-history.mjs'], { stdio: 'inherit' })
const { stripAnsi, buildPrimer } = await import('/tmp/agent-ide-history.mjs')

const PICKS = {
  codex: { cmd: 'codex', args: ['-m', 'gpt-5-codex'] },
  claude: { cmd: 'claude', args: ['--model', 'claude-opus-4-8'] },
  gemini: { cmd: 'gemini', args: ['-m', 'gemini-2.5-pro'] }
}
const providers = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PICKS)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0

for (const name of providers) {
  const { cmd, args } = PICKS[name]
  const marker = `MARKER_${name.toUpperCase()}_${process.pid}`
  process.stdout.write(`\n=== ${name}: ${cmd} ${args.join(' ')} ===\n`)
  let raw = ''
  const proc = spawn(cmd, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.env.HOME, env: process.env })
  // Minimal terminal-emulator responses: TUIs (claude/gemini) query the
  // terminal and stall without answers — in the app, xterm.js provides them.
  const answered = new Set()
  const answer = (key, reply) => { if (!answered.has(key)) { answered.add(key); proc.write(reply) } }
  proc.onData((d) => {
    raw += d
    if (d.includes('\x1b[6n')) proc.write('\x1b[1;1R')                    // cursor position (repeatable)
    if (/\x1b\[[>=]?c/.test(d)) answer('da', '\x1b[?62;22c')              // device attributes
    if (d.includes('\x1b[?u')) answer('kitty', '\x1b[?0u')                // kitty keyboard
    if (d.includes('\x1b]10;?')) answer('fg', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
    if (d.includes('\x1b]11;?')) answer('bg', '\x1b]11;rgb:0000/0000/0000\x1b\\')
  })

  // wait for the TUI to render, then submit the marker prompt
  const readyBy = Date.now() + 60_000
  while (raw.length < 300 && Date.now() < readyBy) await sleep(500)
  if (raw.length < 300) {
    console.log(`${name}: FAIL — TUI produced no output. Tail: ${raw.slice(-500)}`)
    failures++
    proc.kill()
    continue
  }
  await sleep(4000)
  // Bracketed paste (like the IDE's own insertions): the TUI takes the text as
  // one unit instead of re-rendering per keystroke, then Enter submits.
  proc.write(`\x1b[200~Reply with exactly OK and nothing else. ${marker}\x1b[201~`)
  await sleep(800)
  proc.write('\r')

  // Wait until the marker shows in the CLEANED transcript (per-keystroke
  // redraws interleave escapes into the raw bytes, so raw.includes is useless).
  const answeredBy = Date.now() + 60_000
  while (!stripAnsi(raw).includes(marker) && Date.now() < answeredBy) await sleep(500)
  await sleep(8000)
  proc.kill()
  await sleep(500)

  const cleaned = stripAnsi(raw)
  const primer = buildPrimer(raw)
  const inClean = cleaned.includes(marker)
  const inPrimer = primer.includes(marker)
  console.log(`${name}: model accepted=${raw.length > 300} markerInStripAnsi=${inClean} markerInPrimer=${inPrimer}`)
  if (!inClean || !inPrimer) {
    failures++
    console.log(`${name}: FAIL — cleaned tail:\n${cleaned.slice(-800)}`)
  }
}

process.exit(failures === 0 ? 0 : 1)
