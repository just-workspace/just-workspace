/**
 * 번들 SPA 앱(VITE_API_BASE) 주소·인증 분기 — 웹은 상대 주소, 번들 앱은 apiBase + Bearer.
 * apiBase 를 타야 하는 곳(WS /ws/chat·플러그인 번들·파일 업/다운로드·메일 첨부)의 회귀 테스트.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeConfig, apiUrl, wsUrl, wsProtocols, bundledAuthHeaders, isBundledApp } from '~/lib/runtimeConfig'
import { $fetch, apiRawFetch } from '~/lib/api'
import { pluginBundleUrl } from '~/plugins/pluginHost'
import { attachmentUrl, attachmentsZipUrl } from '~/composables/useMail'
import { downloadFile, getPreviewUrl, uploadFiles } from '~/composables/useFiles'
import { connectWS, disconnectWS } from '~/composables/useChat'

const BASE = 'https://ws.example.com'

function okResponse(body = 'x') {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
}

afterEach(() => {
  runtimeConfig.public.apiBase = ''
  localStorage.removeItem('ws_token')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('웹(apiBase 없음) — 상대 주소 그대로', () => {
  it('주소는 상대 그대로, 인증 헤더 없음', () => {
    localStorage.setItem('ws_token', 'tok')
    expect(isBundledApp()).toBe(false)
    expect(apiUrl('/api/files/download?path=a')).toBe('/api/files/download?path=a')
    expect(bundledAuthHeaders()).toEqual({})
    expect(pluginBundleUrl('notes')).toBe('/api/plugin-assets/notes/bundle.mjs')
    expect(getPreviewUrl('a b.png')).toBe('/api/files/preview?path=a%20b.png')
    expect(attachmentUrl('b1')).toBe('/api/mail/attachments/b1?mailbox_id=INBOX')
  })

  it('웹소켓은 현재 창 주소 기준, 토큰 없음', () => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    expect(wsUrl('/ws/chat')).toBe(`${proto}//${window.location.host}/ws/chat`)
    expect(wsProtocols()).toBeUndefined()
  })
})

describe('번들 앱(apiBase 있음)', () => {
  beforeEach(() => {
    runtimeConfig.public.apiBase = `${BASE}/`
    localStorage.setItem('ws_token', 'tok 1')
  })

  it('/api·/oauth 만 apiBase 를 붙인다', () => {
    expect(apiUrl('/api/x')).toBe(`${BASE}/api/x`)
    expect(apiUrl('/oauth/authorize')).toBe(`${BASE}/oauth/authorize`)
    expect(apiUrl('/files')).toBe('/files')
  })

  it('웹소켓: apiBase 호스트(wss) · 토큰은 주소가 아니라 하위 프로토콜로(nginx error_log 평문 회귀)', () => {
    expect(wsUrl('/ws/chat')).toBe('wss://ws.example.com/ws/chat')
    const wiki = new URL(wsUrl('/ws/wiki/collab?page_id=p1'))
    expect(wiki.host).toBe('ws.example.com')
    expect(wiki.searchParams.get('page_id')).toBe('p1')
    expect(wiki.searchParams.get('token')).toBeNull()
    // 'tok 1' → base64url 'dG9rIDE'
    expect(wsProtocols()).toEqual(['jw.bearer', 'jw.token.dG9rIDE'])
    runtimeConfig.public.apiBase = 'http://ws.example.com'
    expect(wsUrl('/ws/chat').startsWith('ws://ws.example.com/ws/chat')).toBe(true)
  })

  it('토큰이 없으면 하위 프로토콜도 없다', () => {
    localStorage.removeItem('ws_token')
    expect(wsUrl('/ws/chat')).toBe('wss://ws.example.com/ws/chat')
    expect(wsProtocols()).toBeUndefined()
    expect(bundledAuthHeaders()).toEqual({})
  })

  it('플러그인 번들·파일 미리보기·메일 첨부 주소가 apiBase 를 탄다', () => {
    expect(pluginBundleUrl('notes')).toBe(`${BASE}/api/plugin-assets/notes/bundle.mjs`)
    expect(getPreviewUrl('a.png')).toBe(`${BASE}/api/files/preview?path=a.png`)
    expect(attachmentUrl('b1', { inline: true })).toBe(`${BASE}/api/mail/attachments/b1?mailbox_id=INBOX&inline=1`)
    expect(attachmentsZipUrl('m1')).toBe(`${BASE}/api/mail/messages/m1/attachments.zip?mailbox_id=INBOX`)
  })

  it('apiRawFetch: apiBase + Bearer, 호출부 헤더는 유지', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    await apiRawFetch('/api/files/download-multi', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/files/download-multi`)
    const h = new Headers(init.headers)
    expect(h.get('authorization')).toBe('Bearer tok 1')
    expect(h.get('content-type')).toBe('application/json')
  })

  it('$fetch.raw 도 Bearer 를 붙인다(utils/apiDownload 경로)', async () => {
    const fetchMock = vi.fn(async (_req: RequestInfo | URL, _init?: RequestInit) => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    await $fetch.raw('/api/contacts/export-vcf', { responseType: 'blob' })
    const [req, init] = fetchMock.mock.calls[0]
    const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url
    expect(url).toBe(`${BASE}/api/contacts/export-vcf`)
    const h = new Headers(init?.headers ?? (req as Request).headers)
    expect(h.get('authorization')).toBe('Bearer tok 1')
  })

  it('파일 내려받기(downloadFile)가 apiBase + Bearer 로 요청한다', async () => {
    const fetchMock = vi.fn(async () => okResponse('hello'))
    vi.stubGlobal('fetch', fetchMock)
    // 브라우저 저장 단계(blob URL·<a>.click)는 happy-dom 에서 흉내만
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }))
    await downloadFile('docs/a.txt')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/files/download?path=docs%2Fa.txt`)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok 1')
  })
})

describe('번들 앱 — 업로드·실시간 소켓', () => {
  beforeEach(() => {
    runtimeConfig.public.apiBase = BASE
    localStorage.setItem('ws_token', 'tok')
  })

  it('파일 업로드 XHR 이 apiBase + Bearer 로 간다', async () => {
    const opened: { method: string; url: string; headers: Record<string, string> }[] = []
    class FakeXHR {
      status = 200
      responseText = '{}'
      withCredentials = false
      upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null }
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      private rec = { method: '', url: '', headers: {} as Record<string, string> }
      open(method: string, url: string) { this.rec.method = method; this.rec.url = url; opened.push(this.rec) }
      setRequestHeader(k: string, v: string) { this.rec.headers[k] = v }
      send() { queueMicrotask(() => this.onload?.()) }
      abort() {}
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[],"path":"shared","written":0,"total":0,"done":true}', { status: 200, headers: { 'content-type': 'application/json' } })))
    await uploadFiles([new File(['abc'], 'a.txt')], 'docs')
    expect(opened).toHaveLength(1)
    expect(opened[0].method).toBe('POST')
    expect(opened[0].url.startsWith(`${BASE}/api/files/upload?path=docs&upload_id=`)).toBe(true)
    expect(opened[0].headers.Authorization).toBe('Bearer tok')
  })

  it('채팅 실시간 소켓(/ws/chat)이 apiBase 호스트 + 인증 하위 프로토콜로 붙는다', () => {
    const urls: string[] = []
    const protos: unknown[] = []
    class FakeWS {
      static OPEN = 1
      static CONNECTING = 0
      readyState = 0
      onopen: unknown = null
      onmessage: unknown = null
      onclose: unknown = null
      onerror: unknown = null
      constructor(url: string, p?: unknown) { urls.push(url); protos.push(p) }
      send() {}
      close() { this.readyState = 3 }
    }
    vi.stubGlobal('WebSocket', FakeWS)
    connectWS()
    expect(urls).toEqual(['wss://ws.example.com/ws/chat'])
    expect(protos).toEqual([['jw.bearer', 'jw.token.dG9r']])
    disconnectWS()
  })
})
