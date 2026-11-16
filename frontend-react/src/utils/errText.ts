/**
 * FastAPI 에러 응답을 사람이 읽을 수 있는 문자열로 변환한다.
 *
 * 422(검증 실패)의 detail 은 배열이므로 그대로 렌더링하면 [object Object] 가 표시된다.
 * 과거에는 배열 항목의 input 필드에 사용자 입력값(비밀번호 포함)이 포함되어
 * 화면에 그대로 노출되었다. 백엔드가 input 을 제외하고 전송하지만,
 * 본 모듈에서도 msg 만 추출하여 사용한다.
 */
export function errText(e: any, fallback: string): string {
  const detail = e?.data?.detail
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d: any) => String(d?.msg ?? '').replace('Value error, ', ''))
      .filter(Boolean)
    return msgs.length ? msgs.join(', ') : fallback
  }
  if (typeof detail === 'string' && detail) return detail
  return fallback
}
