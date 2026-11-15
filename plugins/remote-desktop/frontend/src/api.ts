/**
 * 원격 데스크톱(뷰어) API — /api/plugins/remote-desktop/*. 호스트 $fetch(pluginApi.$fetch)로 부른다.
 *
 * GET    /status                       → { livekit, org_name, org_domain, support_download, support_available, support_size, support_requirements, desktop_download, code_ttl_s, is_admin }
 * GET    /devices[?all=1]               → { devices }
 * PATCH  /devices/{id}                  {allow_remote?, unattended?, name?}
 * POST   /devices/{id}/connect          → { session }   (호스트가 30초 안에 동의해야 열린다)
 * POST   /support/join {code}           → { session }   (피지원자가 동의해야 열린다. 실패 detail = {code: format|no_match|expired, message})
 * GET    /sessions/{id}[?token=1]       → { session, livekit? }
 * POST   /sessions/{id}/end
 */
export const BASE = '/api/plugins/remote-desktop'

export type Fetch = <T = unknown>(url: string, opts?: { method?: string; body?: unknown; query?: Record<string, unknown> }) => Promise<T>

export interface RemoteDevice {
  id: string
  name: string
  platform: string
  /** 사람이 읽는 OS 이름(예: Windows 11) — 옛 앱이면 빈 값 */
  os_name: string
  owner_id: string
  owner_name: string
  allow_remote: boolean
  unattended: boolean
  online: boolean
  last_seen_at: string | null
}

export type RemoteStatus = 'waiting_code' | 'pending' | 'active' | 'ended' | 'denied' | 'expired'

export interface RemoteSession {
  id: string
  kind: 'device' | 'support'
  status: RemoteStatus
  device_id: string | null
  requester_name: string
  requester_email: string
  duration_s: number | null
  expires_at: string | null
  started_at: string | null
  ended_at: string | null
  end_reason: string
}

export interface RemoteLivekit {
  ws_url: string
  token: string
  room: string
  peer_identity: string
}

export interface RemoteInfo {
  livekit: boolean
  org_name: string
  support_download: string
  support_available: boolean
  /** 서버에 올라간 지원 프로그램 실제 크기(바이트). 없으면 null → 받기 버튼을 숨긴다 */
  support_size: number | null
  support_requirements: string
  desktop_download: string
  org_domain: string
  code_ttl_s: number
  is_admin: boolean
}

export function makeApi(f: Fetch) {
  return {
    status: () => f<RemoteInfo>(`${BASE}/status`),
    devices: (all = false) => f<{ devices: RemoteDevice[] }>(`${BASE}/devices${all ? '?all=1' : ''}`),
    patchDevice: (id: string, body: Partial<Pick<RemoteDevice, 'allow_remote' | 'unattended' | 'name'>>) =>
      f<{ device: RemoteDevice }>(`${BASE}/devices/${id}`, { method: 'PATCH', body }),
    connect: (id: string) => f<{ session: RemoteSession }>(`${BASE}/devices/${id}/connect`, { method: 'POST' }),
    joinCode: (code: string) => f<{ session: RemoteSession }>(`${BASE}/support/join`, { method: 'POST', body: { code } }),
    session: (id: string, token = false) =>
      f<{ session: RemoteSession; livekit?: RemoteLivekit }>(`${BASE}/sessions/${id}${token ? '?token=1' : ''}`),
    end: (id: string) => f<{ session: RemoteSession }>(`${BASE}/sessions/${id}/end`, { method: 'POST' }),
  }
}

export type RemoteApi = ReturnType<typeof makeApi>

/** 입력칸 정리 — 숫자만 남겨 3자리씩 띄운다(지원 프로그램 "482 913 057"·"123-456-789"·문장째 붙여넣기 어느 쪽이든) */
export function cleanCodeInput(raw: string): string {
  // 숫자만 뽑아 3자리씩 띄운다 — "접속 코드: 482 913 057"·"482-913-057"·줄바꿈이 섞인 붙여넣기도 그대로 받는다.
  // (예전엔 글자만 지우고 13자로 잘라, 문장째 붙여넣으면 앞쪽 공백에 밀려 숫자가 잘렸다)
  // 12자리까지만 둔다 — 넘치면 형식 오류로 보이게(9자리로 몰래 자르지 않는다).
  const d = raw.replace(/\D/g, '').slice(0, 12)
  return d.replace(/(\d{3})(?=\d)/g, '$1 ')
}

/** 형식 검사 — 숫자 9자리이고 숫자·공백·하이픈 말고는 없어야 한다 */
export function codeFormatOk(raw: string): boolean {
  return /^[\d\s-]*$/.test(raw) && raw.replace(/\D/g, '').length === 9
}

/** 서버 오류 → 시안 오류 종류 */
export function joinErrorKind(e: unknown): 'format' | 'no_match' | 'expired' | 'tooMany' | 'other' {
  const status = (e as { status?: number; statusCode?: number }).status ?? (e as { statusCode?: number }).statusCode
  if (status === 429) return 'tooMany'
  const d = (e as { data?: { detail?: unknown } }).data?.detail as { code?: string } | undefined
  if (d && (d.code === 'format' || d.code === 'no_match' || d.code === 'expired')) return d.code
  return 'other'
}
