import { useState } from 'react'
import { Folder, FolderOpen, FileCode, ChevronRight, ChevronDown, FileTerminal } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import cx from 'classnames'
import type { FileTreeNode, FileTreeResponse, ModifiedFile } from '../../shared/types'
import type { WorkspaceItem } from '../App'
import './SidebarLeft.css'

interface SidebarLeftProps {
  className?: string
  fileTree?: FileTreeResponse
  modifiedFiles: ModifiedFile[]
  onOpenWorkspace(item: WorkspaceItem): void
  loadTree(path: string): Promise<FileTreeResponse>
}

interface FileTreeItemProps {
  node: FileTreeNode
  depth: number
  expandedByPath: Record<string, boolean>
  childrenByPath: Record<string, FileTreeNode[]>
  loadingByPath: Record<string, boolean>
  errorByPath: Record<string, string>
  onFolderToggle(path: string): void
  onFileClick(node: FileTreeNode): void
}

function FileTreeItem({
  node,
  depth,
  expandedByPath,
  childrenByPath,
  loadingByPath,
  errorByPath,
  onFolderToggle,
  onFileClick,
}: FileTreeItemProps) {
  const isFolder = node.type === 'folder'
  const expanded = Boolean(expandedByPath[node.path])
  const children = childrenByPath[node.path] ?? node.children
  const loading = Boolean(loadingByPath[node.path])
  const error = errorByPath[node.path] || undefined

  return (
    <div className="tree-item-container">
      <div
        className={cx('tree-item', { 'is-folder': isFolder })}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => {
          if (isFolder) onFolderToggle(node.path)
          else onFileClick(node)
        }}
      >
        <span className="icon-wrapper">
          {isFolder ? expanded ? <FolderOpen size={16} /> : <Folder size={16} /> : <FileCode size={16} />}
        </span>
        <span className="file-name" title={node.path}>{node.name}</span>
        {isFolder && (
          <span className="folder-arrow">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        )}
      </div>

      {isFolder && (
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              style={{ overflow: 'hidden' }}
            >
              {loading && <div className="tree-status" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>Loading…</div>}
              {error && <div className="tree-status error" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>{error}</div>}
              {!loading && !error && (children?.length ?? 0) === 0 && (
                <div className="tree-status" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>Empty</div>
              )}
              {children?.map(child => (
                <FileTreeItem
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  expandedByPath={expandedByPath}
                  childrenByPath={childrenByPath}
                  loadingByPath={loadingByPath}
                  errorByPath={errorByPath}
                  onFolderToggle={onFolderToggle}
                  onFileClick={onFileClick}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  )
}

export default function SidebarLeft({ className, fileTree, modifiedFiles, onOpenWorkspace, loadTree }: SidebarLeftProps) {
  const [expandedByPath, setExpandedByPath] = useState<Record<string, boolean>>({})
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FileTreeNode[]>>({})
  const [loadingByPath, setLoadingByPath] = useState<Record<string, boolean>>({})
  const [errorByPath, setErrorByPath] = useState<Record<string, string>>({})

  const handleFolderToggle = (folderPath: string) => {
    const willOpen = !expandedByPath[folderPath]
    setExpandedByPath(prev => ({ ...prev, [folderPath]: willOpen }))
    if (!willOpen || childrenByPath[folderPath] || loadingByPath[folderPath]) return

    setLoadingByPath(prev => ({ ...prev, [folderPath]: true }))
    void loadTree(folderPath)
      .then(response => {
        setChildrenByPath(prev => ({ ...prev, [folderPath]: response.nodes }))
        setErrorByPath(prev => ({ ...prev, [folderPath]: '' }))
      })
      .catch(error => {
        setErrorByPath(prev => ({ ...prev, [folderPath]: error instanceof Error ? error.message : String(error) }))
      })
      .finally(() => {
        setLoadingByPath(prev => ({ ...prev, [folderPath]: false }))
      })
  }

  const handleFileClick = (node: FileTreeNode) => {
    onOpenWorkspace({ id: node.path, type: 'file', title: node.name, path: node.path })
  }

  const handleDiffClick = (info: ModifiedFile) => {
    onOpenWorkspace({ id: info.path, type: 'diff', title: info.path.split('/').pop() || info.path, path: info.path })
  }

  return (
    <div className={className}>
      <div className="sidebar-section panel">
        <div className="section-header">
          <FolderOpen size={18} /> 当前项目文件
        </div>
        <div className="section-content">
          {!fileTree && <div className="empty-state">No project tree loaded.</div>}
          {fileTree?.nodes.map(node => (
            <FileTreeItem
              key={node.path}
              node={node}
              depth={0}
              expandedByPath={expandedByPath}
              childrenByPath={childrenByPath}
              loadingByPath={loadingByPath}
              errorByPath={errorByPath}
              onFolderToggle={handleFolderToggle}
              onFileClick={handleFileClick}
            />
          ))}
          {fileTree?.truncated && <div className="tree-status">Tree truncated. Narrow the folder.</div>}
        </div>
      </div>

      <div className="sidebar-section panel half">
        <div className="section-header">
          <FileTerminal size={18} /> 修改的文件
        </div>
        <div className="section-content">
          {modifiedFiles.length === 0 && <div className="empty-state">No modified files.</div>}
          {modifiedFiles.map(info => (
            <div key={info.path} className="modified-item-container">
              <div className="modified-item" onClick={() => handleDiffClick(info)} title={`${info.status} ${info.path}`}>
                <FileCode size={16} />
                <span className="file-name">{info.path.split('/').pop()}</span>
                <div className="diff-stats">
                  {info.additions > 0 && <span className="diff-plus">+{info.additions}</span>}
                  {info.deletions > 0 && <span className="diff-minus">-{info.deletions}</span>}
                  {info.additions === 0 && info.deletions === 0 && <span>{info.status}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
