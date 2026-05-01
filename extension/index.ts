import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MissingDistError, WebuiRuntime, type WebuiRuntimeApi } from './server'
import { DEFAULT_WEBUI_SETTINGS, normalizeWebuiSettings, type WebuiExtensionContext, type WebuiSettings } from './state'

interface OmpWebuiCommandContext extends WebuiExtensionContext {
  ui: {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
  }
}

interface OmpWebuiApi extends WebuiRuntimeApi {
  setLabel(label: string): void
  registerCommand(
    name: string,
    options: {
      description?: string
      handler(args: string, ctx: OmpWebuiCommandContext): Promise<void>
    },
  ): void
  on(event: string, handler: (event: unknown, ctx: OmpWebuiCommandContext) => void | Promise<void>): void
}

const PLUGIN_NAME = 'omp-webui'
const extensionDir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(extensionDir, '..', 'dist')

export default function ompWebui(pi: OmpWebuiApi) {
  pi.setLabel('OMP WebUI')

  let runtime: WebuiRuntime | undefined

  async function loadSettings(ctx: WebuiExtensionContext): Promise<WebuiSettings> {
    try {
      return normalizeWebuiSettings(await loadPluginSettings(ctx.cwd))
    } catch (error) {
      pi.logger?.warn?.('Failed to load omp-webui plugin settings; using defaults', { error: String(error) })
      return DEFAULT_WEBUI_SETTINGS
    }
  }

  async function getRuntime(ctx: WebuiExtensionContext): Promise<{ runtime: WebuiRuntime; settings: WebuiSettings }> {
    const settings = await loadSettings(ctx)
    if (!runtime) {
      runtime = new WebuiRuntime({ pi, settings, distDir })
    } else {
      runtime.updateSettings(settings)
    }
    runtime.setContext(ctx)
    return { runtime, settings }
  }

  function record(event: unknown, ctx: WebuiExtensionContext): void {
    runtime?.recordEvent(event, ctx)
  }

  pi.registerCommand('webui', {
    description: 'Open the OMP WebUI for the current session',
    handler: async (_args, ctx) => {
      const { runtime: webuiRuntime, settings } = await getRuntime(ctx)
      try {
        await webuiRuntime.start()
      } catch (error) {
        if (error instanceof MissingDistError) {
          ctx.ui.notify(
            'OMP WebUI is not built. Run `bun --cwd plugin/omp-webui run build` for local linked development, then run /webui again.',
            'error',
          )
          return
        }
        ctx.ui.notify(`Failed to start OMP WebUI: ${error instanceof Error ? error.message : String(error)}`, 'error')
        return
      }

      if (settings.port !== webuiRuntime.port) {
        ctx.ui.notify(`Configured WebUI port ${settings.port} was unavailable; using ${webuiRuntime.port}.`, 'warning')
      }

      const url = webuiRuntime.url
      if (settings.autoOpen) {
        const opened = await openBrowser(url)
        ctx.ui.notify(opened ? `OMP WebUI opened at ${url}` : `OMP WebUI is running at ${url}`, opened ? 'info' : 'warning')
      } else {
        ctx.ui.notify(`OMP WebUI is running at ${url}`, 'info')
      }
    },
  })

  pi.on('session_start', (event, ctx) => record(event, ctx))
  pi.on('session_switch', (event, ctx) => record(event, ctx))
  pi.on('session_branch', (event, ctx) => record(event, ctx))
  pi.on('session_tree', (event, ctx) => record(event, ctx))
  pi.on('turn_start', (event, ctx) => record(event, ctx))
  pi.on('turn_end', (event, ctx) => record(event, ctx))
  pi.on('before_provider_request', (event, ctx) => record(event, ctx))
  pi.on('message_start', (event, ctx) => record(event, ctx))
  pi.on('message_update', (event, ctx) => record(event, ctx))
  pi.on('message_end', (event, ctx) => record(event, ctx))
  pi.on('tool_execution_start', (event, ctx) => record(event, ctx))
  pi.on('tool_execution_update', (event, ctx) => record(event, ctx))
  pi.on('tool_execution_end', (event, ctx) => record(event, ctx))
  pi.on('session_shutdown', (event, ctx) => {
    record(event, ctx)
    runtime = undefined
  })

  pi.on('agent_end', () => {
    runtime?.broadcastState()
  })
}

async function openBrowser(url: string): Promise<boolean> {
  const command = getOpenCommand(url)
  try {
    const proc = Bun.spawn(command, {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    const exitCode = await proc.exited
    return exitCode === 0
  } catch {
    return false
  }
}

function getOpenCommand(url: string): string[] {
  if (process.platform === 'darwin') return ['open', url]
  if (process.platform === 'win32') return ['cmd', '/c', 'start', '', url]
  return ['xdg-open', url]
}

async function loadPluginSettings(cwd: string): Promise<Record<string, unknown>> {
  const specifier = '@oh-my-pi/pi-coding-agent/extensibility/plugins' as string
  const module = (await import(specifier)) as {
    getPluginSettings?: (pluginName: string, cwd: string) => Promise<Record<string, unknown>>
  }
  if (typeof module.getPluginSettings !== 'function') {
    throw new Error('OMP plugin settings API is unavailable')
  }
  return module.getPluginSettings(PLUGIN_NAME, cwd)
}
