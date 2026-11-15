/**
 * 내 로그인 기기(세션).
 * 설정 › 보안 "내 세션" 표와 설정 › 계정 "로그인된 기기" 카드가 같이 쓴다.
 * GET /api/auth/me/sessions · DELETE …/{id} · POST …/revoke-others. 본인 세션만 다룬다(서버가 호출자로 묶음).
 * 끊은 세션이 지금 이 기기였으면(was_current) 로컬도 정리하고 로그인 화면으로.
 *
 * 싱글턴이 아니다 — 컴포넌트 지역 상태 hook.
 * 이름·시각 꾸미기는 순수 함수(sessionBaseName 등)로도 내보낸다(테스트용).
 */
import { useCallback, useMemo, useState } from 'react'
import { useI18n, type I18nApi } from '~/i18n'
import { $fetch, errorStatus } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { setUser } from '~/composables/useAuth'
import { cleanupChat } from '~/composables/useChat'
import { confirmBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'

export interface MySession {
  id: string
  current: boolean
  device: string
  browser: string | null
  os: string | null
  device_type: 'desktop' | 'mobile' | 'tablet' | 'unknown'
  app: string | null
  ip: string
  hostname: string
  created_at: string | null
  last_seen_at: string | null
}

type T = I18nApi['t']

/** 기기 이름 — "Chrome on macOS" · "데스크톱 앱 · Windows" */
export function sessionBaseName(t: T, s: MySession): string {
  if (s.app === 'desktop') return s.os ? t('settings.devices.desktopAppOs', { os: s.os }) : t('settings.devices.desktopApp')
  const browser = s.browser || t('settings.account.browserFallback')
  return s.os ? `${browser} on ${s.os}` : browser
}

/** 표시 이름 — 지금 이 기기(웹)면 "이 기기 (…)" */
export function sessionName(t: T, s: MySession): string {
  const base = sessionBaseName(t, s)
  return s.current && s.app !== 'desktop' ? t('settings.devices.thisDevice', { name: base }) : base
}

/** 앱 종류 줄 — 웹 · 모바일 웹 · 데스크톱 앱 */
export function sessionKind(t: T, s: MySession): string {
  if (s.app === 'desktop') return t('settings.sessions.kindDesktop')
  if (s.device_type === 'mobile' || s.device_type === 'tablet') return t('settings.sessions.kindMobileWeb')
  return t('settings.sessions.kindWeb')
}

/** 기기 아이콘 이름 */
export function sessionIcon(s: MySession): string {
  return s.device_type === 'mobile' || s.device_type === 'tablet' ? 'smartphone' : 'monitor'
}

/** 마지막 활동 — 5분 안 "지금 활동 중", n분 전, n시간 전, 어제, MM.DD */
export function sessionWhen(t: T, locale: string, iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const d = new Date(iso)
  const mins = Math.floor((now - d.getTime()) / 60000)
  if (mins < 5) return t('settings.account.activeNow')
  if (mins < 60) return t('settings.devices.minutesAgo', { n: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t('settings.devices.hoursAgo', { n: hrs })
  if (hrs < 48) return t('settings.sessions.yesterday')
  return d.toLocaleDateString(locale === 'ko' ? 'ko-KR' : 'en-US', { month: '2-digit', day: '2-digit' })
}

function errDetail(e: unknown): string | undefined {
  return (e as { data?: { detail?: string } } | null)?.data?.detail
}

export function useMySessions() {
  const { t, locale } = useI18n()

  const [sessions, setSessions] = useState<MySession[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const others = useMemo(() => sessions.filter(s => !s.current), [sessions])

  const load = useCallback(async () => {
    setLoading(true); setLoadError(false)
    try { setSessions((await $fetch<{ sessions: MySession[] }>('/api/auth/me/sessions')).sessions || []) }
    catch { setLoadError(true) }
    finally { setLoading(false) }
  }, [])

  const baseName = (s: MySession) => sessionBaseName(t, s)
  const name = (s: MySession) => sessionName(t, s)
  const kind = (s: MySession) => sessionKind(t, s)
  const icon = sessionIcon
  const when = (iso: string | null) => sessionWhen(t, locale, iso)

  async function signedOutHere() {
    try { cleanupChat() } catch { /* 무시 */ }
    try { localStorage.removeItem('ws_token') } catch { /* 무시 */ }
    setUser(null)
    await navigateTo('/login')
  }

  async function revoke(s: MySession) {
    if (!await confirmBox(t('settings.devices.revokeBody', { name: baseName(s) }), { title: t('settings.devices.revokeTitle'), confirmLabel: t('auth.logout'), danger: true })) return
    setBusy(s.id)
    try {
      const r = await $fetch<{ ok: boolean; was_current: boolean }>(`/api/auth/me/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
      if (r.was_current) { await signedOutHere(); return }
      setSessions(list => list.filter(x => x.id !== s.id))
    } catch (e) {
      if (errorStatus(e) === 404) setSessions(list => list.filter(x => x.id !== s.id))
      else addToast('error', errDetail(e) || t('settings.devices.revokeFailed'))
    } finally { setBusy(null) }
  }

  async function revokeOthers() {
    if (!await confirmBox(t('settings.devices.revokeOthersBody', { n: others.length }), { title: t('settings.sessions.revokeOthers'), confirmLabel: t('auth.logout'), danger: true })) return
    setBusy('others')
    try {
      const r = await $fetch<{ ok: boolean; revoked: number; kept_current: boolean }>('/api/auth/me/sessions/revoke-others', { method: 'POST' })
      addToast('success', t('settings.devices.revokedOthers', { n: r.revoked }))
      await load()
    } catch (e) {
      addToast('error', errDetail(e) || t('settings.devices.revokeFailed'))
    } finally { setBusy(null) }
  }

  return { sessions, loading, loadError, busy, others, load, name, baseName, kind, icon, when, revoke, revokeOthers }
}
