/**
 * FastAPI 에러 응답을 사람이 읽을 문자열로 변환한다.
 *
 * 422(검증 실패)의 detail 은 배열이라 그대로 렌더하면 [object Object] 가 뜬다.
 * 예전에는 배열 항목의 input 필드에 사용자가 입력한 값(비밀번호 포함)이 실려
 * 화면에 그대로 노출됐다. 백엔드가 input 을 빼고 보내지만,
 * 여기서도 msg 만 뽑아 쓴다.
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
