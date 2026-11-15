/**
 * 격리 브라우저 미러 뷰 — DOM 미러 모드 세션의 화면(헤드리스: 미러 iframe + 숨은 입력칸만).
 * 신뢰 크롬(주소·정책·연결/지연·방식 전환·끝내기)은 단독 앱의 상단 줄(src/rbi-app/RbiTrustedBar)이 그린다 — 이 부품은 상태를 콜백으로 올린다.
 * 기존 키트·토큰만 쓰고 새 시각 요소를 만들지 않는다.
 *
 * 구조(보안 모델 docs/rbi.md §6·§7)
 *  - 미러 iframe: src=/rbi/<sid>/view, sandbox="allow-same-origin"(allow-scripts 없음) — 문서 CSP 가 script-src 'none'.
 *    스크립트는 이 부모(rbi 출처의 단독 앱)에만 있고, lib/rbiMirror 의 MirrorClient 가 contentDocument 에 DOM 을 조립한다(문자열 → DOM 싱크 없음).
 *  - 원격의 alert/confirm/prompt·파일 선택·내려받기는 신뢰 크롬(우리 대화상자·토스트)으로 묻는다 — 원격 페이지는 iframe 경계 밖에 닿지 못한다.
 *  - 키보드·한글 IME 는 부모의 숨은 입력칸이 받는다(imeHost). 미러 안에는 포커스 가능한 요소가 없다. focus() 로 그 칸에 포커스를 준다.
 */
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { useI18n } from '~/i18n'
import { addToast, toast } from '~/composables/useToast'
import { alertBox, confirmBox, promptBox } from '~/composables/useDialog'
import { rbiMirrorUrls, type RbiSession } from '~/composables/useRbi'
import { MirrorClient, type MirrorNotice } from '~/lib/rbiMirror/mirror-client'
import type { DocInfo, PolicyInfo } from '~/lib/rbiMirror/vocab'

export interface RbiMirrorConn { connected: boolean; reason?: string; rtt: number }

export interface RbiMirrorHandle {
  /** 키보드 포커스를 격리 화면(숨은 입력칸)으로 */
  focus: () => void
}

export interface RbiMirrorViewProps {
  session: RbiSession
  /** 원격 문서 주소·제목이 바뀜(신뢰 크롬의 읽기 전용 주소) */
  onDoc?: (d: DocInfo) => void
  /** 에이전트가 알려 준 실제 강제 정책(hello) */
  onPolicy?: (p: PolicyInfo) => void
  /** 연결·지연(1초에 한 번까지) */
  onConn?: (c: RbiMirrorConn) => void
  /** 미러가 버거운 페이지(노드 상한) — 픽셀 모드로 바꾸라는 행동 */
  onSuggestPixel?: () => void
  ref?: Ref<RbiMirrorHandle>
}

function fmtSize(n: number | undefined): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 원격 파일 선택 요청 → 사용자 PC 의 파일 고르기(우리 숨은 input). 취소면 null */
function pickFiles(multi: boolean): Promise<File[] | null> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multi
    input.style.display = 'none'
    let done = false
    const finish = (v: File[] | null) => { if (done) return; done = true; input.remove(); resolve(v) }
    input.addEventListener('change', () => finish(input.files && input.files.length ? Array.from(input.files) : null))
    input.addEventListener('cancel', () => finish(null))
    document.body.appendChild(input)
    try { input.click() } catch { finish(null) }
    // 브라우저가 대화상자를 못 띄웠으면(사용자 동작이 너무 오래 전) 1분 뒤 정리 — 원격은 취소로 안다
    window.setTimeout(() => finish(null), 60_000)
  })
}

export function RbiMirrorView({ session, onDoc, onPolicy, onConn, onSuggestPixel, ref }: RbiMirrorViewProps) {
  const { t } = useI18n()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const imeRef = useRef<HTMLDivElement>(null)
  const clientRef = useRef<MirrorClient | null>(null)
  // 콜백은 최신 것을 부른다(클라이언트는 세션마다 한 번만 만든다)
  const cb = useRef({ onDoc, onPolicy, onConn, onSuggestPixel })
  cb.current = { onDoc, onPolicy, onConn, onSuggestPixel }
  const urls = rbiMirrorUrls(session)

  useImperativeHandle(ref, () => ({ focus: () => clientRef.current?.focusInput() }), [])

  useEffect(() => {
    if (!urls || !frameRef.current || !imeRef.current) return
    let lastStat = 0
    let conn: RbiMirrorConn = { connected: false, rtt: 0 }
    const setConn = (c: RbiMirrorConn) => {
      if (c.connected === conn.connected && c.rtt === conn.rtt && c.reason === conn.reason) return
      conn = c
      cb.current.onConn?.(c)
    }
    const notice = (n: MirrorNotice) => {
      const B = 'rbi.mirror.blocked.'
      switch (n.k) {
        case 'blocked-download': addToast('warning', t(B + 'download')); break
        case 'blocked-upload': addToast('warning', t(B + 'upload')); break
        case 'blocked-clip-in': addToast('warning', t(B + 'clipIn')); break
        case 'blocked-clip-out': addToast('warning', t(B + 'clipOut')); break
        case 'blocked-nav': toast({ type: 'warning', title: t(B + 'nav'), description: n.detail }); break
        case 'blocked-popup': toast({ type: 'info', title: t(B + 'popup'), description: n.detail }); break
        case 'download': {
          const href = n.id ? clientRef.current?.downloadUrl(n.id) : ''
          if (!href) break
          toast({
            type: 'info', title: t('rbi.mirror.download'), description: `${n.name ?? ''} ${fmtSize(n.size)}`.trim(),
            action: { label: t('rbi.mirror.downloadAction'), onClick: () => { const a = document.createElement('a'); a.href = href; a.download = n.name || 'download'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove() } },
          })
          break
        }
        case 'degraded': {
          const sp = cb.current.onSuggestPixel
          toast({ type: 'warning', title: t('rbi.mirror.degraded'), action: sp ? { label: t('rbi.mirror.switchToPixel'), onClick: sp } : undefined })
          break
        }
        case 'limit': toast({ type: 'warning', title: t('rbi.mirror.limit'), description: n.detail }); break
        default: break
      }
    }
    const client = new MirrorClient({
      iframe: frameRef.current,
      wsUrl: urls.ws,
      base: urls.base,
      imeHost: imeRef.current,
      onDoc: d => cb.current.onDoc?.(d),
      onPolicy: p => cb.current.onPolicy?.(p),
      onStats: s => { const now = performance.now(); if (now - lastStat < 1000) return; lastStat = now; setConn({ ...conn, connected: s.connected, rtt: s.rttMs }) },
      onConnection: (connected, reason) => setConn({ ...conn, connected, reason }),
      onNotice: notice,
      onDialog: async d => {
        const title = t('rbi.mirror.dialogTitle')
        if (d.k === 'alert') { await alertBox(d.msg, { title }); return { ok: true } }
        if (d.k === 'prompt') { const v = await promptBox(d.msg, { title, defaultValue: d.def ?? '' }); return v === null ? { ok: false } : { ok: true, text: v } }
        return { ok: await confirmBox(d.msg, { title, danger: d.k === 'beforeunload' }) }
      },
      onFileChooser: multi => pickFiles(multi),
    })
    clientRef.current = client
    client.start()
    return () => { client.stop(); clientRef.current = null }
    // 세션(=경로)이 바뀔 때만 새로 붙는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, urls?.ws])

  if (!urls) return null
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <iframe
        ref={frameRef}
        title={t('rbi.mirror.frameTitle', { name: session.target_name })}
        src={urls.view}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
      {/* 숨은 키보드·IME 입력칸이 여기 붙는다(MirrorClient) */}
      <div ref={imeRef} />
    </div>
  )
}
