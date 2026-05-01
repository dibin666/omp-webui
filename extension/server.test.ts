import { describe, expect, test } from 'bun:test'
import { DEFAULT_WEBUI_SETTINGS, type WebuiExtensionContext } from './state'
import { assertBuiltDist, MissingDistError, WebuiRuntime } from './server'

describe('WebuiRuntime message endpoint', () => {
  test('requires the per-server token', async () => {
    const runtime = new WebuiRuntime({
      pi: { sendUserMessage: () => undefined },
      settings: DEFAULT_WEBUI_SETTINGS,
      distDir: '.',
      token: 'secret',
    })
    runtime.setContext(fakeContext(true))

    const response = await runtime.handleRequest(new Request('http://127.0.0.1/api/messages', { method: 'POST' }))

    expect(response.status).toBe(401)
  })

  test('queues messages as follow-up while OMP is busy', async () => {
    const calls: Array<{ content: unknown; deliverAs: string | undefined }> = []
    const runtime = new WebuiRuntime({
      pi: {
        sendUserMessage: (content, options) => {
          calls.push({ content, deliverAs: options?.deliverAs })
        },
      },
      settings: DEFAULT_WEBUI_SETTINGS,
      distDir: '.',
      token: 'secret',
    })
    runtime.setContext(fakeContext(false))

    const response = await runtime.handleRequest(
      new Request('http://127.0.0.1/api/messages?token=secret', {
        method: 'POST',
        body: JSON.stringify({ text: 'hello' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ queued: true })
    expect(calls).toEqual([{ content: 'hello', deliverAs: 'followUp' }])
  })
  test('sends pasted images as structured user content', async () => {
    const calls: Array<{ content: unknown; deliverAs: string | undefined }> = []
    const runtime = new WebuiRuntime({
      pi: {
        sendUserMessage: (content, options) => {
          calls.push({ content, deliverAs: options?.deliverAs })
        },
      },
      settings: DEFAULT_WEBUI_SETTINGS,
      distDir: '.',
      token: 'secret',
    })
    runtime.setContext(fakeContext(true))

    const response = await runtime.handleRequest(
      new Request('http://127.0.0.1/api/messages?token=secret', {
        method: 'POST',
        body: JSON.stringify({ text: '', images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }] }),
      }),
    )

    expect(response.status).toBe(200)
    expect(calls).toEqual([
      {
        content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
        deliverAs: undefined,
      },
    ])
  })

  test('rejects invalid pasted image payloads', async () => {
    const runtime = new WebuiRuntime({
      pi: { sendUserMessage: () => undefined },
      settings: DEFAULT_WEBUI_SETTINGS,
      distDir: '.',
      token: 'secret',
    })
    runtime.setContext(fakeContext(true))

    const response = await runtime.handleRequest(
      new Request('http://127.0.0.1/api/messages?token=secret', {
        method: 'POST',
        body: JSON.stringify({ text: '', images: [{ mimeType: 'text/plain', data: 'aGVsbG8=' }] }),
      }),
    )

    expect(response.status).toBe(400)
  })
  test('shows only running task subagent jobs from tool events', async () => {
    const runtime = new WebuiRuntime({
      pi: { sendUserMessage: () => undefined },
      settings: DEFAULT_WEBUI_SETTINGS,
      distDir: '.',
      token: 'secret',
    })
    const ctx = fakeContext(true)

    runtime.recordEvent({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'a.ts' } }, ctx)
    runtime.recordEvent(
      {
        type: 'tool_execution_start',
        toolCallId: 'task-1',
        toolName: 'task',
        args: { agent: 'explore', tasks: [{ id: 'FindContext', description: 'Find context' }] },
      },
      ctx,
    )

    const runningState = await runtime.buildState()
    expect(runningState.jobs).toHaveLength(1)
    expect(runningState.jobs[0]).toMatchObject({ id: 'task-1', title: 'explore: Find context', status: 'running' })

    runtime.recordEvent(
      {
        type: 'tool_execution_end',
        toolCallId: 'task-1',
        toolName: 'task',
        result: { content: [{ type: 'text', text: 'done' }] },
        isError: false,
      },
      ctx,
    )

    const completedState = await runtime.buildState()
    expect(completedState.jobs).toEqual([])
  })


  test('rejects traversal through the file API', async () => {
    const runtime = new WebuiRuntime({
      pi: { sendUserMessage: () => undefined },
      settings: DEFAULT_WEBUI_SETTINGS,
      distDir: '.',
      token: 'secret',
    })
    runtime.setContext(fakeContext(true))

    const response = await runtime.handleRequest(new Request('http://127.0.0.1/api/file?token=secret&path=../package.json'))

    expect(response.status).not.toBe(200)
    expect((await response.json()) as { error: string }).toHaveProperty('error')
  })
})


describe('static build checks', () => {
  test('reports a missing dist build truthfully', async () => {
    await expect(assertBuiltDist('/definitely/missing/omp-webui-dist')).rejects.toBeInstanceOf(MissingDistError)
  })
})
function fakeContext(idle: boolean): WebuiExtensionContext {
  return {
    cwd: process.cwd(),
    model: undefined,
    getContextUsage: () => undefined,
    isIdle: () => idle,
    hasPendingMessages: () => false,
    sessionManager: {
      getBranch: () => [],
      getSessionDir: () => '',
      getSessionFile: () => undefined,
      getSessionName: () => undefined,
    },
  }
}
