import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  ApiErrorResponse,
  DiffResponse,
  FileContentResponse,
  FileTreeResponse,
  SendMessageRequest,
  SendMessageResponse,
  WebuiJob,
  WebuiMessage,
  WebuiState,
} from '../shared/types'
import {
  buildWebuiState,
  formatError,
  getDiffForPath,
  isRecord,
  listFileTree,
  mapAgentMessage,
  messageFingerprint,
  readFileContent,
  resolveExistingPathInsideRoot,
  resolvePathInsideRoot,
  type WebuiExtensionContext,
  type WebuiSettings,
} from './state'

const MAX_MESSAGE_IMAGES = 6
const MAX_MESSAGE_IMAGE_BYTES = 5 * 1024 * 1024

export class MissingDistError extends Error {
  constructor(distDir: string) {
    super(`WebUI build output is missing at ${path.join(distDir, 'index.html')}`)
  }
}

export interface WebuiRuntimeApi {
  sendUserMessage(
    content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>,
    options?: { deliverAs?: 'steer' | 'followUp' },
  ): void
  getThinkingLevel?(): unknown
  logger?: {
    warn?(message: string, details?: unknown): void
    error?(message: string, details?: unknown): void
  }
}

export interface WebuiRuntimeOptions {
  pi: WebuiRuntimeApi
  settings: WebuiSettings
  distDir: string
  token?: string
}

type BunServer = ReturnType<typeof Bun.serve>

type StreamController = ReadableStreamDefaultController<Uint8Array>

const encoder = new TextEncoder()

export class WebuiRuntime {
  readonly token: string
  #server: BunServer | undefined
  #actualPort: number | undefined
  #ctx: WebuiExtensionContext | undefined
  #settings: WebuiSettings
  #distDir: string
  #pi: WebuiRuntimeApi
  #clients = new Set<StreamController>()
  #jobs = new Map<string, WebuiJob>()
  #liveMessages = new Map<string, WebuiMessage>()
  #latestProviderPayload: unknown
  #warnings: string[] = []

  constructor(options: WebuiRuntimeOptions) {
    this.#pi = options.pi
    this.#settings = options.settings
    this.#distDir = options.distDir
    this.token = options.token ?? crypto.randomUUID()
  }

  get isRunning(): boolean {
    return this.#server !== undefined
  }

  get port(): number | undefined {
    return this.#actualPort
  }

  get url(): string {
    if (!this.#actualPort) return ''
    return `http://127.0.0.1:${this.#actualPort}/?token=${encodeURIComponent(this.token)}`
  }

  updateSettings(settings: WebuiSettings): void {
    this.#settings = settings
  }

  setContext(ctx: WebuiExtensionContext): void {
    this.#ctx = ctx
  }

  async start(): Promise<void> {
    await assertBuiltDist(this.#distDir)
    if (this.#server) return

    const requestedPort = this.#settings.port
    try {
      this.#server = this.#serve(requestedPort)
    } catch (error) {
      this.#warnings.push(
        `Port ${requestedPort} unavailable (${formatError(error)}); using an ephemeral loopback port instead.`,
      )
      this.#server = this.#serve(0)
    }
    this.#actualPort = getServerPort(this.#server)
  }

  stop(): void {
    for (const client of this.#clients) {
      try {
        client.close()
      } catch {
        // Already closed.
      }
    }
    this.#clients.clear()
    this.#server?.stop(true)
    this.#server = undefined
    this.#actualPort = undefined
  }

  recordEvent(event: unknown, ctx: WebuiExtensionContext): void {
    this.#ctx = ctx
    if (!isRecord(event) || typeof event.type !== 'string') {
      this.broadcastState()
      return
    }

    if (
      event.type === 'session_start' ||
      event.type === 'session_switch' ||
      event.type === 'session_branch' ||
      event.type === 'session_tree'
    ) {
      this.#liveMessages.clear()
    } else if (event.type === 'session_shutdown') {
      this.stop()
      return
    } else if (event.type === 'before_provider_request') {
      this.#latestProviderPayload = event.payload
    } else if (
      event.type === 'message_start' ||
      event.type === 'message_update' ||
      event.type === 'message_end'
    ) {
      this.#recordMessageEvent(event)
    } else if (
      event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_update' ||
      event.type === 'tool_execution_end'
    ) {
      this.#recordToolEvent(event)
    }

    this.broadcastState()
  }

  async buildState(): Promise<WebuiState> {
    if (!this.#ctx) {
      throw new Error('WebUI has no active OMP context yet')
    }
    return buildWebuiState(
      this.#ctx,
      this.#settings,
      Array.from(this.#jobs.values()).sort((left, right) => right.startedAt - left.startedAt),
      Array.from(this.#liveMessages.values()),
      this.#warnings,
      this.#latestProviderPayload,
      this.#pi.getThinkingLevel?.(),
    )
  }

  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname.startsWith('/api/')) {
        return await this.#handleApi(request, url)
      }
      return await this.#serveStatic(url)
    } catch (error) {
      const status = error instanceof MissingDistError ? 503 : 500
      return jsonError(formatError(error), status)
    }
  }

  broadcastState(): void {
    if (this.#clients.size === 0) return
    void this.buildState()
      .then(state => {
        const payload = encodeSse('message', state)
        for (const client of this.#clients) {
          try {
            client.enqueue(payload)
          } catch (error) {
            this.#clients.delete(client)
            this.#pi.logger?.warn?.('Failed to write WebUI SSE update', { error: formatError(error) })
          }
        }
      })
      .catch(error => {
        const payload = encodeSse('error', { error: formatError(error) })
        for (const client of this.#clients) {
          try {
            client.enqueue(payload)
          } catch {
            this.#clients.delete(client)
          }
        }
      })
  }

  #serve(port: number): BunServer {
    return Bun.serve({
      hostname: '127.0.0.1',
      port,
      idleTimeout: 255,
      fetch: request => this.handleRequest(request),
      error: error => jsonError(`WebUI server error: ${formatError(error)}`, 500),
    })
  }

  async #handleApi(request: Request, url: URL): Promise<Response> {
    if (!this.#authorized(request, url)) {
      return jsonError('Unauthorized WebUI request', 401)
    }

    if (url.pathname === '/api/state' && request.method === 'GET') {
      return Response.json(await this.buildState())
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
      return this.#eventStream()
    }

    if (url.pathname === '/api/messages' && request.method === 'POST') {
      return await this.#handleMessageRequest(request)
    }

    if (url.pathname === '/api/tree' && request.method === 'GET') {
      const ctx = this.#requireContext()
      const requestedPath = url.searchParams.get('path') ?? '.'
      const response: FileTreeResponse = await listFileTree(ctx.cwd, requestedPath, this.#settings.fileTreeMaxFiles)
      return Response.json(response)
    }

    if (url.pathname === '/api/file' && request.method === 'GET') {
      const ctx = this.#requireContext()
      const requestedPath = url.searchParams.get('path') ?? ''
      const response: FileContentResponse = await readFileContent(ctx.cwd, requestedPath, this.#settings.filePreviewMaxBytes)
      return Response.json(response)
    }

    if (url.pathname === '/api/diff' && request.method === 'GET') {
      const ctx = this.#requireContext()
      const requestedPath = url.searchParams.get('path') ?? ''
      const response: DiffResponse = { path: requestedPath, diff: await getDiffForPath(ctx.cwd, requestedPath) }
      return Response.json(response)
    }

    return jsonError('Not found', 404)
  }

  async #handleMessageRequest(request: Request): Promise<Response> {
    const ctx = this.#requireContext()
    let body: SendMessageRequest
    try {
      body = (await request.json()) as SendMessageRequest
    } catch {
      return jsonError('Invalid JSON request body', 400)
    }

    if (!body || typeof body.text !== 'string') {
      return jsonError('Message text is required', 400)
    }

    const text = body.text.trim()
    const images = validateMessageImages(body.images)
    if (images instanceof Response) return images
    if (!text && images.length === 0) {
      return jsonError('Message text or image is required', 400)
    }

    const queued = !ctx.isIdle() || ctx.hasPendingMessages()
    const content = images.length > 0
      ? [...(text ? [{ type: 'text' as const, text }] : []), ...images.map(image => ({ type: 'image' as const, ...image }))]
      : text
    this.#pi.sendUserMessage(content, queued ? { deliverAs: 'followUp' } : undefined)
    const response: SendMessageResponse = { queued }
    return Response.json(response)
  }

  #eventStream(): Response {
    let streamController: StreamController | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        streamController = controller
        this.#clients.add(controller)
        controller.enqueue(encoder.encode(': connected\n\n'))
        void this.buildState()
          .then(state => controller.enqueue(encodeSse('message', state)))
          .catch(error => controller.enqueue(encodeSse('error', { error: formatError(error) })))
      },
      cancel: () => {
        if (streamController) this.#clients.delete(streamController)
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  }

  async #serveStatic(url: URL): Promise<Response> {
    await assertBuiltDist(this.#distDir)
    const decodedPath = decodeURIComponent(url.pathname)
    const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '')
    let filePath = await resolveExistingPathInsideRoot(this.#distDir, relativePath)
    const stat = await fs.stat(filePath)
    if (stat.isDirectory()) {
      filePath = await resolveExistingPathInsideRoot(filePath, 'index.html')
    } else if (!stat.isFile()) {
      return jsonError('Static asset not found', 404)
    }
    return new Response(Bun.file(filePath))
  }

  #authorized(request: Request, url: URL): boolean {
    const queryToken = url.searchParams.get('token')
    if (queryToken === this.token) return true
    const authorization = request.headers.get('authorization')
    return authorization === `Bearer ${this.token}`
  }

  #requireContext(): WebuiExtensionContext {
    if (!this.#ctx) throw new Error('WebUI has no active OMP context yet')
    return this.#ctx
  }

  #recordMessageEvent(event: Record<string, unknown>): void {
    const message = mapAgentMessage(event.message, messageFingerprint(event.message))
    if (!message) return
    this.#liveMessages.set(message.id, message)
    if (event.type === 'message_end') {
      setTimeout(() => {
        this.#liveMessages.delete(message.id)
        this.broadcastState()
      }, 1_000)
    }
  }

  #recordToolEvent(event: Record<string, unknown>): void {
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : crypto.randomUUID()
    const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
    if (toolName !== 'task') return
    const existing = this.#jobs.get(toolCallId)
    const job: WebuiJob = existing ?? {
      id: toolCallId,
      title: formatTaskJobTitle(event.args),
      status: 'running',
      logs: [],
      startedAt: Date.now(),
    }

    if (event.type === 'tool_execution_start') {
      job.status = 'running'
      job.logs.push(`start ${toolName}`)
      const args = stringifyForLog(event.args)
      if (args) job.logs.push(args)
    } else if (event.type === 'tool_execution_update') {
      const update = stringifyForLog(event.partialResult)
      if (update) job.logs.push(update)
    } else if (event.type === 'tool_execution_end') {
      job.status = event.isError ? 'error' : 'done'
      job.endedAt = Date.now()
      const result = stringifyForLog(event.result)
      job.logs.push(event.isError ? 'failed' : 'completed')
      if (result) job.logs.push(result)
    }

    job.logs = job.logs.slice(-80)
    this.#jobs.set(toolCallId, job)
  }
}

export async function assertBuiltDist(distDir: string): Promise<void> {
  try {
    const indexPath = path.join(distDir, 'index.html')
    const stat = await fs.stat(indexPath)
    if (!stat.isFile()) throw new MissingDistError(distDir)
  } catch (error) {
    if (error instanceof MissingDistError) throw error
    throw new MissingDistError(distDir)
  }
}

function validateMessageImages(images: SendMessageRequest['images']): Array<{ mimeType: string; data: string }> | Response {
  if (images === undefined) return []
  if (!Array.isArray(images)) return jsonError('Message images must be an array', 400)
  if (images.length > MAX_MESSAGE_IMAGES) return jsonError(`A message may include at most ${MAX_MESSAGE_IMAGES} images`, 400)

  const validated: Array<{ mimeType: string; data: string }> = []
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]
    if (!image || typeof image.mimeType !== 'string' || typeof image.data !== 'string') {
      return jsonError(`Image ${index + 1} is invalid`, 400)
    }
    if (!image.mimeType.startsWith('image/')) {
      return jsonError(`Image ${index + 1} must use an image MIME type`, 400)
    }
    if (!isBase64(image.data)) {
      return jsonError(`Image ${index + 1} data must be base64 encoded`, 400)
    }
    if (decodedBase64Bytes(image.data) > MAX_MESSAGE_IMAGE_BYTES) {
      return jsonError(`Image ${index + 1} exceeds the ${MAX_MESSAGE_IMAGE_BYTES} byte limit`, 413)
    }
    validated.push({ mimeType: image.mimeType, data: image.data })
  }
  return validated
}

function isBase64(data: string): boolean {
  return data.length > 0 && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)
}

function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - padding
}

export function jsonError(error: string, status: number, detail?: string): Response {
  const body: ApiErrorResponse = detail ? { error, detail } : { error }
  return Response.json(body, { status })
}

function getServerPort(server: BunServer): number {
  const maybePort = (server as { port?: unknown }).port
  if (typeof maybePort === 'number') return maybePort
  return Number(new URL(String(server.url)).port)
}

function encodeSse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function formatTaskJobTitle(args: unknown): string {
  if (!isRecord(args)) return 'task'
  const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : 'task'
  const tasks = Array.isArray(args.tasks) ? args.tasks : []
  if (tasks.length === 1) {
    const task = tasks[0]
    if (isRecord(task) && typeof task.description === 'string' && task.description.trim()) {
      return `${agent}: ${task.description.trim()}`
    }
  }
  if (tasks.length > 1) return `${agent}: ${tasks.length} subagents`
  return agent
}

function stringifyForLog(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try {
    const serialized = JSON.stringify(value, null, 2)
    return serialized.length > 2_000 ? `${serialized.slice(0, 2_000)}…` : serialized
  } catch {
    return String(value)
  }
}

export async function verifyStaticPath(distDir: string, requestedPath: string): Promise<string> {
  const lexical = resolvePathInsideRoot(distDir, requestedPath)
  return resolveExistingPathInsideRoot(distDir, path.relative(distDir, lexical))
}
