/**
 * 하네스 — 에이전트 /dev/ 에서 서빙되는 부모 문서(개발 이미지 전용). React 없이 MirrorClient 를 띄우고
 * window.__mirror 로 측정값(지연 샘플·바이트·노드 수·글리프 폭)을 Playwright 벤치에 노출한다.
 * 운영 뷰어는 frontend-react 의 pages/rbi.tsx(같은 클라이언트 코드의 동기화 사본)다.
 */
import { MirrorClient, type LatencySample, type MirrorNotice, type MirrorStats } from '../src/mirror-client'

const iframe = document.getElementById('mirror') as HTMLIFrameElement
const base = location.pathname.replace(/\/dev\/.*$/, '') // '' 또는 '/rbi/<sid>'
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws'
iframe.src = `${base}/view`

const stEl = document.getElementById('st')!, urlEl = document.getElementById('url')!, dot = document.getElementById('dot')!
const samples: LatencySample[] = []
const notices: MirrorNotice[] = []
const dialogs: { k: string; msg: string }[] = []
let stats: MirrorStats | null = null
/** 벤치가 대화상자 답·올릴 파일을 미리 정해 둔다 */
let dialogAnswer: { ok: boolean; text?: string } = { ok: true }
let uploadFile: File | null = null

const client = new MirrorClient({
  iframe,
  wsUrl: `${wsProto}://${location.host}${base}/mirror`,
  base,
  imeHost: document.getElementById('imehost')!,
  onStats: s => {
    stats = s
    dot.style.background = s.connected ? '#4c4' : '#d44'
    stEl.textContent = `nodes ${s.nodes} · msgs ${s.msgs} · in ${(s.bytesIn / 1024).toFixed(0)}KB (inset ${(s.bytesInset / 1024).toFixed(0)}KB/${s.insetFrames}f) · snap ${s.lastSnapMs}ms · apply ${s.applyMs}ms · rtt ${s.rttMs}ms · rej ${s.rejected}/${s.rejectedNodes}`
  },
  onLatency: l => { samples.push(l) },
  onDoc: d => { urlEl.textContent = d.url; document.title = d.title ? `${d.title} — mirror` : 'mirror' },
  onNotice: n => { notices.push(n) },
  onDialog: async d => { dialogs.push({ k: d.k, msg: d.msg }); return dialogAnswer },
  onFileChooser: async () => (uploadFile ? [uploadFile] : null),
})
client.start()
document.getElementById('resync')!.addEventListener('click', () => client.resync())

;(window as unknown as { __mirror: unknown }).__mirror = {
  client,
  samples,
  notices,
  dialogs,
  setDialogAnswer(a: { ok: boolean; text?: string }) { dialogAnswer = a },
  setUpload(name: string, text: string) { uploadFile = new File([text], name, { type: 'text/plain' }) },
  get stats() { return stats },
  reset() { samples.length = 0 },
  /** 미러 텍스트 런의 로컬 실측 폭 vs 원격 폭(글리프 폭 드리프트) */
  glyphDrift() {
    const doc = iframe.contentDocument!
    const out: { t: string; remote: number; local: number; ff: string }[] = []
    doc.querySelectorAll<HTMLElement>('span.t[data-rw]').forEach(s => {
      const remote = parseFloat(s.dataset.rw || '0')
      if (!remote || !s.textContent) return
      const range = doc.createRange(); range.selectNodeContents(s)
      const local = range.getBoundingClientRect().width
      out.push({ t: s.textContent.slice(0, 40), remote, local: Math.round(local * 100) / 100, ff: (s.parentElement as HTMLElement).style.fontFamily.slice(0, 60) })
    })
    return out
  },
}
