/**
 * 채널 탭 — 작업.
 *  칩 줄: 열린 작업 n · 나에게 배정 · 완료 n (단일 선택) — 오른쪽 [작업에서 전체 보기](ghost xs)
 *  빠른 입력(UiInput icon plus): "이 채널에 작업 추가 — 금요일 !높음 @도윤" — 작업 모듈 빠른 입력과 동일하게 해석(날짜·!우선순위·@담당).
 *    @담당은 이 채널 멤버에서 조회(조회 실패 시 담당 없이 생성 후 알림). @ 가 없으면 담당 없음(기존 채널 작업과 동일).
 *  목록 행 48(작업 모듈 열): 완료 체크 · 제목 · 상태 배지(tint 18) · 우선순위 · 마감 mono · 담당 아바타 24.
 *  완료 체크·제목 링크는 생성자·담당자에게만 제공(서버 can_open).
 * 서버: GET /api/chat/channels/{id}/tasks?filter=open|mine|done (counts = 칩 숫자)
 */
import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { addToast } from '~/composables/useToast'
import { useChat } from '~/composables/useChat'
import { createTask, fetchTaskList, type ChannelTaskCounts, type ChannelTaskFilter, type ChannelTaskItem } from '~/composables/useChannelTabs'
import { dueLabel, parseQuickTask, PRIORITY_META, resolveAssignee, STATUS_META, type TaskPriority, type TaskStatus } from '~/utils/taskQuick'
import { NuxtLink } from '~/components/NuxtLink'
import { UiChip } from '~/components/ui/Chip'
import { UiButton } from '~/components/ui/Button'
import { UiInput } from '~/components/ui/Input'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiBadge } from '~/components/ui/Badge'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'

export interface ChatChannelTasksTabProps {
  channelId: string
  /** 작업 생성 또는 완료 — 탭 숫자 갱신 */
  onChanged?: () => void
}

const GRID = { gridTemplateColumns: '36px 1fr 96px 80px 96px 36px' }

/** 채널 작업 탭 */
export function ChatChannelTasksTab({ channelId, onChanged }: ChatChannelTasksTabProps) {
  const { t } = useI18n()
  const chat = useChat()
  const [filter, setFilter] = useState<ChannelTaskFilter>('open')
  const [items, setItems] = useState<ChannelTaskItem[]>([])
  const [counts, setCounts] = useState<ChannelTaskCounts | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (f: ChannelTaskFilter) => {
    setLoading(true); setFailed(false)
    try {
      const r = await fetchTaskList(channelId, f)
      setItems(r.items); setCounts(r.counts)
    } catch { setFailed(true) } finally { setLoading(false) }
  }, [channelId])
  useEffect(() => { void load(filter) }, [load, filter])

  // ── 빠른 입력 ──
  const [text, setText] = useState('')
  const [creating, setCreating] = useState(false)
  async function add() {
    if (!text.trim() || creating) return
    const p = parseQuickTask(text)
    setCreating(true)
    try {
      let title = p.title
      let assigneeId: string | null = null
      let unresolved = ''
      if (p.assignee) {
        const pool = chat.members.map(m => ({ id: m.user_id, username: m.username, display_name: m.display_name }))
        const found = resolveAssignee(p.assignee, pool)
        if (found) assigneeId = found.id
        else { title = p.titleWithAssignee; unresolved = p.assignee }
      }
      if (!title) title = p.titleWithAssignee
      await createTask(channelId, title, { priority: p.priority ?? 'medium', due_date: p.due ?? null, assignee_id: assigneeId })
      setText('')
      addToast('success', t('chat.tabs.taskAdded'))
      if (unresolved) addToast('info', t('chat.tabs.assigneeNotFound', { name: unresolved }))
      await load(filter)
      onChanged?.()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('chat.tabs.taskCreateFailed'))
    } finally { setCreating(false) }
  }

  async function toggle(tk: ChannelTaskItem) {
    try {
      await $fetch(`/api/tasks/${encodeURIComponent(tk.id)}/toggle`, { method: 'POST' })
      await load(filter)
      onChanged?.()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('chat.tabs.toggleFailed'))
    }
  }

  const chips: { key: ChannelTaskFilter; label: string; count?: number }[] = [
    { key: 'open', label: t('chat.tabs.chipOpen'), count: counts?.open },
    { key: 'mine', label: t('chat.tabs.chipMine') },
    { key: 'done', label: t('chat.tabs.chipDone'), count: counts?.done },
  ]
  const emptyTitle = filter === 'mine' ? t('chat.tabs.noMineTasks') : filter === 'done' ? t('chat.tabs.noDoneTasks') : t('chat.tabs.noTasks')

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="flex flex-col gap-3" style={{ maxWidth: 960 }}>
        <div className="flex flex-wrap items-center gap-2">
          {chips.map(c => (
            <UiChip key={c.key} label={c.label} count={c.count} modelValue={filter === c.key} onUpdateModelValue={() => setFilter(c.key)} />
          ))}
          <span className="flex-1" />
          <UiButton variant="ghost" size="xs" onClick={() => { void navigateTo('/tasks') }}>{t('chat.tabs.openAllTasks')}</UiButton>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); void add() }}>
          <UiInput
            icon="plus"
            modelValue={text}
            onUpdateModelValue={setText}
            placeholder={t('chat.tabs.quickTaskPlaceholder')}
            aria-label={t('chat.tabs.newTask')}
            maxLength={500}
            disabled={creating}
          />
        </form>
        {loading && !items.length
          ? <UiSkeleton preset="list" rows={4} />
          : failed
            ? <UiErrorTile placement="panel" title={t('chat.tabs.listFailed')} onRetry={() => { void load(filter) }} />
            : !items.length
              ? <UiEmptyState variant="panel" icon="check-square" title={emptyTitle} description={filter === 'open' ? t('chat.tabs.noTasksHint') : undefined} />
              : (
                <div className="border-t border-border" aria-busy={loading || undefined}>
                  {items.map(tk => {
                    const done = tk.status === 'done'
                    const st = STATUS_META[tk.status as TaskStatus] ?? STATUS_META.todo
                    const pr = PRIORITY_META[tk.priority as TaskPriority] ?? PRIORITY_META.medium
                    const due = dueLabel({ due_date: tk.due_date, status: tk.status }, undefined, (k, p) => t(k, p ?? {}))
                    const who = tk.assignee_name || ''
                    return (
                      <div key={tk.id} className="grid h-12 items-center border-b border-border text-[13.5px]" style={GRID}>
                        <UiCheckbox
                          ariaLabel={done ? t('chat.tabs.markUndone') : t('chat.tabs.markDone')}
                          modelValue={done}
                          disabled={!tk.can_open}
                          onUpdateModelValue={() => { void toggle(tk) }}
                        />
                        {tk.can_open
                          ? <NuxtLink to={{ path: '/tasks', query: { task: tk.id } }} className="truncate font-medium hover:underline">{tk.title}</NuxtLink>
                          : <span className="truncate font-medium">{tk.title}</span>}
                        <span><UiBadge tone={st.tone} tint size={18}>{t(st.labelKey)}</UiBadge></span>
                        <span className="text-xs font-semibold">{pr.arrow} {t(pr.labelKey)}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{due?.text || '—'}</span>
                        {who ? <UiAvatar fallback={who.slice(0, 1)} textSize={10} className="h-6 w-6" title={who} /> : <span />}
                      </div>
                    )
                  })}
                </div>
              )}
      </div>
    </div>
  )
}

export default ChatChannelTasksTab
