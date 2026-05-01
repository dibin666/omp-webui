import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildWebuiState,
  DEFAULT_WEBUI_SETTINGS,
  extractTodoTasksFromEntries,
  getModifiedFiles,
  listFileTree,
  mapAgentMessage,
  parseDiffLines,
  resolvePathInsideRoot,
} from './state'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('path guards', () => {
  test('rejects traversal outside the project root', async () => {
    const root = await makeTempDir()
    expect(() => resolvePathInsideRoot(root, '../outside.txt')).toThrow('escapes')
    expect(() => resolvePathInsideRoot(root, '/etc/passwd')).toThrow('relative')
  })
})

describe('file tree', () => {
  test('bounds directory listings and reports truncation', async () => {
    const root = await makeTempDir()
    await fs.writeFile(path.join(root, 'a.txt'), 'a')
    await fs.writeFile(path.join(root, 'b.txt'), 'b')
    await fs.writeFile(path.join(root, 'c.txt'), 'c')

    const tree = await listFileTree(root, '.', 2)

    expect(tree.nodes).toHaveLength(2)
    expect(tree.truncated).toBe(true)
  })
})


describe('git state', () => {
  test('reports non-git directories without fake modified files', async () => {
    const root = await makeTempDir()
    const result = await getModifiedFiles(root)

    expect(result.files).toEqual([])
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})

describe('context usage mapping', () => {
  test('uses provider request scope for category totals when available', async () => {
    const root = await makeTempDir()
    const state = await buildWebuiState(
      {
        cwd: root,
        model: { name: 'gpt-5.5', contextWindow: 1000 },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        getSystemPrompt: () => 'system prompt text\n<skills>\n<skill name="doc">Write docs</skill>\n</skills>',
        isIdle: () => true,
        hasPendingMessages: () => false,
        sessionManager: {
          getBranch: () => [{ type: 'message', id: 'm1', message: { role: 'user', content: 'old historical message that is no longer provider scope' } }],
          getSessionDir: () => '',
          getSessionFile: () => undefined,
          getSessionName: () => 'test',
        },
      },
      DEFAULT_WEBUI_SETTINGS,
      [],
      [],
      [],
      {
        messages: [
          { role: 'system', content: 'system prompt text\n<skills>\n<skill name="doc">Write docs</skill>\n</skills>' },
          { role: 'user', content: 'hello' },
        ],
        tools: [{ name: 'read', description: 'Read files', input_schema: { type: 'object' } }],
      },
      'high',
    )

    const usedCategoryTokens = state.contextUsage.categories
      .filter(category => ['systemPrompt', 'systemTools', 'skills', 'messages'].includes(category.id))
      .reduce((sum, category) => sum + (category.tokens ?? 0), 0)
    expect(state.contextUsage.tokens).toBe(usedCategoryTokens)
    expect(state.contextUsage.tokens).not.toBe(900)
    expect(state.contextUsage.tokens).toBeGreaterThan(0)
    expect(state.contextUsage.freeTokens).toBe(1000 - (state.contextUsage.tokens ?? 0) - (state.contextUsage.autoCompactBufferTokens ?? 0))
    expect(state.contextUsage.categories.map(category => category.id)).toEqual([
      'systemPrompt',
      'systemTools',
      'skills',
      'messages',
      'freeSpace',
      'autoCompactBuffer',
    ])
    expect(state.contextUsage.categories.find(category => category.id === 'messages')?.tokens).toBeLessThan(50)
    expect(state.contextUsage.categories.find(category => category.id === 'skills')?.tokens).toBeGreaterThan(0)
    expect(state.contextUsage.categories.find(category => category.id === 'autoCompactBuffer')?.tokens).toBe(1)
    expect(state.thinkingLevel).toBe('high')
  })
})

describe('diff parsing', () => {
  test('classifies changed lines without counting diff headers as changes', () => {
    const lines = parseDiffLines(['diff --git a/a b/a', '--- a/a', '+++ b/a', ' context', '-old', '+new'].join('\n'))

    expect(lines.filter(line => line.type === 'plus').map(line => line.content)).toEqual(['+new'])
    expect(lines.filter(line => line.type === 'minus').map(line => line.content)).toEqual(['-old'])
    expect(lines.slice(0, 3).every(line => line.type === 'normal')).toBe(true)
  })
})

describe('message mapping', () => {
  test('merges tool results into their assistant tool call message', async () => {
    const root = await makeTempDir()
    const askArguments = {
      questions: [
        {
          id: 'deploy',
          question: 'Deploy this change?',
          options: [{ label: 'Yes' }, { label: 'No' }],
          recommended: 1,
        },
      ],
    }
    const askDetails = {
      results: [
        {
          id: 'deploy',
          question: 'Deploy this change?',
          options: ['Yes', 'No'],
          multi: false,
          selectedOptions: ['No'],
        },
      ],
    }

    const state = await buildWebuiState(
      {
        cwd: root,
        model: { name: 'test-model' },
        getContextUsage: () => undefined,
        isIdle: () => true,
        hasPendingMessages: () => false,
        sessionManager: {
          getBranch: () => [
            {
              type: 'message',
              id: 'assistant-ask',
              message: {
                role: 'assistant',
                content: [{ type: 'toolCall', id: 'toolu_ask', name: 'ask', arguments: askArguments }],
              },
            },
            {
              type: 'message',
              id: 'ask-result',
              message: {
                role: 'toolResult',
                toolCallId: 'toolu_ask',
                toolName: 'ask',
                content: [{ type: 'text', text: 'User answers:\n[deploy] No' }],
                isError: false,
                details: askDetails,
              },
            },
          ],
          getSessionDir: () => '',
          getSessionFile: () => undefined,
          getSessionName: () => 'test',
        },
      },
      DEFAULT_WEBUI_SETTINGS,
      [],
      [],
    )

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.content).toBe('')
    expect(state.messages[0]?.tools).toHaveLength(1)
    expect(state.messages[0]?.tools?.[0]).toMatchObject({
      id: 'toolu_ask',
      name: 'ask',
      result: 'User answers:\n[deploy] No',
      resultDetails: askDetails,
      isError: false,
    })
    expect(JSON.parse(state.messages[0]?.tools?.[0]?.args ?? '{}')).toEqual(askArguments)
    expect(state.jobs).toEqual([])
  })
  test('preserves edit result details for diff rendering', () => {
    const details = { diff: '-1|old\n+1|new', firstChangedLine: 1 }
    const message = mapAgentMessage(
      {
        role: 'toolResult',
        toolCallId: 'toolu_edit',
        toolName: 'edit',
        content: [{ type: 'text', text: 'Updated a.ts\nDiff preview:\n-1ab|old\n+1cd|new' }],
        details,
      },
      'edit-result',
    )

    expect(message?.tools?.[0]?.resultDetails).toEqual(details)
  })

  test('does not derive subagent jobs from historical tool messages', async () => {
    const root = await makeTempDir()
    const taskArguments = {
      agent: 'explore',
      tasks: [{ id: 'FindContext', description: 'Find context', assignment: 'Read files' }],
    }

    const state = await buildWebuiState(
      {
        cwd: root,
        model: { name: 'test-model' },
        getContextUsage: () => undefined,
        isIdle: () => true,
        hasPendingMessages: () => false,
        sessionManager: {
          getBranch: () => [
            {
              type: 'message',
              id: 'assistant-task',
              message: {
                role: 'assistant',
                timestamp: 1000,
                content: [
                  { type: 'text', text: 'Tool call requested.' },
                  { type: 'toolCall', id: 'toolu_task', name: 'task', arguments: taskArguments },
                  { type: 'toolCall', id: 'toolu_read', name: 'read', arguments: { path: 'a.ts' } },
                ],
              },
            },
            {
              type: 'message',
              id: 'read-result',
              message: {
                role: 'toolResult',
                toolCallId: 'toolu_read',
                toolName: 'read',
                content: [{ type: 'text', text: 'file content' }],
              },
            },
            {
              type: 'message',
              id: 'task-result',
              message: {
                role: 'toolResult',
                toolCallId: 'toolu_task',
                toolName: 'task',
                content: [{ type: 'text', text: 'subagent done' }],
                isError: false,
              },
            },
          ],
          getSessionDir: () => '',
          getSessionFile: () => undefined,
          getSessionName: () => 'test',
        },
      },
      DEFAULT_WEBUI_SETTINGS,
      [],
      [],
    )

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.content).toBe('')
    expect(state.messages[0]?.tools?.map(tool => tool.name).sort()).toEqual(['read', 'task'])
    expect(state.jobs).toEqual([])
  })


  test('maps system notices into collapsed notice blocks', () => {
    const message = mapAgentMessage(
      {
        role: 'developer',
        content: '<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\n\n[Command timed out after 120 seconds]\n$ vite preview --host "127.0.0.1" --port "4173"\n</system-notice>',
      },
      'notice-1',
    )

    expect(message).toMatchObject({
      id: 'notice-1',
      role: 'system',
      content: '',
      notices: [
        {
          id: 'notice-1:notice',
          title: 'Background job completed · bg_1',
          status: 'warning',
        },
      ],
    })
    expect(message?.notices?.[0]?.body).toContain('vite preview')
  })
  test('maps image content into renderable image blocks', () => {
    const message = mapAgentMessage(
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        ],
      },
      'image-1',
    )

    expect(message).toMatchObject({
      id: 'image-1',
      role: 'user',
      content: 'look at this',
      images: [{ id: 'image-1:image:1', mimeType: 'image/png', data: 'aGVsbG8=' }],
    })
  })


  test('keeps unpaired tool results collapsed without duplicate message content', () => {
    const message = mapAgentMessage(
      {
        role: 'toolResult',
        toolCallId: 'toolu_read',
        toolName: 'read',
        content: [{ type: 'text', text: 'file content' }],
      },
      'result-1',
    )

    expect(message).toMatchObject({
      id: 'result-1',
      role: 'tool',
      content: '',
      tools: [{ id: 'toolu_read', name: 'read', result: 'file content' }],
    })
  })

  test('renders legacy execution messages as collapsed tool blocks', () => {
    const message = mapAgentMessage(
      {
        role: 'bashExecution',
        command: 'echo ok',
        output: 'ok',
        exitCode: 0,
      },
      'bash-1',
    )

    expect(message?.content).toBe('')
    expect(message?.tools?.[0]?.name).toBe('bash')
    expect(message?.tools?.[0]?.result).toContain('Command: echo ok')
  })
})

describe('todo extraction', () => {
  test('uses latest persisted custom todo edit over older tool results', () => {
    const entries = [
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'todo_write',
          isError: false,
          details: {
            phases: [{ name: 'Old', tasks: [{ content: 'Old task', status: 'completed' }] }],
          },
        },
      },
      {
        type: 'custom',
        customType: 'user_todo_edit',
        data: {
          phases: [{ name: 'New', tasks: [{ content: 'New task', status: 'in_progress', notes: ['note'] }] }],
        },
      },
    ]

    expect(extractTodoTasksFromEntries(entries)).toEqual([
      {
        id: 'New:New task',
        title: 'New task',
        status: 'in_progress',
        phase: 'New',
        notes: ['note'],
      },
    ])
  })
})

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-webui-'))
  tempDirs.push(dir)
  return dir
}
