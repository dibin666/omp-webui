import { useCallback, useEffect, useMemo, useState } from 'react'
import { History, FolderOpen } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import cx from 'classnames'

import SidebarLeft from './components/SidebarLeft'
import SidebarRight from './components/SidebarRight'
import ChatArea from './components/ChatArea'
import WorkspaceArea from './components/WorkspaceArea'

import type {
  ApiErrorResponse,
  DiffResponse,
  FileContentResponse,
  FileTreeResponse,
  SendMessageImage,
  SendMessageResponse,
  WebuiState,
} from '../shared/types'
import './App.css'

export interface WorkspaceItem {
  id: string
  type: 'file' | 'diff'
  title: string
  path: string
}

function App() {
  const [mobileMenu, setMobileMenu] = useState<'left' | 'right' | null>(null)
  const [workspaceItem, setWorkspaceItem] = useState<WorkspaceItem | null>(null)
  const webui = useWebuiState()

  const toggleLeft = () => setMobileMenu(prev => (prev === 'left' ? null : 'left'))
  const toggleRight = () => setMobileMenu(prev => (prev === 'right' ? null : 'right'))

  const openWorkspace = (item: WorkspaceItem) => {
    setWorkspaceItem(item)
    setMobileMenu(null)
  }

  return (
    <div className={cx('app-layout', { 'has-workspace': !!workspaceItem })}>
      <div className="mobile-topbar panel">
        <button onClick={toggleLeft} className="icon-btn" aria-label="Open project files">
          <FolderOpen size={20} />
        </button>
        <span className="title">OMP WebUI</span>
        <button onClick={toggleRight} className="icon-btn" aria-label="Open sessions">
          <History size={20} />
        </button>
      </div>

      {webui.error && <div className="app-status app-status-error">{webui.error}</div>}
      {webui.loading && !webui.state && <div className="app-status">Loading OMP state…</div>}

      <AnimatePresence>
        {mobileMenu && (
          <motion.div
            className="mobile-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setMobileMenu(null)}
          />
        )}
      </AnimatePresence>

      <SidebarLeft
        className={cx('sidebar', 'left-sidebar', { 'mobile-open': mobileMenu === 'left' })}
        fileTree={webui.state?.fileTree}
        modifiedFiles={webui.state?.modifiedFiles ?? []}
        onOpenWorkspace={openWorkspace}
        loadTree={webui.loadTree}
      />

      <AnimatePresence initial={false}>
        {workspaceItem && (
          <motion.div
            key="workspace-overlay"
            className="workspace-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setWorkspaceItem(null)}
          />
        )}
        {workspaceItem && (
          <motion.div
            key="workspace-panel"
            className="workspace-wrapper"
            initial={{ flex: 0, opacity: 0, marginLeft: 0, minWidth: 0, overflow: 'hidden' }}
            animate={{ flex: 1, opacity: 1, marginLeft: 16 }}
            exit={{ flex: 0, opacity: 0, marginLeft: 0 }}
            transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
            style={{ display: 'flex' }}
          >
            <WorkspaceArea
              className="workspace-main"
              item={workspaceItem}
              loadFile={webui.loadFile}
              loadDiff={webui.loadDiff}
              onClose={() => setWorkspaceItem(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <ChatArea
        className="main-chat"
        messages={webui.state?.messages ?? []}
        contextUsage={webui.state?.contextUsage}
        thinkingLevel={webui.state?.thinkingLevel}
        modelLabel={webui.state?.modelLabel}
        isIdle={webui.state?.isIdle ?? true}
        hasPendingMessages={webui.state?.hasPendingMessages ?? false}
        tasks={webui.state?.todos ?? []}
        jobs={webui.state?.jobs ?? []}
        onSendMessage={webui.sendMessage}
      />

      <AnimatePresence initial={false}>
        {!workspaceItem && (
          <motion.div
            key="sidebar-right"
            initial={{ width: 0, opacity: 0, marginLeft: 0, minWidth: 0, overflow: 'hidden' }}
            animate={{ width: 280, opacity: 1, marginLeft: 16, transitionEnd: { overflow: 'visible' } }}
            exit={{ width: 0, opacity: 0, marginLeft: 0 }}
            transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
            style={{ display: 'flex' }}
          >
            <SidebarRight
              className={cx('sidebar', 'right-sidebar', { 'mobile-open': mobileMenu === 'right' })}
              tasks={webui.state?.todos ?? []}
              jobs={webui.state?.jobs ?? []}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function useWebuiState() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get('token') ?? '', [])
  const [state, setState] = useState<WebuiState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const apiUrl = useCallback(
    (pathname: string, params: Record<string, string> = {}) => {
      const url = new URL(pathname, window.location.origin)
      if (token) url.searchParams.set('token', token)
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      return url.toString()
    },
    [token],
  )

  const requestJson = useCallback(
    async <T,>(pathname: string, init?: RequestInit, params?: Record<string, string>): Promise<T> => {
      const response = await fetch(apiUrl(pathname, params), init)
      if (!response.ok) {
        let apiError: ApiErrorResponse | undefined
        try {
          apiError = (await response.json()) as ApiErrorResponse
        } catch {
          apiError = undefined
        }
        throw new Error(apiError?.detail ?? apiError?.error ?? `HTTP ${response.status}`)
      }
      return (await response.json()) as T
    },
    [apiUrl],
  )

  const refresh = useCallback(async () => {
    const nextState = await requestJson<WebuiState>('/api/state')
    setState(nextState)
    setError(null)
  }, [requestJson])

  useEffect(() => {
    let ignore = false

    async function loadInitialState() {
      setLoading(true)
      try {
        const nextState = await requestJson<WebuiState>('/api/state')
        if (!ignore) {
          setState(nextState)
          setError(null)
        }
      } catch (loadError) {
        if (!ignore) setError(loadError instanceof Error ? loadError.message : String(loadError))
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    loadInitialState()

    const eventSource = new EventSource(apiUrl('/api/events'))
    eventSource.onmessage = event => {
      if (ignore) return
      try {
        setState(JSON.parse(event.data) as WebuiState)
        setError(null)
      } catch (parseError) {
        setError(parseError instanceof Error ? parseError.message : String(parseError))
      }
    }
    eventSource.onerror = () => {
      eventSource.close()
    }

    const interval = window.setInterval(() => {
      if (!ignore) void refresh().catch(refreshError => setError(refreshError instanceof Error ? refreshError.message : String(refreshError)))
    }, 5_000)

    return () => {
      ignore = true
      eventSource.close()
      window.clearInterval(interval)
    }
  }, [apiUrl, refresh, requestJson])

  const sendMessage = useCallback(
    async (text: string, images: SendMessageImage[] = []): Promise<SendMessageResponse> => {
      const response = await requestJson<SendMessageResponse>('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, images }),
      })
      await refresh()
      return response
    },
    [refresh, requestJson],
  )

  const loadTree = useCallback(
    (path: string) => requestJson<FileTreeResponse>('/api/tree', undefined, { path }),
    [requestJson],
  )

  const loadFile = useCallback(
    (path: string) => requestJson<FileContentResponse>('/api/file', undefined, { path }),
    [requestJson],
  )

  const loadDiff = useCallback(
    (path: string) => requestJson<DiffResponse>('/api/diff', undefined, { path }),
    [requestJson],
  )

  return { state, loading, error, refresh, sendMessage, loadTree, loadFile, loadDiff }
}

export default App
