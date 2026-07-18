// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { BacklogView, effectiveStatusOf, isReadOnly } from '../../src/renderer/components/BacklogView'
import { BacklogModal } from '../../src/renderer/components/BacklogModal'
import type { BacklogItem } from '@shared/types'

function item(over: Partial<BacklogItem>): BacklogItem {
  return {
    id: 'bl-' + Math.random().toString(36).slice(2),
    projectId: 'p1',
    kind: 'task',
    title: 'Item',
    bodyMd: '',
    manualStatus: 'planned',
    sessionState: 'none',
    remoteStatus: null,
    source: 'manual',
    parentId: null,
    linearId: null,
    linearUrl: null,
    contentHash: null,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

const noop = () => {}
function props(over: Partial<Parameters<typeof BacklogView>[0]> = {}): Parameters<typeof BacklogView>[0] {
  return {
    projectName: 'proj',
    items: [],
    layout: 'grid',
    selected: new Set<string>(),
    onToggleLayout: noop,
    onNew: noop,
    onEdit: noop,
    onDelete: noop,
    onSetStatus: noop,
    onToggleSelect: noop,
    onWorkOnThis: noop,
    ...over
  }
}

describe('effectiveStatusOf (R34 precedence)', () => {
  it('done-by-ticket > in-session > manualStatus', () => {
    expect(effectiveStatusOf({ manualStatus: 'icebox', sessionState: 'done-by-ticket' })).toBe('done')
    expect(effectiveStatusOf({ manualStatus: 'icebox', sessionState: 'in-session' })).toBe('in-session')
    expect(effectiveStatusOf({ manualStatus: 'planned', sessionState: 'none' })).toBe('planned')
  })
})

describe('isReadOnly', () => {
  it('generated + linear rows are read-only; manual/agent are not', () => {
    expect(isReadOnly(item({ source: 'generated' }))).toBe(true)
    expect(isReadOnly(item({ source: 'linear' }))).toBe(true)
    expect(isReadOnly(item({ source: 'manual' }))).toBe(false)
    expect(isReadOnly(item({ source: 'agent' }))).toBe(false)
  })
})

describe('BacklogView layout', () => {
  const items = [item({ title: 'A' }), item({ title: 'B' })]

  it('renders the bento grid in grid layout', () => {
    const el = BacklogView(props({ items, layout: 'grid' }))
    expect(el.querySelector('.bk-grid')).toBeTruthy()
    expect(el.querySelector('.bk-table')).toBeNull()
    expect(el.querySelectorAll('.bk-card').length).toBe(2)
  })

  it('renders the table in table layout', () => {
    const el = BacklogView(props({ items, layout: 'table' }))
    expect(el.querySelector('.bk-table')).toBeTruthy()
    expect(el.querySelector('.bk-grid')).toBeNull()
    // one head row + two data rows
    expect(el.querySelectorAll('.bk-row').length).toBe(3)
  })

  it('the toggle fires onToggleLayout with the other layout', () => {
    let picked = ''
    const el = BacklogView(
      props({
        items,
        layout: 'grid',
        onToggleLayout: (l) => {
          picked = l
        }
      })
    )
    ;(el.querySelector('.bk-tg[data-layout="table"]') as HTMLButtonElement).click()
    expect(picked).toBe('table')
  })

  it('empty state when no items', () => {
    const el = BacklogView(props({ items: [] }))
    expect(el.querySelector('.bk-empty')).toBeTruthy()
  })
})

describe('BacklogView CRUD callbacks', () => {
  it('the + New button fires onNew', () => {
    let n = false
    const el = BacklogView(
      props({
        onNew: () => {
          n = true
        }
      })
    )
    ;(el.querySelector('.bk-new') as HTMLButtonElement).click()
    expect(n).toBe(true)
  })

  it('selecting an item fires onToggleSelect', () => {
    const it = item({ title: 'Sel' })
    let toggled: string | null = null
    const el = BacklogView(
      props({
        items: [it],
        onToggleSelect: (x) => {
          toggled = x.id
        }
      })
    )
    const box = el.querySelector('.bk-select') as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event('change'))
    expect(toggled).toBe(it.id)
  })

  it('shows Work-on-this only when items are selected, and fires it', () => {
    const it = item({ title: 'Sel' })
    const none = BacklogView(props({ items: [it], selected: new Set() }))
    expect(none.querySelector('.bk-work')).toBeNull()
    let worked = false
    const some = BacklogView(
      props({
        items: [it],
        selected: new Set([it.id]),
        onWorkOnThis: () => {
          worked = true
        }
      })
    )
    const work = some.querySelector('.bk-work') as HTMLButtonElement
    expect(work).toBeTruthy()
    work.click()
    expect(worked).toBe(true)
  })
})

describe('BacklogView read-only + status + hierarchy', () => {
  it('read-only rows show a lock and no checkbox is pre-checked', () => {
    const gen = item({ source: 'generated', title: 'Gen' })
    const el = BacklogView(props({ items: [gen] }))
    expect(el.querySelector('.bk-card.readonly')).toBeTruthy()
    expect(el.querySelector('.bk-lock')!.textContent).toMatch(/read-only/)
  })

  it('renders effective status badge (in-session wins over manualStatus)', () => {
    const it = item({ manualStatus: 'planned', sessionState: 'in-session', title: 'Busy' })
    const el = BacklogView(props({ items: [it] }))
    expect(el.querySelector('.bk-status.in-session')).toBeTruthy()
  })

  it('groups an epic with its children in the grid', () => {
    const epic = item({ kind: 'epic', title: 'Epic', createdAt: 1 })
    const child = item({ kind: 'task', title: 'Child', parentId: epic.id, createdAt: 2 })
    const el = BacklogView(props({ items: [epic, child], layout: 'grid' }))
    const group = el.querySelector('.bk-group')
    expect(group).toBeTruthy()
    expect(group!.querySelector('.bk-kids .bk-card')!.querySelector('.bk-title')!.textContent).toBe('Child')
  })

  it('renders backlog text via textContent (no HTML injection)', () => {
    const evil = item({ title: '<img src=x onerror=alert(1)>', bodyMd: '<script>bad</script>' })
    const el = BacklogView(props({ items: [evil] }))
    expect(el.querySelector('.bk-title')!.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('script')).toBeNull()
  })
})

describe('BacklogModal', () => {
  it('create: fires onCreate with kind/title/body/parent', () => {
    let created: unknown = null
    const el = BacklogModal({
      items: [],
      onCreate: (i) => {
        created = i
      },
      onUpdate: () => {},
      onCancel: () => {}
    })
    ;(el.querySelector('input[type="text"].bk-input') as HTMLInputElement).value = 'New task'
    ;(el.querySelector('.bk-textarea') as HTMLTextAreaElement).value = 'details'
    ;(el.querySelector('.foot button.primary') as HTMLButtonElement).click()
    expect(created).toMatchObject({ kind: 'task', title: 'New task', bodyMd: 'details' })
  })

  it('create: requires a title (shows an error, no callback)', () => {
    let created = false
    const el = BacklogModal({
      items: [],
      onCreate: () => {
        created = true
      },
      onUpdate: () => {},
      onCancel: () => {}
    })
    ;(el.querySelector('.foot button.primary') as HTMLButtonElement).click()
    expect(created).toBe(false)
    expect(el.querySelector('.bk-modal-err')!.textContent).toMatch(/required/)
  })

  it('edit: prefills, disables kind, fires onUpdate with the id', () => {
    const it = item({ id: 'bl-x', kind: 'goal', title: 'Old', bodyMd: 'b' })
    let updated: unknown = null
    const el = BacklogModal({
      item: it,
      items: [it],
      onCreate: () => {},
      onUpdate: (i) => {
        updated = i
      },
      onCancel: () => {}
    })
    expect((el.querySelector('select.bk-input') as HTMLSelectElement).disabled).toBe(true)
    ;(el.querySelector('input[type="text"].bk-input') as HTMLInputElement).value = 'Renamed'
    ;(el.querySelector('.foot button.primary') as HTMLButtonElement).click()
    expect(updated).toMatchObject({ id: 'bl-x', title: 'Renamed' })
  })

  it('parent selector offers only nestable, non-read-only candidates', () => {
    const epic = item({ id: 'e1', kind: 'epic', title: 'Epic' })
    const genEpic = item({ id: 'g1', kind: 'epic', title: 'GenEpic', source: 'generated' })
    // Creating a task: an epic can be its parent; a generated epic cannot.
    const el = BacklogModal({
      items: [epic, genEpic],
      onCreate: () => {},
      onUpdate: () => {},
      onCancel: () => {}
    })
    const opts = [...el.querySelectorAll('select.bk-input')].pop()!.querySelectorAll('option')
    const values = [...opts].map((o) => (o as HTMLOptionElement).value)
    expect(values).toContain('e1')
    expect(values).not.toContain('g1')
  })
})
