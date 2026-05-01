import { useState, useRef, useLayoutEffect, useCallback, type ClipboardEvent, type CSSProperties, type ReactNode } from 'react'
import { Send, Cpu, Database, BrainCircuit, Wrench, ChevronRight, X, Bell, CheckCircle2, AlertCircle, type LucideIcon } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import cx from 'classnames'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  SendMessageImage,
  SendMessageResponse,
  WebuiContextCategory,
  WebuiContextCategoryId,
  WebuiContextUsage,
  WebuiImageBlock,
  WebuiJob,
  WebuiMessage,
  WebuiNoticeBlock,
  WebuiToolBlock,
  WebuiTask,
} from '../../shared/types'
import TaskTracker from './TaskTracker'
import './ChatArea.css'

interface ChatAreaProps {
  className?: string
  messages: WebuiMessage[]
  contextUsage?: WebuiContextUsage
  modelLabel: string | null | undefined
  thinkingLevel?: string | null
  isIdle: boolean
  hasPendingMessages: boolean
  tasks: WebuiTask[]
  jobs: WebuiJob[]
  onSendMessage(text: string, images?: SendMessageImage[]): Promise<SendMessageResponse>
}

const MESSAGE_PREVIEW_CHARS = 6_000
const TOOL_PREVIEW_CHARS = 3_000
const TOOL_BODY_CHARS = 80_000
const SCROLL_STICKY_PX = 96
const INITIAL_VISIBLE_MESSAGES = 80
const MESSAGE_LOAD_BATCH = 40
const MAX_PASTED_IMAGES = 6
const MAX_PASTED_IMAGE_BYTES = 5 * 1024 * 1024
interface ImageAttachment extends SendMessageImage {
  id: string
  name: string
  size: number
}



function Collapsible({
  title,
  icon: Icon,
  children,
  className,
  preview,
  defaultOpen = false,
}: {
  title: ReactNode
  icon: LucideIcon
  children: ReactNode
  className?: string
  preview?: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={cx('collapsible', className, { open })}>
      <button className="collapsible-header" onClick={() => setOpen(!open)} type="button">
        <ChevronRight size={16} className="arrow" />
        <Icon size={16} /> <span>{title}</span>
      </button>
      {!open && preview && <div className="collapsible-preview">{preview}</div>}
      <div className="collapsible-wrapper">
        <div className="collapsible-content">
          <div className="collapsible-inner">{children}</div>
        </div>
      </div>
    </div>
  )
}

function ContextUsageBubble({ usage, modelLabel, onClose }: { usage?: WebuiContextUsage; modelLabel: string | null | undefined; onClose: () => void }) {
  const blocks = buildContextBlocks(usage)

  return (
    <>
      <div className="context-bubble-backdrop" onClick={onClose} />
      <motion.div
        className="context-usage-panel panel"
        onClick={event => event.stopPropagation()}
        initial={{ opacity: 0, y: 10, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.95 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      >
        <div className="bubble-tail-bottom" />
        <div className="context-header">
          <span>Context Usage</span>
          <button className="icon-btn close-btn" onClick={onClose} aria-label="Close context usage">
            <X size={16} />
          </button>
        </div>
        <div className="context-body">
          <div className="context-grid">
            {blocks.map((type, index) => (
              <div key={index} className={`context-block ${type}`} />
            ))}
          </div>
          <div className="context-details">
            <div className="model-name">{modelLabel ?? 'Model unknown'}</div>
            <div className="model-sub">{formatContextWindow(usage)}</div>
            <div className="usage-total">{formatContextUsage(usage)}</div>
            <div className="category-title">Estimated usage by category</div>
            <ul className="category-list">
              {usage?.categories.map(category => (
                <li key={category.id} title={category.note}>
                  <span className={`dot ${contextClassName(category.id)}`}></span>
                  <span className="category-label">{category.label}:</span>
                  <span className="category-value">{formatCategoryValue(category.tokens, category.percent)}</span>
                </li>
              )) ?? <li>Context detail unavailable</li>}
            </ul>
          </div>
        </div>
      </motion.div>
    </>
  )
}

function NoticeBlock({ notice }: { notice: WebuiNoticeBlock }) {
  const Icon = notice.status === 'success' ? CheckCircle2 : notice.status === 'error' ? AlertCircle : Bell
  return (
    <Collapsible
      title={notice.title}
      icon={Icon}
      className={cx('notice-collapsible', notice.status)}
      preview={<LinePreview lines={previewLines(notice.body)} />}
    >
      <StructuredText className="notice-content" text={notice.body} limit={TOOL_PREVIEW_CHARS} />
    </Collapsible>
  )
}

function ToolBlock({ tool }: { tool: WebuiToolBlock }) {
  const title = formatToolTitle(tool)
  const isEditPreview = tool.name === 'edit' || tool.name === 'ast_edit'
  return (
    <Collapsible
      title={title}
      icon={Wrench}
      className={cx('tool-collapsible', tool.name, { error: tool.isError })}
      preview={isEditPreview ? <EditCollapsedPreview tool={tool} /> : <LinePreview lines={toolPreviewLines(tool)} />}
      defaultOpen={toolDefaultOpen(tool)}
    >
      {renderToolBody(tool)}
    </Collapsible>
  )
}

function renderToolBody(tool: WebuiToolBlock): ReactNode {
  if (tool.name === 'ask') return <AskToolView tool={tool} />
  if (tool.name === 'bash' || tool.name === 'python' || tool.name === 'recipe') return <ShellToolView tool={tool} />
  if (tool.name === 'read') return <ReadToolView tool={tool} />
  if (tool.name === 'todo_write') return <TodoWriteView tool={tool} />
  if (tool.name === 'edit' || tool.name === 'ast_edit') return <EditToolView tool={tool} />
  return <ToolDetails tool={tool} />
}

function toolDefaultOpen(tool: WebuiToolBlock): boolean {
  return tool.name === 'bash' || tool.name === 'python' || tool.name === 'recipe' || tool.name === 'read'
}

function formatToolTitle(tool: WebuiToolBlock): string {
  if (tool.name === 'ask') return formatAskToolTitle(tool)
  if (tool.name === 'bash') return `Bash${tool.isError ? ' · failed' : ''}`
  if (tool.name === 'python') return `Python${tool.isError ? ' · failed' : ''}`
  if (tool.name === 'read') {
    const path = stringArg(tool.args, 'path')
    return path ? `read · ${shortenInline(path, 64)}` : 'read'
  }
  if (tool.name === 'edit' || tool.name === 'ast_edit') {
    const path = editToolPath(tool)
    return path ? `${tool.name} · ${shortenInline(path, 64)}` : `${tool.name}${tool.isError ? ' · failed' : ''}`
  }
  return `${tool.name}${tool.isError ? ' · failed' : ''}`
}

function ShellToolView({ tool }: { tool: WebuiToolBlock }) {
  const execution = parseShellExecution(tool)
  return (
    <div className="shell-tool-view">
      {execution.command && (
        <div className="shell-command">
          <span className="shell-prompt">$</span>
          <pre>{execution.command}</pre>
        </div>
      )}
      <div className="shell-output">
        <div className="tool-data-label">Output</div>
        {execution.output ? (
          <StructuredText className="tool-data-content" text={execution.output} limit={TOOL_BODY_CHARS} />
        ) : (
          <div className="tool-empty">(no output)</div>
        )}
      </div>
      {execution.exitCode && <div className={cx('shell-meta', { error: tool.isError })}>Exit code: {execution.exitCode}</div>}
    </div>
  )
}

function ReadToolView({ tool }: { tool: WebuiToolBlock }) {
  const path = stringArg(tool.args, 'path')
  const selector = stringArg(tool.args, 'sel')
  return (
    <div className="read-tool-view">
      {(path || selector) && (
        <div className="read-meta">
          {path && <span>{path}</span>}
          {selector && <span>sel: {selector}</span>}
        </div>
      )}
      {tool.result ? (
        <StructuredText className="tool-data-content read-output" text={tool.result} limit={TOOL_BODY_CHARS} />
      ) : (
        <div className="tool-empty">No content captured.</div>
      )}
    </div>
  )
}

function TodoWriteView({ tool }: { tool: WebuiToolBlock }) {
  const lines = todoWriteSummaryLines(tool.args)
  return (
    <div className="todo-tool-view">
      {lines.length > 0 && (
        <ul className="todo-summary-list">
          {lines.map((line, index) => (
            <li key={`${line}:${index}`}>{line}</li>
          ))}
        </ul>
      )}
      <ToolDetails tool={tool} />
    </div>
  )
}

function EditCollapsedPreview({ tool }: { tool: WebuiToolBlock }) {
  const [showFullDiff, setShowFullDiff] = useState(false)
  const preview = buildEditPreview(tool)
  const visibleChangedLines = preview.changedLines.slice(0, PREVIEW_LINE_LIMIT)
  const hiddenChangedCount = Math.max(0, preview.changedLines.length - visibleChangedLines.length)
  const canShowFullDiff = preview.diffLines.length > 0
  const toggleLabel = showFullDiff
    ? '▴ hide full diff'
    : hiddenChangedCount > 0
      ? `▸ ${hiddenChangedCount} more changed lines`
      : '▸ show full diff'

  return (
    <div className="edit-preview">
      {preview.path && <div className="edit-preview-path" title={preview.path}>{preview.path}</div>}
      {showFullDiff ? (
        <div className="edit-preview-full" aria-label="Full diff preview">
          <DiffLineList lines={preview.diffLines} />
        </div>
      ) : (
        <LinePreview lines={visibleChangedLines} highlightDiff />
      )}
      {canShowFullDiff && (
        <button className="preview-more edit-preview-toggle" type="button" onClick={() => setShowFullDiff(value => !value)}>
          {toggleLabel}
        </button>
      )}
    </div>
  )
}

function EditToolView({ tool }: { tool: WebuiToolBlock }) {
  const result = splitEditResult(tool.result)
  const diffLines = editDetailDiffLines(tool) ?? result.diffLines
  if (!tool.args && !tool.result && diffLines.length === 0) return <div className="tool-empty">No details available.</div>

  return (
    <div className="tool-details edit-tool-view">
      {tool.args && <ToolData label="Input" text={tool.args} />}
      {(tool.result || diffLines.length > 0) && (
        <div className="tool-data">
          <div className="tool-data-label">{tool.isError ? 'Error' : 'Result'}</div>
          {result.summary && <StructuredText className="tool-data-content edit-result-summary" text={result.summary} limit={TOOL_BODY_CHARS} />}
          {diffLines.length > 0 ? <DiffBlock text={diffLines.join('\n')} /> : !result.summary && <div className="tool-empty">(no output)</div>}
        </div>
      )}
    </div>
  )
}

function ToolDetails({ tool }: { tool: WebuiToolBlock }) {
  if (!tool.args && !tool.result) return <div className="tool-empty">No details available.</div>

  return (
    <div className="tool-details">
      {tool.args && <ToolData label="Input" text={tool.args} />}
      {tool.result && <ToolData label={tool.isError ? 'Error' : 'Result'} text={tool.result} />}
    </div>
  )
}

function ToolData({ label, text }: { label: string; text: string }) {
  return (
    <div className="tool-data">
      <div className="tool-data-label">{label}</div>
      <StructuredText className="tool-data-content" text={text} limit={TOOL_BODY_CHARS} />
    </div>
  )
}

function AskToolView({ tool }: { tool: WebuiToolBlock }) {
  const questions = parseAskQuestions(tool.args)
  const results = parseAskResults(tool.resultDetails)

  if (questions.length === 0 && results.length === 0) {
    return <ToolDetails tool={tool} />
  }

  const rows = questions.length > 0 ? questions : results.map(resultToAskQuestion)

  return (
    <div className="ask-tool-view">
      {rows.map((question, index) => {
        const result = findAskResult(question, results, index)
        const selected = new Set(result?.selectedOptions ?? [])
        return (
          <div className="ask-question" key={`${question.id ?? question.question}:${index}`}>
            <div className="ask-question-text">{question.question}</div>
            {question.options.length > 0 && (
              <ul className="ask-options">
                {question.options.map((option, optionIndex) => (
                  <li
                    key={`${option}:${optionIndex}`}
                    className={cx({ selected: selected.has(option), recommended: question.recommended === optionIndex })}
                  >
                    {option}
                  </li>
                ))}
              </ul>
            )}
            <div className={cx('ask-answer', { empty: !result })}>
              {formatAskAnswer(result)}
            </div>
          </div>
        )
      })}
      {tool.result && results.length === 0 && <ToolData label="Raw result" text={tool.result} />}
    </div>
  )
}

function MessageContent({ content }: { content: string }) {
  return <StructuredText className="message-content" text={content} limit={MESSAGE_PREVIEW_CHARS} markdown />
}
function MessageImages({ images }: { images: WebuiImageBlock[] }) {
  if (images.length === 0) return null
  return (
    <div className="message-images">
      {images.map(image => (
        <a key={image.id} className="message-image-link" href={`data:${image.mimeType};base64,${image.data}`} target="_blank" rel="noreferrer">
          <img src={`data:${image.mimeType};base64,${image.data}`} alt="Attached content" loading="lazy" />
        </a>
      ))}
    </div>
  )
}

function WorkingIndicator({ queued }: { queued: boolean }) {
  return (
    <div className="working-indicator" role="status" aria-live="polite">
      <span className="working-dots" aria-hidden="true"><span /> <span /> <span /></span>
      <span>{queued ? 'Working · follow-up queued' : 'Working'}</span>
    </div>
  )
}



function StructuredText({
  className,
  text,
  limit,
  markdown = false,
}: {
  className: string
  text: string
  limit: number
  markdown?: boolean
}) {
  const parts = splitStructuredText(text)
  return (
    <div className={className}>
      {parts.map((part, index) => {
        if (part.type === 'diff') {
          return <DiffBlock key={`${part.type}:${index}`} text={part.text} />
        }
        if (part.type === 'notice' && part.notice) {
          return <NoticeBlock key={`${part.type}:${index}:${part.notice.id}`} notice={part.notice} />
        }
        return <ExpandableText key={`${part.type}:${index}`} className={markdown ? 'structured-text-markdown' : 'structured-text-plain'} text={part.text} limit={limit} markdown={markdown} />
      })}
    </div>
  )
}

function ExpandableText({
  className,
  text,
  limit,
  markdown = false,
}: {
  className: string
  text: string
  limit: number
  markdown?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const shouldTruncate = text.length > limit
  const visibleText = shouldTruncate && !expanded ? `${text.slice(0, limit).trimEnd()}\n…` : text

  return (
    <div className={className}>
      {markdown ? <MarkdownText text={visibleText} /> : visibleText}
      {shouldTruncate && (
        <button className="inline-toggle" type="button" onClick={() => setExpanded(value => !value)}>
          {expanded ? 'Show less' : `Show full (${formatTokens(text.length)} chars)`}
        </button>
      )}
    </div>
  )
}

const markdownComponents: Components = {
  a({ href, title, children }) {
    if (!href) return <>{children}</>
    return (
      <a href={href} title={title} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  },
  img({ src, alt, title }) {
    if (!src) return null
    return (
      <a className="markdown-image-link" href={src} title={title} target="_blank" rel="noreferrer noopener">
        {alt || title || src}
      </a>
    )
  },
}

function MarkdownText({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {text}
    </Markdown>
  )
}

function DiffBlock({ text }: { text: string }) {
  const lines = splitRenderableDiff(text)
  const stats = diffStatsForLines(lines)
  const header = stats.added > 0 || stats.removed > 0
    ? `Diff · +${stats.added} -${stats.removed}${stats.hunks > 0 ? ` · ${stats.hunks} ${stats.hunks === 1 ? 'hunk' : 'hunks'}` : ''}`
    : `Diff · ${lines.length} lines`

  return (
    <div className="code-diff-block">
      <div className="code-diff-header">{header}</div>
      <div className="code-diff-content">
        <DiffLineList lines={lines} />
      </div>
    </div>
  )
}

function DiffLineList({ lines }: { lines: string[] }) {
  const parsed = lines.map(parseDiffDisplayLine)
  const lineNumberWidth = Math.max(1, ...parsed.map(line => line.lineNumber.length))
  const rows = parsed.map((line, index) => {
    const previousLineNumber = parsed.slice(0, index).findLast(previous => previous.lineNumber)?.lineNumber ?? ''
    const displayLineNumber = line.lineNumber && line.lineNumber === previousLineNumber ? '' : line.lineNumber
    return { line, displayLineNumber }
  })
  return (
    <div className="diff-line-list" style={{ '--diff-line-number-width': `${lineNumberWidth}ch` } as CSSProperties}>
      {rows.map(({ line, displayLineNumber }, index) => (
          <div key={`${index}:${line.raw}`} className={cx('diff-line', line.type, { 'with-gutter': line.hasGutter })}>
            {line.hasGutter ? (
              <>
                <span className="diff-marker">{line.marker}</span>
                <span className="diff-line-number">{displayLineNumber}</span>
                <span className="diff-separator">|</span>
                <span className="diff-code">{line.content || ' '}</span>
              </>
            ) : (
              line.raw || ' '
            )}
          </div>
      ))}
    </div>
  )
}


function imageFileToAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Could not read pasted image'))
        return
      }
      const match = /^data:([^;]+);base64,(.+)$/.exec(reader.result)
      if (!match) {
        reject(new Error('Pasted image could not be encoded'))
        return
      }
      resolve({
        id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${file.name}`,
        name: file.name || 'pasted image',
        size: file.size,
        mimeType: match[1],
        data: match[2],
      })
    }
    reader.onerror = () => reject(new Error('Could not read pasted image'))
    reader.readAsDataURL(file)
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function ChatArea({
  className,
  messages,
  contextUsage,
  thinkingLevel,
  modelLabel,
  isIdle,
  hasPendingMessages,
  tasks,
  jobs,
  onSendMessage,
}: ChatAreaProps) {
  const [input, setInput] = useState('')
  const [showContext, setShowContext] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const historyRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const initialScrollRef = useRef(false)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES)
  const hiddenMessageCount = Math.max(messages.length - visibleMessageCount, 0)
  const visibleMessages = messages.slice(hiddenMessageCount)

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    endRef.current?.scrollIntoView({ behavior, block: 'end' })
  }, [])

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault()
    setSendError(null)

    const remainingSlots = MAX_PASTED_IMAGES - imageAttachments.length
    if (remainingSlots <= 0) {
      setSendError(`最多只能附加 ${MAX_PASTED_IMAGES} 张图片`)
      return
    }

    const accepted = files.slice(0, remainingSlots)
    const tooLarge = accepted.find(file => file.size > MAX_PASTED_IMAGE_BYTES)
    if (tooLarge) {
      setSendError(`图片 ${tooLarge.name || 'pasted image'} 超过 ${formatBytes(MAX_PASTED_IMAGE_BYTES)} 限制`)
      return
    }

    void Promise.all(accepted.map(imageFileToAttachment))
      .then(attachments => setImageAttachments(current => [...current, ...attachments].slice(0, MAX_PASTED_IMAGES)))
      .catch(error => setSendError(error instanceof Error ? error.message : String(error)))
  }, [imageAttachments.length])

  const removeImageAttachment = useCallback((id: string) => {
    setImageAttachments(current => current.filter(image => image.id !== id))
  }, [])


  const handleHistoryScroll = () => {
    const history = historyRef.current
    if (!history) return
    const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight <= SCROLL_STICKY_PX
    stickToBottomRef.current = nearBottom
    setShowJumpToLatest(!nearBottom)
    if (history.scrollTop <= SCROLL_STICKY_PX && hiddenMessageCount > 0) {
      setVisibleMessageCount(count => Math.min(messages.length, count + MESSAGE_LOAD_BATCH))
    }
  }

  useLayoutEffect(() => {
    if (!initialScrollRef.current) {
      initialScrollRef.current = true
      scrollToLatest('auto')
      return
    }

    if (stickToBottomRef.current) {
      scrollToLatest('auto')
    } else {
      setShowJumpToLatest(true)
    }
  }, [messages, scrollToLatest])

  const handleSend = async () => {
    const text = input.trim()
    if ((!text && imageAttachments.length === 0) || sending) return
    stickToBottomRef.current = true
    setShowJumpToLatest(false)
    scrollToLatest('smooth')
    setSending(true)
    setSendError(null)
    try {
      await onSendMessage(text, imageAttachments.map(({ mimeType, data }) => ({ mimeType, data })))
      setInput('')
      setImageAttachments([])
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={cx('panel', className)}>
      <div className="chat-history-wrap">
      <div className="chat-history" ref={historyRef} onScroll={handleHistoryScroll}>
        {messages.length === 0 && <div className="empty-state chat-empty">No messages in the current branch.</div>}
        {hiddenMessageCount > 0 && (
          <button
            className="load-older-messages"
            type="button"
            onClick={() => setVisibleMessageCount(count => Math.min(messages.length, count + MESSAGE_LOAD_BATCH))}
          >
            Load {Math.min(MESSAGE_LOAD_BATCH, hiddenMessageCount)} older messages
          </button>
        )}
        {visibleMessages.map(message => (
          <div key={message.id} className={cx('message-wrapper', message.role === 'user' ? 'user' : 'agent')}>
            <div className={cx('message', message.role === 'user' ? 'user' : 'agent')}>
              {message.notices?.map(notice => <NoticeBlock key={`${message.id}:notice:${notice.id}`} notice={notice} />)}
              {message.thinking?.map((thinking, index) => (
                <Collapsible key={`${message.id}:thinking:${index}`} title="思考过程" icon={BrainCircuit}>
                  <ExpandableText className="cot-content" text={thinking} limit={TOOL_PREVIEW_CHARS} />
                </Collapsible>
              ))}
              {message.tools?.map(tool => <ToolBlock key={`${message.id}:tool:${tool.id}`} tool={tool} />)}
              {message.content && <MessageContent content={message.content} />}
              {message.images && <MessageImages images={message.images} />}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {showJumpToLatest && (
        <button className="jump-latest" type="button" onClick={() => {
          stickToBottomRef.current = true
          setShowJumpToLatest(false)
          scrollToLatest('smooth')
        }}>
          Jump to latest
        </button>
      )}
    </div>


      <TaskTracker className="mobile-tracker" tasks={tasks} jobs={jobs} />

      <div className="input-area">
        {imageAttachments.length > 0 && (
          <div className="image-attachments" aria-label="Pasted images">
            {imageAttachments.map(image => (
              <div key={image.id} className="image-attachment">
                <img src={`data:${image.mimeType};base64,${image.data}`} alt="Pasted attachment preview" />
                <span className="image-attachment-meta">{image.name} · {formatBytes(image.size)}</span>
                <button type="button" onClick={() => removeImageAttachment(image.id)} aria-label={`Remove ${image.name}`}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="input-box">
          <textarea
            value={input}
            onChange={event => setInput(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void handleSend()
              }
            }}
            placeholder="输入指令，或者描述你想让 agent 完成的任务..."
            rows={1}
            style={{ height: input.split('\n').length * 24 + 16 }}
          />
          <button className="btn-cta" onClick={() => void handleSend()} disabled={sending || (!input.trim() && imageAttachments.length === 0)} aria-label="Send message">
            <Send size={18} />
          </button>
        </div>
        <div className="input-footer">
          <div className="input-footer-left">
            <div className="info-badge">
              <Cpu size={14} /> {modelLabel ?? 'Model unknown'}
              {thinkingLevel && <span className="thinking-level">· {thinkingLevel}</span>}
            </div>
            {(!isIdle || hasPendingMessages) && <WorkingIndicator queued={hasPendingMessages} />}
          </div>
          <div style={{ position: 'relative' }}>
            <div className="info-badge clickable" onClick={() => setShowContext(true)}>
              <Database size={14} /> {formatContextUsage(contextUsage)}
            </div>
            <AnimatePresence>
              {showContext && <ContextUsageBubble usage={contextUsage} modelLabel={modelLabel} onClose={() => setShowContext(false)} />}
            </AnimatePresence>
          </div>
        </div>
        {sendError && <div className="send-error">{sendError}</div>}
      </div>
    </div>
  )
}

interface AskQuestionView {
  id?: string
  question: string
  options: string[]
  multi: boolean
  recommended?: number
}

interface AskResultView {
  id?: string
  question?: string
  selectedOptions: string[]
  customInput?: string
}

type StructuredPart = { type: 'text' | 'diff' | 'notice'; text: string; notice?: WebuiNoticeBlock }
type ParsedDiffLine = { type: 'plus' | 'minus' | 'normal'; marker: '+' | '-' | ' '; lineNumber: string; content: string; raw: string; hasGutter: boolean }

const PREVIEW_LINE_LIMIT = 5
const CONTEXT_GRID_CELLS = 200


interface ShellExecution {
  command: string | null
  output: string
  exitCode: string | null
}

function LinePreview({
  lines,
  highlightDiff = false,
  moreLabel = 'more lines',
}: {
  lines: string[]
  highlightDiff?: boolean
  moreLabel?: string
}) {
  if (lines.length === 0) return null
  const visibleLines = lines.slice(0, PREVIEW_LINE_LIMIT)
  const hiddenCount = Math.max(0, lines.length - visibleLines.length)
  return (
    <div className={cx('line-preview', { diff: highlightDiff })}>
      {visibleLines.map((line, index) => (
        <div key={`${index}:${line}`} className={cx('preview-line', highlightDiff ? previewDiffLineClass(line) : undefined)}>{line || ' '}</div>
      ))}
      {hiddenCount > 0 && <div className="preview-more">▸ {hiddenCount} {moreLabel}</div>}
    </div>
  )
}

function toolPreviewLines(tool: WebuiToolBlock): string[] {
  if (tool.name === 'todo_write') return todoWriteSummaryLines(tool.args)
  if (tool.name === 'edit' || tool.name === 'ast_edit') return editPreviewLines(tool.result)
  if (tool.name === 'bash' || tool.name === 'python' || tool.name === 'recipe') {
    const execution = parseShellExecution(tool)
    const command = execution.command ? `$ ${singleLineCommand(execution.command)}` : ''
    const outputLines = previewLines(execution.output)
    return [command, ...outputLines].filter(Boolean)
  }
  if (tool.name === 'read') {
    const path = stringArg(tool.args, 'path')
    return previewLines([path ?? '', tool.result ?? ''].filter(Boolean).join('\n'))
  }
  if (tool.name === 'ask') {
    return parseAskQuestions(tool.args).map(question => `ASK: ${question.question}`)
  }
  return previewLines(tool.result ?? tool.args ?? '')
}

function previewDiffLineClass(line: string): string | undefined {
  if (isAddedDiffLine(line)) return 'plus'
  if (isRemovedDiffLine(line)) return 'minus'
  return undefined
}

function buildEditPreview(tool: WebuiToolBlock): { path: string | null; diffLines: string[]; changedLines: string[] } {
  const result = splitEditResult(tool.result)
  const sourceDiffLines = editDetailDiffLines(tool) ?? result.diffLines
  const normalizedDiffLines = sourceDiffLines
    .map(line => normalizePreviewDiffLine(line))
    .filter((line): line is string => Boolean(line))
  const changedLines = normalizedDiffLines.filter(isPreviewDiffChangeLine)
  return {
    path: editToolPath(tool),
    diffLines: normalizedDiffLines.length > 0 ? normalizedDiffLines : sourceDiffLines,
    changedLines: changedLines.length > 0 ? changedLines : normalizedDiffLines,
  }
}

function editDetailDiffLines(tool: WebuiToolBlock): string[] | null {
  return diffLinesFromDetails(tool.resultDetails)
}

function diffLinesFromDetails(details: unknown): string[] | null {
  if (!isUiRecord(details)) return null
  if (typeof details.diff === 'string' && details.diff.trim()) return splitRenderableDiff(details.diff)
  if (!Array.isArray(details.perFileResults)) return null

  const lines: string[] = []
  for (const result of details.perFileResults) {
    if (!isUiRecord(result) || typeof result.diff !== 'string' || !result.diff.trim()) continue
    if (typeof result.path === 'string' && details.perFileResults.length > 1) lines.push(`# ${result.path}`)
    lines.push(...splitRenderableDiff(result.diff))
  }
  return lines.length > 0 ? lines : null
}

function editToolPath(tool: WebuiToolBlock): string | null {
  return stringArg(tool.args, 'path') ?? stringArg(tool.args, 'file_path') ?? pathFromEditSummary(splitEditResult(tool.result).summary)
}

function pathFromEditSummary(summary: string): string | null {
  const firstPathLine = summary
    .split('\n')
    .map(line => line.trim())
    .find(line => /^(?:Updated|Created|Deleted|Moved|Renamed)\s+\S+/.test(line))
  const match = firstPathLine?.match(/^(?:Updated|Created|Deleted|Moved|Renamed)\s+(.+)$/)
  return match?.[1]?.trim() || null
}

function singleLineCommand(command: string): string {
  const lines = command.split('\n').map(line => line.trimEnd()).filter(Boolean)
  if (lines.length <= 1) return lines[0] ?? command
  return `${lines[0]} …`
}

function editPreviewLines(result: string | undefined): string[] {
  const diffLines = extractEditDiffLines(result)
    .map(line => normalizePreviewDiffLine(line))
    .filter((line): line is string => Boolean(line))
  const changedLines = diffLines.filter(isPreviewDiffChangeLine)
  return changedLines.length > 0 ? changedLines : diffLines
}

function splitEditResult(result: string | undefined): { summary: string; diffLines: string[] } {
  if (!result) return { summary: '', diffLines: [] }
  const lines = result.split('\n')
  const previewStart = lines.findIndex(line => line.trim() === 'Diff preview:')
  if (previewStart < 0) return { summary: result.trim(), diffLines: [] }
  return {
    summary: lines.slice(0, previewStart).join('\n').trim(),
    diffLines: extractEditDiffLines(result),
  }
}

function extractEditDiffLines(result: string | undefined): string[] {
  if (!result) return []
  const lines = result.split('\n')
  const previewStart = lines.findIndex(line => line.trim() === 'Diff preview:')
  return (previewStart >= 0 ? lines.slice(previewStart + 1) : lines)
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
}

function isPreviewDiffChangeLine(line: string): boolean {
  return isAddedDiffLine(line) || isRemovedDiffLine(line)
}

function isAddedDiffLine(line: string): boolean {
  return diffLineMarker(line) === '+'
}

function isRemovedDiffLine(line: string): boolean {
  return diffLineMarker(line) === '-'
}

function normalizePreviewDiffLine(line: string): string | null {
  const trimmedEnd = line.trimEnd()
  if (!trimmedEnd.trim()) return null
  const anchored = trimmedEnd.match(/^([+\-\s*])(\d+)(?:[a-z]{2})?\|(.*)$/)
  if (anchored) {
    const marker = anchored[1] === '*' ? ' ' : anchored[1]
    return `${marker}${anchored[2]}|${anchored[3] ?? ''}`
  }
  return trimmedEnd
}

function previewLines(text: string): string[] {
  return text.split('\n').map(line => line.trimEnd()).filter(line => line.length > 0)
}

function todoWriteSummaryLines(args: string | undefined): string[] {
  const parsed = parseJsonRecord(args)
  const ops = Array.isArray(parsed?.ops) ? parsed.ops : []
  return ops.flatMap(todoWriteOperationSummary).filter(Boolean)
}

function todoWriteOperationSummary(op: unknown): string[] {
  if (!isUiRecord(op)) return []
  const action = typeof op.op === 'string' ? op.op : 'update'
  if (typeof op.task === 'string' && op.task.trim()) return [`${action}: ${op.task.trim()}`]
  if (typeof op.phase === 'string' && op.phase.trim()) return [`${action}: ${op.phase.trim()}`]
  if (Array.isArray(op.items)) {
    return op.items
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(item => `${action}: ${item.trim()}`)
  }
  if (Array.isArray(op.list)) {
    return op.list.flatMap(phase => {
      if (!isUiRecord(phase)) return []
      const phaseName = typeof phase.phase === 'string' ? phase.phase : 'phase'
      const items = Array.isArray(phase.items) ? phase.items : []
      return items
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => `${action}: ${phaseName} / ${item.trim()}`)
    })
  }
  return [action]
}

function parseShellExecution(tool: WebuiToolBlock): ShellExecution {
  const args = parseJsonRecord(tool.args)
  const parsedResult = parseExecutionResult(tool.result)
  const command =
    stringFromRecord(args, 'command') ??
    stringFromRecord(args, 'code') ??
    stringFromRecord(args, 'op') ??
    parsedResult.command
  const output = parsedResult.output ?? tool.result ?? ''
  return {
    command,
    output,
    exitCode: parsedResult.exitCode,
  }
}

function parseExecutionResult(result: string | undefined): ShellExecution {
  if (!result) return { command: null, output: '', exitCode: null }
  const match = result.match(/^(?:Command|Python):\s*([^\n]*)\nExit code:\s*([^\n]*)(?:\n([\s\S]*))?$/)
  if (!match) return { command: null, output: result, exitCode: null }
  return {
    command: match[1]?.trim() || null,
    exitCode: match[2]?.trim() || null,
    output: match[3] ?? '',
  }
}

function stringArg(args: string | undefined, key: string): string | undefined {
  return stringFromRecord(parseJsonRecord(args), key) ?? undefined
}

function stringFromRecord(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function formatAskToolTitle(tool: WebuiToolBlock): string {
  const question = parseAskQuestions(tool.args)[0]?.question ?? parseAskResults(tool.resultDetails)[0]?.question
  return question ? `ASK · ${shortenInline(question, 72)}` : 'ASK'
}

function parseAskQuestions(args: string | undefined): AskQuestionView[] {
  const parsed = parseJsonRecord(args)
  if (!parsed) return []

  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.flatMap(questionFromUnknown)
    : questionFromUnknown(parsed)
  return questions
}

function questionFromUnknown(value: unknown): AskQuestionView[] {
  if (!isUiRecord(value) || typeof value.question !== 'string') return []
  return [
    {
      id: typeof value.id === 'string' ? value.id : undefined,
      question: value.question,
      options: Array.isArray(value.options) ? value.options.flatMap(optionLabelFromUnknown) : [],
      multi: value.multi === true,
      recommended: typeof value.recommended === 'number' ? value.recommended : undefined,
    },
  ]
}

function optionLabelFromUnknown(option: unknown): string[] {
  if (typeof option === 'string') return [option]
  if (isUiRecord(option) && typeof option.label === 'string') return [option.label]
  return []
}

function parseAskResults(details: unknown): AskResultView[] {
  if (!isUiRecord(details)) return []
  if (Array.isArray(details.results)) return details.results.flatMap(resultFromUnknown)
  return resultFromUnknown(details)
}

function resultFromUnknown(value: unknown): AskResultView[] {
  if (!isUiRecord(value)) return []
  const selectedOptions = Array.isArray(value.selectedOptions)
    ? value.selectedOptions.filter((option): option is string => typeof option === 'string')
    : []
  const customInput = typeof value.customInput === 'string' ? value.customInput : undefined
  const question = typeof value.question === 'string' ? value.question : undefined
  if (!question && selectedOptions.length === 0 && customInput === undefined) return []
  return [
    {
      id: typeof value.id === 'string' ? value.id : undefined,
      question,
      selectedOptions,
      customInput,
    },
  ]
}

function resultToAskQuestion(result: AskResultView): AskQuestionView {
  return {
    id: result.id,
    question: result.question ?? result.id ?? 'Question',
    options: result.selectedOptions,
    multi: result.selectedOptions.length > 1,
  }
}

function findAskResult(question: AskQuestionView, results: AskResultView[], index: number): AskResultView | undefined {
  return (
    results.find(result => result.id !== undefined && result.id === question.id) ??
    results.find(result => result.question !== undefined && result.question === question.question) ??
    results[index]
  )
}

function formatAskAnswer(result: AskResultView | undefined): string {
  if (!result) return 'Waiting for answer'
  if (result.customInput !== undefined) return `Answer: ${result.customInput}`
  if (result.selectedOptions.length > 0) return `Answer: ${result.selectedOptions.join(', ')}`
  return 'No answer selected'
}

function splitStructuredText(text: string): StructuredPart[] {
  const noticeParts = splitSystemNoticeParts(text)
  if (noticeParts) return noticeParts

  const parts: StructuredPart[] = []
  const fencePattern = /```([\w-]+)?[^\n]*\n([\s\S]*?)```/g
  let cursor = 0
  for (const match of text.matchAll(fencePattern)) {
    const fullMatch = match[0]
    const start = match.index ?? 0
    const language = match[1]?.toLowerCase()
    const body = match[2] ?? ''
    if (start > cursor) pushTextPart(parts, text.slice(cursor, start))
    if (language === 'diff' || language === 'patch' || looksLikeUnifiedDiff(body)) {
      parts.push({ type: 'diff', text: body })
    } else {
      pushTextPart(parts, fullMatch)
    }
    cursor = start + fullMatch.length
  }
  if (cursor < text.length) pushTextPart(parts, text.slice(cursor))

  if (parts.length === 0 && looksLikeUnifiedDiff(text)) return [{ type: 'diff', text }]
  return parts.length > 0 ? parts : [{ type: 'text', text }]
}

function splitSystemNoticeParts(text: string): StructuredPart[] | null {
  const noticePattern = /<system-notice>\s*([\s\S]*?)\s*<\/system-notice>/g
  const matches = Array.from(text.matchAll(noticePattern))
  if (matches.length === 0) return null

  const parts: StructuredPart[] = []
  let cursor = 0
  for (const match of matches) {
    const start = match.index ?? 0
    if (start > cursor) pushTextPart(parts, text.slice(cursor, start))
    const body = match[1]?.trim() ?? ''
    parts.push({
      type: 'notice',
      text: body,
      notice: noticeFromBody(`raw-notice-${parts.length}`, body),
    })
    cursor = start + match[0].length
  }
  if (cursor < text.length) pushTextPart(parts, text.slice(cursor))
  return parts
}

function noticeFromBody(id: string, body: string): WebuiNoticeBlock {
  const lines = body.split('\n')
  const firstLine = lines.find(line => line.trim())?.trim() ?? 'System notice'
  const jobMatch = firstLine.match(/^Background job\s+(\S+)\s+has completed/i)
  const title = jobMatch ? `Background job completed · ${jobMatch[1]}` : firstLine
  const isTimeout = /timed out|timeout/i.test(body)
  const isFailed = /Command exited with code [1-9]\d*|failed|error/i.test(body)
  return {
    id,
    title,
    body,
    status: isFailed ? 'error' : isTimeout ? 'warning' : 'success',
  }
}

function pushTextPart(parts: StructuredPart[], text: string): void {
  if (text.length > 0) parts.push({ type: 'text', text })
}

function looksLikeUnifiedDiff(text: string): boolean {
  const lines = text.split('\n')
  const hasHeader = lines.some(line => line.startsWith('diff --git ') || line.startsWith('@@ ') || line.startsWith('--- ') || line.startsWith('+++ '))
  const hasChange = lines.some(line => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---')))
  return hasHeader && hasChange
}

function splitRenderableDiff(text: string): string[] {
  const trimmed = text.replace(/\n$/, '')
  return trimmed ? trimmed.split('\n') : []
}

function diffStatsForLines(lines: string[]): { added: number; removed: number; hunks: number } {
  return {
    added: lines.filter(isAddedDiffLine).length,
    removed: lines.filter(isRemovedDiffLine).length,
    hunks: lines.filter(line => line.startsWith('@@')).length,
  }
}

function parseDiffDisplayLine(line: string): ParsedDiffLine {
  const raw = normalizePreviewDiffLine(line) ?? line.trimEnd()
  const anchored = raw.match(/^([+\-\s])(\d+)\|(.*)$/)
  if (anchored) {
    const marker = anchored[1] as '+' | '-' | ' '
    return {
      type: marker === '+' ? 'plus' : marker === '-' ? 'minus' : 'normal',
      marker,
      lineNumber: anchored[2] ?? '',
      content: anchored[3] ?? '',
      raw,
      hasGutter: true,
    }
  }

  const type = classifyDiffLine(raw)
  return {
    type,
    marker: type === 'plus' ? '+' : type === 'minus' ? '-' : ' ',
    lineNumber: '',
    content: raw,
    raw,
    hasGutter: false,
  }
}

function classifyDiffLine(line: string): 'plus' | 'minus' | 'normal' {
  const marker = diffLineMarker(line)
  if (marker === '+') return 'plus'
  if (marker === '-') return 'minus'
  return 'normal'
}

function diffLineMarker(line: string): '+' | '-' | null {
  const raw = line.trimEnd()
  if (raw.startsWith('+++') || raw.startsWith('---')) return null
  const anchored = raw.match(/^([+-])\d+(?:[a-z]{2})?\|/)
  if (anchored?.[1] === '+' || anchored?.[1] === '-') return anchored[1]
  if (raw.startsWith('+')) return '+'
  if (raw.startsWith('-')) return '-'
  return null
}

function parseJsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text)
    return isUiRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isUiRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function shortenInline(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`
}

function formatContextUsage(usage: WebuiContextUsage | undefined): string {
  if (!usage || usage.tokens === null || usage.contextWindow === null) return 'Context unknown'
  return `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`
}

function formatContextWindow(usage: WebuiContextUsage | undefined): string {
  if (!usage?.contextWindow) return 'Context window unknown'
  return `${formatTokens(usage.contextWindow)} context window`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

function formatCategoryValue(tokens: number | null, percent: number | null): string {
  if (tokens === null) return 'unavailable'
  const pct = percent === null ? '' : ` (${formatPercent(percent)})`
  return `${formatTokens(tokens)} tokens${pct}`
}

function formatPercent(percent: number): string {
  if (percent > 0 && percent < 0.05) return '<0.1%'
  return `${percent.toFixed(1)}%`
}

function contextClassName(id: WebuiContextCategoryId): string {
  switch (id) {
    case 'systemPrompt':
      return 'system-prompt'
    case 'systemTools':
      return 'system-tools'
    case 'skills':
      return 'skills'
    case 'messages':
      return 'messages'
    case 'autoCompactBuffer':
      return 'buffer'
    case 'unclassified':
      return 'unclassified'
    case 'freeSpace':
      return 'free-space'
  }
}

function buildContextBlocks(usage: WebuiContextUsage | undefined): string[] {
  if (!usage?.contextWindow || usage.contextWindow <= 0) return Array.from({ length: CONTEXT_GRID_CELLS }, () => 'free-space')
  const tokensPerCell = usage.contextWindow / CONTEXT_GRID_CELLS
  const ratioCells = (tokens: number): number => {
    if (tokens <= 0) return 0
    return Math.max(1, Math.round(tokens / tokensPerCell))
  }

  const usageCategoryIds: WebuiContextCategoryId[] = ['systemPrompt', 'systemTools', 'skills', 'messages']
  const categoryCounts = usageCategoryIds
    .map(id => {
      const category = usage.categories.find(item => item.id === id)
      return { category, count: ratioCells(category?.tokens ?? 0) }
    })
    .filter((entry): entry is { category: WebuiContextCategory; count: number } => Boolean(entry.category) && entry.count > 0)

  let bufferCount = ratioCells(usage.autoCompactBufferTokens ?? usage.categories.find(category => category.id === 'autoCompactBuffer')?.tokens ?? 0)
  let usedCount = categoryCounts.reduce((sum, entry) => sum + entry.count, 0)
  const maxUsable = CONTEXT_GRID_CELLS - bufferCount

  if (usedCount > maxUsable) {
    let overflow = usedCount - maxUsable
    const largestFirst = [...categoryCounts].sort((a, b) => b.count - a.count)
    for (const entry of largestFirst) {
      while (overflow > 0 && entry.count > 1) {
        entry.count -= 1
        overflow -= 1
      }
    }
    usedCount = categoryCounts.reduce((sum, entry) => sum + entry.count, 0)
    if (usedCount + bufferCount > CONTEXT_GRID_CELLS) {
      bufferCount = Math.max(0, CONTEXT_GRID_CELLS - usedCount)
    }
  }

  const blocks: string[] = []
  for (const { category, count } of categoryCounts) {
    for (let index = 0; index < count; index += 1) blocks.push(contextClassName(category.id))
  }
  const freeCount = Math.max(0, CONTEXT_GRID_CELLS - blocks.length - bufferCount)
  for (let index = 0; index < freeCount; index += 1) blocks.push('free-space')
  for (let index = 0; index < bufferCount; index += 1) blocks.push('buffer')
  while (blocks.length < CONTEXT_GRID_CELLS) blocks.push('free-space')
  return blocks.slice(0, CONTEXT_GRID_CELLS)
}