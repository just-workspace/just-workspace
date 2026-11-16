/**
 * 화면 안 AI 버튼 상태 — /api/ai/inline/status 를 한 번 받아 메일·채팅·회의·문서가 같이 쓴다(5분 캐시).
 *
 * 버튼 상태(꺼짐 모양은 기존 관례로 정함):
 *  - AI 모듈 꺼짐(module_off) · 상태를 못 받음 → 버튼을 숨긴다(기능이 없는 것과 같다)
 *  - 제공자 미설정(not_configured) · 외부 AI 데이터 차단(external_blocked) → 버튼은 보이되 비활성 + 이유 툴팁
 *  - 쓸 수 있음 → 활성. 외부 AI 면 결과 패널에 "개인정보는 가려서 보냅니다" 안내
 */
import { useEffect } from 'react'
import { createStore, useStore } from 'zustand'
import { fetchInlineStatus, type AiInlineStatus } from '~/utils/aiInline'
import { authStore } from '~/composables/useAuth'
import { fetchAppConfig, isZoneInstalled, siteConfigStore } from '~/composables/useSiteConfig'

const TTL = 5 * 60_000

export const aiInlineStore = createStore<{ status: AiInlineStatus | null; loadedAt: number; loading: boolean }>()(
  () => ({ status: null, loadedAt: 0, loading: false }),
)

let inflight: Promise<void> | null = null

export function loadAiInlineStatus(force = false): Promise<void> {
  const s = aiInlineStore.getState()
  if (!force && s.loadedAt && Date.now() - s.loadedAt < TTL) return Promise.resolve()
  if (inflight) return inflight
  aiInlineStore.setState({ loading: true })
  // AI 구역이 설치되지 않은 서버에는 이 경로가 없다(404). 구역 목록을 먼저 확인하고 미설치이면 호출하지 않는다.
  inflight = (siteConfigStore.getState().loaded ? Promise.resolve() : fetchAppConfig())
    .then(() => (isZoneInstalled('ai') ? fetchInlineStatus() : null))
    .then(status => aiInlineStore.setState({ status, loadedAt: Date.now(), loading: false }))
    .catch(() => aiInlineStore.setState({ status: null, loadedAt: Date.now(), loading: false }))
    .finally(() => { inflight = null })
  return inflight
}

/** 테스트용 */
export function _setAiInlineStatus(status: AiInlineStatus | null) {
  aiInlineStore.setState({ status, loadedAt: status ? Date.now() : 0, loading: false })
}

authStore.subscribe((s, prev) => {
  if (s.user !== prev.user) aiInlineStore.setState({ status: null, loadedAt: 0 })
})

export type AiInlineButtonState = 'hidden' | 'disabled' | 'ready'

export function buttonState(status: AiInlineStatus | null): AiInlineButtonState {
  if (!status || status.reason === 'module_off') return 'hidden'
  return status.available ? 'ready' : 'disabled'
}

/** 상태 + 버튼 모양. 마운트할 때 한 번 받는다 */
export function useAiInline() {
  const status = useStore(aiInlineStore, s => s.status)
  useEffect(() => { void loadAiInlineStatus() }, [])
  return { status, state: buttonState(status), reload: () => loadAiInlineStatus(true) }
}
