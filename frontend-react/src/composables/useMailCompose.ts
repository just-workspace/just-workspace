/**
 * 플로팅 메일 작성 창.
 *
 * - 데스크톱: 앱 내 우측 하단 580×640 창. 다중 열기 가능하며 창별 최소화(제목 줄만)·크게 보기 지원.
 *   팝업(window.open) 은 폐지.
 * - 모바일(≤767): 전체 화면 페이지 `/mail/compose` 로 이동한다(창 구성 불가).
 * - 창 호스트(MailComposeHost)는 앱 루트(토스트·대화상자 호스트 옆)에 위치한다 — 어느 화면에서 열어도
 *   해당 위치에 표시되며, 메일 화면을 벗어나도(레이아웃이 변경되어도) 창과 작성 중인 내용이 유지된다.
 *   `/mail?compose=…`(외부 링크·/mail/compose 데스크톱 진입)도 계속 수신한다.
 * - 받는 사람 사전 입력: open('new', null, null, { to }) · `/mail/compose?mode=new&to=…`
 *
 * 상태는 모듈 싱글턴(mailComposeStore).
 * React: const { windows, hasWindows, open, close, ... } = useMailCompose()
 * 컴포넌트 외부: import { openCompose, closeCompose, ... } from '~/composables/useMailCompose'
 *   (모듈 수준 이름은 타 모듈과의 충돌을 피해 Compose 를 덧붙였다)
 *
 * 로그아웃(user → null) 시 창을 비운다 —
 * 본 모듈이 authStore 구독으로 수행한다.
 */
import { createStore, useStore } from 'zustand'
import type { ComposeMode, MessageDetail } from '~/composables/useMail'
import { isMobileNow } from '~/composables/useIsMobile'
import { authStore } from '~/composables/useAuth'
import { navigateTo } from '~/lib/router'
import { i18n } from '~/i18n'

export interface ComposeWindow {
  id: string
  mode: ComposeMode
  /** 답장·전달 원문 id */
  msgId?: string
  /** 원문(목록에서 열려 있던 것). 없으면 창이 msgId 로 조회한다 */
  original?: Readonly<MessageDetail> | null
  draftId?: string | null
  /** 새 메일 받는 사람 사전 입력(쉼표로 다수 지정) */
  to?: string
  /** 화면 내 AI 답장 초안 — 본문에 입력하고, 발송 시 X-AI-Generated 를 추가한다 */
  aiDraft?: string
  /** 제목 줄 — 제목 입력 변경 시 갱신 */
  title: string
  minimized: boolean
  maximized: boolean
}

export const mailComposeStore = createStore<{ windows: ComposeWindow[] }>()(() => ({ windows: [] }))

/**
 * 앱 초안(DB) 변경 횟수 — 작성기가 저장·삭제·발송 시 증가시킨다. 임시보관함 목록이 이 값을 감시해 재조회한다
 * (이전에는 폴더 진입 시에만 조회하여, 발송한 초안이 목록에 남고 방금 닫은 초안은 표시되지 않았다).
 */
export const mailDraftsStore = createStore<{ rev: number }>()(() => ({ rev: 0 }))
export function bumpMailDrafts() { mailDraftsStore.setState({ rev: mailDraftsStore.getState().rev + 1 }) }
let seq = 0

/** 동시에 펼쳐 둘 창 수. 초과 시 오래된 것부터 최소화(시안에 수치 없음 — 580 폭 × 2 가 1440 에서 겹치지 않는 한도). */
const MAX_EXPANDED = 2

const getWindows = () => mailComposeStore.getState().windows
const setWindows = (windows: ComposeWindow[]) => mailComposeStore.setState({ windows })

/** 테스트용: 창을 비우고 번호도 초기화 */
export function _resetMailComposeStore() {
  seq = 0
  setWindows([])
  pendingAiDrafts.clear()
}

/**
 * 모바일 전체 화면 작성(/mail/compose)으로 전달할 AI 초안 — 본문을 주소에 포함하지 않고 원문 id 로 임시 보관한다.
 * 작성 화면이 takeAiDraft 로 1회 인출한다.
 */
const pendingAiDrafts = new Map<string, string>()
export function takeAiDraft(msgId: string | null | undefined): string | undefined {
  if (!msgId) return undefined
  const d = pendingAiDrafts.get(msgId)
  pendingAiDrafts.delete(msgId)
  return d
}

function buildQuery(mode: ComposeMode, msgId?: string, draftId?: string | null, to?: string) {
  const params = new URLSearchParams({ mode })
  if (msgId && mode !== 'new' && mode !== 'draft') params.set('msgId', msgId)
  if (draftId) params.set('draftId', draftId)
  if (to && mode === 'new') params.set('to', to)
  return params
}

export function defaultTitle(mode: ComposeMode, subject?: string | null) {
  const t = i18n.t
  const base = subject || ''
  switch (mode) {
    case 'reply':
    case 'replyAll':
      return base ? (base.startsWith('Re:') ? base : `Re: ${base}`) : t('mail.compose.reply')
    case 'forward':
      return base ? (base.startsWith('Fwd:') ? base : `Fwd: ${base}`) : t('mail.compose.forward')
    case 'resend':
      return base || t('mail.compose.resend')
    case 'draft':
      return base || t('mail.compose.draftTitle')
    default:
      return base || t('mail.compose.new')
  }
}

/** 펼친 창이 한도를 초과하면 오래된 것부터 최소화한 새 배열 */
function capExpanded(list: ComposeWindow[]): ComposeWindow[] {
  const expanded = list.filter(w => !w.minimized)
  if (expanded.length <= MAX_EXPANDED) return list
  const fold = new Set(expanded.slice(0, expanded.length - MAX_EXPANDED).map(w => w.id))
  return list.map(w => (fold.has(w.id) ? { ...w, minimized: true } : w))
}

/**
 * 작성 창 열기. 모바일이면 전체 화면 페이지로, 데스크톱이면 현재 화면의 플로팅 창으로 연다.
 * 동일 원문에 동일 모드의 창이 이미 있으면 해당 창을 펼친다(중복 답장 창 방지).
 */
export function openCompose(mode: ComposeMode = 'new', msg?: Readonly<MessageDetail> | null, draftId?: string | null, opts: { to?: string; aiDraft?: string } = {}): string | null {
  const params = buildQuery(mode, msg?.id, draftId, opts.to)
  if (isMobileNow()) {
    if (opts.aiDraft && msg?.id) {
      pendingAiDrafts.set(msg.id, opts.aiDraft)
      params.set('ai', '1')
    }
    navigateTo(`/mail/compose?${params.toString()}`)
    return null
  }
  // AI 초안을 입력하는 창은 항상 새로 연다(작성 중인 답장 창의 내용을 덮어쓰지 않도록)
  if (mode !== 'new' && !opts.aiDraft) {
    const key = draftId ? `d:${draftId}` : `m:${msg?.id}`
    const existing = getWindows().find(w => w.mode === mode && (w.draftId ? `d:${w.draftId}` : `m:${w.msgId}`) === key)
    if (existing) {
      setWindows(getWindows().map(w => (w.id === existing.id ? { ...w, minimized: false } : w)))
      return existing.id
    }
  }
  const id = `compose-${++seq}`
  setWindows(capExpanded([...getWindows(), {
    id, mode,
    msgId: msg?.id,
    original: msg ?? null,
    draftId: draftId ?? null,
    to: mode === 'new' ? opts.to : undefined,
    aiDraft: opts.aiDraft,
    title: defaultTitle(mode, msg?.subject),
    minimized: false,
    maximized: false,
  }]))
  return id
}

/** `/mail?compose=mode%3Dreply%26msgId%3D…` 와 같이 쿼리로 전달된 요청을 연다. */
export function openComposeFromQuery(raw: string) {
  const p = new URLSearchParams(raw)
  const mode = (p.get('mode') as ComposeMode) || 'new'
  const msgId = p.get('msgId') || undefined
  const draftId = p.get('draftId') || undefined
  const to = (mode === 'new' && p.get('to')) || undefined
  if (isMobileNow()) {
    navigateTo(`/mail/compose?${p.toString()}`)
    return
  }
  if (mode !== 'new') {
    const existing = getWindows().find(w => w.mode === mode && (draftId ? w.draftId === draftId : w.msgId === msgId))
    if (existing) {
      setWindows(getWindows().map(w => (w.id === existing.id ? { ...w, minimized: false } : w)))
      return
    }
  }
  const id = `compose-${++seq}`
  setWindows(capExpanded([...getWindows(), { id, mode, msgId, original: null, draftId: draftId ?? null, to, title: defaultTitle(mode), minimized: false, maximized: false }]))
}

export function closeCompose(id: string) {
  setWindows(getWindows().filter(w => w.id !== id))
}

export function setComposeMinimized(id: string, v: boolean) {
  const list = getWindows()
  if (!list.find(x => x.id === id)) return
  let next = list.map(x => (x.id === id ? { ...x, minimized: v, ...(v ? {} : { maximized: false }) } : x))
  if (!v) {
    const expanded = next.filter(x => !x.minimized && x.id !== id)
    if (expanded.length >= MAX_EXPANDED) {
      const fold = new Set(expanded.slice(0, expanded.length - MAX_EXPANDED + 1).map(x => x.id))
      next = next.map(x => (fold.has(x.id) ? { ...x, minimized: true } : x))
    }
  }
  setWindows(next)
}

export function toggleComposeMaximized(id: string) {
  const w = getWindows().find(x => x.id === id)
  if (!w) return
  const maximized = !w.maximized
  // 크게 보기는 1개만 허용 — 나머지는 최소화
  setWindows(getWindows().map((x) => {
    if (x.id === id) return { ...x, maximized }
    return maximized ? { ...x, minimized: true } : x
  }))
}

export function setComposeTitle(id: string, title: string) {
  const w = getWindows().find(x => x.id === id)
  if (w) setWindows(getWindows().map(x => (x.id === id ? { ...x, title: title || defaultTitle(x.mode) } : x)))
}

export function setComposeDraftId(id: string, draftId: string | null) {
  const w = getWindows().find(x => x.id === id)
  if (w) setWindows(getWindows().map(x => (x.id === id ? { ...x, draftId } : x)))
}

/** 로그아웃 시 — 다음 사용자에게 창이 남지 않도록 */
export function resetCompose() { setWindows([]) }

// user 가 변경되어 null 이 될 때만 창을 비운다
authStore.subscribe((s, prev) => {
  if (s.user !== prev.user && !s.user) resetCompose()
})

/** 상태 + 동작 */
export function useMailCompose() {
  const windows = useStore(mailComposeStore, s => s.windows)
  return {
    windows,
    hasWindows: windows.length > 0,
    open: openCompose,
    openFromQuery: openComposeFromQuery,
    close: closeCompose,
    setMinimized: setComposeMinimized,
    toggleMaximized: toggleComposeMaximized,
    setTitle: setComposeTitle,
    setDraftId: setComposeDraftId,
    defaultTitle,
    reset: resetCompose,
  }
}
