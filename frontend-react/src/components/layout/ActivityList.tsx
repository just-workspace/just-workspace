/**
 * 활동 수신함 목록(Vue components/layout/ActivityList.vue):
 * 필터 칩 + 날짜 그룹 + 행(아바타 32/40 + 종류 아이콘 배지, 안 읽음 = 굵게, 읽음 = muted).
 * 데스크톱 패널(400)과 모바일 /activity 페이지가 같은 목록을 쓴다.
 *
 * - 칩 = 서버 필터(GET /api/notifications?type=a,b). 칩 숫자는 종류별 안 읽은 수(서버 total).
 * - 아바타 = 보낸 사람(actor_name) 첫 글자, 없으면 제목 첫 글자(예전 알림).
 * - 행동 버튼(actions: 회의 초대 수락/거절 등)은 맥락 줄에 텍스트 버튼으로 — 누르면 그 API 를 부르고 읽음 처리.
 *   서버가 "이미 응답했는지"를 알림에 남기지 않아, 이번 화면에서 누른 것만 "완료"로 바뀐다.
 * - 행을 누르면 action_url(없으면 link)로 이동.
 *
 * Vue defineExpose({ markAllAsRead, reload }) → ref 로 같은 두 함수(ActivityListHandle).
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { addToast } from '~/composables/useToast'
import {
  useNotifications, notificationTarget,
  type AppNotification, type NotificationAction, type NotificationType,
} from '~/composables/useNotifications'
import { UiChip } from '~/components/ui/Chip'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'

export interface ActivityListHandle {
  markAllAsRead: () => unknown
  reload: () => Promise<void>
}

export interface LayoutActivityListProps {
  /** 모바일 페이지면 칩 36·아바타 40·글자 14 */
  mobile?: boolean
  /** 행을 눌러 이동할 때(패널을 닫는 데 쓴다) */
  onNavigate?: () => void
  ref?: Ref<ActivityListHandle | null>
}

type Filter = 'all' | 'mention' | 'thread' | 'task_assigned' | 'share' | 'system'
// labelKey = i18n 키(렌더에서 t — 로캘 전환에 반응)
const CHIPS: { key: Filter; labelKey: string; types: NotificationType[] | null }[] = [
  { key: 'all', labelKey: 'common.all', types: null },
  { key: 'mention', labelKey: 'notifications.types.mention', types: ['mention'] },
  { key: 'thread', labelKey: 'shell.activity.filterThread', types: ['thread_reply'] },
  { key: 'task_assigned', labelKey: 'shell.activity.filterAssigned', types: ['task_assigned'] },
  { key: 'share', labelKey: 'shell.activity.filterShare', types: ['meeting_invite', 'calendar_invite', 'file_shared'] },
  { key: 'system', labelKey: 'notifications.types.system', types: ['system'] },
]
const TYPE_ICON: Partial<Record<NotificationType, string>> = {
  mention: 'at-sign', thread_reply: 'threads', task_assigned: 'check-square', meeting_invite: 'video', calendar_invite: 'calendar',
  file_shared: 'folder', new_mail: 'mail', board_must_read: 'clipboard-list', system: 'info',
}
// 종류별 맥락 이름(i18n 키)
const TYPE_CTX: Partial<Record<NotificationType, string>> = {
  mention: 'nav.chat', thread_reply: 'shell.activity.ctxThread', task_assigned: 'shell.activity.ctxTask', meeting_invite: 'shell.activity.ctxMeeting',
  file_shared: 'nav.files', calendar_invite: 'nav.calendar', new_mail: 'shell.activity.ctxMail', board_must_read: 'shell.activity.ctxBoard',
  system: 'notifications.types.system',
}
// 서버 라벨은 한국어 고정이라 아는 id 는 로캘 문구로
const ACTION_KEY: Record<string, string> = { accept: 'shell.activity.actionAccept', decline: 'shell.activity.actionDecline', tentative: 'shell.activity.actionTentative' }

type Row = AppNotification

// 날짜 그룹: 오늘 / 어제 / 이전 — 값은 i18n 키
function groupKey(iso: string) {
  const d = new Date(iso), now = new Date()
  const day = (x: Date) => Math.floor((x.getTime() - x.getTimezoneOffset() * 60000) / 86400000)
  const diff = day(now) - day(d)
  return diff <= 0 ? 'common.today' : diff === 1 ? 'common.yesterday' : 'shell.activity.earlier'
}

function fmtTime(iso: string) {
  const d = new Date(iso), now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${d.getMonth() + 1}/${d.getDate()}`
}
function initial(n: Row) {
  return ((n.actor_name || n.title || '?').trim().charAt(0) || '?').toUpperCase()
}

export function LayoutActivityList({ mobile = false, onNavigate, ref }: LayoutActivityListProps) {
  const { notifications, loading, fetchNotifications, fetchUnreadTotal, markAsRead, markAllAsRead, unreadCount, runAction } = useNotifications()
  const { t } = useI18n()

  const [filter, setFilter] = useState<Filter>('all')
  // 서버가 거른 목록 + 실시간으로 끼어든 다른 종류는 한 번 더 거른다
  const filtered = useMemo(() => {
    const c = CHIPS.find(x => x.key === filter)!
    return c.types ? notifications.filter((n: Row) => c.types!.includes(n.type)) : notifications
  }, [notifications, filter]) as readonly Row[]

  // 칩 숫자(종류별 안 읽음) — 서버 total. 전체는 배지 수.
  const [chipCounts, setChipCounts] = useState<Partial<Record<Filter, number>>>({})
  const loadCounts = useCallback(async () => {
    const res = await Promise.allSettled(CHIPS.filter(c => c.types).map(async c => [c.key, await fetchUnreadTotal(c.types!)] as const))
    const next: Partial<Record<Filter, number>> = {}
    for (const r of res) if (r.status === 'fulfilled') next[r.value[0]] = r.value[1] as number
    setChipCounts(next)
  }, [fetchUnreadTotal])
  const countFor = (c: typeof CHIPS[number]) => (c.types ? chipCounts[c.key] ?? 0 : unreadCount)

  // 안 읽은 수가 바뀌면(새 알림·읽음) 칩 숫자도 다시 — 연달아 바뀌면 한 번만
  const countTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstCount = useRef(true)
  useEffect(() => {
    if (firstCount.current) { firstCount.current = false; return }
    if (countTimer.current) clearTimeout(countTimer.current)
    countTimer.current = setTimeout(() => { countTimer.current = null; void loadCounts() }, 400)
  }, [unreadCount, loadCounts])
  useEffect(() => () => { if (countTimer.current) clearTimeout(countTimer.current) }, [])

  const groups = useMemo(() => {
    const out: { key: string; items: Row[] }[] = []
    for (const n of filtered) {
      const k = groupKey(n.created_at)
      const g = out.find(x => x.key === k)
      if (g) g.items.push(n)
      else out.push({ key: k, items: [n] })
    }
    return out
  }, [filtered])

  async function open(n: Row) {
    if (!n.is_read) await markAsRead(n.id)
    const to = notificationTarget(n)
    onNavigate?.()
    if (to) void navigateTo(to)
  }

  // ── 행동 버튼 ──
  const actionLabel = (a: Pick<NotificationAction, 'id' | 'label'>) => (ACTION_KEY[a.id] ? t(ACTION_KEY[a.id]) : a.label)
  const [acting, setActing] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, string>>({}) // 알림 id → 누른 행동 라벨
  async function act(n: Row, a: NotificationAction) {
    setActing(n.id)
    try {
      await runAction(n, a)
      setDone(d => ({ ...d, [n.id]: actionLabel(a) }))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('shell.activity.actionFailed'))
    } finally { setActing(null) }
  }

  const [error, setError] = useState(false)
  const filterRef = useRef(filter)
  filterRef.current = filter
  const load = useCallback(async () => {
    setError(false)
    const types = CHIPS.find(x => x.key === filterRef.current)!.types
    const ok = await fetchNotifications(false, 50, types)
    if (!ok) setError(true)
    void loadCounts()
  }, [fetchNotifications, loadCounts])
  // onMounted(load) + watch(filter, load)
  useEffect(() => { void load() }, [filter]) // eslint-disable-line react-hooks/exhaustive-deps
  // 닫힐 때 필터를 풀어 둔다 — 다른 곳(재접속 보정 등)이 다시 읽어도 전체가 오게
  useEffect(() => () => { if (filterRef.current !== 'all') void fetchNotifications(false, undefined, null) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useImperativeHandle(ref, () => ({ markAllAsRead, reload: load }), [markAllAsRead, load])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 필터 칩 */}
      <div className={cn('flex shrink-0 gap-1.5 overflow-x-auto whitespace-nowrap border-b border-border px-4 py-2.5 scrollbar-none', mobile ? 'border-b-0' : '')}>
        {CHIPS.map(c => (
          <UiChip
            key={c.key}
            label={t(c.labelKey)}
            count={countFor(c) || undefined}
            modelValue={filter === c.key}
            size={mobile ? 'lg' : 'sm'}
            // 데스크톱은 떠 있는 활동 패널(card + 그림자) 위
            surface={mobile ? 'page' : 'raised'}
            onClick={() => setFilter(c.key)}
          />
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !notifications.length ? (
          <UiSkeleton preset="list" rows={5} />
        ) : error ? (
          <UiErrorTile placement="panel" title={t('shell.activity.loadFailed')} onRetry={load} />
        ) : !filtered.length ? (
          <UiEmptyState
            variant="panel"
            icon="bell"
            title={filter === 'all' ? t('shell.activity.empty') : t('shell.activity.emptyFiltered')}
            description={t('shell.activity.emptyDesc')}
          />
        ) : (
          groups.map(g => (
            <section key={g.key}>
              <div className="px-4 pb-1 pt-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t(g.key)}</div>
              {g.items.map(n => (
                <div key={n.id} className="border-b border-border">
                  <button
                    type="button"
                    className="flex w-full gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))]"
                    onClick={() => open(n)}
                  >
                    {/* 아바타(보낸 사람) + 종류 아이콘 배지 */}
                    <span className={cn('relative grid shrink-0 place-items-center rounded-full bg-muted font-semibold', mobile ? 'h-10 w-10 text-sm' : 'h-8 w-8 text-xs')} title={n.actor_name || undefined}>
                      {initial(n)}
                      <span className="absolute -bottom-1 -right-1 grid h-[18px] w-[18px] place-items-center rounded-[6px] bg-card text-muted-foreground shadow-[0_0_0_1px_hsl(var(--border))]">
                        <UiIcon name={TYPE_ICON[n.type] || 'info'} className="h-[11px] w-[11px]" strokeWidth={2.2} />
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className={cn('min-w-0 flex-1 truncate', mobile ? 'text-sm' : 'text-[13px]', n.is_read ? 'text-muted-foreground' : 'font-bold text-foreground')}>{n.title}</span>
                        <span className={cn('shrink-0 font-mono text-[11px]', n.is_read ? 'text-muted-foreground' : 'font-semibold text-foreground')}>{fmtTime(n.created_at)}</span>
                      </span>
                      {n.body && <span className={cn('mt-0.5 block truncate leading-[1.45] text-foreground', mobile ? 'text-sm' : 'text-[13px]')}>{n.body}</span>}
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{TYPE_CTX[n.type] ? t(TYPE_CTX[n.type]!) : n.type}{n.actor_name && <span> · {n.actor_name}</span>}</span>
                    </span>
                  </button>
                  {/* 행동(회의 초대 수락/거절 등) — 맥락 줄 아래 텍스트 버튼, 히트 40 */}
                  {!!n.actions?.length && (
                    <div className={cn('-mt-1.5 flex items-center gap-4 pb-2 pr-4 text-xs', mobile ? 'pl-[68px]' : 'pl-[60px]')}>
                      {done[n.id] ? (
                        <span className="inline-flex items-center gap-1 font-semibold text-success" role="status">
                          <UiIcon name="check" className="h-3 w-3" strokeWidth={3} />{t('shell.activity.actionDone', { label: done[n.id] })}
                        </span>
                      ) : (
                        n.actions.map((a, i) => (
                          <button
                            key={a.id}
                            type="button"
                            className={cn("relative font-semibold hover:underline after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] disabled:opacity-50", i === 0 ? 'text-primary' : 'text-muted-foreground hover:text-foreground')}
                            disabled={acting === n.id}
                            onClick={() => act(n, a)}
                          >{actionLabel(a)}</button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  )
}

export default LayoutActivityList
