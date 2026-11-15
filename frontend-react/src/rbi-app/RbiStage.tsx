/**
 * 격리 화면 자리(단독 앱) — 상단 신뢰 줄 아래 나머지 전체를 채운다.
 *  · 픽셀: 세션 컨테이너의 KasmVNC 클라이언트를 같은 출처(rbi) iframe 으로(/rbi/<sid>/?autoconnect…)
 *  · 미러: components/rbi/RbiMirrorView(스크립트 없는 iframe + 부모가 조립)
 *  · 시작 중: 안내 글
 * focus() 로 키보드 포커스를 격리 화면에 준다(앱이 세션이 열리면 기본으로 부른다).
 * onFrameWindow: 픽셀 iframe 의 창(같은 출처) — 앱이 단축키(상단 줄로 가기)를 그 창에도 건다(키가 iframe 안에서 먼저 소비되므로).
 * TODO(handover-rbi): 시작 중·오류 화면의 시각은 시안에서.
 */
import { useImperativeHandle, useRef, type Ref } from 'react'
import { useI18n } from '~/i18n'
import { rbiStreamSrc, type RbiSession } from '~/composables/useRbi'
import { RbiMirrorView, type RbiMirrorConn, type RbiMirrorHandle } from '~/components/rbi/RbiMirrorView'
import type { DocInfo, PolicyInfo } from '~/lib/rbiMirror/vocab'

export interface RbiStageHandle { focus: () => void }

export interface RbiStageProps {
  session: RbiSession
  onDoc?: (d: DocInfo) => void
  onPolicy?: (p: PolicyInfo) => void
  onConn?: (c: RbiMirrorConn) => void
  onSuggestPixel?: () => void
  onFrameWindow?: (w: Window | null) => void
  ref?: Ref<RbiStageHandle>
}

export function RbiStage({ session, onDoc, onPolicy, onConn, onSuggestPixel, onFrameWindow, ref }: RbiStageProps) {
  const { t } = useI18n()
  const pixelRef = useRef<HTMLIFrameElement>(null)
  const mirrorRef = useRef<RbiMirrorHandle>(null)
  const mode = session.mode ?? 'pixel'
  const running = session.status === 'running' && !!session.stream_url

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (mode === 'mirror') { mirrorRef.current?.focus(); return }
      const f = pixelRef.current
      if (!f) return
      f.focus()
      try { f.contentWindow?.focus() } catch { /* 아직 로드 전 */ }
    },
  }), [mode])

  if (session.status === 'starting') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground" role="status">
        {t('rbi.starting')}
      </div>
    )
  }
  if (!running) return null
  if (mode === 'mirror') {
    return <RbiMirrorView ref={mirrorRef} session={session} onDoc={onDoc} onPolicy={onPolicy} onConn={onConn} onSuggestPixel={onSuggestPixel} />
  }
  return (
    <iframe
      ref={pixelRef}
      title={session.target_name}
      src={rbiStreamSrc(session)}
      className="min-h-0 w-full flex-1 border-0 bg-black"
      allow="clipboard-read; clipboard-write"
      sandbox="allow-scripts allow-same-origin allow-forms"
      referrerPolicy="no-referrer"
      onLoad={() => {
        let w: Window | null
        try { w = pixelRef.current?.contentWindow ?? null } catch { w = null }
        onFrameWindow?.(w)
        // 로드되면 키보드를 격리 화면으로(앱 첫 포커스 규칙)
        try { pixelRef.current?.focus(); w?.focus() } catch { /* 무시 */ }
      }}
    />
  )
}
