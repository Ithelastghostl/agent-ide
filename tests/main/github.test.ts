import { describe, it, expect, vi } from 'vitest'
import { parseRepoList, buildHistorySyncCommands } from '../../src/main/github'

describe('parseRepoList', () => {
  it('parses gh repo list JSON into {repo,name}', () => {
    const json = JSON.stringify([
      { nameWithOwner: 'example/sample-api', name: 'sample-api' },
      { nameWithOwner: 'example/sample-cli', name: 'sample-cli' }
    ])
    expect(parseRepoList(json)).toEqual([
      { repo: 'example/sample-api', name: 'sample-api' },
      { repo: 'example/sample-cli', name: 'sample-cli' }
    ])
  })

  it('returns [] for empty output', () => {
    expect(parseRepoList('[]')).toEqual([])
  })
})

describe('buildHistorySyncCommands', () => {
  it('produces add, commit, push with the given timestamp', () => {
    const cmds = buildHistorySyncCommands('2026-06-15T10:00:00Z')
    expect(cmds).toEqual([
      ['git', ['add', '-A']],
      ['git', ['commit', '-m', 'history: 2026-06-15T10:00:00Z']],
      ['git', ['push']]
    ])
  })
})
