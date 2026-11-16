/**
 * 나에게 온 것(기본 2칸 · 주 줄): 범위 [우선|전체], 행 56 = 아바타 28(발신자 첫 글자) +
 * 제목(안 읽음 semibold) · 맥락(종류 · 발신자) + 시각 + 호버 [읽음]. 헤더 "활동 보기 ›"(데스크톱 활동 패널, 모바일 /activity).
 * 우선 = 본인에게 직접 온 요청(멘션·스레드 답글·작업 배정·회의/일정 초대 — 백엔드 PRIORITY_TYPES 와 동일), 전체 = 모든 알림.
 * 개수 = 해당 범위의 안 읽은 수. 행 수 = 실효 높이 상한. 비어 있으면 제자리 한 행(주 줄 카드).
 */
import { useCallback, useEffect, useState } from 'react'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { useI18n } from '~/i18n'
import { openActivity } from '~/composables/useShell'
import { isMobileNow } from '~/composables/useIsMobile'
import { markAsRead, notificationTarget, useNotifications, type AppNotification, type NotificationType } from '~/composables/useNotifications'
import { useDashSummary } from '~/composables/useDashSummary'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { DashCard, DashRow, DashRows, DashRowsSkeleton, DashInlineEmpty, shortTime, useCardStatus, useDash } from './DashCard'

export const PRIORITY_TYPES: NotificationType[] = ['mention', 'thread_reply', 'task_assigned', 'meeting_invite', 'calendar_invite']

// 종류별 맥락 이름(i18n 키)
const TYPE_CTX: Partial<Record<NotificationType, string>> = {
  mention: 'notifications.types.mention', task_assigned: 'dashboard.inbox.ctxTaskAssigned', file_shared: 'dashboard.inbox.ctxFileShared', calendar_invite: 'dashboard.inbox.ctxCalendarInvite', system: 'notifications.types.system',
  thread_reply: 'dashboard.inbox.ctxThreadReply', meeting_invite: 'dashboard.inbox.ctxMeetingInvite', new_mail: 'dashboard.inbox.ctxNewMail', board_must_read: 'dashboard.inbox.ctxBoardMustRead',
}

type Scope = 'priority' | 'all'

/** 대시보드 "나에게 온 것" 카드 */
export function DashboardInbox() {
  const { t } = useI18n()
  const { maxRows } = useDash()
  const { summary } = useDashSummary()
  const { unreadCount } = useNotifications()
  const [scope, setScope] = useState<Scope>('priority')
  const [items, setItems] = useState<AppNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async (s: Scope) => {
    setLoading(true); setError(false)
    try {
      const params: Record<string, unknown> = { limit: maxRows }
      if (s === 'priority') params.type = PRIORITY_TYPES.join(',')
      const d = await $fetch<{ notifications: AppNotification[] }>('/api/notifications/', { params })
      setItems(d.notifications || [])
    } catch { setError(true) } finally { setLoading(false) }
  }, [maxRows])
  useEffect(() => { void load(scope) }, [load, scope])
  useCardStatus('inbox', loading && !items.length ? 'loading' : error ? 'error' : items.length ? 'ready' : 'empty')

  function ctx(n: AppNotification) {
    const key = TYPE_CTX[n.type]
    return [key ? t(key) : '', n.actor_name || ''].filter(Boolean).join(' · ')
  }
  async function read(n: AppNotification) {
    await markAsRead(n.id)
    setItems(list => list.map(x => (x.id === n.id ? { ...x, is_read: true } : x)))
  }
  async function open(n: AppNotification) {
    if (!n.is_read) await read(n)
    const to = notificationTarget(n)
    if (to) void navigateTo(to)
    else if (isMobileNow()) void navigateTo('/activity')
    else openActivity()
  }
  function all() { if (isMobileNow()) void navigateTo('/activity'); else openActivity() }

  const count = scope === 'priority' ? summary?.mentions_unread : unreadCount
  return (
    <DashCard
      cardKey="inbox"
      title={t('dashboard.inbox.title')}
      count={count}
      scope={{ label: t('dashboard.d17.scope'), value: scope, onChange: v => setScope(v === 'all' ? 'all' : 'priority'), items: [
        { value: 'priority', label: t('dashboard.d17.inbox.priority') }, { value: 'all', label: t('dashboard.d17.inbox.all') },
      ] }}
      link={{ label: t('dashboard.d17.inbox.link'), onClick: all }}
    >
      {loading && !items.length ? <DashRowsSkeleton rows={Math.min(4, maxRows)} />
        : error ? <UiErrorTile placement="card" title={t('shell.activity.loadFailed')} className="m-3.5" onRetry={() => { void load(scope) }} />
          : !items.length ? <DashInlineEmpty icon="inbox" text={t('dashboard.inbox.empty')} />
            : (
              <DashRows busy={loading}>
                {items.slice(0, maxRows).map(n => (
                  <DashRow
                    key={n.id}
                    avatar={((n.actor_name || n.title || '?').trim().charAt(0) || '?').toUpperCase()}
                    title={n.title}
                    titleClass={n.is_read ? undefined : 'font-semibold'}
                    srPrefix={n.is_read ? undefined : t('dashboard.unreadSr')}
                    meta={ctx(n) || ' '}
                    time={shortTime(n.created_at, t('common.yesterday'))}
                    onOpen={() => { void open(n) }}
                    action={n.is_read ? undefined : { label: t('dashboard.d17.inbox.read'), onClick: () => { void read(n) } }}
                  />
                ))}
              </DashRows>
            )}
    </DashCard>
  )
}

export default DashboardInbox
