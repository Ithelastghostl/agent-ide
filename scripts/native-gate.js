// R1 native-module gate (plan §2 decision 4 — the standing policy that replaces
// the old Electron pin). Runs INSIDE Electron and asserts that the two native
// modules load and work against the CURRENT Electron ABI: better-sqlite3 and
// node-pty. A major Electron bump that breaks a native build fails here loudly,
// before it can ship. Exits 0 on success, 1 on failure.
//
// Run via `npm run native-gate` (which rebuilds for the Electron ABI first and
// launches this headless). Kept dependency-free and out of the app bundle.

const { app } = require('electron')

app.disableHardwareAcceleration() // no GPU needed; keep it lightweight/headless-safe

app.whenReady().then(async () => {
  const results = []
  let ok = true

  // better-sqlite3: open an in-memory DB, round-trip a row.
  try {
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    db.prepare('INSERT INTO t (v) VALUES (?)').run('hello')
    const row = db.prepare('SELECT v FROM t WHERE id = 1').get()
    db.close()
    if (row && row.v === 'hello') results.push('better-sqlite3: OK')
    else {
      ok = false
      results.push('better-sqlite3: FAIL (unexpected read)')
    }
  } catch (err) {
    ok = false
    results.push('better-sqlite3: FAIL — ' + (err && err.message))
  }

  // node-pty: spawn a trivial process, confirm data + a clean exit.
  try {
    const pty = require('node-pty')
    await new Promise((resolve, reject) => {
      const p = pty.spawn('sh', ['-c', 'echo pty-ok'], { cwd: process.cwd(), env: process.env })
      let out = ''
      const timer = setTimeout(() => reject(new Error('pty timeout')), 5000)
      p.onData((d) => {
        out += d
      })
      p.onExit(() => {
        clearTimeout(timer)
        if (out.includes('pty-ok')) {
          results.push('node-pty: OK')
          resolve()
        } else reject(new Error('pty produced no expected output'))
      })
    })
  } catch (err) {
    ok = false
    results.push('node-pty: FAIL — ' + (err && err.message))
  }

  for (const r of results) console.log('[native-gate] ' + r)
  console.log('[native-gate] ' + (ok ? 'ALL NATIVE MODULES OK' : 'NATIVE GATE FAILED'))
  app.exit(ok ? 0 : 1)
})
