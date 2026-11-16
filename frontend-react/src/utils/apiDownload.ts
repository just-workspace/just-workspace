// API 응답 파일(.ics·.vcf 등)을 브라우저 다운로드로 전달한다.
import { $fetch } from '~/lib/api'

// <a href> 대신 $fetch 를 사용하는 이유: 번들 앱(apiBase + Bearer)에서도 인증이 적용되도록 하기 위함.

/** Content-Disposition 에서 파일 이름 추출(UTF-8 filename* 우선) */
export function filenameFromDisposition(cd: string | null | undefined, fallback: string): string {
  if (!cd) return fallback
  const star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)
  if (star) { try { return decodeURIComponent(star[1].trim()) } catch { /* 아래 */ } }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i)
  return plain ? plain[1].trim() : fallback
}

/** GET url → 파일로 저장. 실패 시 throw(호출부가 토스트 표시) */
export async function downloadApi(url: string, fallbackName: string): Promise<void> {
  const res = await ($fetch as any).raw(url, { responseType: 'blob' })
  const blob: Blob = res._data
  const name = filenameFromDisposition(res.headers?.get?.('content-disposition'), fallbackName)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
