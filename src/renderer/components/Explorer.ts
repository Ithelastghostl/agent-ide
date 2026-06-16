export interface FileNode {
  name: string
  dir: boolean
  depth: number
  modified?: boolean
}

export interface ExplorerProps {
  projectName: string
  /** Top-level nodes (depth 0). Children are fetched lazily on expand. */
  tree: FileNode[]
  /** Project-relative paths of currently-expanded directories. */
  expanded: Set<string>
  /** Cached children per directory path (populated as folders are expanded). */
  childrenOf: (dirPath: string) => FileNode[] | undefined
  /** Project-relative path of the file shown in the active tab (highlight it). */
  activePath?: string
  /** Toggle a directory open/closed (caller fetches + caches children, re-renders). */
  onToggleDir: (dirPath: string) => void
  /** Open a file in a tab. */
  onOpenFile: (filePath: string, name: string) => void
  /** Right-click a file: caller shows a context menu at (x, y). F15. */
  onContextMenu?: (filePath: string, name: string, x: number, y: number) => void
}

/** Left file explorer: collapsible folders (lazy children) + click-to-open files.
 *  Paths are project-relative and built by joining names down the tree. */
export function Explorer(p: ExplorerProps): HTMLElement {
  const el = document.createElement('div')
  el.className = 'explorer'

  const h = document.createElement('div')
  h.className = 'ex-h'
  h.textContent = p.projectName
  el.appendChild(h)

  const list = document.createElement('div')
  list.className = 'ex-list'
  el.appendChild(list)

  // Render a node row and, for an expanded directory, recurse into its children.
  const renderNodes = (nodes: FileNode[], parentPath: string, depth: number) => {
    for (const node of nodes) {
      const path = parentPath ? `${parentPath}/${node.name}` : node.name
      const row = document.createElement('div')
      row.className = 'ex-i' + (depth === 0 ? ' f' : '') + (!node.dir && path === p.activePath ? ' active' : '')
      row.style.paddingLeft = `${10 + depth * 14}px`

      const twisty = document.createElement('span')
      twisty.className = 'tw'
      twisty.textContent = node.dir ? (p.expanded.has(path) ? '▾' : '▸') : ' '
      row.appendChild(twisty)

      const icon = document.createElement('span')
      icon.className = 'ic'
      icon.textContent = node.dir ? '📁' : '📄'
      row.appendChild(icon)

      const label = document.createElement('span')
      label.className = 'nm'
      label.textContent = node.name
      row.appendChild(label)

      if (node.modified) {
        const m = document.createElement('span')
        m.className = 'mut'
        m.textContent = 'M'
        row.appendChild(m)
      }

      row.onclick = () => {
        if (node.dir) p.onToggleDir(path)
        else p.onOpenFile(path, node.name)
      }
      if (!node.dir && p.onContextMenu) {
        row.oncontextmenu = (e) => {
          e.preventDefault()
          p.onContextMenu!(path, node.name, e.clientX, e.clientY)
        }
      }
      list.appendChild(row)

      if (node.dir && p.expanded.has(path)) {
        const kids = p.childrenOf(path)
        if (kids === undefined) {
          const loading = document.createElement('div')
          loading.className = 'ex-i loading'
          loading.style.paddingLeft = `${10 + (depth + 1) * 14}px`
          loading.textContent = '…'
          list.appendChild(loading)
        } else {
          renderNodes(kids, path, depth + 1)
        }
      }
    }
  }

  renderNodes(p.tree, '', 0)
  return el
}
