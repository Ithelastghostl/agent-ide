// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { ProjectRail } from '../../src/renderer/components/ProjectRail'
import { Cockpit } from '../../src/renderer/components/Cockpit'
import type { Project, Session } from '@shared/types'

const projects: Project[] = [
  { id: '1', name: 'sample-api', repo: 'example/sample-api', localPath: '/x', hasDevcontainer: true },
  { id: '2', name: 'sample-cli', repo: 'example/sample-cli', localPath: '/y', hasDevcontainer: false }
]

describe('ProjectRail', () => {
  it('renders one avatar per project plus a home and add button', () => {
    const el = ProjectRail({
      projects,
      activeId: '1',
      counts: { '1': 2, '2': 1 },
      onSelect: () => {},
      onHome: () => {},
      onAdd: () => {}
    })
    expect(el.querySelectorAll('.pj').length).toBe(2)
    expect(el.querySelector('.home')).toBeTruthy()
    expect(el.querySelector('.add')).toBeTruthy()
  })

  it('marks the active project and shows its session count', () => {
    const el = ProjectRail({
      projects,
      activeId: '2',
      counts: { '1': 2, '2': 1 },
      onSelect: () => {},
      onHome: () => {},
      onAdd: () => {}
    })
    const active = el.querySelector('.pj.on')!
    expect(active).toBeTruthy()
    expect(active.querySelector('.av')!.textContent).toBe('SC')
  })
})

describe('Cockpit', () => {
  const sessions: Session[] = [
    { id: 's1', projectId: '1', provider: 'codex', model: 'gpt-5-codex', objective: 'Fix auth', status: 'running', createdAt: 0, updatedAt: 0 },
    { id: 's2', projectId: '1', provider: 'claude', model: 'claude-sonnet-4-6', objective: 'Tests', status: 'idle', createdAt: 0, updatedAt: 0 }
  ]

  it('groups sessions by provider and renders a card each', () => {
    const el = Cockpit({ sessions, activeSessionId: 's1', onLaunch: () => {}, onSelectSession: () => {} })
    expect(el.querySelectorAll('.scard').length).toBe(2)
    // provider group headers present for codex and claude
    expect(el.querySelector('.provrow.codex')).toBeTruthy()
    expect(el.querySelector('.provrow.claude')).toBeTruthy()
  })

  it('fires onLaunch with the provider when a launch button is clicked', () => {
    let launched = ''
    const el = Cockpit({ sessions, activeSessionId: 's1', onLaunch: (p) => { launched = p }, onSelectSession: () => {} })
    const btn = el.querySelector('.launch button.codex') as HTMLButtonElement
    btn.click()
    expect(launched).toBe('codex')
  })

  it('shows a ⋯ menu button per card and fires onSessionMenu (F6)', () => {
    let opened: string | null = null
    const el = Cockpit({
      sessions, activeSessionId: 's1',
      onLaunch: () => {}, onSelectSession: () => {},
      onSessionMenu: (s) => { opened = s.id }
    })
    const dots = el.querySelectorAll('.scard .dots')
    expect(dots.length).toBe(2)
    ;(dots[0] as HTMLElement).click()
    expect(opened).toBe('s1')
  })

  it('marks a session needing reconnect and tags it (F4)', () => {
    const el = Cockpit({
      sessions, activeSessionId: 's1',
      reconnect: new Set(['s1']),
      onLaunch: () => {}, onSelectSession: () => {}, onSessionMenu: () => {}
    })
    const card = el.querySelector('.scard.reconnect')
    expect(card).toBeTruthy()
    expect(el.querySelector('.reconnect-tag')!.textContent).toContain('reconnect')
  })
})
