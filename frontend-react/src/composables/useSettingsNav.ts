/**
 * /settings/* (개인) 와 /admin/* (관리) 좌측 내비 정의 + "설정 찾기" 검색 색인(시안 SettingsPage·AdminPage, 10-6 ⑥).
 * 색인은 클라이언트 전용 — 항목 이름·키워드로 걸러 해당 페이지로 보낸다. 서버 검색 없음.
 * (Vue 판 composables/useSettingsNav.ts 그대로)
 *
 * React: const { groups, flat, find, labelFor } = useSettingsNav('settings' | 'admin')   — groups·flat 은 배열 값
 */
import { useCallback, useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { usePlatform } from '~/composables/usePlatform'
import { siteConfigStore, zoneInstalledIn } from '~/composables/useSiteConfig'
import { useAdminOps } from '~/composables/useAdminOps'
import { authStore } from '~/composables/useAuth'
import { useI18n } from '~/i18n'

export interface SettingsNavItem {
  to: string
  label: string
  /** 보조 글자(mono) 또는 경고 배지 */
  meta?: string
  metaTone?: 'plain' | 'warning'
  /** 설정 찾기용 키워드 */
  keywords?: string[]
  /** 모듈이 꺼져 있으면 숨김 */
  module?: string
  /** 이 구역이 설치되지 않았으면 숨김(켜고 끄는 모듈과 별개 — AI 설정처럼 모듈을 켜기 전에도 보여야 하는 항목) */
  zone?: string
  adminOnly?: boolean
}
export interface SettingsNavGroup { label: string; items: SettingsNavItem[] }
export type SettingsNavFlatItem = SettingsNavItem & { group: string }
export type SettingsNavMatch = SettingsNavFlatItem & { matched: string | undefined }

export function useSettingsNav(scope: 'settings' | 'admin') {
  const { isModuleEnabled } = usePlatform()
  const zones = useStore(siteConfigStore, s => s.zones)
  const { ops, ensure } = useAdminOps()
  const { t } = useI18n()

  // 관리 내비 보조 글자(승인 대기·SSL·서비스) — 관리자만 부른다(비관리자는 403 소음). Vue 는 setup 에서 한 번.
  useEffect(() => {
    if (scope === 'admin' && authStore.getState().user?.is_admin) ensure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const groups = useMemo<SettingsNavGroup[]>(() => {
    // 항목 이름·찾기 키워드는 i18n(<ns>.label.<id> · <ns>.kw.<id>, 키워드는 쉼표 구분)
    const L = (ns: string, id: string) => ({
      label: t(`${ns}.label.${id}`),
      keywords: t(`${ns}.kw.${id}`).split(',').map(s => s.trim()).filter(Boolean),
    })
    // 꺼진 모듈·설치되지 않은 구역의 항목은 뺀다(항목이 다 빠진 묶음은 묶음째)
    const shown = (i: SettingsNavItem) => (!i.module || isModuleEnabled(i.module)) && (!i.zone || zoneInstalledIn(zones, i.zone))
    if (scope === 'settings') {
      return [
        { label: t('shell.settingsNav.group.personal'), items: [
          { to: '/settings/account', ...L('shell.settingsNav', 'account') },
          { to: '/settings/security', ...L('shell.settingsNav', 'security') },
          { to: '/settings/notifications', ...L('shell.settingsNav', 'notifications') },
          { to: '/settings/display', ...L('shell.settingsNav', 'display') },
          { to: '/settings/apps', ...L('shell.settingsNav', 'apps') },
        ] as SettingsNavItem[] },
        { label: t('shell.settingsNav.group.modules'), items: [
          { to: '/settings/mail', ...L('shell.settingsNav', 'mail'), module: 'mail' },
          { to: '/settings/calendar', ...L('shell.settingsNav', 'calendar'), module: 'calendar' },
          { to: '/settings/chat', ...L('shell.settingsNav', 'chat'), module: 'chat' },
          { to: '/settings/ai', ...L('shell.settingsNav', 'ai'), zone: 'ai' },
        ] as SettingsNavItem[] },
        // AI 하위(시안 H1 좌 내비 "AI" 묶음) — 메모리 · AI 연동(MCP)
        { label: t('shell.settingsNav.group.ai'), items: [
          { to: '/settings/ai/memory', ...L('shell.settingsNav', 'aiMemory'), zone: 'ai' },
          { to: '/settings/ai/mcp', ...L('shell.settingsNav', 'aiMcp'), zone: 'ai' },
        ] as SettingsNavItem[] },
      ].map(g => ({ ...g, items: g.items.filter(shown) })).filter(g => g.items.length)
    }
    // 관리(시안 AdminPage nav · 관리 1 ②): 설정 9카드를 항목으로 쪼개고 /admin/system 은 "서비스 상태"로 흡수.
    // 보조 글자는 운영 요약(useAdminOps)에서: 승인 대기 n(경고) · SSL D-n(30일 이하 경고) · 서비스 n/n.
    const o = ops
    const pendingMeta = o.pending ? { meta: String(o.pending), metaTone: 'warning' as const } : {}
    const sslDays = o.ssl?.days
    const sslMeta = sslDays != null && sslDays <= 30 ? { meta: sslDays < 0 ? t('shell.adminNav.sslExpired') : `D-${sslDays}`, metaTone: 'warning' as const } : {}
    const svcMeta = o.services && o.services.total
      ? { meta: `${o.services.ok}/${o.services.total}`, metaTone: (o.services.ok < o.services.total ? 'warning' : 'plain') as 'warning' | 'plain' }
      : {}
    return [
      { label: t('shell.adminNav.group.ops'), items: [
        { to: '/admin/dashboard', ...L('shell.adminNav', 'dashboard') },
        { to: '/admin/users', ...L('shell.adminNav', 'users'), ...pendingMeta },
        { to: '/admin/groups', ...L('shell.adminNav', 'groups') },
        { to: '/admin/modules', ...L('shell.adminNav', 'modules') },
        { to: '/admin/ai-ops', ...L('shell.adminNav', 'aiOps'), zone: 'ai' },
      ] },
      { label: t('shell.adminNav.group.settings'), items: [
        { to: '/admin/settings', ...L('shell.adminNav', 'settings') },
        { to: '/admin/dashboard-layout', ...L('shell.adminNav', 'dashLayout') },
        { to: '/admin/branding', ...L('shell.adminNav', 'branding') },
        { to: '/admin/mail', ...L('shell.adminNav', 'mail') },
        { to: '/admin/storage', ...L('shell.adminNav', 'storage') },
        { to: '/admin/security', ...L('shell.adminNav', 'security'), ...sslMeta },
        { to: '/admin/ai', ...L('shell.adminNav', 'ai'), zone: 'ai' },
        { to: '/admin/app-build', ...L('shell.adminNav', 'appBuild') },
      ] },
      // 격리 브라우저는 따로 묶는다(r22) — 사용자 메뉴(레일·탭·팔레트)에는 없고, 사용자는 전용 출처(rbi.<도메인>)로 바로 들어간다
      { label: t('shell.adminNav.group.rbi'), items: [
        { to: '/admin/rbi', ...L('shell.adminNav', 'rbi'), zone: 'rbi' },
      ] },
      { label: t('shell.adminNav.group.system'), items: [
        { to: '/admin/system', ...L('shell.adminNav', 'system'), ...svcMeta },
        { to: '/admin/logs', ...L('shell.adminNav', 'logs') },
      ] },
    ].map(g => ({ ...g, items: (g.items as SettingsNavItem[]).filter(shown) })).filter(g => g.items.length)
  }, [scope, t, isModuleEnabled, zones, ops])

  const flat = useMemo<SettingsNavFlatItem[]>(() => groups.flatMap(g => g.items.map(i => ({ ...i, group: g.label }))), [groups])

  /** 설정 찾기: 이름·키워드 부분 일치 */
  const find = useCallback((q: string): SettingsNavMatch[] => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return flat
      .map(i => {
        const hitLabel = i.label.toLowerCase().includes(s)
        const kw = (i.keywords ?? []).find(k => k.toLowerCase().includes(s))
        return hitLabel || kw ? { ...i, matched: hitLabel ? undefined : kw } : null
      })
      .filter((x): x is SettingsNavMatch => !!x)
  }, [flat])

  // 가장 길게 맞는 항목(/settings/ai/mcp 는 "AI" 가 아니라 "AI 연동(MCP)")
  const labelFor = useCallback((path: string) => flat
    .filter(i => path === i.to || path.startsWith(i.to + '/'))
    .sort((a, b) => b.to.length - a.to.length)[0]?.label ?? '', [flat])

  return { groups, flat, find, labelFor }
}
