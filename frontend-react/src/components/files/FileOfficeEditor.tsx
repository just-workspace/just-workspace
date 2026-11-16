/**
 * 오피스 편집기 틀: 머리(뒤로 · 파일 이름 · 편집기 이름) + 편집기 iframe.
 * 공유 링크 손님 화면(pages/s/[token])에서 사용한다.
 * OnlyOffice 는 WOPI 표준대로 access_token 을 **POST 폼 본문**으로만 수신한다 — 숨은 폼을 iframe 을 target 으로 하여 제출한다.
 * 편집기가 postMessage 로 UI_Close/close 를 송신하면 닫는다.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import type { EditorSession } from '~/composables/useOfficeEditor'

export interface FilesFileOfficeEditorProps {
  session: EditorSession
  filePath: string
  onClose?: () => void
}

export function FilesFileOfficeEditor({ session, onClose }: FilesFileOfficeEditorProps) {
  const { t } = useI18n()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const formRef = useRef<HTMLFormElement | null>(null)
  const [loading, setLoading] = useState(true)

  // OnlyOffice 는 WOPI 표준대로 access_token 을 **POST 폼 본문**으로만 수신한다.
  // iframe src 에 토큰을 붙여 GET 하면 404 가 반환된다. Collabora 는 쿼리 방식도 허용하므로
  // 그동안 이 차이가 드러나지 않았다.
  const isOnlyOffice = session.editor === 'onlyoffice'
  // 매번 다른 이름을 사용해야 문서를 연속으로 열 때 이전 프레임이 재사용되지 않는다.
  const [frameName] = useState(() => `office-frame-${Math.random().toString(36).slice(2, 9)}`)
  // WOPI 의 access_token_ttl 은 "만료 시각(epoch ms)" 이다. 초 단위 TTL 이 아니다.
  const tokenTtlMs = session.token_ttl ? String(Date.now() + session.token_ttl * 1000) : '0'

  function handleLoad() {
    setLoading(false)
  }

  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // Listen for PostMessage events from the editor
  useEffect(() => {
    function handlePostMessage(event: MessageEvent) {
      // Handle editor events (save, close, etc.)
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if (data.MessageId === 'UI_Close' || data.MessageId === 'close') {
          closeRef.current?.()
        }
      } catch {
        // Not a JSON message, ignore
      }
    }
    window.addEventListener('message', handlePostMessage)
    // 폼이 DOM 에 추가된 이후 제출해야 target(iframe) 이 인식된다.
    if (isOnlyOffice) formRef.current?.submit()
    return () => window.removeEventListener('message', handlePostMessage)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => onClose?.()}
            className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-accent shrink-0"
            title={t('common.back')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="text-sm font-medium truncate">{session.file_name}</span>
          <span className="text-xs text-muted-foreground px-2 py-0.5 rounded bg-muted shrink-0">
            {session.editor === 'onlyoffice' ? 'OnlyOffice' : 'Collabora'}
          </span>
        </div>
      </div>

      {/* Editor iframe */}
      <div className="flex-1 relative min-h-0">
        {/* Loading spinner */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">{t('files.editor.loading')}</p>
            </div>
          </div>
        )}

        <iframe
          ref={iframeRef}
          name={frameName}
          src={isOnlyOffice ? undefined : session.editor_url}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          allow="clipboard-read; clipboard-write"
          onLoad={handleLoad}
        />

        {/* OnlyOffice 진입용 POST 폼 (WOPI 표준). 위 iframe 을 target 으로 제출한다. */}
        {isOnlyOffice && (
          <form
            ref={formRef}
            action={session.editor_url}
            method="post"
            target={frameName}
            className="hidden"
          >
            <input type="hidden" name="access_token" value={session.token} readOnly />
            <input type="hidden" name="access_token_ttl" value={tokenTtlMs} readOnly />
          </form>
        )}
      </div>
    </div>
  )
}

export default FilesFileOfficeEditor
