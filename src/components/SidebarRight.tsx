import type { WebuiJob, WebuiTask } from '../../shared/types'
import TaskTracker from './TaskTracker'

interface SidebarRightProps {
  className?: string
  tasks: WebuiTask[]
  jobs: WebuiJob[]
}

export default function SidebarRight({ className, tasks, jobs }: SidebarRightProps) {
  return (
    <div className={className}>
      <TaskTracker className="desktop-tracker" tasks={tasks} jobs={jobs} />
    </div>
  )
}
