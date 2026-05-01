import { useState } from 'react'
import { CheckCircle2, Circle, Terminal, Loader2, X, ChevronRight, AlertCircle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import cx from 'classnames'
import type { WebuiJob, WebuiTask } from '../../shared/types'
import './TaskTracker.css'

interface TaskTrackerProps {
  className?: string
  tasks: WebuiTask[]
  jobs: WebuiJob[]
}

function JobDetailBubble({ job, onClose }: { job: WebuiJob; onClose: () => void }) {
  return (
    <>
      <div className="job-bubble-backdrop" onClick={onClose} />
      <motion.div
        className="job-detail-panel"
        onClick={event => event.stopPropagation()}
        initial={{ opacity: 0, y: 10, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.95 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      >
        <div className="job-bubble-tail" />
        <div className="job-header">
          <div className="job-header-title">
            {job.status === 'running' ? <Loader2 size={16} className="job-icon spin" /> : job.status === 'error' ? <AlertCircle size={16} className="job-icon error" /> : <Terminal size={16} className="job-icon done" />}
            <span>{job.title}</span>
          </div>
          <button className="icon-btn close-btn" onClick={onClose} aria-label="Close job details">
            <X size={16} />
          </button>
        </div>
        <div className="job-body">
          <div className="job-logs">
            {job.logs.length === 0 && <div className="log-line">No logs captured.</div>}
            {job.logs.map((log, index) => (
              <div key={`${job.id}:${index}`} className="log-line">
                <ChevronRight size={12} className="log-arrow" /> {log}
              </div>
            ))}
            {job.status === 'running' && <div className="log-line blinking-cursor">_</div>}
          </div>
        </div>
      </motion.div>
    </>
  )
}

export default function TaskTracker({ className, tasks, jobs }: TaskTrackerProps) {
  const [selectedJob, setSelectedJob] = useState<WebuiJob | null>(null)

  return (
    <div className={cx('task-tracker-container', className)}>
      <div className="task-section panel todos-section">
        <div className="section-title">任务清单</div>
        <div className="task-list">
          {tasks.length === 0 && <div className="empty-state compact">No active todos.</div>}
          {tasks.map(task => (
            <div key={task.id} className={cx('task-item', task.status)} title={task.phase}>
              {task.status === 'completed' ? <CheckCircle2 size={14} className="task-icon done" /> : <Circle size={14} className="task-icon pending" />}
              <span className="task-title">{task.title}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="task-section panel jobs-section">
        <div className="section-title">子 Agent</div>
        <div className="task-list">
          {jobs.length === 0 && <div className="empty-state compact">No running subagents.</div>}
          {jobs.map(job => (
            <div key={job.id} className="job-item clickable relative-container" onClick={() => setSelectedJob(job)}>
              {job.status === 'running' ? (
                <Loader2 size={14} className="job-icon spin" />
              ) : job.status === 'error' ? (
                <AlertCircle size={14} className="job-icon error" />
              ) : (
                <Terminal size={14} className="job-icon done" />
              )}
              <span className="job-title" title={job.title}>{job.title}</span>
              <AnimatePresence>
                {selectedJob?.id === job.id && <JobDetailBubble job={selectedJob} onClose={() => setSelectedJob(null)} />}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
