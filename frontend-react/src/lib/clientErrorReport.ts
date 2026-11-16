/**
 * 화면 측 오류를 요청 번호와 함께 서버 로그로 전송한다(POST /api/client-error).
 *
 * 서버에서 발생한 오류는 서버 요청 번호로 로그에서 조회할 수 있으나, 화면 측 오류는 브라우저가 번호를
 * 생성하므로 콘솔에만 기록되면 관리자가 조회할 수단이 없다. 오류 화면에 표시된 번호를 그대로 전송한다.
 * 전송 실패는 무시한다(오류 화면에서 추가 오류를 발생시켜서는 안 된다).
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
