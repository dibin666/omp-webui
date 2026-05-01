import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SendMessageResponse, WebuiState } from '../shared/types'
import type { WebuiExtensionContext } from './state'

const tempDirs: string[] = []
const previousEnv = {
  HOME: process.env.HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
}

afterEach(async () => {
  restoreEnv()
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('omp-webui extension command', () => {
  test('starts a tokenized loopback server and forwards WebUI messages', async () => {
    const home = await makeTempDir()
    process.env.HOME = home
    delete process.env.XDG_DATA_HOME
    delete process.env.XDG_STATE_HOME
    delete process.env.XDG_CACHE_HOME
    await writePluginRuntimeConfig(home)

    const commands = new Map<string, { handler(args: string, ctx: FakeCommandContext): Promise<void> }>()
    const handlers = new Map<string, (event: unknown, ctx: FakeCommandContext) => void | Promise<void>>()
    const sentMessages: Array<{ content: unknown; deliverAs: string | undefined }> = []
    const notifications: string[] = []

    const extension = (await import('./index')).default
    extension({
      setLabel: () => undefined,
      logger: { warn: () => undefined, error: () => undefined },
      sendUserMessage: (content, options) => sentMessages.push({ content, deliverAs: options?.deliverAs }),
      registerCommand: (name, options) => commands.set(name, options),
      on: (event, handler) => handlers.set(event, handler),
    })

    const command = commands.get('webui')
    expect(command).toBeDefined()

    const ctx = fakeCommandContext(false, notifications)
    await command?.handler('', ctx)

    const url = extractUrl(notifications)
    expect(url).toContain('127.0.0.1')
    expect(url).toContain('token=')

    const stateResponse = await fetch(apiUrl(url, '/api/state'))
    expect(stateResponse.status).toBe(200)
    const state = (await stateResponse.json()) as WebuiState
    expect(state.cwd).toBe(process.cwd())
    expect(Array.isArray(state.fileTree.nodes)).toBe(true)

    const messageResponse = await fetch(apiUrl(url, '/api/messages'), {
      method: 'POST',
      body: JSON.stringify({ text: 'hello from webui' }),
    })
    expect(messageResponse.status).toBe(200)
    expect((await messageResponse.json()) as SendMessageResponse).toEqual({ queued: true })
    expect(sentMessages).toEqual([{ content: 'hello from webui', deliverAs: 'followUp' }])

    await handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, ctx)
  })
})

interface FakeCommandContext extends WebuiExtensionContext {
  ui: {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
  }
}

function fakeCommandContext(idle: boolean, notifications: string[]): FakeCommandContext {
  return {
    cwd: process.cwd(),
    model: { provider: 'test', id: 'model', name: 'Test Model' },
    getContextUsage: () => ({ tokens: null, contextWindow: 100_000, percent: null }),
    isIdle: () => idle,
    hasPendingMessages: () => false,
    ui: {
      notify: message => notifications.push(message),
    },
    sessionManager: {
      getBranch: () => [
        {
          type: 'message',
          id: 'm1',
          message: { role: 'user', content: 'hello', timestamp: Date.now() },
        },
      ],
      getSessionDir: () => '',
      getSessionFile: () => undefined,
      getSessionName: () => 'Smoke session',
    },
  }
}

async function writePluginRuntimeConfig(home: string): Promise<void> {
  const pluginsDir = path.join(home, '.omp', 'plugins')
  await fs.mkdir(pluginsDir, { recursive: true })
  await Bun.write(
    path.join(pluginsDir, 'omp-plugins.lock.json'),
    JSON.stringify(
      {
        plugins: { 'omp-webui': { version: '0.1.0', enabledFeatures: null, enabled: true } },
        settings: { 'omp-webui': { autoOpen: false, port: 3848, fileTreeMaxFiles: 20, filePreviewMaxBytes: 4096 } },
      },
      null,
      2,
    ),
  )
}

function extractUrl(notifications: string[]): string {
  const notification = notifications.find(message => message.includes('http://127.0.0.1:'))
  if (!notification) throw new Error(`No WebUI URL notification found: ${notifications.join('\n')}`)
  const match = notification.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)
  if (!match) throw new Error(`No URL found in notification: ${notification}`)
  return match[0]
}


function apiUrl(baseUrl: string, pathname: string): URL {
  const base = new URL(baseUrl)
  const url = new URL(pathname, base)
  const token = base.searchParams.get('token')
  if (token) url.searchParams.set('token', token)
  return url
}
async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-webui-home-'))
  tempDirs.push(dir)
  return dir
}

function restoreEnv(): void {
  setEnv('HOME', previousEnv.HOME)
  setEnv('XDG_DATA_HOME', previousEnv.XDG_DATA_HOME)
  setEnv('XDG_STATE_HOME', previousEnv.XDG_STATE_HOME)
  setEnv('XDG_CACHE_HOME', previousEnv.XDG_CACHE_HOME)
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
