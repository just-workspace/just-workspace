/**
 * 릴레이 입장 토큰 — 백엔드 `POST /api/chat/channels/{id}/voice/relay-token`.
 * 503 이면 릴레이 미설정/다운 → 호출자는 음악 티어로 내려간다(RelayUnavailable).
 */
import { $fetch, errorStatus } from '~/lib/api'
import { wsUrl } from '~/lib/runtimeConfig'
import type { RelayGrant } from './types'

export class RelayUnavailable extends Error {
  constructor(message = '무손실 릴레이를 사용할 수 없습니다') {
    super(message)
    this.name = 'RelayUnavailable'
  }
}

export async function requestRelayGrant(channelId: string, identity?: string): Promise<RelayGrant> {
  try {
    const g = await $fetch<RelayGrant>(`/api/chat/channels/${encodeURIComponent(channelId)}/voice/relay-token`, {
      method: 'POST', body: identity ? { identity } : {},
    })
    // 번들 앱(apiBase)은 현재 창이 아니라 API 호스트로 WS 를 열어야 한다 — 백엔드가 준 절대 URL 대신 경로로 다시 만든다
    return { ...g, ws_url: wsUrl(g.ws_path || '/audiorelay/ws') }
  } catch (e) {
    if (errorStatus(e) === 503) throw new RelayUnavailable()
    throw e
  }
}
