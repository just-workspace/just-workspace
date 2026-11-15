/**
 * 보안 S2 — 웹은 세션값을 localStorage 에 두지 않는다(httpOnly 쿠키만). 번들 앱(apiBase 있음)만 ws_token 저장.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeConfig, storeSessionToken, clearLegacyWebToken } from '~/lib/runtimeConfig'
import { nativeLogin, verify2fa } from '~/composables/useAuth'

afterEach(() => {
  runtimeConfig.public.apiBase = ''
  localStorage.removeItem('ws_token')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('세션값 저장 위치', () => {
  it('웹: 로그인 응답에 token 이 와도 저장하지 않고, 남은 값은 지운다', async () => {
    localStorage.setItem('ws_token', 'old')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('/api/auth/login')) return jsonResponse({ status: 'ok', token: 'leak' })
      return jsonResponse({ id: 'u1', username: 'a' })
    }))
    await nativeLogin('a', 'b')
    expect(localStorage.getItem('ws_token')).toBeNull()
  })

  it('웹: 2단계 인증 확인 뒤에도 저장하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('/2fa/verify')) return jsonResponse({ status: 'ok', token: 'leak' })
      return jsonResponse({ id: 'u1', username: 'a' })
    }))
    await verify2fa('t', '123456')
    expect(localStorage.getItem('ws_token')).toBeNull()
  })

  it('번들 앱: 저장한다', () => {
    runtimeConfig.public.apiBase = 'https://ws.example.com'
    storeSessionToken('tok')
    expect(localStorage.getItem('ws_token')).toBe('tok')
    clearLegacyWebToken()
    expect(localStorage.getItem('ws_token')).toBe('tok')
  })

  it('웹 시작 시 예전 값을 지운다', () => {
    localStorage.setItem('ws_token', 'old')
    clearLegacyWebToken()
    expect(localStorage.getItem('ws_token')).toBeNull()
  })
})
