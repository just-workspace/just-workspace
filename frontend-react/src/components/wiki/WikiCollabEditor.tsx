/**
 * 위키 실시간 공동 편집 (Yjs + 서버 릴레이 app/collab/relay.py).
 *
 * 릴레이는 바이트를 그대로 중계할 뿐이므로 동기화 규칙은 본 모듈에서 정의한다. 프레임 첫 바이트가 종류:
 *   0 UPDATE        — 편집 변경분
 *   1 SYNC_REQUEST  — 접속 직후 자신의 상태 벡터를 전달하고 부족분을 요청
 *   2 SYNC_RESPONSE — 요청 측에 부족한 변경분
 *   3 AWARENESS     — 프레즌스(편집 중인 사용자와 위치). 아바타·커서 이름표.
 *                     구 클라이언트는 미지의 종류를 무시하므로 0~2 동작은 동일하다.
 *   4 ACCESS        — 서버가 해당 소켓에만 송신하는 제어 프레임: [4, 0|1] = 접속 중 본인 권한 변경(0 읽기 전용 · 1 편집 가능).
 *                     권한이 완전히 소멸하면 서버가 닫힘 코드 4003 으로 연결을 종료한다 — 이 경우 재접속하지 않는다.
 *
 * 본문 시드: 서버가 Yjs 상태를 저장하지 않으므로 방에 접속자가 없으면 저장된 HTML 로 시작한다. **고정
 * clientID(0) 문서에 동일 HTML 을 삽입하여** 생성한 변경분을 적용한다 — 동시 접속자 간에는 동일한 Yjs
 * 항목(같은 id)이 생성되므로 병합해도 하나로 유지된다.
 * 단, 방에 먼저 편집 중인 사용자가 있으면 **시드하지 않고 해당 사용자의 상태(SYNC_RESPONSE)로 시작한다.**
 * 선행 접속자가 시드 이후 입력한 내용은 해당 접속자의 clientID 항목이므로, 그 내용이 저장된 HTML 로 재시드하면
 * 동일한 글이 상이한 항목으로 중복된다(후행 합류 측 본문 중복·편집 유실 회귀). 따라서 접속 직후
 * SYNC_WAIT_MS 동안 응답을 대기하고, 본문이 포함된 응답을 수신하면 시드를 생략한다. 대기 중에는 편집을 차단한다.
 *
 * 툴바·저장 표시는 호스트(pages/wiki)가 렌더링한다.
 *  - ref 핸들: getContent · save · editor · connected · peers · scrollToHeading.
 *  - editor·connected·peers 변경 시 onUpdateState 로 통지한다(호스트가 렌더링).
 *  - 로컬 사용자가 직접 수행한 변경은 onChange 로 전달하여 호스트가 자동 저장한다.
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Editor, EditorContent, generateJSON } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
// v3 Collaboration 은 y-prosemirror 포크인 @tiptap/y-tiptap 을 사용한다 — 시드 변환도 동일 구현을 사용해야 바인딩이 단일로 유지된다
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { useI18n, i18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { wsUrl, wsProtocols } from '~/lib/runtimeConfig'
import './wiki.css'

const MSG_UPDATE = 0
const MSG_SYNC_REQUEST = 1
const MSG_SYNC_RESPONSE = 2
const MSG_AWARENESS = 3
const MSG_ACCESS = 4
/** 서버가 "권한 없음" 으로 연결을 종료할 때의 닫힘 코드(backend wiki/collab.py) */
const CLOSE_FORBIDDEN = 4003
const SEED_ORIGIN = 'seed'
const REMOTE_ORIGIN = 'remote'
/** 접속 후 선행 접속자의 상태를 대기하는 시간 — 응답이 없으면 단독 접속으로 간주하고 저장본으로 시드 */
export const SYNC_WAIT_MS = 700
/** 접속 자체가 불가할 때(릴레이 중지) 저장본으로 시작하기까지의 대기 시간 */
export const CONNECT_WAIT_MS = 2500

// 프레즌스 색(success·warning 링). 사용자 id 해시로 디자인 토큰에서 선택한다.
// awareness 로는 토큰을 해석한 #rrggbb 를 송신한다: TipTap v3(y-tiptap 커서 플러그인·CollaborationCaret)는 user.color 가
// #rrggbb 가 아니면 경고를 출력하고 투명으로 렌더링한다(원격 awareness 값을 스타일에 그대로 삽입하던 취약점을 차단한 조치).
const PEER_TOKENS = ['--success', '--warning', '--primary'] as const
// 토큰 해석이 불가한 환경(테스트 DOM 등)에서 사용하는 값 — 다크 시안의 success·warning, 기본 브랜드색
const PEER_FALLBACK_HEX = ['#3eb17e', '#e0a22e', '#3b82f6']
const HEX_RE = /^#[0-9a-fA-F]{6}$/

function rgbToHex(rgb: string): string | null {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(rgb)
  if (!m) return null
  return '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')
}

/** 디자인 토큰 i 번째를 현재 테마의 #rrggbb 로 변환. 해석 실패 시 고정값 */
export function peerTokenHex(i: number): string {
  const idx = ((i % PEER_TOKENS.length) + PEER_TOKENS.length) % PEER_TOKENS.length
  try {
    const el = document.createElement('span')
    el.style.color = `hsl(var(${PEER_TOKENS[idx]}))`
    document.body.appendChild(el)
    const hex = rgbToHex(getComputedStyle(el).color)
    el.remove()
    if (hex) return hex
  } catch { /* DOM 없음 */ }
  return PEER_FALLBACK_HEX[idx]
}

/**
 * 상대가 송신한 색을 안전한 #rrggbb 로 변환한다. 구 클라이언트는 토큰 문자열(hsl(var(--success)))을 송신하므로
 * 동일 토큰을 로컬에서 해석하여 사용한다. 그 외의 값(임의 문자열)은 첫 번째 색으로 대체한다 — 스타일에 그대로 삽입되지 않는다.
 */
export function safePeerColor(color: unknown): string {
  if (typeof color === 'string') {
    if (HEX_RE.test(color)) return color
    const i = PEER_TOKENS.findIndex(t => color === `hsl(var(${t}))`)
    if (i >= 0) return peerTokenHex(i)
  }
  return peerTokenHex(0)
}

/** 타 사용자의 커서(2px 세로선 + 이름표) — 클래스가 v3 기본(collaboration-carets__*)과 동일하여 wiki.css 가 그대로 적용된다 */
export function renderPeerCaret(user: { name?: unknown; color?: unknown }): HTMLElement {
  const color = safePeerColor(user.color)
  const cursor = document.createElement('span')
  cursor.classList.add('collaboration-carets__caret')
  cursor.style.borderColor = color
  const label = document.createElement('div')
  label.classList.add('collaboration-carets__label')
  label.style.backgroundColor = color
  label.textContent = typeof user.name === 'string' ? user.name : ''
  cursor.appendChild(label)
  return cursor
}

/** 타 사용자의 선택 영역 — 배경을 해당 사용자의 색으로 지정(투명도는 wiki.css .ProseMirror-yjs-selection) */
export function renderPeerSelection(user: { color?: unknown }): { class: string; style: string } {
  return { class: 'ProseMirror-yjs-selection', style: `background-color: ${safePeerColor(user.color)}` }
}

export interface WikiPeer { id: string; name: string; color: string; initial: string }

/** ref 로 노출하는 항목. editor·connected·peers 는 읽는 시점의 값 */
export interface WikiCollabEditorHandle {
  getContent: () => string
  save: () => void
  scrollToHeading: (index: number) => void
  readonly editor: Editor | null
  readonly connected: boolean
  readonly peers: WikiPeer[]
}

/** onUpdateState 로 통지하는 값(호스트가 렌더링 시 참조) */
export interface WikiCollabState { editor: Editor | null; connected: boolean; peers: WikiPeer[] }

export interface WikiCollabEditorProps {
  pageId: string
  /** 저장된 HTML — 고정 clientID(0) 시드로 삽입한다(편집기 생성 시 1회) */
  initialContent: string
  readonly: boolean
  /** save() 호출 시 본문 HTML 전달 */
  onSave?: (content: string) => void
  /** 로컬 사용자의 변경(원격·시드 제외) — 호스트가 자동 저장 디바운스 */
  onChange?: () => void
  /** editor·connected·peers 변경 시 */
  onUpdateState?: (state: WikiCollabState) => void
  ref?: Ref<WikiCollabEditorHandle | null>
}

function colorFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return peerTokenHex(h % PEER_TOKENS.length)
}

function frame(type: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(payload.length + 1)
  out[0] = type
  out.set(payload, 1)
  return out
}

/**
 * 위키 공동 편집기(본문만). 툴바는 호스트가 onUpdateState 로 수신한 editor 로 <UiEditorToolbar> 를 렌더링한다.
 * @example <WikiCollabEditor ref={editorRef} pageId={id} initialContent={html} readonly={false} onChange={onEditorChange} onUpdateState={setCollab} />
 */
export function WikiCollabEditor({ pageId, initialContent, readonly, onSave, onChange, onUpdateState, ref }: WikiCollabEditorProps) {
  const { t } = useI18n()
  // 빈 본문 자리표시 — CSS content 는 따옴표로 감싼 문자열이어야 하므로 JSON.stringify 적용
  const emptyPlaceholderCss = JSON.stringify(t('wiki.collab.placeholder'))

  const [editor, setEditor] = useState<Editor | null>(null)
  const [connected, setConnected] = useState(false)
  const [peers, setPeers] = useState<WikiPeer[]>([])

  const editorRef = useRef<Editor | null>(null)
  const ydocRef = useRef<Y.Doc | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const awarenessRef = useRef<Awareness | null>(null)
  const connectedRef = useRef(false)
  // 본문 준비(시드 완료 또는 방 상태 수신) — 그 이전에는 편집 차단
  const readyRef = useRef(false)
  const seedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 접속 중 서버가 권한을 회수함 — 'read' 편집만 차단(강등), 'none' 열람 권한도 없음(연결 종료, 재접속하지 않음).
  // 호스트의 readonly 와 별개로 편집을 차단한다(호스트는 강등을 인지하지 못한 채 readonly=false 를 계속 전달한다)
  const revokedRef = useRef<null | 'read' | 'none'>(null)
  const extensionsRef = useRef<any[]>([])
  const peersRef = useRef<WikiPeer[]>([])
  const latest = useRef({ initialContent, readonly, onChange, onSave, onUpdateState, pageId })
  latest.current = { initialContent, readonly, onChange, onSave, onUpdateState, pageId }

  function setConn(v: boolean) { connectedRef.current = v; setConnected(v) }
  function setPeerList(v: WikiPeer[]) { peersRef.current = v; setPeers(v) }
  function setEd(v: Editor | null) { editorRef.current = v; setEditor(v) }

  function getWsUrl(): string {
    // 웹은 현재 창 주소 기준, 번들 앱은 apiBase 호스트 — lib/runtimeConfig wsUrl
    return wsUrl(`/ws/wiki/collab?page_id=${latest.current.pageId}`)
  }

  function refreshPeers() {
    const awareness = awarenessRef.current
    if (!awareness) { setPeerList([]); return }
    const mine = awareness.clientID
    const seen = new Set<string>()
    const list: WikiPeer[] = []
    awareness.getStates().forEach((state, clientId) => {
      const u = state?.user
      if (clientId === mine || !u?.name) return
      const key = u.id || u.name
      if (seen.has(key)) return   // 동일 사용자의 다른 탭
      seen.add(key)
      list.push({ id: key, name: u.name, color: safePeerColor(u.color), initial: String(u.name).trim().charAt(0) })
    })
    setPeerList(list)
  }

  /** 저장된 HTML 을 고정 clientID(0) 로 생성한 변경분으로 삽입한다. 모든 클라이언트가 동일한 항목을 생성한다. */
  function seedFromHtml(doc: Y.Doc, extensions: any[]) {
    const html = latest.current.initialContent || ''
    const ed = editorRef.current
    if (!html.trim() || !ed) return
    try {
      const seed = new Y.Doc()
      seed.clientID = 0
      const json = generateJSON(html, extensions)
      prosemirrorJSONToYXmlFragment(ed.schema, json, seed.getXmlFragment('default'))
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), SEED_ORIGIN)
      seed.destroy()
    } catch (e) {
      console.debug('wiki seed error:', e)
    }
  }

  function clearSeedTimer() {
    if (seedTimer.current) { clearTimeout(seedTimer.current); seedTimer.current = null }
  }

  /** 본문 준비 완료 — seed=true 면 저장본으로 시드(단독 접속 시), false 면 방 상태를 수신한 경우 */
  function markReady(doc: Y.Doc, seed: boolean) {
    if (readyRef.current || doc !== ydocRef.current) return
    readyRef.current = true
    clearSeedTimer()
    if (seed) seedFromHtml(doc, extensionsRef.current)
    applyEditable()
  }

  /** 편집 가능 = 호스트가 허용 + 서버가 권한을 회수하지 않음 */
  function applyEditable() {
    editorRef.current?.setEditable(!latest.current.readonly && !revokedRef.current)
  }

  /** 서버가 통지한 권한 변경 — 편집을 차단(또는 재허용)하고 1회 안내한다 */
  function setRevoked(next: null | 'read' | 'none') {
    if (revokedRef.current === next) return
    revokedRef.current = next
    if (readyRef.current) applyEditable()
    if (next === 'none') addToast('error', i18n.t('wiki.collab.accessGone', '이 문서를 볼 권한이 없어졌습니다. 실시간 연결을 끊었습니다.'))
    else if (next === 'read') addToast('warning', i18n.t('wiki.collab.accessReadonly', '이 문서를 편집할 권한이 없어졌습니다. 읽기 전용으로 변경됩니다.'))
  }

  function scheduleSeed(doc: Y.Doc, ms: number) {
    if (readyRef.current) return
    clearSeedTimer()
    seedTimer.current = setTimeout(() => markReady(doc, true), ms)
  }

  function connectWs(doc: Y.Doc) {
    const socket = new WebSocket(getWsUrl(), wsProtocols())
    socket.binaryType = 'arraybuffer'
    wsRef.current = socket

    socket.onopen = () => {
      setConn(true)
      // 선행 접속자의 편집을 수신한다(재접속이면 단절 중의 변경분 포함)
      socket.send(frame(MSG_SYNC_REQUEST, Y.encodeStateVector(doc)))
      // 단절 중 로컬에서 입력한 내용은 어디에도 전달되지 않았다(소켓이 닫혀 있어 폐기됨) — 로컬 상태 전체를 1회 송신한다.
      // 송신하지 않으면 상대는 해당 변경을 영구히 수신하지 못하고, 이후 로컬 편집도 선행 구조가 없어 상대 측에서 보류된다
      // (화면이 불일치한 상태로 양측의 자동 저장이 번갈아 덮어쓴다). Yjs 적용은 멱등이므로 이미 보유한 측에는 무해하며,
      // 크기는 문서 하나(본문 + 편집 이력)이므로 재접속 시 1회 송신에 부담이 없다. 본문 준비 전(빈 문서)에는 송신할 내용이 없다.
      if (readyRef.current) socket.send(frame(MSG_UPDATE, Y.encodeStateAsUpdate(doc)))
      // 본문 준비 전이면 응답을 잠시 대기한다 — 미수신 시 단독 접속으로 간주하고 저장본으로 시드
      scheduleSeed(doc, SYNC_WAIT_MS)
      // 로컬 프레즌스 통지
      const awareness = awarenessRef.current
      if (awareness) socket.send(frame(MSG_AWARENESS, encodeAwarenessUpdate(awareness, [awareness.clientID])))
    }

    socket.onclose = (ev?: CloseEvent) => {
      setConn(false)
      // 본문 준비 전에 연결이 종료되면 대기 없이 저장본으로 시작
      markReady(doc, true)
      // 권한 소멸로 서버가 연결을 종료한 경우 — 재접속해도 거부만 반복된다. 읽기 전용으로 두고 중지한다
      if (ev?.code === CLOSE_FORBIDDEN) {
        if (doc === ydocRef.current) setRevoked('none')
        return
      }
      // Reconnect after 3s
      setTimeout(() => {
        if (ydocRef.current && !ydocRef.current.isDestroyed) {
          connectWs(doc)
        }
      }, 3000)
    }

    socket.onmessage = (event) => {
      try {
        const data = new Uint8Array(event.data)
        if (!data.length) return
        const type = data[0]
        const body = data.subarray(1)
        const awareness = awarenessRef.current
        if (type === MSG_UPDATE || type === MSG_SYNC_RESPONSE) {
          Y.applyUpdate(doc, body, REMOTE_ORIGIN)
          // 선행 접속자가 본문을 전달함 — 해당 상태로 시작(시드 시 중복 발생)
          if (!readyRef.current && doc.getXmlFragment('default').length > 0) markReady(doc, false)
        } else if (type === MSG_SYNC_REQUEST) {
          // 상대에게 부족한 분량만 반환한다. 릴레이가 방 전체에 전달하지만 Yjs 적용은 멱등이므로 무해하다.
          const diff = Y.encodeStateAsUpdate(doc, body)
          if (socket.readyState === WebSocket.OPEN) socket.send(frame(MSG_SYNC_RESPONSE, diff))
          // 신규 접속자에게 로컬 프레즌스도 재통지한다
          if (awareness) socket.send(frame(MSG_AWARENESS, encodeAwarenessUpdate(awareness, [awareness.clientID])))
        } else if (type === MSG_AWARENESS) {
          if (awareness) applyAwarenessUpdate(awareness, body, REMOTE_ORIGIN)
        } else if (type === MSG_ACCESS) {
          // 서버만 송신한다(서버는 클라이언트가 송신한 이 종류를 중계하지 않는다)
          if (doc === ydocRef.current) setRevoked(body[0] === 1 ? null : 'read')
        }
      } catch (e) {
        console.debug('Yjs apply error:', e)
      }
    }

    // Broadcast local updates to peers (시드는 모든 클라이언트가 동일하게 생성하므로 송신하지 않는다)
    const updateHandler = (update: Uint8Array, origin: any) => {
      if (origin !== REMOTE_ORIGIN && origin !== SEED_ORIGIN && socket.readyState === WebSocket.OPEN) {
        socket.send(frame(MSG_UPDATE, update))
      }
    }
    doc.on('update', updateHandler)
    // 로컬 커서·상태 변경 시(y-protocols 가 15초 간격으로 갱신도 수행한다) 방에 통지한다
    const awarenessHandler = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: any) => {
      const awareness = awarenessRef.current
      if (origin === REMOTE_ORIGIN || !awareness || socket.readyState !== WebSocket.OPEN) return
      socket.send(frame(MSG_AWARENESS, encodeAwarenessUpdate(awareness, added.concat(updated, removed))))
    }
    const awarenessAtConnect = awarenessRef.current
    awarenessAtConnect?.on('update', awarenessHandler)
    // close 시 해당 시점의 awareness 에서 off — 동일 객체(재접속은 동일 문서·동일 awareness)
    socket.addEventListener('close', () => { doc.off('update', updateHandler); awarenessRef.current?.off('update', awarenessHandler) })
  }

  function cleanup() {
    clearSeedTimer()
    readyRef.current = false
    revokedRef.current = null   // 다른 문서로 이동하면 해당 문서의 권한으로 새로 시작
    const awareness = awarenessRef.current
    if (awareness) {
      try { removeAwarenessStates(awareness, [awareness.clientID], 'local') } catch { /* 이미 닫힘 */ }
      awareness.destroy()
      awarenessRef.current = null
    }
    setPeerList([])
    editorRef.current?.destroy()
    setEd(null)
    wsRef.current?.close()
    wsRef.current = null
    ydocRef.current?.destroy()
    ydocRef.current = null
    setConn(false)
  }

  function initEditor() {
    cleanup()

    const doc = new Y.Doc()
    ydocRef.current = doc
    const awareness = new Awareness(doc)
    awarenessRef.current = awareness
    const me = authStore.getState().user
    const myName = me?.display_name || me?.username || i18n.t('wiki.collab.me')
    // CollaborationCaret 이 이 user 객체를 그대로 awareness 'user' 로 재기록한다 — id 도 함께 전달한다(동일 사용자의 여러 탭 묶음용)
    const myUser = { id: me?.id ?? '', name: myName, color: colorFor(me?.id ?? myName) }
    awareness.setLocalStateField('user', myUser)
    awareness.on('change', refreshPeers)

    const extensions = [
      StarterKit.configure({
        undoRedo: false, // Yjs handles undo/redo (v2 의 history: false)
        // v3 StarterKit 은 밑줄·링크를 기본 포함한다(별도 추가 시 중복 등록 경고). 링크는 편집 중 클릭으로 열지 않는다
        link: { openOnClick: false },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      Table.configure({ resizable: false }),
      TableRow, TableHeader, TableCell,
      Collaboration.configure({
        document: doc,
      }),
      CollaborationCaret.configure({
        provider: { awareness },
        user: myUser,
        render: renderPeerCaret,
        selectionRender: renderPeerSelection,
      }),
    ]
    extensionsRef.current = extensions
    // content 옵션은 사용하지 않는다 — Collaboration 과 병용하면 클라이언트마다 본문을 개별 삽입한다(중복 원인)
    // 본문 준비(markReady) 전에는 편집을 차단한다 — 시드 전 입력이 시드와 섞이는 것을 방지
    const ed = new Editor({ editable: false, extensions })
    setEd(ed)
    // 접속 불가 시(릴레이 중지) 일정 시간 대기 후 저장본으로 시작
    scheduleSeed(doc, CONNECT_WAIT_MS)

    // 로컬 사용자의 변경만 호스트에 통지한다(자동 저장). 원격·시드 변경은 상대 측이 저장한다.
    doc.on('update', (_u: Uint8Array, origin: any) => {
      if (origin !== REMOTE_ORIGIN && origin !== SEED_ORIGIN) latest.current.onChange?.()
    })

    // Connect WebSocket for real-time sync
    connectWs(doc)
  }

  function getContent(): string {
    // 본문 준비 전(방 상태 대기 중)에는 편집기가 비어 있다 — 빈 본문이 저장되지 않도록 저장본을 반환
    if (!readyRef.current) return latest.current.initialContent || ''
    return editorRef.current?.getHTML() || ''
  }

  // onMounted(initEditor) + watch(pageId, initEditor) + onUnmounted(cleanup)
  useEffect(() => {
    initEditor()
    return () => cleanup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId])

  // watch(readonly) — 첫 값은 편집기 생성 시 이미 반영됨
  const firstReadonly = useRef(true)
  useEffect(() => {
    if (firstReadonly.current) { firstReadonly.current = false; return }
    if (readyRef.current) applyEditable()
  }, [readonly])

  // 반응형 노출 값 알림
  useEffect(() => {
    latest.current.onUpdateState?.({ editor, connected, peers })
  }, [editor, connected, peers])

  useImperativeHandle(ref, () => ({
    getContent,
    save: () => { latest.current.onSave?.(getContent()) },
    /** n 번째 제목(h1~h3)으로 스크롤 — 오른쪽 레일 목차 클릭 */
    scrollToHeading: (index: number) => {
      const el = editorRef.current?.view.dom.querySelectorAll('h1, h2, h3')[index] as HTMLElement | undefined
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    },
    get editor() { return editorRef.current },
    get connected() { return connectedRef.current },
    get peers() { return peersRef.current },
  }), [])

  if (!editor) return null
  return (
    <EditorContent
      editor={editor}
      className="wiki-collab-editor prose max-w-none break-words text-[15px] leading-[1.75] dark:prose-invert"
      style={{ ['--wiki-collab-placeholder' as string]: emptyPlaceholderCss }}
    />
  )
}

export default WikiCollabEditor
