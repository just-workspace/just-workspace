/**
 * 위키 실시간 공동 편집 (Yjs + 서버 릴레이 app/collab/relay.py) — Vue 판 components/wiki/WikiCollabEditor.vue 이식.
 *
 * 릴레이는 바이트를 그대로 중계할 뿐이라 동기화 규칙은 여기서 정한다. 프레임 첫 바이트가 종류:
 *   0 UPDATE        — 편집 변경분
 *   1 SYNC_REQUEST  — 접속 직후 "내 상태 벡터는 이거다, 모자란 걸 달라"
 *   2 SYNC_RESPONSE — 요청한 쪽에 모자란 변경분
 *   3 AWARENESS     — 프레즌스(누가 어디를 편집 중인지). 아바타·커서 이름표.
 *                     옛 클라이언트는 모르는 종류를 무시하므로 0~2 동작은 그대로다.
 *   4 ACCESS        — 서버가 이 소켓에만 보내는 제어 프레임: [4, 0|1] = 붙어 있는 동안 내 권한이 바뀜(0 읽기 전용 · 1 편집 가능).
 *                     권한이 아예 사라지면 서버가 닫힘 코드 4003 으로 끊는다 — 그때는 재접속하지 않는다.
 *
 * 본문 시드: 서버가 Yjs 상태를 저장하지 않으므로 방에 아무도 없으면 저장된 HTML 로 시작한다. **고정
 * clientID(0) 문서에 같은 HTML 을 넣어** 만든 변경분을 적용한다 — 동시에 들어온 사람끼리는 똑같은 Yjs
 * 항목(같은 id)을 만들므로 합쳐도 하나로 남는다.
 * 단, 방에 먼저 편집 중인 사람이 있으면 **시드하지 않고 그 사람의 상태(SYNC_RESPONSE)로 시작한다.**
 * 먼저 온 사람이 시드 뒤 타이핑한 내용은 그 사람 clientID 항목이라, 그게 저장된 HTML 로 다시 시드하면
 * 같은 글이 다른 항목으로 두 벌이 된다(늦게 합류한 쪽 본문 중복·편집 유실 회귀). 그래서 접속 직후
 * SYNC_WAIT_MS 동안 응답을 기다리고, 본문이 담긴 응답이 오면 시드를 건너뛴다. 기다리는 동안은 편집을 막는다.
 * (Vue 판과 바이트 단위로 같은 프로토콜 — 두 판이 한 방에서 같이 편집된다.)
 *
 * 툴바·저장 표시는 호스트(pages/wiki)가 그린다.
 *  - Vue defineExpose({ getContent, save, editor, connected, peers, scrollToHeading }) → ref 핸들(같은 이름).
 *  - Vue 는 노출한 editor·connected·peers 가 반응형이라 호스트가 그대로 그렸다 — React 는 onUpdateState 로 알린다.
 *  - 내 손으로 바꾼 변경은 onChange 로 올려 호스트가 자동 저장한다.
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Editor, EditorContent, generateJSON } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
// v3 Collaboration 은 y-prosemirror 포크인 @tiptap/y-tiptap 을 쓴다 — 시드 변환도 같은 구현을 써야 한 가지 바인딩만 남는다
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
/** 서버가 "권한 없음" 으로 끊을 때의 닫힘 코드(backend wiki/collab.py) */
const CLOSE_FORBIDDEN = 4003
const SEED_ORIGIN = 'seed'
const REMOTE_ORIGIN = 'remote'
/** 접속 뒤 먼저 온 사람의 상태를 기다리는 시간 — 응답이 없으면 혼자라고 보고 저장본으로 시드 */
export const SYNC_WAIT_MS = 700
/** 접속이 아예 안 될 때(릴레이 꺼짐) 저장본으로 시작하기까지 */
export const CONNECT_WAIT_MS = 2500

// 프레즌스 색(success·warning 링). 디자인 토큰에서 고른다 — 사용자 id 해시로.
// awareness 로는 토큰을 푼 #rrggbb 를 보낸다: TipTap v3(y-tiptap 커서 플러그인·CollaborationCaret)는 user.color 가
// #rrggbb 가 아니면 경고를 찍고 투명으로 그린다(원격 awareness 값을 스타일에 그대로 꽂던 구멍을 막은 것).
const PEER_TOKENS = ['--success', '--warning', '--primary'] as const
// 토큰을 못 푸는 환경(테스트 DOM 등)에서 쓰는 값 — 다크 시안의 success·warning, 기본 브랜드색
const PEER_FALLBACK_HEX = ['#3eb17e', '#e0a22e', '#3b82f6']
const HEX_RE = /^#[0-9a-fA-F]{6}$/

function rgbToHex(rgb: string): string | null {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(rgb)
  if (!m) return null
  return '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')
}

/** 디자인 토큰 i 번째를 지금 테마의 #rrggbb 로. 못 풀면 고정값 */
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
 * 상대가 보낸 색을 안전한 #rrggbb 로. 옛(Vue) 클라이언트는 토큰 문자열(hsl(var(--success)))을 보내므로
 * 같은 토큰을 내 쪽에서 풀어 쓴다. 그 밖의 값(임의 문자열)은 첫 색으로 — 스타일에 그대로 들어가지 않는다.
 */
export function safePeerColor(color: unknown): string {
  if (typeof color === 'string') {
    if (HEX_RE.test(color)) return color
    const i = PEER_TOKENS.findIndex(t => color === `hsl(var(${t}))`)
    if (i >= 0) return peerTokenHex(i)
  }
  return peerTokenHex(0)
}

/** 다른 사람의 커서(2px 세로선 + 이름표) — 클래스는 v3 기본(collaboration-carets__*)과 같아 wiki.css 가 그대로 입는다 */
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

/** 다른 사람의 선택 영역 — 배경을 그 사람 색으로(투명도는 wiki.css .ProseMirror-yjs-selection) */
export function renderPeerSelection(user: { color?: unknown }): { class: string; style: string } {
  return { class: 'ProseMirror-yjs-selection', style: `background-color: ${safePeerColor(user.color)}` }
}

export interface WikiPeer { id: string; name: string; color: string; initial: string }

/** ref 로 쓰는 것(Vue defineExpose). editor·connected·peers 는 읽는 시점의 값 */
export interface WikiCollabEditorHandle {
  getContent: () => string
  save: () => void
  scrollToHeading: (index: number) => void
  readonly editor: Editor | null
  readonly connected: boolean
  readonly peers: WikiPeer[]
}

/** onUpdateState 로 알리는 반응형 값(Vue 판에서 호스트가 editorRef.value?.x 로 읽던 것) */
export interface WikiCollabState { editor: Editor | null; connected: boolean; peers: WikiPeer[] }

export interface WikiCollabEditorProps {
  pageId: string
  /** 저장된 HTML — 고정 clientID(0) 시드로 넣는다(편집기를 만들 때 한 번) */
  initialContent: string
  readonly: boolean
  /** save() 를 부르면 본문 HTML */
  onSave?: (content: string) => void
  /** 내가 바꾼 변경(원격·시드 제외) — 호스트가 자동 저장 디바운스 */
  onChange?: () => void
  /** editor·connected·peers 가 바뀔 때 */
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
 * 위키 공동 편집기(본문만). 툴바는 호스트가 onUpdateState 로 받은 editor 로 <UiEditorToolbar> 를 그린다.
 * @example <WikiCollabEditor ref={editorRef} pageId={id} initialContent={html} readonly={false} onChange={onEditorChange} onUpdateState={setCollab} />
 */
export function WikiCollabEditor({ pageId, initialContent, readonly, onSave, onChange, onUpdateState, ref }: WikiCollabEditorProps) {
  const { t } = useI18n()
  // 빈 본문 자리표시 — CSS content 는 따옴표 붙은 문자열이어야 해서 JSON.stringify
  const emptyPlaceholderCss = JSON.stringify(t('wiki.collab.placeholder'))

  const [editor, setEditor] = useState<Editor | null>(null)
  const [connected, setConnected] = useState(false)
  const [peers, setPeers] = useState<WikiPeer[]>([])

  const editorRef = useRef<Editor | null>(null)
  const ydocRef = useRef<Y.Doc | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const awarenessRef = useRef<Awareness | null>(null)
  const connectedRef = useRef(false)
  // 본문 준비(시드했거나 방 상태를 받음) — 그 전엔 편집 막음
  const readyRef = useRef(false)
  const seedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 붙어 있는 동안 서버가 권한을 거둠 — 'read' 편집만 막힘(강등), 'none' 볼 권한도 없음(끊김, 재접속 안 함).
  // 호스트의 readonly 와 별개로 편집을 막는다(호스트는 강등을 모른 채 readonly=false 를 계속 준다)
  const revokedRef = useRef<null | 'read' | 'none'>(null)
  const extensionsRef = useRef<any[]>([])
  const peersRef = useRef<WikiPeer[]>([])
  const latest = useRef({ initialContent, readonly, onChange, onSave, onUpdateState, pageId })
  latest.current = { initialContent, readonly, onChange, onSave, onUpdateState, pageId }

  function setConn(v: boolean) { connectedRef.current = v; setConnected(v) }
  function setPeerList(v: WikiPeer[]) { peersRef.current = v; setPeers(v) }
  function setEd(v: Editor | null) { editorRef.current = v; setEditor(v) }

  function getWsUrl(): string {
    // 웹은 현재 창 주소 기준(Vue 판과 같다), 번들 앱은 apiBase 호스트 — lib/runtimeConfig wsUrl
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
      if (seen.has(key)) return   // 같은 사람의 다른 탭
      seen.add(key)
      list.push({ id: key, name: u.name, color: safePeerColor(u.color), initial: String(u.name).trim().charAt(0) })
    })
    setPeerList(list)
  }

  /** 저장된 HTML 을 고정 clientID(0) 로 만든 변경분으로 넣는다. 모든 클라이언트가 같은 항목을 만든다. */
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

  /** 본문 준비 완료 — seed=true 면 저장본으로 시드(혼자일 때), false 면 방 상태를 받은 것 */
  function markReady(doc: Y.Doc, seed: boolean) {
    if (readyRef.current || doc !== ydocRef.current) return
    readyRef.current = true
    clearSeedTimer()
    if (seed) seedFromHtml(doc, extensionsRef.current)
    applyEditable()
  }

  /** 편집 가능 = 호스트가 허용 + 서버가 권한을 거두지 않음 */
  function applyEditable() {
    editorRef.current?.setEditable(!latest.current.readonly && !revokedRef.current)
  }

  /** 서버가 알린 권한 변화 — 편집을 막고(또는 다시 풀고) 한 번 안내한다 */
  function setRevoked(next: null | 'read' | 'none') {
    if (revokedRef.current === next) return
    revokedRef.current = next
    if (readyRef.current) applyEditable()
    if (next === 'none') addToast('error', i18n.t('wiki.collab.accessGone', '이 문서를 볼 권한이 없어졌습니다. 실시간 연결을 끊었습니다.'))
    else if (next === 'read') addToast('warning', i18n.t('wiki.collab.accessReadonly', '이 문서를 편집할 권한이 없어졌습니다. 읽기 전용으로 바뀝니다.'))
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
      // 먼저 와 있던 사람의 편집을 받아 온다(재접속이면 끊긴 동안의 것도)
      socket.send(frame(MSG_SYNC_REQUEST, Y.encodeStateVector(doc)))
      // 끊긴 사이에 내가 친 것은 어디로도 가지 않았다(소켓이 닫혀 있어 버려진다) — 내 상태를 통째로 한 번 보낸다.
      // 안 보내면 상대는 그 변경을 영영 못 받고, 그 뒤 내 편집도 앞선 구조가 없어 상대 쪽에서 보류된다
      // (화면이 갈라진 채 서로의 자동 저장이 번갈아 덮어쓴다). Yjs 적용은 멱등이라 이미 가진 쪽에는 무해하고,
      // 크기는 문서 하나(본문 + 편집 이력)라 재접속 때 한 번 보내기에 부담 없다. 본문 준비 전(빈 문서)엔 보낼 것이 없다.
      if (readyRef.current) socket.send(frame(MSG_UPDATE, Y.encodeStateAsUpdate(doc)))
      // 아직 본문 전이면 응답을 잠깐 기다린다 — 안 오면 혼자, 저장본으로 시드
      scheduleSeed(doc, SYNC_WAIT_MS)
      // 내 프레즌스를 알린다
      const awareness = awarenessRef.current
      if (awareness) socket.send(frame(MSG_AWARENESS, encodeAwarenessUpdate(awareness, [awareness.clientID])))
    }

    socket.onclose = (ev?: CloseEvent) => {
      setConn(false)
      // 본문 준비 전에 끊겼으면 기다리지 않고 저장본으로 시작
      markReady(doc, true)
      // 권한이 없어져 서버가 끊은 것 — 다시 붙어 봐야 거절만 반복된다. 읽기 전용으로 두고 멈춘다
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
          // 먼저 온 사람이 본문을 보내 줬다 — 그 상태로 시작(시드하면 두 벌)
          if (!readyRef.current && doc.getXmlFragment('default').length > 0) markReady(doc, false)
        } else if (type === MSG_SYNC_REQUEST) {
          // 상대에게 모자란 만큼만 돌려준다. 릴레이가 방 전체에 뿌리지만 Yjs 적용은 멱등이라 무해하다.
          const diff = Y.encodeStateAsUpdate(doc, body)
          if (socket.readyState === WebSocket.OPEN) socket.send(frame(MSG_SYNC_RESPONSE, diff))
          // 새로 온 사람에게 내 프레즌스도 다시 알린다
          if (awareness) socket.send(frame(MSG_AWARENESS, encodeAwarenessUpdate(awareness, [awareness.clientID])))
        } else if (type === MSG_AWARENESS) {
          if (awareness) applyAwarenessUpdate(awareness, body, REMOTE_ORIGIN)
        } else if (type === MSG_ACCESS) {
          // 서버만 보낸다(서버는 클라이언트가 보낸 이 종류를 중계하지 않는다)
          if (doc === ydocRef.current) setRevoked(body[0] === 1 ? null : 'read')
        }
      } catch (e) {
        console.debug('Yjs apply error:', e)
      }
    }

    // Broadcast local updates to peers (시드는 모두가 똑같이 만들므로 보내지 않는다)
    const updateHandler = (update: Uint8Array, origin: any) => {
      if (origin !== REMOTE_ORIGIN && origin !== SEED_ORIGIN && socket.readyState === WebSocket.OPEN) {
        socket.send(frame(MSG_UPDATE, update))
      }
    }
    doc.on('update', updateHandler)
    // 내 커서·상태가 바뀌면(y-protocols 가 15초마다 갱신도 해 준다) 방에 알린다
    const awarenessHandler = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: any) => {
      const awareness = awarenessRef.current
      if (origin === REMOTE_ORIGIN || !awareness || socket.readyState !== WebSocket.OPEN) return
      socket.send(frame(MSG_AWARENESS, encodeAwarenessUpdate(awareness, added.concat(updated, removed))))
    }
    const awarenessAtConnect = awarenessRef.current
    awarenessAtConnect?.on('update', awarenessHandler)
    // Vue 판은 close 때 그 시점의 awareness 에서 off — 같은 객체(재접속은 같은 문서·같은 awareness)
    socket.addEventListener('close', () => { doc.off('update', updateHandler); awarenessRef.current?.off('update', awarenessHandler) })
  }

  function cleanup() {
    clearSeedTimer()
    readyRef.current = false
    revokedRef.current = null   // 다른 문서로 가면 그 문서의 권한으로 새로 시작
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
    // CollaborationCaret 이 이 user 객체를 그대로 awareness 'user' 로 다시 쓴다 — id 까지 같이 넘긴다(같은 사람 여러 탭 묶기)
    const myUser = { id: me?.id ?? '', name: myName, color: colorFor(me?.id ?? myName) }
    awareness.setLocalStateField('user', myUser)
    awareness.on('change', refreshPeers)

    const extensions = [
      StarterKit.configure({
        undoRedo: false, // Yjs handles undo/redo (v2 의 history: false)
        // v3 StarterKit 은 밑줄·링크를 기본 포함한다(따로 넣으면 중복 등록 경고). 링크는 편집 중 클릭으로 열지 않는다
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
    // content 옵션은 쓰지 않는다 — Collaboration 과 함께 쓰면 클라이언트마다 본문을 따로 넣는다(중복 원인)
    // 본문 준비(markReady) 전에는 편집을 막는다 — 시드 전에 친 글이 시드와 섞이지 않게
    const ed = new Editor({ editable: false, extensions })
    setEd(ed)
    // 접속이 안 되면(릴레이 꺼짐) 조금 기다렸다 저장본으로
    scheduleSeed(doc, CONNECT_WAIT_MS)

    // 내 손으로 바꾼 변경만 호스트에 알린다(자동 저장). 원격·시드 변경은 상대가 저장한다.
    doc.on('update', (_u: Uint8Array, origin: any) => {
      if (origin !== REMOTE_ORIGIN && origin !== SEED_ORIGIN) latest.current.onChange?.()
    })

    // Connect WebSocket for real-time sync
    connectWs(doc)
  }

  function getContent(): string {
    // 본문 준비 전(방 상태 기다리는 중)엔 편집기가 비어 있다 — 저장본을 돌려줘 빈 본문이 저장되지 않게
    if (!readyRef.current) return latest.current.initialContent || ''
    return editorRef.current?.getHTML() || ''
  }

  // onMounted(initEditor) + watch(pageId, initEditor) + onUnmounted(cleanup)
  useEffect(() => {
    initEditor()
    return () => cleanup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId])

  // watch(readonly) — 첫 값은 편집기를 만들 때 이미 반영
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
