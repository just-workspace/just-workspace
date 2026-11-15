/**
 * 화면 쪽 오류를 요청 번호와 함께 서버 로그로 보낸다(POST /api/client-error).
 *
 * 서버가 낸 오류는 서버 요청 번호로 로그에서 찾을 수 있지만, 화면 쪽 오류는 브라우저가 번호를
 * 만들기 때문에 콘솔에만 남으면 관리자가 찾을 길이 없다. 오류 화면이 보여 준 번호 그대로 보낸다.
 * 실패해도 조용히 넘어간다(오류 화면을 또 깨뜨리면 안 된다).
 */

const MAX = 4000

function text(v: unknown, n: number) {
  return typeof v === 'string' ? v.slice(0, n) : ''
}

export function clientErrorPayload(requestId: string, err: unknown, statusCode?: number) {
  const e = (err && typeof err === 'object' ? err : {}) as { message?: unknown; stack?: unknown; data?: any }
  const inner = e.data && typeof e.data === 'object' ? e.data : null
  return {
    request_id: requestId,
    status: statusCode ?? 500,
    message: text(e.message, 500) || text(inner?.message, 500) || text(String(err ?? ''), 500),
    stack: text(e.stack, MAX) || text(inner?.stack, MAX),
    url: text(typeof location !== 'undefined' ? location.pathname + location.search : '', 500),
  }
}

export function reportClientError(requestId: string, err: unknown, statusCode?: number) {
  try {
    const body = JSON.stringify(clientErrorPayload(requestId, err, statusCode))
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => {})
  } catch { /* ignore */ }
}
