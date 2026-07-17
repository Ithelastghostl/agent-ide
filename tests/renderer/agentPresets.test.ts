// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { LibraryPanel } from '../../src/renderer/components/LibraryPanel'
import { ModelPicker } from '../../src/renderer/components/ModelPicker'
import { Cockpit } from '../../src/renderer/components/Cockpit'
import { SupervisionView } from '../../src/renderer/components/SupervisionView'
import type { LibraryItem, Model, Provider, Session } from '@shared/types'

const AGENT: LibraryItem = {
  category: 'agents',
  name: 'Release Writer',
  description: 'writes terse release notes',
  relPath: 'agents/release-writer.md',
  path: '/lib/agents/release-writer.md'
}

const MODELS: Record<Provider, Model[]> = {
  claude: [{ id: 'claude-sonnet-4-6', label: 'Sonnet', tier: 'balanced' }],
  codex: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex', tier: 'max' }],
  gemini: [{ id: 'gemini-2.5-pro', label: 'Gemini Pro', tier: 'max' }]
}

describe('S8 LibraryPanel — Launch session action on agents', () => {
  it('renders a "Launch session" action per agent and fires onLaunchAgent', () => {
    let launched: LibraryItem | null = null
    const panel = LibraryPanel({
      category: 'agents',
      items: [AGENT],
      hasActiveSession: false,
      onUse: () => {},
      onLaunchAgent: (it) => { launched = it },
      onCancel: () => {}
    })
    const btn = panel.querySelector('.lib-launch') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.textContent).toContain('Launch session')
    // Available even with NO active session (a preset launch starts a new one).
    expect(btn.disabled).toBe(false)
    btn.click()
    expect(launched).toBe(AGENT)
  })

  it('does not render Launch session for non-agent categories', () => {
    const panel = LibraryPanel({
      category: 'prompts',
      items: [{ ...AGENT, category: 'prompts', relPath: 'prompts/x.md' }],
      hasActiveSession: true,
      onUse: () => {},
      onCancel: () => {}
    })
    expect(panel.querySelector('.lib-launch')).toBeNull()
  })
})

describe('S8 ModelPicker — prefilled agent-preset launcher', () => {
  it('prefills the objective from the agent description and carries it on confirm', () => {
    const calls: { provider: Provider; model: string; objective: string }[] = []
    const picker = ModelPicker({
      provider: 'claude',
      models: MODELS.claude,
      modelsForProvider: (p) => MODELS[p],
      agentName: AGENT.name,
      objective: AGENT.description,
      onLaunch: (provider, model, objective) => calls.push({ provider, model, objective }),
      onPick: () => { throw new Error('onPick should not fire when onLaunch is set') },
      onCancel: () => {}
    })
    // Title names the agent; objective field is prefilled + editable.
    expect(picker.querySelector('h3')!.textContent).toContain('Release Writer')
    const obj = picker.querySelector('.mp-objective') as HTMLTextAreaElement
    expect(obj).toBeTruthy()
    expect(obj.value).toBe(AGENT.description)

    // Provider tabs allow switching; models list follows.
    expect(picker.querySelectorAll('.mp-provtab').length).toBe(3)

    // Pick the first model → onLaunch carries the (edited) objective.
    obj.value = 'ship the 2.0 notes'
    ;(picker.querySelector('.mopt') as HTMLElement).click()
    expect(calls).toEqual([{ provider: 'claude', model: 'claude-sonnet-4-6', objective: 'ship the 2.0 notes' }])
  })

  it('switching provider lists that provider’s models', () => {
    const picker = ModelPicker({
      provider: 'claude', models: MODELS.claude, modelsForProvider: (p) => MODELS[p],
      agentName: AGENT.name, objective: AGENT.description,
      onLaunch: () => {}, onPick: () => {}, onCancel: () => {}
    })
    const codexTab = Array.from(picker.querySelectorAll('.mp-provtab'))
      .find((t) => (t as HTMLElement).dataset.provider === 'codex') as HTMLButtonElement
    codexTab.click()
    const shown = Array.from(picker.querySelectorAll('.mopt .ti span')).map((s) => s.textContent)
    expect(shown).toEqual(['gpt-5-codex'])
  })

  it('classic model-only picker (no S8 props) still works and fires onPick', () => {
    let picked: { p: Provider; m: string } | null = null
    const picker = ModelPicker({
      provider: 'claude', models: MODELS.claude,
      onPick: (p, m) => { picked = { p, m } }, onCancel: () => {}
    })
    expect(picker.querySelector('.mp-objective')).toBeNull() // no objective field
    expect(picker.querySelector('.mp-provtabs')).toBeNull()  // provider fixed
    ;(picker.querySelector('.mopt') as HTMLElement).click()
    expect(picked).toEqual({ p: 'claude', m: 'claude-sonnet-4-6' })
  })
})

describe('S8 launch flow — the resulting launch request carries agentRelPath', () => {
  it('LibraryPanel → ModelPicker → sessionLaunch(agentRelPath)', async () => {
    // Model the exact renderer wiring: clicking Launch session opens a prefilled
    // picker whose confirm calls sessionLaunch with the agent's relPath.
    const sessionLaunch = vi.fn().mockResolvedValue({ id: 's1' } as Session)
    ;(globalThis as unknown as { window: unknown }).window = { agentIDE: { sessionLaunch } }

    let picker: HTMLElement | null = null
    const panel = LibraryPanel({
      category: 'agents', items: [AGENT], hasActiveSession: false, onUse: () => {},
      onLaunchAgent: (agent) => {
        picker = ModelPicker({
          provider: 'claude', models: MODELS.claude, modelsForProvider: (p) => MODELS[p],
          agentName: agent.name, objective: agent.description,
          onLaunch: (provider, model, objective) => {
            window.agentIDE.sessionLaunch({
              projectId: 'p1', provider, model, objective,
              cwd: '/tmp/p1', useContainer: false,
              taskKind: 'product', taskSubkind: 'feature',
              agentRelPath: agent.relPath
            })
          },
          onPick: () => {}, onCancel: () => {}
        })
      },
      onCancel: () => {}
    })

    ;(panel.querySelector('.lib-launch') as HTMLElement).click()
    expect(picker).not.toBeNull()
    ;(picker!.querySelector('.mopt') as HTMLElement).click()

    expect(sessionLaunch).toHaveBeenCalledTimes(1)
    const req = sessionLaunch.mock.calls[0][0]
    expect(req.agentRelPath).toBe('agents/release-writer.md')
    expect(req.provider).toBe('claude')
    expect(req.model).toBe('claude-sonnet-4-6')
    expect(req.objective).toBe(AGENT.description)
  })
})

describe('S8 agent chip renders for agent-launched sessions', () => {
  const base: Session = {
    id: 's1', projectId: 'p1', provider: 'claude', model: 'claude-sonnet-4-6',
    objective: 'ship notes', status: 'running', createdAt: 0, updatedAt: 0,
    agentRelPath: 'agents/release-writer.md'
  }

  it('Cockpit shows the agent chip on a session card', () => {
    const el = Cockpit({
      sessions: [base], activeSessionId: 's1', onLaunch: () => {}, onSelectSession: () => {},
      agentNameFor: (s) => (s.agentRelPath ? 'Release Writer' : null)
    })
    const chip = el.querySelector('.scard .agent-chip')
    expect(chip).toBeTruthy()
    expect(chip!.textContent).toContain('Release Writer')
  })

  it('Cockpit omits the chip when the session has no agent', () => {
    const el = Cockpit({
      sessions: [{ ...base, agentRelPath: null }], activeSessionId: 's1',
      onLaunch: () => {}, onSelectSession: () => {}, agentNameFor: () => null
    })
    expect(el.querySelector('.scard .agent-chip')).toBeNull()
  })

  it('SupervisionView shows the agent chip in the session header', () => {
    const el = SupervisionView({
      session: base, projectName: 'proj', openFiles: [], openReports: [],
      activeTab: { kind: 'session' }, onSelectTab: () => {}, onCloseFile: () => {}, onCloseReport: () => {},
      agentName: 'Release Writer'
    })
    const chip = el.querySelector('.sv-head .agent-chip')
    expect(chip).toBeTruthy()
    expect(chip!.textContent).toContain('Release Writer')
  })
})
