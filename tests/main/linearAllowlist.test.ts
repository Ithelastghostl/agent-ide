import { describe, it, expect } from 'vitest'
import { resolveTool, resolveAllowedTools, argNameFor } from '../../src/main/linear/toolAllowlist'
import type { McpTool } from '../../src/main/linear/mcpClient'

const tools: McpTool[] = [
  { name: 'list_issues', inputSchema: { type: 'object', properties: { teamId: {}, first: {}, after: {} } } },
  { name: 'get_issue', inputSchema: { type: 'object', properties: { id: {} } } },
  { name: 'update_issue', inputSchema: { type: 'object', properties: { id: {}, stateId: {}, title: {} } } },
  { name: 'create_comment', inputSchema: { type: 'object', properties: { issueId: {}, body: {} } } },
  { name: 'delete_issue', inputSchema: { type: 'object', properties: { id: {} } } },
  { name: 'create_issue', inputSchema: { type: 'object', properties: { title: {}, teamId: {} } } }
]

describe('resolveTool — name pattern + schema shape', () => {
  it('resolves list-issues to list_issues (not create/delete/search)', () => {
    expect(resolveTool(tools, 'list-issues')?.name).toBe('list_issues')
  })
  it('resolves get-issue only when an id-like arg exists', () => {
    expect(resolveTool(tools, 'get-issue')?.name).toBe('get_issue')
  })
  it('resolves update-state to update_issue (needs id + state arg)', () => {
    expect(resolveTool(tools, 'update-state')?.name).toBe('update_issue')
  })
  it('resolves create-comment to create_comment (needs a body arg)', () => {
    expect(resolveTool(tools, 'create-comment')?.name).toBe('create_comment')
  })
  it('does NOT resolve update-state to a tool lacking a state arg', () => {
    const noState: McpTool[] = [{ name: 'update_issue', inputSchema: { type: 'object', properties: { id: {}, title: {} } } }]
    expect(resolveTool(noState, 'update-state')).toBeNull()
  })
  it('does NOT resolve create-comment to a tool that forbids the intent', () => {
    const only: McpTool[] = [{ name: 'delete_comment', inputSchema: { type: 'object', properties: { body: {} } } }]
    expect(resolveTool(only, 'create-comment')).toBeNull()
  })
  it('rejects a get-issue tool with no schema properties (can not validate args)', () => {
    const bare: McpTool[] = [{ name: 'get_issue' }]
    expect(resolveTool(bare, 'get-issue')).toBeNull()
  })
})

describe('resolveAllowedTools', () => {
  it('resolves all four intents from a realistic tool list', () => {
    const all = resolveAllowedTools(tools)
    expect(all['list-issues']?.name).toBe('list_issues')
    expect(all['get-issue']?.name).toBe('get_issue')
    expect(all['update-state']?.name).toBe('update_issue')
    expect(all['create-comment']?.name).toBe('create_comment')
  })
  it('leaves an intent null when no tool matches', () => {
    const partial: McpTool[] = [tools[1]] // only get_issue
    const all = resolveAllowedTools(partial)
    expect(all['get-issue']).not.toBeNull()
    expect(all['create-comment']).toBeNull()
    expect(all['update-state']).toBeNull()
  })
})

describe('argNameFor', () => {
  it('picks the schema arg the tool actually declares', () => {
    expect(argNameFor(tools[3], ['issueId', 'issue_id', 'id'])).toBe('issueId')
    expect(argNameFor(tools[2], ['stateName', 'stateId', 'state'])).toBe('stateId')
  })
  it('returns null when none of the candidates are in a declared schema', () => {
    expect(argNameFor(tools[1], ['body', 'text'])).toBeNull()
  })
})
