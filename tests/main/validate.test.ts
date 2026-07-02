import { describe, it, expect } from 'vitest'
import {
  asString,
  asBool,
  isKnownModel,
  validateLaunchRequest,
  validateResumeSession,
  validateTaskLabel,
  validateTaskTransition,
  validateTicketFields
} from '../../src/main/validate'

// B9: IPC payloads cross the renderer→main boundary as `unknown`; TS types don't
// survive it. Main must validate every field at runtime (enum membership, length,
// project ownership, model membership, status transitions) so a compromised or
// buggy renderer can't drive main with malformed input.

describe('asString', () => {
  it('accepts a string within the length cap', () => {
    expect(asString('hello', 'f', { max: 10 })).toBe('hello')
  })
  it('rejects a non-string', () => {
    expect(() => asString(42, 'f')).toThrow(/f/)
    expect(() => asString(undefined, 'f')).toThrow(/f/)
    expect(() => asString({}, 'f')).toThrow(/f/)
  })
  it('rejects an over-long string', () => {
    expect(() => asString('x'.repeat(11), 'f', { max: 10 })).toThrow(/f/)
  })
  it('allows empty only when permitted', () => {
    expect(() => asString('', 'f')).toThrow(/f/) // empty rejected by default
    expect(asString('', 'f', { allowEmpty: true })).toBe('')
  })
})

describe('asBool', () => {
  it('accepts booleans', () => {
    expect(asBool(true, 'f')).toBe(true)
    expect(asBool(false, 'f')).toBe(false)
  })
  it('rejects non-booleans (no truthiness coercion)', () => {
    expect(() => asBool('true', 'f')).toThrow(/f/)
    expect(() => asBool(1, 'f')).toThrow(/f/)
  })
})

describe('isKnownModel (model membership)', () => {
  it('accepts a real model for its provider', () => {
    expect(isKnownModel('claude', 'claude-opus-4-8')).toBe(true)
    expect(isKnownModel('codex', 'gpt-5-codex')).toBe(true)
  })
  it('rejects a model that is not in the provider\'s registry', () => {
    expect(isKnownModel('claude', 'gpt-5-codex')).toBe(false) // wrong provider
    expect(isKnownModel('claude', 'made-up-model')).toBe(false)
  })
})

describe('validateLaunchRequest (B9)', () => {
  const knownProjects = new Set(['proj-abc'])
  const isKnownProject = (id: string) => knownProjects.has(id)
  const good = {
    projectId: 'proj-abc',
    provider: 'claude',
    model: 'claude-opus-4-8',
    objective: 'do a thing',
    cwd: '/home/me/proj',
    useContainer: false,
    taskKind: 'product',
    taskSubkind: 'bug'
  }

  it('accepts a well-formed request', () => {
    const r = validateLaunchRequest(good, isKnownProject)
    expect(r.provider).toBe('claude')
    expect(r.projectId).toBe('proj-abc')
    expect(r.taskKind).toBe('product')
    expect(r.taskSubkind).toBe('bug')
  })

  it('rejects a bad provider (enum membership)', () => {
    expect(() => validateLaunchRequest({ ...good, provider: 'skynet' }, isKnownProject)).toThrow(/provider/i)
  })

  it('rejects a model not in the provider registry (model membership)', () => {
    expect(() => validateLaunchRequest({ ...good, model: 'nope' }, isKnownProject)).toThrow(/model/i)
  })

  it('rejects an unknown projectId (project ownership)', () => {
    expect(() => validateLaunchRequest({ ...good, projectId: 'proj-evil' }, isKnownProject)).toThrow(/project/i)
  })

  it('rejects non-object / missing payloads', () => {
    expect(() => validateLaunchRequest(null, isKnownProject)).toThrow()
    expect(() => validateLaunchRequest('str', isKnownProject)).toThrow()
    expect(() => validateLaunchRequest({ provider: 'claude' }, isKnownProject)).toThrow()
  })

  it('rejects a wrong-typed useContainer (no coercion)', () => {
    expect(() => validateLaunchRequest({ ...good, useContainer: 'yes' }, isKnownProject)).toThrow(/useContainer/i)
  })

  it('M-LOG-a: rejects a launch with no/invalid task label', () => {
    const { taskKind, taskSubkind, ...noLabel } = good
    expect(() => validateLaunchRequest(noLabel, isKnownProject)).toThrow(/taskKind/i)
    expect(() => validateLaunchRequest({ ...good, taskKind: 'nonsense' }, isKnownProject)).toThrow(/taskKind/i)
  })

  it('M-LOG-a: a product launch requires a subkind; analysis must not have one', () => {
    expect(() => validateLaunchRequest({ ...good, taskKind: 'product', taskSubkind: undefined }, isKnownProject)).toThrow(/subkind/i)
    const analysis = validateLaunchRequest({ ...good, taskKind: 'analysis', taskSubkind: undefined }, isKnownProject)
    expect(analysis.taskKind).toBe('analysis')
    expect(analysis.taskSubkind).toBeUndefined()
    expect(() => validateLaunchRequest({ ...good, taskKind: 'analysis', taskSubkind: 'bug' }, isKnownProject)).toThrow(/subkind/i)
  })
})

describe('validateTaskLabel (M-LOG-a §4.1)', () => {
  it('accepts product+subkind and analysis (no subkind)', () => {
    expect(validateTaskLabel('product', 'code')).toEqual({ taskKind: 'product', taskSubkind: 'code' })
    expect(validateTaskLabel('analysis', undefined)).toEqual({ taskKind: 'analysis' })
  })
  it('rejects unknown kind/subkind and product-without-subkind', () => {
    expect(() => validateTaskLabel('x', 'code')).toThrow(/taskKind/i)
    expect(() => validateTaskLabel('product', 'x')).toThrow(/subkind/i)
    expect(() => validateTaskLabel('product', undefined)).toThrow(/subkind/i)
  })
})

describe('validateTaskTransition (M-LOG-a §4.1 lifecycle)', () => {
  it('allows forward moves and self-transition', () => {
    expect(validateTaskTransition('open', 'finished')).toBe('finished')
    expect(validateTaskTransition('finished', 'deployed')).toBe('deployed')
    expect(validateTaskTransition('deployed', 'ticketed')).toBe('ticketed')
    expect(validateTaskTransition('open', 'open')).toBe('open')
    expect(validateTaskTransition(null, 'finished')).toBe('finished') // null → treated as open
  })
  it('rejects backward moves and unknown states', () => {
    expect(() => validateTaskTransition('deployed', 'open')).toThrow(/backward/i)
    expect(() => validateTaskTransition('finished', 'zombie')).toThrow(/task status/i)
  })
})

describe('validateTicketFields (M-LOG-b §4.4 schema)', () => {
  const good = {
    title: 'Fix the widget race', subkind: 'bug', problem: 'it raced', solution: 'added a lock',
    files_touched: ['a.ts', 'b.ts'], key_decisions: ['use a mutex'], follow_ups: [],
    test_status: 'unit green', deploy_ref: 'commit abc123'
  }
  it('accepts a well-formed ticket', () => {
    const t = validateTicketFields(good)
    expect(t.title).toBe('Fix the widget race')
    expect(t.subkind).toBe('bug')
    expect(t.files_touched).toEqual(['a.ts', 'b.ts'])
  })
  it('rejects a bad subkind', () => {
    expect(() => validateTicketFields({ ...good, subkind: 'chore' })).toThrow(/subkind/i)
  })
  it('rejects a missing title', () => {
    expect(() => validateTicketFields({ ...good, title: '' })).toThrow(/title/i)
    const { title, ...noTitle } = good
    expect(() => validateTicketFields(noTitle)).toThrow(/title/i)
  })
  it('rejects non-array list fields', () => {
    expect(() => validateTicketFields({ ...good, files_touched: 'a.ts' })).toThrow(/files_touched/i)
    expect(() => validateTicketFields({ ...good, follow_ups: null })).toThrow(/follow_ups/i)
  })
  it('rejects a non-object payload', () => {
    expect(() => validateTicketFields('not json')).toThrow(/object/i)
    expect(() => validateTicketFields(null)).toThrow()
  })
})

describe('validateResumeSession (B9: status transitions + membership)', () => {
  const good = {
    id: 'sess-1-123',
    projectId: 'proj-abc',
    provider: 'codex',
    model: 'gpt-5-codex',
    objective: 'x',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2
  }
  it('accepts a valid session with a known status', () => {
    expect(validateResumeSession(good).id).toBe('sess-1-123')
  })
  it('rejects an unknown status value (status transitions)', () => {
    expect(() => validateResumeSession({ ...good, status: 'zombie' })).toThrow(/status/i)
  })
  it('rejects a bad provider and a bad model', () => {
    expect(() => validateResumeSession({ ...good, provider: 'x' })).toThrow(/provider/i)
    expect(() => validateResumeSession({ ...good, model: 'x' })).toThrow(/model/i)
  })
  it('rejects a missing id', () => {
    expect(() => validateResumeSession({ ...good, id: '' })).toThrow(/id/i)
  })
})
