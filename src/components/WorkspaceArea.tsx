import { useEffect, useState } from 'react'
import { X, FileCode } from 'lucide-react'
import cx from 'classnames'
import type { DiffLine, DiffResponse, FileContentResponse } from '../../shared/types'
import type { WorkspaceItem } from '../App'
import './WorkspaceArea.css'

interface WorkspaceAreaProps {
  item: WorkspaceItem
  onClose: () => void
  className?: string
  loadFile(path: string): Promise<FileContentResponse>
  loadDiff(path: string): Promise<DiffResponse>
}

interface WorkspaceContentState {
  itemKey: string
  loading: boolean
  error: string | null
  content: string | null
  diff: DiffLine[] | null
}

export default function WorkspaceArea({ item, onClose, className, loadFile, loadDiff }: WorkspaceAreaProps) {
  const itemKey = `${item.type}:${item.path}`
  const [contentState, setContentState] = useState<WorkspaceContentState>({
    itemKey: '',
    loading: true,
    error: null,
    content: null,
    diff: null,
  })

  useEffect(() => {
    let ignore = false

    async function loadWorkspaceItem() {
      try {
        if (item.type === 'file') {
          const response = await loadFile(item.path)
          if (!ignore) setContentState({ itemKey, loading: false, error: null, content: response.content, diff: null })
        } else {
          const response = await loadDiff(item.path)
          if (!ignore) setContentState({ itemKey, loading: false, error: null, content: null, diff: response.diff })
        }
      } catch (error) {
        if (!ignore) {
          setContentState({
            itemKey,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
            content: null,
            diff: null,
          })
        }
      }
    }

    loadWorkspaceItem()
    return () => {
      ignore = true
    }
  }, [item.path, item.type, itemKey, loadDiff, loadFile])

  const isCurrentItem = contentState.itemKey === itemKey
  const isLoading = !isCurrentItem || contentState.loading
  const error = isCurrentItem ? contentState.error : null

  return (
    <div className={cx('workspace-area panel', className)}>
      <div className="workspace-header">
        <div className="workspace-tabs">
          <div className="workspace-tab active">
            <FileCode size={16} />
            <span className="tab-title" title={item.path}>{item.title}</span>
            <button className="icon-btn close-tab-btn" onClick={event => { event.stopPropagation(); onClose() }} aria-label="Close workspace tab">
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="workspace-actions">
          <button className="icon-btn" onClick={onClose} aria-label="Close workspace">
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="workspace-content">
        {isLoading && <div className="workspace-status">Loading…</div>}
        {error && <div className="workspace-status error">{error}</div>}
        {!isLoading && !error && item.type === 'file' && (
          <pre className="workspace-pre">{contentState.content}</pre>
        )}
        {!isLoading && !error && item.type === 'diff' && (
          <div className="workspace-diff-block">
            {(contentState.diff?.length ?? 0) === 0 && <div className="workspace-status">No diff available for this file.</div>}
            {contentState.diff?.map((line, index) => (
              <div key={`${item.path}:${index}`} className={`diff-line ${line.type}`}>
                {line.content}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
