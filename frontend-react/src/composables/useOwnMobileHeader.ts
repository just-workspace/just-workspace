/**
 * 페이지(또는 화면 단계)가 모바일에서 자체 머리(상단 바)를 쓴다고 셸에 알린다 → 셸이 모바일 공용 상단바(LayoutTopBar)를 숨긴다.
 *  · 정적: routes.ts 의 ownMobileHeader: true — 그 페이지는 모바일에서 늘 자체 머리
 *  · 동적: useOwnMobileHeader(조건) — 화면 단계에 따라(채팅: 목록은 공용 상단바, 대화 이상은 자체 머리)
 *  · LayoutMobileDetailBar 는 붙어 있는 동안 스스로 선언한다(replaceTopbar=false 로 끔).
 * 여러 곳이 동시에 선언할 수 있어(라우트 전환 중 새 페이지가 먼저 붙는다) 수를 센다.
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

/** 셸용: 지금 페이지가 자체 머리를 선언했는가(모바일 판정은 부르는 쪽이 한다) */
export function useOwnMobileHeaderActive(): boolean {
  const count = useStore(ownMobileHeaderStore, s => s.count)
  const route = useRoute()
  return count > 0 || !!route.meta.ownMobileHeader
}
