import { describe, it, expect } from 'vitest'
import {
  asString,
  asBool,
  isKnownModel,
  validateLaunchRequest,
  validateResumeSession
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
    useContainer: false
  }

  it('accepts a well-formed request', () => {
    const r = validateLaunchRequest(good, isKnownProject)
    expect(r.provider).toBe('claude')
    expect(r.projectId).toBe('proj-abc')
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
