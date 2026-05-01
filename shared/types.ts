export type DiffLineType = 'normal' | 'plus' | 'minus'

export interface DiffLine {
  type: DiffLineType
  content: string
}

export interface ModifiedFile {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'folder'
  loaded?: boolean
  truncated?: boolean
  children?: FileTreeNode[]
}

export interface FileTreeResponse {
  path: string
  nodes: FileTreeNode[]
  truncated: boolean
  warnings: string[]
}

export interface FileContentResponse {
  path: string
  content: string
  size: number
}

export interface DiffResponse {
  path: string
  diff: DiffLine[]
}

export interface WebuiToolBlock {
  id: string
  name: string
  args?: string
  result?: string
  resultDetails?: unknown
  isError?: boolean
}

export interface WebuiImageBlock {
  id: string
  mimeType: string
  data: string
}

export interface WebuiNoticeBlock {
  id: string
  title: string
  body: string
  status?: 'info' | 'success' | 'warning' | 'error'
}

export interface WebuiMessage {
  id: string
  role: 'user' | 'agent' | 'tool' | 'system'
  content: string
  timestamp?: number
  thinking?: string[]
  tools?: WebuiToolBlock[]
  notices?: WebuiNoticeBlock[]
  images?: WebuiImageBlock[]
}

export interface WebuiSession {
  id: string
  path: string
  title: string
  time: string
  active: boolean
}

export type WebuiTaskStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned'

export interface WebuiTask {
  id: string
  title: string
  status: WebuiTaskStatus
  phase?: string
  notes?: string[]
}

export type WebuiJobStatus = 'running' | 'done' | 'error'

export interface WebuiJob {
  id: string
  title: string
  status: WebuiJobStatus
  logs: string[]
  startedAt: number
  endedAt?: number
}

export type WebuiContextCategoryId =
  | 'systemPrompt'
  | 'systemTools'
  | 'skills'
  | 'messages'
  | 'unclassified'
  | 'freeSpace'
  | 'autoCompactBuffer'

export type WebuiContextCategorySource = 'omp' | 'estimated' | 'unavailable'

export interface WebuiContextCategory {
  id: WebuiContextCategoryId
  label: string
  tokens: number | null
  percent: number | null
  source: WebuiContextCategorySource
  note?: string
}

export interface WebuiContextUsage {
  tokens: number | null
  contextWindow: number | null
  percent: number | null
  categories: WebuiContextCategory[]
  freeTokens: number | null
  autoCompactBufferTokens: number | null
}

export interface WebuiState {
  cwd: string
  sessionName: string | null
  modelLabel: string | null
  thinkingLevel: string | null
  contextUsage: WebuiContextUsage
  messages: WebuiMessage[]
  sessions: WebuiSession[]
  todos: WebuiTask[]
  jobs: WebuiJob[]
  modifiedFiles: ModifiedFile[]
  fileTree: FileTreeResponse
  warnings: string[]
  isIdle: boolean
  hasPendingMessages: boolean
}

export interface ApiErrorResponse {
  error: string
  detail?: string
}

export interface SendMessageImage {
  mimeType: string
  data: string
}

export interface SendMessageRequest {
  text: string
  images?: SendMessageImage[]
}

export interface SendMessageResponse {
  queued: boolean
}
