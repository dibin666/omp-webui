import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  DiffLine,
  FileTreeNode,
  FileTreeResponse,
  ModifiedFile,
  WebuiContextCategory,
  WebuiContextUsage,
  WebuiImageBlock,
  WebuiJob,
  WebuiMessage,
  WebuiNoticeBlock,
  WebuiSession,
  WebuiState,
  WebuiTask,
  WebuiTaskStatus,
  WebuiToolBlock,
} from '../shared/types'

export interface WebuiSessionManager {
  getBranch(): unknown[]
  getSessionDir(): string
  getSessionFile(): string | undefined
  getSessionName(): string | undefined
}

export interface WebuiExtensionContext {
  cwd: string
  sessionManager: WebuiSessionManager
  model: unknown
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined
  getSystemPrompt?(): string
  isIdle(): boolean
  hasPendingMessages(): boolean
}
export interface WebuiSettings {
  port: number
  autoOpen: boolean
  fileTreeMaxFiles: number
  filePreviewMaxBytes: number
}

export const DEFAULT_WEBUI_SETTINGS: WebuiSettings = {
  port: 3848,
  autoOpen: true,
  fileTreeMaxFiles: 300,
  filePreviewMaxBytes: 262_144,
}

const IGNORED_TREE_NAMES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vite',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  '__pycache__',
])

const MAX_SESSIONS = 20
const MAX_MODIFIED_FILES = 100
const MAX_JOB_LOGS = 80
const MAX_VISIBLE_JOBS = 40
const MAX_JOB_LOG_CHARS = 2_000

export function normalizeWebuiSettings(raw: Record<string, unknown> | undefined): WebuiSettings {
  const port = clampInteger(raw?.port, DEFAULT_WEBUI_SETTINGS.port, 1, 65_535)
  const fileTreeMaxFiles = clampInteger(raw?.fileTreeMaxFiles, DEFAULT_WEBUI_SETTINGS.fileTreeMaxFiles, 10, 5_000)
  const filePreviewMaxBytes = clampInteger(
    raw?.filePreviewMaxBytes,
    DEFAULT_WEBUI_SETTINGS.filePreviewMaxBytes,
    1_024,
    5_242_880,
  )

  return {
    port,
    autoOpen: typeof raw?.autoOpen === 'boolean' ? raw.autoOpen : DEFAULT_WEBUI_SETTINGS.autoOpen,
    fileTreeMaxFiles,
    filePreviewMaxBytes,
  }
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  const integer = Math.trunc(numeric)
  return Math.min(max, Math.max(min, integer))
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function resolvePathInsideRoot(root: string, requestedPath: string): string {
  const cleanPath = requestedPath.trim() || '.'
  if (cleanPath.includes('\0')) {
    throw new Error('Path contains a null byte')
  }
  if (path.isAbsolute(cleanPath)) {
    throw new Error('Path must be relative to the project')
  }

  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(resolvedRoot, cleanPath)
  if (!isInsideRoot(resolvedRoot, resolvedTarget)) {
    throw new Error('Path escapes the project directory')
  }
  return resolvedTarget
}

export async function resolveExistingPathInsideRoot(root: string, requestedPath: string): Promise<string> {
  const lexicalTarget = resolvePathInsideRoot(root, requestedPath)
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(lexicalTarget)])
  if (!isInsideRoot(realRoot, realTarget)) {
    throw new Error('Resolved path escapes the project directory')
  }
  return realTarget
}

export async function listFileTree(cwd: string, requestedPath: string, maxEntries: number): Promise<FileTreeResponse> {
  const warnings: string[] = []
  const directory = await resolveExistingPathInsideRoot(cwd, requestedPath)
  const stat = await fs.stat(directory)
  if (!stat.isDirectory()) {
    throw new Error('Path is not a directory')
  }

  const entries = await fs.readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
    return left.name.localeCompare(right.name)
  })

  const nodes: FileTreeNode[] = []
  let truncated = false

  for (const entry of entries) {
    if (IGNORED_TREE_NAMES.has(entry.name)) continue
    if (nodes.length >= maxEntries) {
      truncated = true
      break
    }

    const absoluteChild = path.join(directory, entry.name)
    let childType: FileTreeNode['type'] | null = entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : null

    if (entry.isSymbolicLink()) {
      try {
        const realRoot = await fs.realpath(cwd)
        const realChild = await fs.realpath(absoluteChild)
        if (!isInsideRoot(realRoot, realChild)) {
          warnings.push(`Skipped symlink outside project: ${entry.name}`)
          continue
        }
        const childStat = await fs.stat(realChild)
        childType = childStat.isDirectory() ? 'folder' : childStat.isFile() ? 'file' : null
      } catch (error) {
        warnings.push(`Skipped unreadable symlink: ${entry.name} (${formatError(error)})`)
        continue
      }
    }

    if (!childType) continue

    const childRelative = normalizeRelativePath(path.relative(cwd, absoluteChild))
    nodes.push({
      name: entry.name,
      path: childRelative,
      type: childType,
      loaded: childType === 'file',
    })
  }

  return {
    path: normalizeRelativePath(path.relative(cwd, directory)) || '.',
    nodes,
    truncated,
    warnings,
  }
}

export function parseDiffLines(diffText: string): DiffLine[] {
  return diffText
    .split('\n')
    .filter((line, index, lines) => index < lines.length - 1 || line.length > 0)
    .map(line => {
      if (line.startsWith('+') && !line.startsWith('+++')) return { type: 'plus', content: line }
      if (line.startsWith('-') && !line.startsWith('---')) return { type: 'minus', content: line }
      return { type: 'normal', content: line }
    })
}

export async function readFileContent(cwd: string, requestedPath: string, maxBytes: number) {
  const filePath = await resolveExistingPathInsideRoot(cwd, requestedPath)
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) {
    throw new Error('Path is not a file')
  }
  if (stat.size > maxBytes) {
    throw new Error(`File is ${stat.size} bytes, exceeding the ${maxBytes} byte preview limit`)
  }
  return {
    path: normalizeRelativePath(path.relative(cwd, filePath)),
    content: await Bun.file(filePath).text(),
    size: stat.size,
  }
}

export async function getModifiedFiles(cwd: string): Promise<{ files: ModifiedFile[]; warnings: string[] }> {
  const status = await runCommand('git', ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=all'], cwd, 3_000)
  if (status.exitCode !== 0) {
    return { files: [], warnings: [`Git status unavailable: ${status.stderr || status.stdout || `exit ${status.exitCode}`}`] }
  }

  const statusByPath = new Map<string, string>()
  for (const line of status.stdout.split('\n')) {
    if (!line.trim()) continue
    const statusText = line.slice(0, 2).trim() || 'modified'
    const rawPath = line.slice(3)
    const normalizedPath = normalizeGitStatusPath(rawPath)
    if (normalizedPath) statusByPath.set(normalizedPath, statusText)
  }

  if (statusByPath.size === 0) return { files: [], warnings: [] }

  const numstat = await runCommand('git', ['-C', cwd, 'diff', '--numstat', 'HEAD', '--'], cwd, 3_000)
  const statsByPath = new Map<string, { additions: number; deletions: number }>()
  if (numstat.exitCode === 0) {
    for (const line of numstat.stdout.split('\n')) {
      const [additionsRaw, deletionsRaw, filePath] = line.split('\t')
      if (!filePath) continue
      statsByPath.set(normalizeGitStatusPath(filePath), {
        additions: parseNumstat(additionsRaw),
        deletions: parseNumstat(deletionsRaw),
      })
    }
  }

  const files = Array.from(statusByPath.entries())
    .slice(0, MAX_MODIFIED_FILES)
    .map(([filePath, statusText]) => {
      const stats = statsByPath.get(filePath) ?? { additions: 0, deletions: 0 }
      return {
        path: filePath,
        status: statusText,
        additions: stats.additions,
        deletions: stats.deletions,
      }
    })

  const warnings = statusByPath.size > MAX_MODIFIED_FILES ? [`Modified file list truncated at ${MAX_MODIFIED_FILES} files`] : []
  return { files, warnings }
}

export async function getDiffForPath(cwd: string, requestedPath: string): Promise<DiffLine[]> {
  const absolutePath = resolvePathInsideRoot(cwd, requestedPath)
  const relativePath = normalizeRelativePath(path.relative(cwd, absolutePath))
  const unstaged = await runCommand('git', ['-C', cwd, 'diff', '--', relativePath], cwd, 3_000)
  const staged = await runCommand('git', ['-C', cwd, 'diff', '--cached', '--', relativePath], cwd, 3_000)
  const diffText = [unstaged.stdout, staged.stdout].filter(Boolean).join('\n')
  return parseDiffLines(diffText)
}

function normalizeGitStatusPath(rawPath: string): string {
  const renamedPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() ?? rawPath : rawPath
  return renamedPath.replace(/^"|"$/g, '')
}

function parseNumstat(value: string | undefined): number {
  if (!value || value === '-') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function runCommand(command: string, args: string[], cwd: string, timeoutMs: number) {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timeout = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timeout)
  }
}

export async function buildWebuiState(
  ctx: WebuiExtensionContext,
  settings: WebuiSettings,
  jobs: WebuiJob[],
  liveMessages: WebuiMessage[],
  runtimeWarnings: string[] = [],
  latestProviderPayload?: unknown,
  thinkingLevel?: unknown,
): Promise<WebuiState> {
  const warnings = [...runtimeWarnings]
  const entries = safely(() => ctx.sessionManager.getBranch(), [])
  const branchMessages = entries.flatMap(entryToMessages)
  const seenMessageIds = new Set(branchMessages.map(message => message.id))
  const messages = mergeToolResultMessages([
    ...branchMessages,
    ...liveMessages.filter(message => !seenMessageIds.has(message.id)),
  ])
  let fileTree: FileTreeResponse
  try {
    fileTree = await listFileTree(ctx.cwd, '.', settings.fileTreeMaxFiles)
    warnings.push(...fileTree.warnings)
  } catch (error) {
    fileTree = { path: '.', nodes: [], truncated: false, warnings: [formatError(error)] }
    warnings.push(`File tree unavailable: ${formatError(error)}`)
  }

  const modified = await getModifiedFiles(ctx.cwd)
  warnings.push(...modified.warnings)

  const sessions = await readSessions(
    safely(() => ctx.sessionManager.getSessionDir(), ''),
    safely(() => ctx.sessionManager.getSessionFile(), undefined),
  )
  const isIdle = safely(() => ctx.isIdle(), true)
  const hasPendingMessages = safely(() => ctx.hasPendingMessages(), false)

  return {
    cwd: ctx.cwd,
    sessionName: safely(() => ctx.sessionManager.getSessionName(), undefined) ?? null,
    modelLabel: formatModelLabel(ctx.model),
    thinkingLevel: formatThinkingLevel(thinkingLevel),
    contextUsage: buildContextUsage(ctx, entries, latestProviderPayload),
    messages,
    sessions,
    todos: extractTodoTasksFromEntries(entries),
    jobs: visibleRuntimeJobs(jobs),
    modifiedFiles: modified.files,
    fileTree,
    warnings,
    isIdle,
    hasPendingMessages,
  }
}

function entryToMessages(entry: unknown): WebuiMessage[] {
  if (!isRecord(entry)) return []
  if (entry.type === 'message') {
    const message = mapAgentMessage(entry.message, String(entry.id ?? messageFingerprint(entry.message)))
    return message ? [message] : []
  }
  if (entry.type === 'custom_message') {
    const message = mapCustomMessageEntry(entry)
    return message ? [message] : []
  }
  return []
}

export function mapAgentMessage(message: unknown, id: string = messageFingerprint(message)): WebuiMessage | null {
  if (!isRecord(message)) return null
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : undefined

  switch (message.role) {
    case 'user':
      return mapContentMessage(id, 'user', message.content, timestamp)
    case 'developer':
      return mapContentMessage(id, 'system', message.content, timestamp)
    case 'assistant':
      return mapAssistantMessage(message, id, timestamp)
    case 'toolResult': {
      const toolName = typeof message.toolName === 'string' ? message.toolName : 'tool'
      return {
        id,
        role: 'tool',
        content: '',
        timestamp,
        tools: [
          {
            id: typeof message.toolCallId === 'string' ? message.toolCallId : id,
            name: toolName,
            result: contentToText(message.content),
            resultDetails: detailsForTool(toolName, message.details),
            isError: typeof message.isError === 'boolean' ? message.isError : undefined,
          },
        ],
      }
    }
    case 'custom':
    case 'hookMessage': {
      if (message.display === false) return null
      const role = message.attribution === 'user' ? 'user' : 'agent'
      return mapContentMessage(id, role, message.content, timestamp)
    }
    case 'bashExecution':
      return {
        id,
        role: 'tool',
        content: '',
        timestamp,
        tools: [{ id, name: 'bash', args: stringifyForUi({ command: message.command }), result: formatExecutionMessage('bash', message) }],
      }
    case 'pythonExecution':
      return {
        id,
        role: 'tool',
        content: '',
        timestamp,
        tools: [{ id, name: 'python', args: stringifyForUi({ code: message.code }), result: formatExecutionMessage('python', message) }],
      }
    case 'branchSummary':
      return { id, role: 'system', content: String(message.summary ?? ''), timestamp }
    case 'compactionSummary':
      return { id, role: 'system', content: String(message.shortSummary ?? message.summary ?? ''), timestamp }
    case 'fileMention':
      return { id, role: 'system', content: formatFileMention(message.files), timestamp }
    default:
      return null
  }
}

function mapAssistantMessage(message: Record<string, unknown>, id: string, timestamp: number | undefined): WebuiMessage {
  const contentBlocks = Array.isArray(message.content) ? message.content : []
  const thinking: string[] = []
  const tools: WebuiToolBlock[] = []
  const textParts: string[] = []
  const images: WebuiImageBlock[] = []

  for (const block of contentBlocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinking.push(block.thinking)
    } else if (block.type === 'redactedThinking') {
      thinking.push('[redacted thinking]')
    } else if (block.type === 'image') {
      const image = imageFromBlock(block, `${id}:image:${images.length}`)
      if (image) images.push(image)
    } else if (block.type === 'toolCall') {
      tools.push({
        id: typeof block.id === 'string' ? block.id : `${id}:tool:${tools.length}`,
        name: typeof block.name === 'string' ? block.name : 'tool',
        args: stringifyForUi(block.arguments),
      })
    }
  }

  const content = cleanAssistantContent(textParts.join('\n').trim(), tools)

  return {
    id,
    role: 'agent',
    content,
    timestamp,
    ...(thinking.length > 0 ? { thinking } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(images.length > 0 ? { images } : {}),
  }
}

function mergeToolResultMessages(messages: WebuiMessage[]): WebuiMessage[] {
  const output: WebuiMessage[] = []
  const toolTargets = new Map<string, { message: WebuiMessage; index: number }>()
  const pendingToolResults = new Map<string, { outputIndex: number; tool: WebuiToolBlock }>()
  const hiddenOutputIndexes = new Set<number>()

  for (const originalMessage of messages) {
    const message = cloneMessageForToolMerge(originalMessage)
    const singleToolResult = message.role === 'tool' && message.tools?.length === 1 ? message.tools[0] : undefined

    if (singleToolResult) {
      const target = toolTargets.get(singleToolResult.id)
      if (target) {
        const existingTool = target.message.tools?.[target.index]
        if (existingTool) {
          target.message.tools![target.index] = mergeToolBlocks(existingTool, singleToolResult)
          continue
        }
      }

      const pending = pendingToolResults.get(singleToolResult.id)
      const mergedToolResult = pending ? mergeToolBlocks(pending.tool, singleToolResult) : singleToolResult
      if (pending) hiddenOutputIndexes.add(pending.outputIndex)
      message.tools![0] = mergedToolResult
      pendingToolResults.set(singleToolResult.id, { outputIndex: output.length, tool: mergedToolResult })
      output.push(message)
      continue
    }

    message.tools?.forEach((tool, index) => {
      const pending = pendingToolResults.get(tool.id)
      if (pending) {
        message.tools![index] = mergeToolBlocks(tool, pending.tool)
        hiddenOutputIndexes.add(pending.outputIndex)
        pendingToolResults.delete(tool.id)
      }
    })

    output.push(message)
    message.tools?.forEach((tool, index) => {
      if (!toolTargets.has(tool.id)) {
        toolTargets.set(tool.id, { message, index })
      }
    })
  }

  return hiddenOutputIndexes.size === 0
    ? output
    : output.filter((_, index) => !hiddenOutputIndexes.has(index))
}

function cloneMessageForToolMerge(message: WebuiMessage): WebuiMessage {
  return message.tools ? { ...message, tools: message.tools.map(tool => ({ ...tool })) } : message
}

function mergeToolBlocks(call: WebuiToolBlock, result: WebuiToolBlock): WebuiToolBlock {
  return {
    ...call,
    result: result.result ?? call.result,
    resultDetails: result.resultDetails ?? call.resultDetails,
    isError: result.isError ?? call.isError,
  }
}

function visibleRuntimeJobs(runtimeJobs: WebuiJob[]): WebuiJob[] {
  return runtimeJobs
    .filter(job => job.status === 'running')
    .map(normalizeJob)
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, MAX_VISIBLE_JOBS)
}

function normalizeJob(job: WebuiJob): WebuiJob {
  return {
    ...job,
    logs: compactJobLogs(job.logs),
  }
}

function compactJobLogs(logs: Array<string | undefined>): string[] {
  return logs
    .filter((log): log is string => Boolean(log && log.trim()))
    .map(log => (log.length > MAX_JOB_LOG_CHARS ? `${log.slice(0, MAX_JOB_LOG_CHARS)}…` : log))
    .slice(-MAX_JOB_LOGS)
}

function detailsForTool(toolName: string, details: unknown): unknown {
  if (details === undefined) return undefined
  return toolName === 'ask' || toolName === 'edit' || toolName === 'ast_edit' ? details : undefined
}

function mapCustomMessageEntry(entry: Record<string, unknown>): WebuiMessage | null {
  if (entry.display === false) return null
  const id = String(entry.id ?? messageFingerprint(entry))
  const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined
  const role = entry.attribution === 'user' ? 'user' : 'agent'
  return mapContentMessage(id, role, entry.content, Number.isFinite(timestamp) ? timestamp : undefined)
}

function mapContentMessage(
  id: string,
  role: WebuiMessage['role'],
  rawContent: unknown,
  timestamp: number | undefined,
  fallbackRole: WebuiMessage['role'] = role,
 ): WebuiMessage {
  return mapTextMessage(id, role, contentToText(rawContent), timestamp, fallbackRole, imagesFromContent(rawContent, id))
}

function mapTextMessage(
  id: string,
  role: WebuiMessage['role'],
  content: string,
  timestamp: number | undefined,
  fallbackRole: WebuiMessage['role'] = role,
  images: WebuiImageBlock[] = [],
): WebuiMessage {
  const notice = parseSystemNotice(id, content)
  if (notice) {
    return { id, role: 'system', content: '', timestamp, notices: [notice], ...(images.length > 0 ? { images } : {}) }
  }
  return { id, role: fallbackRole, content, timestamp, ...(images.length > 0 ? { images } : {}) }
}

function parseSystemNotice(id: string, content: string): WebuiNoticeBlock | undefined {
  const trimmed = content.trim()
  const match = trimmed.match(/^<system-notice>\s*([\s\S]*?)\s*<\/system-notice>$/)
  if (!match) return undefined
  const body = match[1]?.trim() ?? ''
  const lines = body.split('\n')
  const firstLine = lines.find(line => line.trim())?.trim() ?? 'System notice'
  const jobMatch = firstLine.match(/^Background job\s+(\S+)\s+has completed/i)
  const title = jobMatch ? `Background job completed · ${jobMatch[1]}` : firstLine
  const isTimeout = /timed out|timeout/i.test(body)
  const isFailed = /Command exited with code [1-9]\d*|failed|error/i.test(body)
  return {
    id: `${id}:notice`,
    title,
    body,
    status: isFailed ? 'error' : isTimeout ? 'warning' : 'success',
  }
}

function cleanAssistantContent(content: string, tools: WebuiToolBlock[]): string {
  if (tools.length === 0) return content
  const normalized = content.trim()
  if (normalized === 'Tool call requested.' || normalized === '(no output)') return ''
  return content
}

function imagesFromContent(content: unknown, messageId: string): WebuiImageBlock[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((block, index) => {
    if (!isRecord(block) || block.type !== 'image') return []
    const image = imageFromBlock(block, `${messageId}:image:${index}`)
    return image ? [image] : []
  })
}

function imageFromBlock(block: Record<string, unknown>, id: string): WebuiImageBlock | undefined {
  if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') return undefined
  if (!block.mimeType.startsWith('image/')) return undefined
  return { id, mimeType: block.mimeType, data: block.data }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (!isRecord(block)) return ''
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function formatExecutionMessage(kind: 'bash' | 'python', message: Record<string, unknown>): string {
  const command = kind === 'bash' ? String(message.command ?? '') : String(message.code ?? '')
  const output = String(message.output ?? '')
  const exitCode = message.exitCode === undefined ? 'unknown' : String(message.exitCode)
  return `${kind === 'bash' ? 'Command' : 'Python'}: ${command}\nExit code: ${exitCode}${output ? `\n${output}` : ''}`
}

function formatFileMention(files: unknown): string {
  if (!Array.isArray(files)) return ''
  return files
    .map(file => (isRecord(file) && typeof file.path === 'string' ? file.path : undefined))
    .filter((filePath): filePath is string => Boolean(filePath))
    .join('\n')
}

function formatModelLabel(model: unknown): string | null {
  if (!isRecord(model)) return null
  const name = typeof model.name === 'string' ? model.name : undefined
  const provider = typeof model.provider === 'string' ? model.provider : undefined
  const id = typeof model.id === 'string' ? model.id : undefined
  return name ?? (provider && id ? `${provider}/${id}` : id ?? null)
}

function formatThinkingLevel(level: unknown): string | null {
  if (typeof level !== 'string') return null
  const normalized = level.trim()
  if (!normalized || /^(?:off|inherit)$/i.test(normalized)) return null
  return normalized
}

function buildContextUsage(ctx: WebuiExtensionContext, entries: unknown[], latestProviderPayload: unknown): WebuiContextUsage {
  const usage = safely(() => ctx.getContextUsage(), undefined)
  const contextWindow = usage?.contextWindow ?? getModelContextWindow(ctx.model)
  const systemPromptText = getSystemPromptText(ctx)
  const skillsTokens = estimateSkillsTokensFromSystemPrompt(systemPromptText)
  const systemPromptTokens = estimateSystemPromptTokens(systemPromptText, skillsTokens)
  const providerMessagesTokens = estimateProviderMessagesTokens(latestProviderPayload)
  const messagesTokens = providerMessagesTokens ?? estimateMessagesTokens(entries)
  const systemToolsTokens = estimateProviderToolsTokens(latestProviderPayload)
  const categoryTokens = sumKnown([systemPromptTokens, systemToolsTokens, skillsTokens, messagesTokens])
  const tokens = categoryTokens > 0 ? categoryTokens : usage?.tokens ?? null
  const percent = percentage(tokens, contextWindow)
  const autoCompactBufferTokens = estimateAutoCompactBufferTokens(contextWindow, tokens)
  const freeTokens = tokens === null || contextWindow === null ? null : Math.max(0, contextWindow - tokens - (autoCompactBufferTokens ?? 0))

  const categories: WebuiContextCategory[] = [
    {
      id: 'systemPrompt',
      label: 'System prompt',
      tokens: systemPromptTokens,
      percent: percentage(systemPromptTokens, contextWindow),
      source: systemPromptTokens === null ? 'unavailable' : 'estimated',
      note: 'Estimated from the active OMP system prompt. OMP core does not expose exact /context category totals to plugins.',
    },

    {
      id: 'systemTools',
      label: 'System tools',
      tokens: systemToolsTokens,
      percent: percentage(systemToolsTokens, contextWindow),
      source: systemToolsTokens === null ? 'unavailable' : 'estimated',
      note: systemToolsTokens === null ? 'Available after a provider request exposes tool schemas.' : 'Estimated from the latest provider request tool schemas.',
    },

    {
      id: 'skills',
      label: 'Skills',
      tokens: skillsTokens,
      percent: percentage(skillsTokens, contextWindow),
      source: skillsTokens === null ? 'unavailable' : 'estimated',
      note: skillsTokens === null ? 'Skill metadata is unavailable.' : 'Estimated from the <skills> section in the active OMP system prompt.',
    },

    {
      id: 'messages',
      label: 'Messages',
      tokens: messagesTokens,
      percent: percentage(messagesTokens, contextWindow),
      source: 'estimated',
      note: providerMessagesTokens === null ? 'Fallback estimate from persisted branch messages.' : 'Estimated from the latest provider request messages, matching OMP /context scope more closely than historical branch size.',
    },
    {
      id: 'freeSpace',
      label: 'Free space',
      tokens: freeTokens,
      percent: percentage(freeTokens, contextWindow),
      source: tokens === null ? 'unavailable' : 'estimated',
    },
    {
      id: 'autoCompactBuffer',
      label: 'Autocompact buffer',
      tokens: autoCompactBufferTokens,
      percent: percentage(autoCompactBufferTokens, contextWindow),
      source: autoCompactBufferTokens === null ? 'unavailable' : 'estimated',
      note: autoCompactBufferTokens === null ? 'Context window or usage is unavailable.' : 'Plugin estimate; OMP core does not expose compaction settings to plugins.',
    },
  ]

  return {
    tokens,
    contextWindow,
    percent,
    categories,
    freeTokens,
    autoCompactBufferTokens,
  }
}

function getSystemPromptText(ctx: WebuiExtensionContext): string | null {
  if (typeof ctx.getSystemPrompt !== 'function') return null
  const systemPrompt = safely(() => ctx.getSystemPrompt?.(), undefined)
  return systemPrompt && systemPrompt.trim() ? systemPrompt : null
}

function estimateSystemPromptTokens(systemPrompt: string | null, skillsTokens: number | null): number | null {
  if (!systemPrompt) return null
  return Math.max(0, estimateTextTokens([systemPrompt]) - (skillsTokens ?? 0))
}

function estimateSkillsTokensFromSystemPrompt(systemPrompt: string | null): number | null {
  if (!systemPrompt) return null
  const skillBlocks = Array.from(systemPrompt.matchAll(/<skill\s+name="([^"]+)">([\s\S]*?)<\/skill>/g))
  if (skillBlocks.length === 0) return 0
  const fragments = skillBlocks.flatMap(match => [match[1] ?? '', (match[2] ?? '').trim()]).filter(Boolean)
  return fragments.length === 0 ? 0 : estimateTextTokens(fragments)
}

function estimateAutoCompactBufferTokens(contextWindow: number | null, tokens: number | null): number | null {
  if (contextWindow === null || tokens === null || contextWindow <= 0) return null
  const available = Math.max(0, contextWindow - tokens)
  return available > 0 ? 1 : 0
}

function estimateMessagesTokens(entries: unknown[]): number {
  let total = 0
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'message') continue
    total += estimateMessageTokens(entry.message)
  }
  return total
}

function estimateMessageTokens(message: unknown): number {
  if (!isRecord(message)) return 0
  const fragments: string[] = []
  if (typeof message.role === 'string') fragments.push(message.role)
  const content = contentToText(message.content)
  if (content) fragments.push(content)
  if (typeof message.toolName === 'string') fragments.push(message.toolName)
  if (message.arguments !== undefined) {
    const args = stringifyForUi(message.arguments)
    if (args) fragments.push(args)
  }
  if (fragments.length === 0) {
    const serialized = stringifyForUi(message)
    if (serialized) fragments.push(serialized)
  }
  return fragments.length === 0 ? 0 : estimateTextTokens(fragments)
}


function estimateTextTokens(fragments: string[]): number {
  let total = 0
  for (const fragment of fragments) {
    if (!fragment) continue
    // Plugin-only fallback: OMP does not expose its native tokenizer to external plugins reliably.
    // Keep these values clearly marked as estimates in the WebUI.
    const chars = Array.from(fragment)
    const nonAscii = chars.filter(char => char.charCodeAt(0) > 127).length
    const ascii = chars.length - nonAscii
    total += Math.ceil(ascii / 4) + nonAscii
  }
  return total
}
function estimateProviderMessagesTokens(payload: unknown): number | null {
  const messages = extractProviderMessages(payload)
  if (!messages || messages.length === 0) return null
  const fragments = messages.flatMap(message => providerMessageFragments(message))
  return fragments.length === 0 ? null : estimateTextTokens(fragments)
}

function providerMessageFragments(message: unknown): string[] {
  if (!isRecord(message)) {
    const serialized = stringifyForUi(message)
    return serialized ? [serialized] : []
  }
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : ''
  if (role === 'system' || role === 'developer') return []
  const fragments: string[] = []
  if (role) fragments.push(role)
  const content = providerMessageContent(message)
  if (content) fragments.push(content)
  if (fragments.length === 0) {
    const serialized = stringifyForUi(message)
    if (serialized) fragments.push(serialized)
  }
  return fragments
}

function providerMessageContent(message: Record<string, unknown>): string {
  const content = message.content ?? message.parts ?? message.message
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (!isRecord(part)) return ''
        if (typeof part.text === 'string') return part.text
        if (typeof part.content === 'string') return part.content
        if (typeof part.input === 'string') return part.input
        if (typeof part.output === 'string') return part.output
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  const serialized = stringifyForUi(content)
  return serialized ?? ''
}

function extractProviderMessages(value: unknown, depth = 0): unknown[] | null {
  if (depth > 4) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try {
      return extractProviderMessages(JSON.parse(trimmed), depth + 1)
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    if (value.some(item => isRecord(item) && typeof item.role === 'string')) return value
    for (const item of value) {
      const messages = extractProviderMessages(item, depth + 1)
      if (messages) return messages
    }
    return null
  }
  if (!isRecord(value)) return null

  for (const key of ['messages', 'contents', 'input']) {
    const candidate = value[key]
    if (Array.isArray(candidate) && candidate.some(item => isRecord(item) && (typeof item.role === 'string' || typeof item.content === 'string' || Array.isArray(item.content)))) {
      return candidate
    }
  }

  for (const key of ['body', 'json', 'payload', 'request', 'params']) {
    const messages = extractProviderMessages(value[key], depth + 1)
    if (messages) return messages
  }
  return null
}

function estimateProviderToolsTokens(payload: unknown): number | null {
  const tools = extractProviderTools(payload)
  if (!tools || tools.length === 0) return null
  return estimateTextTokens([JSON.stringify(tools)])
}

function extractProviderTools(value: unknown, depth = 0): unknown[] | null {
  if (depth > 4) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try {
      return extractProviderTools(JSON.parse(trimmed), depth + 1)
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const tools = extractProviderTools(item, depth + 1)
      if (tools) return tools
    }
    return null
  }
  if (!isRecord(value)) return null

  const directTools = value.tools
  if (Array.isArray(directTools)) return directTools

  for (const key of ['body', 'json', 'payload', 'request', 'params', 'input']) {
    const tools = extractProviderTools(value[key], depth + 1)
    if (tools) return tools
  }
  return null
}

function getModelContextWindow(model: unknown): number | null {
  return isRecord(model) && typeof model.contextWindow === 'number' ? model.contextWindow : null
}

function percentage(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null
  return (part / whole) * 100
}

function sumKnown(values: Array<number | null>): number {
  return values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
}

export function extractTodoTasksFromEntries(entries: unknown[]): WebuiTask[] {
  const phases = extractLatestTodoPhases(entries)
  return phases.flatMap(phase => {
    const phaseName = isRecord(phase) && typeof phase.name === 'string' ? phase.name : undefined
    const tasks = isRecord(phase) && Array.isArray(phase.tasks) ? phase.tasks : []
    return tasks.flatMap(task => {
      if (!isRecord(task) || typeof task.content !== 'string') return []
      const status = normalizeTodoStatus(task.status)
      return [
        {
          id: `${phaseName ?? 'Todos'}:${task.content}`,
          title: task.content,
          status,
          phase: phaseName,
          notes: Array.isArray(task.notes) ? task.notes.filter((note): note is string => typeof note === 'string') : undefined,
        },
      ]
    })
  })
}

function extractLatestTodoPhases(entries: unknown[]): unknown[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!isRecord(entry)) continue

    if (entry.type === 'custom' && entry.customType === 'user_todo_edit' && isRecord(entry.data) && Array.isArray(entry.data.phases)) {
      return entry.data.phases
    }

    if (entry.type !== 'message' || !isRecord(entry.message)) continue
    const message = entry.message
    if (message.role !== 'toolResult' || message.toolName !== 'todo_write' || message.isError === true) continue
    if (isRecord(message.details) && Array.isArray(message.details.phases)) return message.details.phases
  }
  return []
}

function normalizeTodoStatus(status: unknown): WebuiTaskStatus {
  return status === 'completed' || status === 'abandoned' || status === 'in_progress' || status === 'pending' ? status : 'pending'
}

async function readSessions(sessionDir: string, activeSessionFile: string | undefined): Promise<WebuiSession[]> {
  if (!sessionDir) return []
  try {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true })
    const sessionFiles = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(async entry => {
          const filePath = path.join(sessionDir, entry.name)
          const stat = await fs.stat(filePath)
          const title = await readSessionTitle(filePath, entry.name)
          return { filePath, title, stat }
        }),
    )

    return sessionFiles
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
      .slice(0, MAX_SESSIONS)
      .map(file => ({
        id: file.filePath,
        path: file.filePath,
        title: file.title,
        time: formatRelativeTime(file.stat.mtimeMs),
        active: activeSessionFile === file.filePath,
      }))
  } catch {
    return []
  }
}

async function readSessionTitle(filePath: string, fallbackName: string): Promise<string> {
  try {
    const headerText = await Bun.file(filePath).slice(0, 8_192).text()
    const firstLine = headerText.split('\n').find(line => line.trim())
    if (!firstLine) return fallbackName
    const header = JSON.parse(firstLine) as { title?: unknown; id?: unknown }
    if (typeof header.title === 'string' && header.title.trim()) return header.title.trim()
    if (typeof header.id === 'string' && header.id.trim()) return header.id.trim()
  } catch {
    // Fall through to filename.
  }
  return fallbackName.replace(/\.jsonl$/, '')
}

function formatRelativeTime(ms: number): string {
  const ageMs = Date.now() - ms
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (ageMs < minute) return 'just now'
  if (ageMs < hour) return `${Math.floor(ageMs / minute)}m ago`
  if (ageMs < day) return `${Math.floor(ageMs / hour)}h ago`
  if (ageMs < 7 * day) return `${Math.floor(ageMs / day)}d ago`
  return new Date(ms).toISOString().slice(0, 10)
}

export function messageFingerprint(message: unknown): string {
  if (!isRecord(message)) return `message:${Date.now()}`
  const role = typeof message.role === 'string' ? message.role : 'unknown'
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : 'no-time'
  const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
  return `${role}:${timestamp}:${toolCallId}`
}

function stringifyForUi(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
