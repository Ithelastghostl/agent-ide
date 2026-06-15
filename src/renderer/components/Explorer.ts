export interface FileNode {
  name: string
  dir: boolean
  depth: number
  modified?: boolean
}

export interface ExplorerProps {
  projectName: string
  tree: FileNode[]
}

/** Left file explorer for the open project. L1 uses mock nodes; L4 feeds a real tree. */
export function Explorer(p: ExplorerProps): HTMLElement {
  const el = document.createElement('div')
  el.className = 'explorer'

  const h = document.createElement('div')
  h.className = 'ex-h'
  h.textContent = p.projectName
  el.appendChild(h)

  for (const node of p.tree) {
    const row = document.createElement('div')
    row.className = 'ex-i' + (node.depth === 0 ? ' f' : '')
    row.style.paddingLeft = `${14 + node.depth * 16}px`
    const icon = node.dir ? '▾ ' : '📄 '
    row.textContent = icon + node.name
    if (node.modified) {
      const m = document.createElement('span')
      m.className = 'mut'
      m.textContent = ' M'
      row.appendChild(m)
    }
    el.appendChild(row)
  }

  return el
}
