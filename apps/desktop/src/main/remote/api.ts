/**
 * 원격 데스크톱 플러그인 API 클라이언트(호스트 측) — /api/plugins/remote-desktop/*.
 *  - 내 기기: 등록·설정은 로그인 Bearer, 롱폴링·동의·종료는 X-Remote-Host(<기기 id>:<호스트 비밀>)
 *  - 1회성 지원(포터블): 계정 없음 — 코드 발급 후 X-Remote-Support(<세션 id>:<비밀>)
 * 플러그인이 서버에 없거나 비활성 상태이면(404·403) 호출부가 기능을 숨긴다.
 */
export const PLUGIN_ID = 'remote-desktop';
export const PREFIX = `/api/plugins/${PLUGIN_ID}`;

export interface LivekitInfo { ws_url: string; token: string; room: string; peer_identity: string }
export interface SessionOut {
  id: string;
  kind: 'device' | 'support';
  status: 'waiting_code' | 'pending' | 'active' | 'ended' | 'denied' | 'expired';
  requester_name: string;
  requester_email?: string;
  expires_at: string | null;
  created_at?: string | null;
  started_at?: string | null;
  duration_s?: number | null;
  auto_allow?: boolean;
  requester_is_owner?: boolean;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type Cred = { kind: 'host'; deviceId: string; secret: string } | { kind: 'support'; sessionId: string; secret: string } | { kind: 'bearer'; token: () => Promise<string> };

export class RemoteApi {
  constructor(private readonly serverUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async req<T>(path: string, cred: Cred | null, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (cred?.kind === 'host') headers['X-Remote-Host'] = `${cred.deviceId}:${cred.secret}`;
    else if (cred?.kind === 'support') headers['X-Remote-Support'] = `${cred.sessionId}:${cred.secret}`;
    else if (cred?.kind === 'bearer') headers.Authorization = `Bearer ${await cred.token()}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 15_000);
    try {
      const res = await this.fetchImpl(`${this.serverUrl}${PREFIX}${path}`, {
        method: init.method ?? 'GET', headers, signal: ctl.signal,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new HttpError(res.status, (data && typeof data.detail === 'string' && data.detail) || `HTTP ${res.status}`);
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 내 기기 ──
  register(token: () => Promise<string>, name: string, platform: string, osName: string) {
    return this.req<{ device: { id: string; name: string; allow_remote: boolean; unattended: boolean }; host_secret: string }>(
      '/devices', { kind: 'bearer', token }, { method: 'POST', body: { name, platform, os_name: osName } });
  }
  patchDevice(token: () => Promise<string>, id: string, body: { allow_remote?: boolean; unattended?: boolean; name?: string }) {
    return this.req<{ device: { name: string; allow_remote: boolean; unattended: boolean } }>(`/devices/${id}`, { kind: 'bearer', token }, { method: 'PATCH', body });
  }
  /** 이 기기로 수신된 접속 기록(최근 순, 소유자만) */
  deviceSessions(token: () => Promise<string>, id: string, limit = 3) {
    return this.req<{ sessions: SessionOut[] }>(`/devices/${id}/sessions?limit=${limit}`, { kind: 'bearer', token });
  }
  /** 등록 해지 — 서버가 키를 폐기하고 진행 중인 세션을 종료한다 */
  deleteDevice(token: () => Promise<string>, id: string) {
    return this.req<unknown>(`/devices/${id}`, { kind: 'bearer', token }, { method: 'DELETE' });
  }
  hostPoll(cred: Cred, wait: number, known: string) {
    return this.req<{ device: { name: string; allow_remote: boolean; unattended: boolean }; sessions: SessionOut[]; org_name?: string; org_domain?: string }>(
      `/host/poll?wait=${wait}&known=${encodeURIComponent(known)}`, cred, { timeoutMs: (wait + 15) * 1000 });
  }
  hostDecision(cred: Cred, sessionId: string, allow: boolean) {
    return this.req<{ session: SessionOut; livekit?: LivekitInfo }>(`/host/sessions/${sessionId}/decision`, cred, { method: 'POST', body: { allow } });
  }
  /** why = 호스트가 자체 종료한 사유(진단용, 서버 감사 기록에 남는다) */
  hostEnd(cred: Cred, sessionId: string, why?: EndWhy) {
    return this.req<{ session: SessionOut }>(`/host/sessions/${sessionId}/end`, cred, { method: 'POST', ...(why ? { body: why } : {}) });
  }

  // ── 1회성 지원 ──
  supportCode() {
    return this.req<{ session_id: string; code: string; host_secret: string; expires_at: string; org_name: string; org_domain?: string }>('/support/code', null, { method: 'POST' });
  }
  supportPoll(cred: Cred, wait: number, since: string) {
    return this.req<{ session: SessionOut; org_name?: string; org_domain?: string }>(`/support/poll?wait=${wait}&since=${encodeURIComponent(since)}`, cred, { timeoutMs: (wait + 15) * 1000 });
  }
  supportDecision(cred: Cred, allow: boolean) {
    return this.req<{ session: SessionOut; livekit?: LivekitInfo }>('/support/decision', cred, { method: 'POST', body: { allow } });
  }
  supportEnd(cred: Cred, why?: EndWhy) {
    return this.req<{ session: SessionOut }>('/support/end', cred, { method: 'POST', ...(why ? { body: why } : {}) });
  }
}

/** 호스트가 자체 종료한 사유 — reason 은 소문자·밑줄(room_closed·runner_failed…), detail 은 오류 문구(300자) */
export interface EndWhy { reason: string; detail?: string }

/** 서버에 원격 데스크톱 플러그인이 활성화되어 있는지 여부 — 모듈 목록(로그인 사용자 기준)으로 확인한다 */
export async function pluginEnabled(serverUrl: string, token: () => Promise<string>, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${serverUrl}/api/platform/modules`, { headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/json' } });
    if (!res.ok) return false;
    const j = await res.json() as { modules?: Array<{ id: string; enabled?: boolean }> };
    return !!j.modules?.some(m => m.id === PLUGIN_ID && m.enabled !== false);
  } catch {
    return false;
  }
}
