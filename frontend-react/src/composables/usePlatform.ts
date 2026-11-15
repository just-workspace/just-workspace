/**
 * 모듈·플러그인 목록(켜짐/꺼짐) — Vue 판 composables/usePlatform.ts 그대로.
 *
 * React: const { modules, loaded, enabledModules, fetchModules, isModuleEnabled, toggleModule } = usePlatform()
 * 컴포넌트 밖: platformStore.getState(), isModuleEnabled(id)
 */
import { createStore, useStore } from 'zustand'
import { useMemo } from 'react'
import { $fetch } from '~/lib/api'

export interface PlatformModule {
  id: string
  name: string
  icon: string
  route: string
  type: string
  requires: string[]
  enabled: boolean
  category?: string
  // 플러그인 전용. manifest 의 "fullscreen": true — 셸이 모바일 하단 탭바를 숨긴다.
  fullscreen?: boolean
  // 플러그인 전용. manifest 의 "order"(정수, 작을수록 위) — 없으면 null(폴더 이름순으로 뒤에). 서버 목록이 이미 이 순서다.
  order?: number | null
  [k: string]: unknown
}

export const platformStore = createStore<{ modules: PlatformModule[]; loaded: boolean }>()(() => ({
  modules: [],
  loaded: false,
}))

export async function fetchModules() {
  try {
    const data = await $fetch<{ modules: PlatformModule[] }>('/api/platform/modules')
    platformStore.setState({ modules: data.modules, loaded: true })
  } catch (e) {
    console.error('fetchModules error:', e)
  }
}

export function isModuleEnabled(id: string): boolean {
  const mod = platformStore.getState().modules.find(m => m.id === id)
  return mod?.enabled ?? true
}

export async function toggleModule(id: string, enabled: boolean) {
  try {
    await $fetch(`/api/admin/modules/${id}`, { method: 'PATCH', body: { enabled } })
    platformStore.setState({
      modules: platformStore.getState().modules.map(m => (m.id === id ? { ...m, enabled } : m)),
    })
  } catch (e) {
    console.error('toggleModule error:', e)
    throw e
  }
}

export function usePlatform() {
  const modules = useStore(platformStore, s => s.modules)
  const loaded = useStore(platformStore, s => s.loaded)
  const enabledModules = useMemo(() => modules.filter(m => m.enabled), [modules])
  // 렌더 중에 판정하는 함수 — 구독한 modules 기준(컴포넌트가 목록 변경에 다시 그려지게)
  const isEnabled = useMemo(() => (id: string) => modules.find(m => m.id === id)?.enabled ?? true, [modules])
  return { modules, loaded, enabledModules, fetchModules, isModuleEnabled: isEnabled, toggleModule }
}
