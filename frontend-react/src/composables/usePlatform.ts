/**
 * 모듈·플러그인 목록(활성/비활성).
 *
 * React: const { modules, loaded, enabledModules, fetchModules, isModuleEnabled, toggleModule } = usePlatform()
 * 컴포넌트 외부: platformStore.getState(), isModuleEnabled(id)
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
  // 플러그인 전용. manifest 의 "order"(정수, 작을수록 위) — 없으면 null(폴더 이름순으로 후순위). 서버 목록에 해당 순서가 이미 적용되어 있다.
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
    // 목록이 아닌 응답(프록시 오류 화면 등)은 수신한 것으로 간주하지 않는다 — "목록에 없으면 꺼짐" 판정으로 전체가 비활성화되는 것을 방지
    if (!Array.isArray(data?.modules)) throw new Error('unexpected /api/platform/modules response')
    platformStore.setState({ modules: data.modules, loaded: true })
  } catch (e) {
    console.error('fetchModules error:', e)
  }
}

/**
 * 모듈(또는 플러그인) id 의 활성화 여부 — 레일·가드·대시보드·명령 팔레트가 모두 이 판정을 사용한다.
 *
 * - 목록 수신 전(loaded=false)에는 판정을 보류한다(활성으로 간주) — 로딩 중 화면 차단·깜빡임 방지.
 * - 목록 수신 후에는 **목록에 없는 id 는 비활성**이다. 서버는 설치되지 않은 구역의 모듈을 목록에서 제외한다.
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
  // 렌더 중 판정하는 함수 — 구독한 modules 기준(목록 변경 시 컴포넌트가 재렌더링되도록)
  const isEnabled = useMemo(() => (id: string) => moduleEnabledIn(modules, loaded, id), [modules, loaded])
  return { modules, loaded, enabledModules, fetchModules, isModuleEnabled: isEnabled, toggleModule }
}
