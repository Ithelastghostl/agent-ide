// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  stageChip, approvalIndicator, stageControl, nextStage, effectiveStageOf,
  approvalModeFor, advanceRequiresRelaunch
} from '../../src/renderer/components/StageChip'
import type { Session } from '@shared/types'

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1', projectId: 'p1', provider: 'claude', model: 'claude-sonnet-4-6',
    objective: 'Ship it', status: 'running', createdAt: 0, updatedAt: 0, ...over
  }
}

describe('nextStage (adjacent-only)', () => {
  it('advances discussion→playback→fix and stops at fix', () => {
    expect(nextStage('discussion')).toBe('playback')
    expect(nextStage('playback')).toBe('fix')
    expect(nextStage('fix')).toBeNull()
  })
})

describe('effectiveStageOf', () => {
  it('reads effectiveStage, falling back to desiredStage then discussion', () => {
    expect(effectiveStageOf(session({ effectiveStage: 'fix' }))).toBe('fix')
    expect(effectiveStageOf(session({ effectiveStage: null, desiredStage: 'playback' }))).toBe('playback')
    expect(effectiveStageOf(session({ effectiveStage: null, desiredStage: null }))).toBe('discussion')
  })
})

describe('approvalModeFor (mirrors main policy)', () => {
  it('auto only at fix in a container; guarded otherwise', () => {
    expect(approvalModeFor('fix', true)).toBe('auto')
    expect(approvalModeFor('fix', false)).toBe('guarded')
    expect(approvalModeFor('playback', true)).toBe('guarded')
    expect(approvalModeFor('discussion', false)).toBe('guarded')
  })
})

describe('stageChip renders effectiveStage', () => {
  it('renders a labelled chip with a per-stage class', () => {
    const el = stageChip('playback')
    expect(el.className).toContain('stage-chip')
    expect(el.className).toContain('playback')
    expect(el.textContent).toBe('Playback')
  })
})

describe('approvalIndicator renders spawnedApprovalMode (not effectiveStage)', () => {
  it('shows guarded/auto from the spawned mode', () => {
    expect(approvalIndicator('guarded', 'running')!.textContent).toBe('guarded')
    const auto = approvalIndicator('auto', 'running')!
    expect(auto.textContent).toBe('auto')
    expect(auto.className).toContain('auto')
  })
  it('is null when no mode or when archived', () => {
    expect(approvalIndicator(null, 'running')).toBeNull()
    expect(approvalIndicator(undefined, 'running')).toBeNull()
    expect(approvalIndicator('auto', 'archived')).toBeNull()
  })
  it('CONTAINER-in-playback that is still guarded shows guarded even though effectiveStage moved', () => {
    // The crux of R29: a container session advanced to playback but not yet
    // relaunched to fix still runs guarded — the two fields disagree by design.
    const s = session({ useContainer: true, effectiveStage: 'playback', spawnedApprovalMode: 'guarded' })
    expect(effectiveStageOf(s)).toBe('playback')
    expect(approvalIndicator(s.spawnedApprovalMode, s.status)!.textContent).toBe('guarded')
  })
})

describe('advanceRequiresRelaunch', () => {
  it('host session → fix is label-only (no relaunch)', () => {
    const s = session({ useContainer: false, effectiveStage: 'playback', spawnedApprovalMode: 'guarded' })
    expect(advanceRequiresRelaunch(s, 'fix')).toBe(false)
  })
  it('running container → fix flips guarded→auto = relaunch required', () => {
    const s = session({ useContainer: true, status: 'running', effectiveStage: 'playback', spawnedApprovalMode: 'guarded' })
    expect(advanceRequiresRelaunch(s, 'fix')).toBe(true)
  })
  it('container discussion→playback is label-only (still guarded)', () => {
    const s = session({ useContainer: true, status: 'running', effectiveStage: 'discussion', spawnedApprovalMode: 'guarded' })
    expect(advanceRequiresRelaunch(s, 'playback')).toBe(false)
  })
  it('idle container → fix does NOT relaunch (no live engine to swap)', () => {
    const s = session({ useContainer: true, status: 'idle', effectiveStage: 'playback', spawnedApprovalMode: 'guarded' })
    expect(advanceRequiresRelaunch(s, 'fix')).toBe(false)
  })
})

describe('stageControl (header)', () => {
  it('renders chip + indicator + an advance button to the next stage', () => {
    const el = stageControl({ session: session({ effectiveStage: 'discussion', spawnedApprovalMode: 'guarded' }), onAdvance: () => {} })
    expect(el.querySelector('.stage-chip.discussion')).toBeTruthy()
    expect(el.querySelector('.approval-ind.guarded')).toBeTruthy()
    const btn = el.querySelector('.stage-advance') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.textContent).toContain('Playback')
  })

  it('fires onAdvance with the next stage', () => {
    let to = ''
    const el = stageControl({ session: session({ effectiveStage: 'playback' }), onAdvance: (t) => { to = t } })
    ;(el.querySelector('.stage-advance') as HTMLButtonElement).click()
    expect(to).toBe('fix')
  })

  it('hides the advance button at fix (top of the ladder)', () => {
    const el = stageControl({ session: session({ effectiveStage: 'fix' }), onAdvance: () => {} })
    expect(el.querySelector('.stage-advance')).toBeNull()
  })

  it('readOnly omits the advance button', () => {
    const el = stageControl({ session: session({ effectiveStage: 'discussion' }), onAdvance: () => {}, readOnly: true })
    expect(el.querySelector('.stage-advance')).toBeNull()
    expect(el.querySelector('.stage-chip')).toBeTruthy()
  })

  it("advance button's title warns about a fix-mode restart for running containers", () => {
    const s = session({ useContainer: true, status: 'running', effectiveStage: 'playback', spawnedApprovalMode: 'guarded' })
    const el = stageControl({ session: s, onAdvance: () => {} })
    expect((el.querySelector('.stage-advance') as HTMLButtonElement).title).toContain('restart')
  })
})
