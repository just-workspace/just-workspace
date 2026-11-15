/**
 * 통합 알림 센터 — Vue 판 composables/useNotifications.ts 그대로(모듈 싱글턴).
 * /api/notifications 의 안 읽은 수를 느리게(5분) 보정 폴링하고, 실시간은 채팅 소켓의 notification 이벤트(useChat)가 맡는다.
 * 목록·읽음 상태·브라우저 Notification API 를 관리한다.
 *
 * React: const { notifications, unreadCount, showDropdown, setShowDropdown, fetchNotifications, ... } = useNotifications()
 *   Vue 의 `showDropdown.value = x` 대입은 setShowDropdown(x)
 * 컴포넌트 밖: notificationsStore.getState() / fetchNotifications() 등 함수 import
 */
import { createStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { subscribePush } from '~/composables/usePwa'
import { useTrackedStore } from '~/composables/useTrackedStore'

/** 서버 알림 종류(backend app/notifications/service.py NOTIFICATION_TYPES) */
export type NotificationType =
  | 'mention' | 'thread_reply' | 'task_assigned' | 'meeting_invite' | 'calendar_invite'
  | 'file_shared' | 'new_mail' | 'board_must_read' | 'system'

/** 알림 행동 버튼(예: 회의 초대 수락/거절) — 서버가 같은 출처 경로만 준다 */
export interface NotificationAction {
  id: string
  label: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  body?: Record<string, unknown>
}

export interface AppNotification {
  id: string
  user_id: string
  type: NotificationType
  title: string
  body: string | null
  link: string | null
  is_read: boolean
  created_at: string
  /** 보낸 사람(예전 알림은 비어 있다) */
  actor_id?: string | null
  actor_name?: string | null
  /** 행을 누르면 갈 곳(없으면 link) */
  action_url?: string | null
  actions?: NotificationAction[] | null
}

/** 행동 URL 이 같은 출처 API 인지(서버도 거르지만 한 번 더) */
export function isSafeActionUrl(url: string | null | undefined): url is string {
  return !!url && url.startsWith('/api/') && !url.startsWith('//')
}
/** 행으로 이동할 앱 안 경로 — action_url 우선, 외부 주소는 버린다 */
export function notificationTarget(n: Pick<AppNotification, 'action_url' | 'link'>): string | null {
  for (const u of [n.action_url, n.link]) {
    if (u && u.startsWith('/') && !u.startsWith('//') && !u.startsWith('/api/')) return u
  }
  return null
}

/**
 * 알림 버튼 실행·새 알림 도착을 화면들이 듣는 창 이벤트.
 *  'jw:notification'        — detail: AppNotification(새로 도착)
 *  'jw:notification-action' — detail: { notification, action }(버튼 실행 성공)
 * 예: 회의 화면은 회의 초대 수락/거절을 듣고 목록을 다시 받는다.
 */
export const NOTIFICATION_EVENT = 'jw:notification'
export const NOTIFICATION_ACTION_EVENT = 'jw:notification-action'

export interface NotificationsState {
  notifications: AppNotification[]
  unreadCount: number
  totalCount: number
  showDropdown: boolean
  loading: boolean
  /** 활동 수신함이 지금 보고 있는 종류 필터(null = 전체) — 재접속 때 다시 읽어도 같은 필터로 */
  currentTypes: NotificationType[] | null
}

// Module-level singleton state
export const notificationsStore = createStore<NotificationsState>()(() => ({
  notifications: [],
  unreadCount: 0,
  totalCount: 0,
  showDropdown: false,
  loading: false,
  currentTypes: null,
}))
const S = () => notificationsStore.getState()
const set = (p: Partial<NotificationsState>) => notificationsStore.setState(p)

let lastLimit = 20
let _fetchSeq = 0

let _pollInterval: ReturnType<typeof setInterval> | null = null
let _pollActive = false

export const setShowDropdown = (v: boolean) => set({ showDropdown: v })

/** types 를 주면 그 종류만(서버 필터) — 주지 않으면 마지막으로 쓴 필터 그대로. 성공 여부를 돌려준다(던지지 않음). */
export async function fetchNotifications(unreadOnly = false, limit?: number, types?: NotificationType[] | null): Promise<boolean> {
  hookReadSync()
  if (types !== undefined) set({ currentTypes: types && types.length ? [...types] : null })
  if (limit) lastLimit = limit
  set({ loading: true })
  const seq = ++_fetchSeq
  try {
    const params: Record<string, unknown> = { unread_only: unreadOnly, limit: lastLimit }
    const cur = S().currentTypes
    if (cur) params.type = cur.join(',')
    const data = await $fetch<{ notifications: AppNotification[]; total: number }>('/api/notifications/', { params })
    if (seq !== _fetchSeq) return true // 필터를 그새 바꿨다 — 늦게 온 응답은 버린다
    set({ notifications: data.notifications, totalCount: data.total })
    // Also sync unread count
    await fetchUnreadCount()
    return true
  } catch (e: any) {
    console.error('fetchNotifications error:', e)
    return false
  } finally {
    if (seq === _fetchSeq) set({ loading: false })
  }
}

/** 종류별 안 읽은 수(칩 숫자) — 서버 total 만 쓰려고 1개씩 받는다 */
export async function fetchUnreadTotal(types: NotificationType[]): Promise<number> {
  const data = await $fetch<{ total: number }>('/api/notifications/', { params: { unread: true, limit: 1, type: types.join(',') } })
  return data.total || 0
}

/** background = 타이머가 스스로 부른 것 — 서버가 "사용자 활동"으로 세지 않게 표시한다(유휴 로그아웃이 폴링 때문에 안 걸리던 것) */
export async function fetchUnreadCount(background = false) {
  try {
    const data = await $fetch<{ count: number }>('/api/notifications/unread-count', background ? { headers: { 'X-Background': '1' } } : undefined)
    set({ unreadCount: data.count })
  } catch {
    // Silently fail for polling — user might be logged out
  }
}

export async function markAsRead(id: string) {
  try {
    await $fetch(`/api/notifications/${id}/read`, { method: 'PATCH' })
    const notif = S().notifications.find(n => n.id === id)
    if (notif && !notif.is_read) {
      set({
        notifications: S().notifications.map(n => (n.id === id ? { ...n, is_read: true } : n)),
        unreadCount: Math.max(0, S().unreadCount - 1),
      })
    }
  } catch (e: any) {
    console.error('markAsRead error:', e)
  }
}

export async function markAllAsRead() {
  try {
    await $fetch('/api/notifications/read-all', { method: 'POST' })
    set({ notifications: S().notifications.map(n => ({ ...n, is_read: true })), unreadCount: 0 })
  } catch (e: any) {
    console.error('markAllAsRead error:', e)
  }
}

export async function deleteNotification(id: string) {
  try {
    await $fetch(`/api/notifications/${id}`, { method: 'DELETE' })
    // 안 읽은 알림을 지우면 배지도 하나 줄인다
    const wasUnread = S().notifications.some(n => n.id === id && !n.is_read)
    set({
      notifications: S().notifications.filter(n => n.id !== id),
      totalCount: Math.max(0, S().totalCount - 1),
      ...(wasUnread ? { unreadCount: Math.max(0, S().unreadCount - 1) } : {}),
    })
  } catch (e: any) {
    console.error('deleteNotification error:', e)
  }
}

/**
 * 알림의 바로 실행 버튼(회의 초대 수락/거절 등). action 은 actions[] 항목 또는 그 id.
 * 같은 출처 /api/ 경로만 보낸다. 성공하면 읽음 처리하고 화면들에 알린다(회의 목록 갱신 등). 실패하면 throw.
 */
export async function runAction(
  notif: AppNotification | Readonly<AppNotification>,
  action: string | { id?: string; method: string; url: string; body?: unknown },
) {
  const a = typeof action === 'string' ? notif.actions?.find(x => x.id === action) : action
  if (!a) throw new Error('unknown action')
  if (!isSafeActionUrl(a.url)) throw new Error('invalid action url')
  const method = (a.method || 'POST').toUpperCase()
  await $fetch(a.url, {
    method: method as any,
    ...(method !== 'GET' && method !== 'DELETE' ? { body: (a.body ?? {}) as Record<string, unknown> } : {}),
  })
  if (!notif.is_read) await markAsRead(notif.id)
  window.dispatchEvent(new CustomEvent(NOTIFICATION_ACTION_EVENT, { detail: { notification: notif, action: a } }))
}

/** 이 주소(예: /api/meetings/by-id/<id>/rsvp)로 가는 버튼을 가진 안 읽은 알림을 읽음 처리 — 화면에서 직접 응답했을 때 */
export async function markActionDone(urlPart: string) {
  const targets = S().notifications.filter(n => !n.is_read && n.actions?.some(a => a.url.includes(urlPart)))
  for (const n of targets) await markAsRead(n.id)
}

/**
 * quiet = 서버가 "지금 방해 금지(지금 켜기·일정)" 라고 알려 준 알림 — 배지·목록은 그대로 올리고 브라우저 알림 팝업만 띄우지 않는다.
 * (예전에는 방해 금지를 켜도 탭이 열려 있으면 멘션마다 OS 알림이 떴다)
 */
export function handleNotificationEvent(notif: AppNotification, opts: { quiet?: boolean } = {}) {
  // 지금 보고 있는 필터에 맞을 때만 목록 맨 위에 넣는다(배지 수는 늘 늘린다)
  const cur = S().currentTypes
  if (!cur || cur.includes(notif.type)) {
    set({ notifications: [notif, ...S().notifications], totalCount: S().totalCount + 1 })
  }
  set({ unreadCount: S().unreadCount + 1 })
  window.dispatchEvent(new CustomEvent(NOTIFICATION_EVENT, { detail: notif }))

  // Browser Notification
  if (opts.quiet) return
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(notif.title, {
        body: notif.body || '',
        icon: '/favicon.ico',
        tag: notif.id,
      })
      n.onclick = () => {
        window.focus()
        const to = notificationTarget(notif)
        if (to) void navigateTo(to)
        n.close()
      }
    } catch {
      // Notification API not available
    }
  }
}

/** 이미 허락된 브라우저면 구독을 맞춰 둔다(구독은 같은 키면 기존 것을 돌려줘 멱등). */
export function ensurePushSubscription() {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  subscribePush().catch(() => { /* 지원 안 하는 환경 */ })
}

/** 사용자가 누른 버튼에서만 부른다(R-25). 허락되면 웹푸시 구독까지 — 창을 닫아도 멘션·DM 이 오게. */
export async function requestBrowserPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported'
  let perm = Notification.permission
  if (perm === 'default') perm = await Notification.requestPermission()
  if (perm === 'granted') ensurePushSubscription()
  return perm
}

/**
 * 다른 탭·기기에서 읽었다(서버 notification_read {unread}) — 배지를 맞추고, 다 읽었으면 목록도 읽음으로.
 * 하나만 읽은 경우 어느 것인지는 오지 않는다 — 목록은 다음에 열 때 다시 읽는다.
 */
export function handleNotificationRead(unread: unknown) {
  if (typeof unread !== 'number' || unread < 0 || unread === S().unreadCount) return
  set({
    unreadCount: unread,
    ...(unread === 0 && S().notifications.some(n => !n.is_read)
      ? { notifications: S().notifications.map(n => (n.is_read ? n : { ...n, is_read: true })) }
      : {}),
  })
}

let _readSyncHooked = false
/** 소켓의 notification_read 를 듣는다(useChat 이 이 파일을 import 하므로 여기서는 지연 import — 순환 방지) */
function hookReadSync() {
  if (_readSyncHooked) return
  _readSyncHooked = true
  void import('~/composables/useChat')
    .then(m => { m.onChatEvent((d: any) => { if (d?.type === 'notification_read') handleNotificationRead(d.unread) }) })
    .catch(() => { _readSyncHooked = false })
}

export function startPolling() {
  hookReadSync()
  if (_pollActive) return
  _pollActive = true
  // Initial fetch
  void fetchUnreadCount()
  // 실시간은 채팅 소켓의 notification 이벤트가 맡는다(layouts/default 가 연다).
  // 이건 소켓이 끊겼거나 이벤트를 놓쳤을 때를 위한 느린 보정이다. 재접속하면 useChat 이 바로 다시 읽는다.
  _pollInterval = setInterval(() => {
    void fetchUnreadCount(true)
  }, 5 * 60_000)
}

export function stopPolling() {
  _pollActive = false
  if (_pollInterval) {
    clearInterval(_pollInterval)
    _pollInterval = null
  }
}

export function useNotifications() {
  const { track } = useTrackedStore(notificationsStore)
  return {
    get notifications() { return track('notifications') },
    get unreadCount() { return track('unreadCount') },
    get totalCount() { return track('totalCount') },
    get showDropdown() { return track('showDropdown') },
    get loading() { return track('loading') },
    get currentTypes() { return track('currentTypes') },
    setShowDropdown,
    fetchNotifications,
    fetchUnreadTotal,
    fetchUnreadCount,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    handleNotificationEvent,
    runAction,
    markActionDone,
    requestBrowserPermission,
    ensurePushSubscription,
    startPolling,
    stopPolling,
  }
}
