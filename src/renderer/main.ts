const app = document.getElementById('app')!
app.innerHTML = `<div style="padding:20px">Agent IDE — booting…</div>`

// Smoke-test the preload bridge.
;(window as any).agentIDE.ping().then((r: string) => {
  app.innerHTML += `<div style="padding:0 20px;color:var(--success)">bridge: ${r}</div>`
})
