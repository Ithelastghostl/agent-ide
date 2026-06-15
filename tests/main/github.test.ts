import { describe, it, expect, vi } from 'vitest'
import { parseRepoList, buildHistorySyncCommands } from '../../src/main/github'

describe('parseRepoList', () => {
  it('parses gh repo list JSON into {repo,name}', () => {
    const json = JSON.stringify([
      { nameWithOwner: 'me/talentchain-api', name: 'talentchain-api' },
      { nameWithOwner: 'me/resume-parser', name: 'resume-parser' }
    ])
    expect(parseRepoList(json)).toEqual([
      { repo: 'me/talentchain-api', name: 'talentchain-api' },
      { repo: 'me/resume-parser', name: 'resume-parser' }
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
