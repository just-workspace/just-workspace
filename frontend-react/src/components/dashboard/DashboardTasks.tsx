/**
 * 내 작업: 한 줄 행 44 = 빈 원 아이콘 + 제목 + 마감(mono 11: 지남 n일 danger · 오늘 warning ·
 * 그 뒤 M/D muted) + 호버 [완료](check). 끝나지 않은 최상위 작업을 마감 순(없는 것은 뒤)으로, 행 수 = 상한.
 * 머리 개수 = 남은 작업 수, "작업 보기 ›".
 */
import { useEffect, useState } from 'react'
import { $fetch } from '~/lib/api'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { DashCard, DashRow, DashRows, DashRowsSkeleton, useCardStatus, useDash } from './DashCard'

interface Task { id: string; title: string; due_date: string | null; status: string; parent_id: string | null }

/** 마감 표기 */
export function taskDue(due: string | null, tr: (k: string, a?: Record<string, unknown>) => string): { text: string; cls: string } {
  if (!due) return { text: '', cls: 'text-muted-foreground' }
  const d = new Date(due); const today = new Date()
  d.setHours(0, 0, 0, 0); today.setHours(0, 0, 0, 0)
  const n = Math.round((d.getTime() - today.getTime()) / 86_400_000)
  if (n < 0) return { text: tr('dashboard.d17.tasks.overdue', { n: -n }), cls: 'text-danger' }
  if (n === 0) return { text: tr('common.today'), cls: 'text-warning' }
  return { text: `${d.getMonth() + 1}/${d.getDate()}`, cls: 'text-muted-foreground' }
}

/** 대시보드 내 작업 카드 */
export function DashboardTasks() {
  const { t: tr } = useI18n()
  const { maxRows } = useDash()
  const [tasks, setTasks] = useState<Task[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)

  async function load() {
    setLoading(true); setError(false)
    try {
      const d = await $fetch<{ tasks: Task[] }>('/api/tasks/', { params: { sort_by: 'due_date', sort_dir: 'asc', limit: 50 } })
      const open = (d.tasks || []).filter(t => t.status !== 'done' && !t.parent_id)
      // 마감 있는 것 먼저(가까운 순), 없는 것은 뒤로
      setTasks(open.sort((a, b) => (a.due_date ? 0 : 1) - (b.due_date ? 0 : 1) || (a.due_date ?? '').localeCompare(b.due_date ?? '')))
      setTotal(open.length)
    } catch { setError(true) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  useCardStatus('tasks', loading && !tasks.length ? 'loading' : error ? 'error' : tasks.length ? 'ready' : 'empty')

  async function complete(t: Task) {
    setToggling(t.id)
    try {
      await $fetch(`/api/tasks/${t.id}/toggle`, { method: 'POST' })
      await load()
    } catch { addToast('error', tr('dashboard.tasks.completeFailed')) }
    finally { setToggling(null) }
  }

  return (
    <DashCard cardKey="tasks" title={tr('dashboard.d17.tasks.title')} count={total} link={{ label: tr('dashboard.d17.tasks.link'), to: '/tasks' }}>
      {loading && !tasks.length ? <DashRowsSkeleton rows={3} twoLine={false} />
        : error ? <UiErrorTile placement="card" title={tr('dashboard.tasks.loadFailed')} className="m-3.5" onRetry={() => { void load() }} />
          : (
            <DashRows>
              {tasks.slice(0, maxRows).map((t) => {
                const d = taskDue(t.due_date, tr)
                return (
                  <DashRow
                    key={t.id}
                    icon="circle"
                    title={t.title}
                    time={d.text}
                    timeClass={d.cls}
                    to="/tasks"
                    iconAction={toggling === t.id ? undefined : { icon: 'check', label: tr('dashboard.tasks.completeItem', { title: t.title }), onClick: () => { void complete(t) } }}
                  />
                )
              })}
            </DashRows>
          )}
    </DashCard>
  )
}

export default DashboardTasks
