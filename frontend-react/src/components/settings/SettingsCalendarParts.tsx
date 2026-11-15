/**
 * 설정 › 캘린더 조각:
 *  · SettingsSubscriptionRow — 외부 캘린더 구독 한 줄(min 56): 범주 색 점 10 · 이름 600 + .ics 주소(11 mono, 한 줄) ·
 *    "받음 HH:MM"(mono) 또는 danger 틴트 배지 "받지 못함 · 404" · UiMenu[지금 새로 고침 · 색 바꾸기(하위 메뉴) · 공유 · ─ · 구독 해제].
 *  · subscriptionMenuItems — 구독 ⋮ 메뉴 한 벌. 설정 › 캘린더와 캘린더 사이드바가 같이 쓴다(두 곳 통일, "삭제" 대신 "구독 해제").
 *  · [+ 구독 추가] 모달은 캘린더와 같이 쓰는 components/calendar/CalendarSubscribeModal.
 *  · subscriptionReason — 서버 실패 이유(HTTP 상태 숫자 또는 이름) → 배지 글자.
 *  · refreshSubscriptionNow — "지금 새로 고침" 한 번(토스트 포함). 캘린더 사이드바 구독 행 ⋮ 도 같이 쓴다.
 */
import { useI18n } from '~/i18n'
import { $fetch, errorStatus } from '~/lib/api'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { fetchCalendars } from '~/composables/useCalendar'
import { catColor, catNameKey, catOf, CAT_HEX } from '~/utils/categoryColor'
import { UiBadge } from '~/components/ui/Badge'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'

/** GET /api/calendar/subscriptions 한 줄 */
export interface CalendarSubscription {
  id: string
  name: string
  color: string | null
  url: string
  fetched_at: string | null
  checked_at: string | null
  /** 마지막 실패 이유 — "404" 같은 HTTP 상태 또는 timeout·too_large·not_ics·blocked·dns·network */
  error: string | null
  is_visible?: boolean
}

type T = (k: string, v?: Record<string, unknown>) => string

/** 실패 이유 → 짧은 글자. 숫자(HTTP 상태)는 그대로 */
export function subscriptionReason(t: T, code: string | null | undefined): string {
  if (!code) return ''
  if (/^\d{3}$/.test(code)) return code
  const k = `settings.calendarPrefs.reason.${code}`
  const s = t(k)
  return s === k ? code : s
}

/**
 * 구독 "지금 새로 고침" — POST /api/calendar/subscriptions/{id}/refresh + 결과 토스트 + 캘린더 다시 읽기.
 * 1분 안에 다시 누르면 서버가 429 → "받지 못했습니다 · 1분 뒤 다시"(메뉴는 비활성으로 두지 않는다).
 * @returns 새 구독 줄(실패면 null)
 */
export async function refreshSubscriptionNow(t: T, sub: { id: string; name: string }): Promise<CalendarSubscription | null> {
  try {
    const row = await $fetch<CalendarSubscription>(`/api/calendar/subscriptions/${sub.id}/refresh`, { method: 'POST' })
    if (row.error) addToast('error', t('settings.calendarPrefs.refreshFailed', { name: row.name, reason: subscriptionReason(t, row.error) }))
    else addToast('success', t('settings.calendarPrefs.refreshed', { name: row.name }))
    void fetchCalendars()
    return row
  } catch (e) {
    // 429 = 서버의 1분 최소 간격(남용 방지) — 기존 일정·상태는 그대로
    const reason = errorStatus(e) === 429 ? 'too_soon' : 'network'
    addToast('error', t('settings.calendarPrefs.refreshFailed', { name: sub.name, reason: subscriptionReason(t, reason) }))
    return null
  }
}

/** 받은 시각 — 오늘이면 HH:MM, 아니면 MM/DD HH:MM */
export function fetchedTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z')
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return same ? hm : `${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}`
}

/**
 * 구독 ⋮ 메뉴 — 지금 새로 고침 · 색 바꾸기(범주 1…8 하위 메뉴) · 공유 · (구분선) 구독 해제(danger).
 * 키: refresh · color:N · share · remove
 */
export function subscriptionMenuItems(t: T, sub: { color: string | null }, busy = false): UiMenuItem[] {
  const cur = catOf(sub.color)
  return [
    { key: 'refresh', label: t('settings.calendarPrefs.refresh'), icon: 'refresh', disabled: busy },
    {
      key: 'color', label: t('settings.calendarPrefs.color'), icon: 'edit',
      children: CAT_HEX.map((_hex, i) => ({ key: `color:${i + 1}`, label: t(catNameKey(i + 1)), radio: true, checked: cur === i + 1 })),
    },
    { key: 'share', label: t('calendar.sidebar.shareTitle'), icon: 'share' },
    { key: 'remove', label: t('settings.calendarPrefs.remove'), icon: 'trash', danger: true, separated: true },
  ]
}

/** 메뉴 키 color:N → 범주 색(hex). 범위 밖이면 null */
export function subscriptionColorOf(key: string): string | null {
  if (!key.startsWith('color:')) return null
  const n = Number(key.slice(6))
  return n >= 1 && n <= CAT_HEX.length ? CAT_HEX[n - 1] : null
}

/** 구독 해제 확인(두 곳 같은 문구) */
export function confirmUnsubscribe(t: T, name: string): Promise<boolean> {
  return confirmBox(t('settings.calendarPrefs.removeBody'), { title: t('settings.calendarPrefs.removeTitle', { name }), confirmLabel: t('settings.calendarPrefs.remove'), danger: true })
}

export interface SettingsSubscriptionRowProps {
  /** 구독 한 줄 */
  sub: CalendarSubscription
  /** 진행 중(새로 받는 중 등) — 메뉴 비활성 */
  busy?: boolean
  /** 메뉴: refresh · color:N(범주 1…8) · share · remove */
  onAction: (key: string) => void
}

export function SettingsSubscriptionRow({ sub, busy = false, onAction }: SettingsSubscriptionRowProps) {
  const { t } = useI18n()
  const items = subscriptionMenuItems(t, sub, busy)
  return (
    <div className="flex min-h-14 items-center gap-3 border-b border-border px-5 py-2 text-[13px] last:border-b-0">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: catColor(sub.color) }} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{sub.name}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={sub.url}>{sub.url}</div>
      </div>
      {sub.error
        ? <UiBadge tone="danger" tint size={18}>{t('settings.calendarPrefs.failed', { reason: subscriptionReason(t, sub.error) })}</UiBadge>
        : sub.fetched_at
          ? <span className="shrink-0 text-xs text-muted-foreground">{t('settings.calendarPrefs.fetched')} <span className="font-mono">{fetchedTime(sub.fetched_at)}</span></span>
          : <span className="shrink-0 text-xs text-muted-foreground">{t('settings.calendarPrefs.never')}</span>}
      <UiMenu label={t('settings.calendarPrefs.menu', { name: sub.name })} items={items} onSelect={onAction} />
    </div>
  )
}
