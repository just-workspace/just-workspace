// 첨부 업로드 — XHR 사용(업로드 진행 상황을 알아야 "올리는 중 → 변환 중"을 구분할 수 있다. fetch 는 업로드 진행 이벤트 미지원).
// 바이트 전송 완료 시 onStage('converting') 호출, 서버가 변환을 마치고 응답하면 결과(성공·실패 코드)를 반환한다.
import { apiUrl, bundledAuthHeaders } from '~/lib/runtimeConfig'
import type { AiAttachment } from '~/utils/aiAssist'

export function aiUploadAttachment(file: File, conversationId: string | null, onStage: (s: 'uploading' | 'converting') => void): Promise<AiAttachment> {
  return new Promise((resolve) => {
    const fd = new FormData()
    fd.append('file', file, file.name || 'attachment')
    if (conversationId) fd.append('conversation_id', conversationId)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl('/api/ai/attachments'))
    xhr.withCredentials = true
    for (const [k, v] of Object.entries(bundledAuthHeaders())) xhr.setRequestHeader(k, v)
    const fail = (code: string, error = ''): AiAttachment => ({ id: null, name: file.name, size: file.size, status: 'failed', error_code: code, error })
    onStage('uploading')
    xhr.upload.onload = () => onStage('converting')
    xhr.onload = () => {
      let body: any = null
      try { body = JSON.parse(xhr.responseText) } catch { /* 본문 없음 */ }
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        resolve(body.status === 'failed'
          ? fail(body.error_code || 'unsupported', body.error || '')
          : { ...body, status: 'ready' } as AiAttachment)
      } else {
        resolve(fail(xhr.status === 413 ? 'too_large' : 'network', typeof body?.detail === 'string' ? body.detail : ''))
      }
    }
    xhr.onerror = () => resolve(fail('network'))
    xhr.send(fd)
  })
}
