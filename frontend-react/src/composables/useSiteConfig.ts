/**
 * 사이트 설정(브랜딩·공지·데모 모드 등). /api/health 를 1회 조회하여 싱글턴으로 보관.
 *
 * React: const { appName, brandColor, config, fetchAppConfig, refetchAppConfig } = useSiteConfig()  (값은 일반 값)
 * 컴포넌트 외부: siteConfigStore.getState().appName
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { $fetch } from '~/lib/api'

export interface SiteConfigState {
  appName: string
  domain: string
  appUrl: string
  giteaUrl: string
  brandLogo: string
  brandColor: string
  defaultTheme: string
  favicon: string
  registrationMode: string
  announcement: string
  announcementType: string
  gitVisibility: string
  demoMode: boolean
  /** NetLab(별도 출처 랩) 주소 — 서버는 https 일 때만 전달한다. 빈 값이면 레일 '도구' 항목·대시보드 카드를 숨긴다 */
  netlabUrl: string
  /** 이 서버가 구동하는 프로그램의 소스 주소(서버의 JW_SOURCE_URL) — "소스 코드" 링크. 빈 값이면 링크를 숨긴다 */
  sourceUrl: string
  /** 라이선스 표기(SPDX) */
  license: string
  /** 디자인 대개편 확장 설정 — appcfg.* (예: config['dash.cards']). 빈값/부재는 i18n 폴백. */
  config: Record<string, string>
  /** 설치된 구역 id(서버 /api/health 의 zones). null 이면 미확인(로딩 중이거나 서버가 제공하지 않음) */
  zones: string[] | null
  loaded: boolean
}

export const siteConfigStore = createStore<SiteConfigState>()(() => ({
  appName: 'Workspace',
  domain: 'localhost',
  appUrl: '',
  giteaUrl: '',
  brandLogo: '',
  brandColor: '#3B82F6',
  defaultTheme: 'system',
  favicon: '',
  registrationMode: 'approval',
  announcement: '',
  announcementType: 'info',
  gitVisibility: 'private',
  demoMode: false,
  netlabUrl: '',
  sourceUrl: '',
  license: 'AGPL-3.0-or-later',
  config: {},
  zones: null,
  loaded: false,
}))

/**
 * 구역(메일·문서·AI 등 설치 단위)의 설치 여부. 활성화/비활성화 대상 모듈이 없는 기능(문서 편집, AI 연동 설정 등)을 숨길 때 사용한다.
 * 구역 목록이 미확인 상태이면 판정을 보류한다(설치된 것으로 간주).
 */
export function zoneInstalledIn(zones: string[] | null, id: string): boolean {
  return zones === null || zones.includes(id)
}

export function isZoneInstalled(id: string): boolean {
  return zoneInstalledIn(siteConfigStore.getState().zones, id)
}

/** 컴포넌트용 — 구역 목록 수신 시 재렌더링한다 */
export function useZoneInstalled(id: string): boolean {
  return useStore(siteConfigStore, s => zoneInstalledIn(s.zones, id))
}

export async function fetchAppConfig() {
  if (siteConfigStore.getState().loaded) return
  try {
    const data = await $fetch<{
      service: string
      domain: string
      app_url: string
      gitea_url: string
      brand_logo: string
      brand_color: string
      default_theme: string
      favicon: string
      registration_mode: string
      announcement: string
      announcement_type: string
      git_visibility: string
      demo_mode: boolean
      netlab_url?: string
      source_url?: string
      license?: string
      config: Record<string, string>
      zones?: string[]
    }>('/api/health')
    siteConfigStore.setState({
      appName: data.service || 'Workspace',
      domain: data.domain || 'localhost',
      appUrl: data.app_url || '',
      giteaUrl: data.gitea_url || '',
      brandLogo: data.brand_logo || '',
      brandColor: data.brand_color || '#3B82F6',
      defaultTheme: data.default_theme || 'system',
      favicon: data.favicon || '',
      registrationMode: data.registration_mode || 'approval',
      announcement: data.announcement || '',
      announcementType: data.announcement_type || 'info',
      gitVisibility: data.git_visibility || 'private',
      demoMode: data.demo_mode || false,
      netlabUrl: data.netlab_url || '',
      sourceUrl: data.source_url || '',
      license: data.license || 'AGPL-3.0-or-later',
      config: data.config || {},
      zones: Array.isArray(data.zones) ? data.zones : null,
      loaded: true,
    })
  } catch {
    // fallback to defaults
  }
}

export async function refetchAppConfig() {
  siteConfigStore.setState({ loaded: false })
  await fetchAppConfig()
}

export function useSiteConfig() {
  const s = useStore(siteConfigStore, useShallow((x: SiteConfigState) => x))
  return { ...s, fetchAppConfig, refetchAppConfig }
}
