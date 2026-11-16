/**
 * 페이지(또는 화면 단계)가 모바일에서 자체 머리(상단 바)를 사용함을 셸에 통지한다 → 셸이 모바일 공용 상단바(LayoutTopBar)를 숨긴다.
 *  · 정적: routes.ts 의 ownMobileHeader: true — 해당 페이지는 모바일에서 항상 자체 머리 사용
 *  · 동적: useOwnMobileHeader(조건) — 화면 단계에 따라 결정(채팅: 목록은 공용 상단바, 대화 이상은 자체 머리)
 *  · LayoutMobileDetailBar 는 마운트된 동안 자동으로 선언한다(replaceTopbar=false 로 비활성화).
 * 여러 위치에서 동시에 선언할 수 있으므로(라우트 전환 중 새 페이지가 먼저 마운트된다) 선언 수를 집계한다.
 */
import { useEffect } from 'react'
import { createStore, useStore } from 'zustand'
import { useRoute } from '~/lib/router'

export const ownMobileHeaderStore = createStore<{ count: number }>()(() => ({ count: 0 }))

export function useOwnMobileHeader(when: boolean = true) {
  const on = !!when
  useEffect(() => {
    if (!on) return
    ownMobileHeaderStore.setState(s => ({ count: s.count + 1 }))
    return () => ownMobileHeaderStore.setState(s => ({ count: Math.max(0, s.count - 1) }))
  }, [on])
}

/** 셸용: 현재 페이지의 자체 머리 선언 여부(모바일 판정은 호출자가 수행) */
export function useOwnMobileHeaderActive(): boolean {
  const count = useStore(ownMobileHeaderStore, s => s.count)
  const route = useRoute()
  return count > 0 || !!route.meta.ownMobileHeader
}
