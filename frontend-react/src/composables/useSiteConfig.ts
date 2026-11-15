/**
 * 사이트 설정(브랜딩·공지·데모 모드 등) — Vue 판 composables/useSiteConfig.ts 그대로. /api/health 한 번 읽어 싱글턴.
 *
 * React: const { appName, brandColor, config, fetchAppConfig, refetchAppConfig } = useSiteConfig()  (값은 일반 값)
 * 컴포넌트 밖: siteConfigStore.getState().appName
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
  /** NetLab(별도 출처 랩) 주소 — 서버가 https 일 때만 준다. 빈값이면 레일 '도구' 항목·대시보드 카드를 숨긴다 */
  netlabUrl: string
  /** 디자인 대개편 확장 설정 — appcfg.* (예: config['dash.cards']). 빈값/부재는 i18n 폴백. */
  config: Record<string, string>
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
  config: {},
  loaded: false,
}))

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
      config: Record<string, string>
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
      config: data.config || {},
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
