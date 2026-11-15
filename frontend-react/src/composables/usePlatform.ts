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
    // 목록이 아닌 답(프록시 오류 화면 등)은 받은 것으로 치지 않는다 — "목록에 없으면 꺼짐" 판정이 전부를 끄지 않게
    if (!Array.isArray(data?.modules)) throw new Error('unexpected /api/platform/modules response')
    platformStore.setState({ modules: data.modules, loaded: true })
  } catch (e) {
    console.error('fetchModules error:', e)
  }
}

/**
 * 모듈(또는 플러그인) id 가 켜져 있는가 — 레일·가드·대시보드·명령 팔레트가 모두 이 판정을 쓴다.
 *
 * - 목록을 아직 못 받았으면(loaded=false) 판정을 미룬다(켜진 것으로 본다) — 로딩 중에 화면을 막거나 깜빡이지 않게.
 * - 목록을 받은 뒤에는 **목록에 없는 id 는 꺼진 것**이다. 서버는 설치하지 않은 구역의 모듈을 목록에서 뺀다.
 */
export function moduleEnabledIn(modules: PlatformModule[], loaded: boolean, id: string): boolean {
  if (!loaded) return true
  return modules.find(m => m.id === id)?.enabled ?? false
}

export function isModuleEnabled(id: string): boolean {
  const { modules, loaded } = platformStore.getState()
  return moduleEnabledIn(modules, loaded, id)
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
  const isEnabled = useMemo(() => (id: string) => moduleEnabledIn(modules, loaded, id), [modules, loaded])
  return { modules, loaded, enabledModules, fetchModules, isModuleEnabled: isEnabled, toggleModule }
}
