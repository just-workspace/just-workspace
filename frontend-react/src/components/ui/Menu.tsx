/**
 * 드롭다운 메뉴("⋮ 메뉴 = 데스크톱 드롭다운, 터치 액션 시트(같은 항목·같은 순서)" · 그림자 shadow-md).
 *  데스크톱 — 팝오버: rounded-lg · border · bg-popover · shadow-md · p-1 · 폭 224 · 항목 36(dense 32) · 아이콘 16 · 13px.
 *  모바일   — UiActionSheet(바닥 시트, 항목 48). sheet={false} 면 모바일에서도 팝오버.
 * 두 가지로 연다.
 *  ① 트리거형: trigger({ toggle, open, controls }) 함수(Vue #trigger 스코프 슬롯) 또는 기본 ⋯ 아이콘 버튼. 열림 상태는 이 부품이 가진다.
 *  ② 기준형: anchor(DOMRect·요소)를 주고 부모가 조건부로 붙였다 뗀다(우클릭·트리 노드 ⋯). 마운트 = 열림, 닫힘은 onClose.
 * 키보드: ↑↓ Home End 이동 · Enter/Space 실행 · Esc 닫고 트리거로 포커스 · Tab 닫기 · 글자 입력 = 타입어헤드(앞글자 일치).
 * 바깥 클릭: 트리거형은 문서 pointerdown(클릭이 밑 요소까지 간다), 기준형은 투명 막(우클릭도 닫음).
 * ref 로 { toggle, open, close } 를 쓸 수 있다(Vue defineExpose 와 같음).
 *
 * 확장:
 *  ① 항목 description — 이름 아래 한 줄(12 muted, truncate). 비활성 이유 등.
 *  ② 하위 메뉴 — 항목 children. 오른쪽 › 표시, → / Enter / 클릭으로 열고 ← / Esc 로 닫아 부모 항목으로 돌아간다.
 *     마우스는 150ms 머물면 열리고, 다른 항목으로 옮기면 250ms 뒤 닫힌다(대각선으로 옮겨 가는 동안 닫히지 않게).
 *     자리가 없으면 반대쪽으로 뒤집는다(subSide 로 처음 방향). 하위 항목을 고르면 onSelect(하위 key) 후 메뉴 전체가 닫힌다.
 *     모바일 시트에서는 눌러서 한 단계 들어가고 맨 위 "뒤로" 로 나온다.
 *  ③ 자유 내용 — 메뉴 위쪽 content 슬롯, 또는 항목 panel(하위 메뉴 자리에 여는 펼침 패널 — 상태 메시지 편집처럼 입력이 들어간다).
 *     자유 내용 안에서는 메뉴 키보드(↑↓·타입어헤드·Tab 닫기)를 쓰지 않는다 — 입력이 글자를 받고, Tab 은 그 패널 안을 돈다
 *     (포커스 트랩 예외), Esc 는 패널(또는 메뉴)을 닫는다. 패널 안 처음 포커스는 data-autofocus → 첫 포커스 가능 요소.
 *
 * 고른 뒤 닫힘:
 *  · 실행형 항목(checked 없음)·링크(to)·단일 선택(radio — 정렬·보기·권한처럼 묶음에서 하나만) = 고르면 닫힌다.
 *  · 다중 토글(checked 만 있고 radio 아님 — "광고 숨기기"처럼 켜고 끄기) = 메뉴가 열린 채(연달아 여러 개를 켜고 끈다).
 *  · 메뉴 단위 closeOnSelect(true = 모두 닫힘 · false = 모두 열린 채), 항목 단위 keepOpen 이 그보다 우선(링크는 늘 닫힘).
 *  · 클릭·Enter/Space·모바일 시트·하위 메뉴 항목 모두 같은 규칙.
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import { toCssRect, viewportCss } from '~/composables/useViewport'
import { navigateTo } from '~/lib/router'
import { UiIcon } from './Icon'
import { UiIconButton } from './IconButton'
import { UiBadge } from './Badge'
import { UiKeycap } from './Keycap'
import { UiActionSheet } from './ActionSheet'
import { FOCUSABLE, menuItemRole, menuKeepsOpen, useUid } from './internal'

/** 모바일 시트 "뒤로" 항목 key */
const SHEET_BACK = '__ui-menu-back'

/** 자유 내용(content·panel) 안에서 일어난 키 입력인가 */
function inFree(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[data-menu-free]')
}

/** 자유 내용(panel·content) 함수가 받는 것 */
export interface UiMenuPanelApi {
  /** 메뉴 전체 닫기 */
  close: () => void
  /** 하위 패널만 닫고 부모 항목으로(content 에서는 close 와 같음) */
  back: () => void
}

export interface UiMenuItem {
  key: string
  label: string
  /** utils/icons.ts 아이콘 이름 */
  icon?: string
  /** 위험 항목(삭제 등) — danger 글자 */
  danger?: boolean
  disabled?: boolean
  /** 정의하면 menuitemcheckbox(radio 면 menuitemradio) — true 면 ✓ 와 굵게. 다중 토글은 골라도 메뉴가 열린 채 */
  checked?: boolean
  /** 단일 선택 묶음의 항목(정렬·보기·권한처럼 하나만 고름) — menuitemradio, 고르면 닫힌다. checked 와 같이 쓴다 */
  radio?: boolean
  /** 고른 뒤 메뉴를 열어 둘지(메뉴 closeOnSelect·기본 규칙보다 우선). 링크(to) 항목은 늘 닫힌다 */
  keepOpen?: boolean
  /** 오른쪽 보조 글자(mono 11, 예: 단축키 "E" · 개수) */
  hint?: string
  /** 오른쪽 단축키 키캡(데스크톱 팝오버에서만) */
  keys?: string[]
  /** 오른쪽 배지(예: "준비 중") */
  badge?: string
  /** 이 항목 위에 구분선 */
  separated?: boolean
  /** 링크 항목 — 고르면 onSelect 를 부른 뒤 이 경로로 이동한다 */
  to?: string
  /** 묶음 머리(고를 수 없는 소제목 — 예: "상태" "정렬") */
  heading?: boolean
  /** 이름 아래 한 줄 설명(12 muted, truncate — 비활성 이유 등) */
  description?: string
  /** 하위 메뉴 항목(→ 로 연다). 있으면 이 항목은 고르지 않고 하위 메뉴를 연다 */
  children?: UiMenuItem[]
  /** 하위 메뉴 자리에 여는 자유 내용 패널(입력 등). 함수면 { close, back } 을 받는다 */
  panel?: ReactNode | ((api: UiMenuPanelApi) => ReactNode)
  /** 하위 메뉴·패널 폭 px(기본 = 메뉴 폭) */
  panelWidth?: number
}

/** trigger 함수가 받는 것(Vue #trigger 슬롯 스코프) */
export interface UiMenuTriggerScope {
  /** 열기/닫기 */
  toggle: () => void
  /** 지금 열림 */
  open: boolean
  /** 메뉴 패널 id(aria-controls 에) */
  controls: string
}

/** ref 로 쓰는 것(Vue defineExpose) */
export interface UiMenuHandle {
  toggle: () => void
  open: () => void
  close: (returnFocus?: boolean) => void
}

export interface UiMenuProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onSelect' | 'content'> {
  /** 항목(필수) */
  items: UiMenuItem[]
  /** 메뉴(와 기본 트리거)의 접근성 이름. 기본 '메뉴'(common.menu) */
  label?: string
  /** 모바일 시트 머리글(데스크톱에서는 메뉴 접근성 이름) */
  title?: string
  /** 기준형: 이 위치에 연다(트리거 없음). undefined 면 트리거형. null = 기준 없음(화면 가운데) */
  anchor?: DOMRect | HTMLElement | null
  /** 기준 요소의 어느 끝에 맞출지 — end(기본) = 오른쪽 끝 */
  align?: 'start' | 'end'
  /** 아래(기본)/위. 자리가 없으면 반대로 뒤집는다 */
  side?: 'bottom' | 'top'
  /** 팝오버 폭 px(기본 224) */
  width?: number
  /** 항목 32(트리·밀집 목록) */
  dense?: boolean
  /** 모바일에서 바닥 시트로(기본 켬). false 면 모바일도 팝오버 */
  sheet?: boolean
  /** 기본 트리거 아이콘(기본 'more-horizontal') */
  triggerIcon?: string
  /** 기본 트리거 크기(기본 sm 32) */
  triggerSize?: 'sm' | 'md' | 'lg'
  /** 항목 고름 — 항목 key(하위 메뉴 항목이면 그 key) */
  onSelect?: (key: string) => void
  /** 닫힘 */
  onClose?: () => void
  /** 열림 */
  onOpen?: () => void
  /** 트리거 직접 그리기(Vue #trigger 스코프 슬롯) */
  trigger?: (scope: UiMenuTriggerScope) => ReactNode
  /** 모바일 시트 머리글 아이콘 자리(Vue #sheet-header 슬롯) */
  sheetHeader?: ReactNode
  /** 메뉴 위쪽 자유 내용(입력 등) — 항목 앞에 그린다. 함수면 { close, back } */
  content?: ReactNode | ((api: UiMenuPanelApi) => ReactNode)
  /** 하위 메뉴·패널이 처음 열리는 쪽(기본 right). 자리가 없으면 반대로 */
  subSide?: 'right' | 'left'
  /**
   * 고르면 닫을지. 안 주면 기본 규칙(실행형·radio 는 닫힘, 다중 토글 checked 는 열린 채).
   * true = 모든 항목 닫힘 · false = 모든 항목 열린 채. 항목 keepOpen 이 우선.
   */
  closeOnSelect?: boolean
  /** { toggle, open, close } */
  ref?: Ref<UiMenuHandle>
}

const hasSubOf = (it: UiMenuItem) => !!it.children || it.panel !== undefined


/**
 * 드롭다운 메뉴(모바일은 바닥 시트).
 * @example <UiMenu label="파일 메뉴" items={[{ key: 'rename', label: '이름 바꾸기', icon: 'edit' }, { key: 'delete', label: '삭제', icon: 'trash', danger: true, separated: true }]} onSelect={run} />
 * @example 하위 메뉴: items={[{ key: 'dnd', label: '방해 금지', children: [{ key: 'dnd-30', label: '30분' }, { key: 'dnd-60', label: '1시간' }] }]}
 * @example 펼침 패널: items={[{ key: 'status', label: '상태 메시지', panelWidth: 320, panel: ({ back }) => <StatusEditor onDone={back} /> }]} subSide="left"
 * @example 설명: { key: 'co-own', label: '공동 소유 지정', disabled: true, description: '원 소유자만 바꿀 수 있습니다' }
 * @example 단일 선택(닫힘): { key: 'date', label: '받은 날짜', radio: true, checked: sort === 'date' }
 * @example 다중 토글(열린 채): { key: 'ads', label: '광고 숨기기', checked: hideAds }
 */
export function UiMenu({
  items, label, title, anchor, align = 'end', side = 'bottom', width = 224, dense = false, sheet = true,
  triggerIcon = 'more-horizontal', triggerSize = 'sm', onSelect, onClose, onOpen, trigger, sheetHeader, content, subSide = 'right', closeOnSelect, ref, className, ...rest
}: UiMenuProps) {
  const { t } = useI18n()
  /** 기본 이름(label 미지정 시 '메뉴') — 로캘 전환에 반응 */
  const menuLabel = label ?? t('common.menu')

  const isMobile = useIsMobile()
  const anchored = anchor !== undefined
  const useSheet = sheet && isMobile

  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const uid = useUid('ui-menu')
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const pendingShow = useRef(false)

  // 리스너·타이머에서 최신 값을 읽는다
  const L = useRef({ anchor, anchored, useSheet, align, side, width, subSide, closeOnSelect, onSelect, onClose, onOpen })
  L.current = { anchor, anchored, useSheet, align, side, width, subSide, closeOnSelect, onSelect, onClose, onOpen }

  function anchorRect(): DOMRect | null {
    const a = L.current.anchor
    // 화면 배율(루트 zoom) 아래에서 사각형은 화면 좌표 → style 에 넣을 CSS px 로
    if (a instanceof HTMLElement) return toCssRect(a.getBoundingClientRect())
    if (a) return toCssRect(a)
    const r = rootRef.current?.getBoundingClientRect()
    return r ? toCssRect(r) : null
  }

  // 높이는 내용만큼(예전 max-h-80 은 우클릭 메뉴 끝 항목을 잘랐다). 화면보다 길 때만 화면 높이-16 에서 스크롤.
  // 위치는 아래 → 위로 뒤집기 → 그래도 넘치면 화면 안으로 끌어온다.
  function place() {
    if (L.current.useSheet) return
    const panel = panelRef.current
    if (!panel) return
    const { vw, vh } = viewportCss()
    const h = panel.offsetHeight
    const w = L.current.width
    const r = anchorRect()
    // 기준형인데 기준이 없으면(anchor=null — 모바일 전용 진입점이 데스크톱에서 열린 경우) 화면 가운데
    if (!r) { setPos({ left: Math.max(8, (vw - w) / 2), top: Math.max(8, (vh - h) / 2) }); return }
    let left = L.current.align === 'start' ? r.left : r.right - w
    left = Math.max(8, Math.min(left, vw - w - 8))
    const below = r.bottom + 4
    const above = r.top - 4 - h
    const sd = L.current.side
    let top = sd === 'top' ? above : below
    if (sd === 'top' && above < 8 && below + h <= vh - 8) top = below
    if (sd === 'bottom' && below + h > vh - 8 && above >= 8) top = above
    top = Math.max(8, Math.min(top, vh - h - 8))
    setPos({ left, top })
  }

  function menuItems(): HTMLElement[] {
    return Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])
  }

  function show() {
    if (openRef.current) return
    opener.current = document.activeElement as HTMLElement | null
    openRef.current = true
    pendingShow.current = true
    setOpen(true)
    setPos(null)
    L.current.onOpen?.()
  }

  // Vue nextTick(show 뒤): 자리 잡기 → 체크된 항목(현재 값)이 있으면 그리로, 없으면 첫 항목에 포커스
  // (content 에 data-autofocus 가 있으면 그것 — 입력이 들어간 메뉴)
  // 포커스는 자리가 잡혀 패널이 보인 뒤(pos 가 생긴 렌더)에 준다 — visibility:hidden 인 요소는 focus() 가 무시돼
  // 마우스로 연 메뉴에서 Esc·↑↓ 가 메뉴에 닿지 않던 문제(플러그인 검수에서 발견)
  const pendingFocus = useRef(false)
  useLayoutEffect(() => {
    if (!open || !pendingShow.current) return
    pendingShow.current = false
    pendingFocus.current = !L.current.useSheet
    place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useLayoutEffect(() => {
    if (!open || !pos || !pendingFocus.current) return
    pendingFocus.current = false
    const auto = panelRef.current?.querySelector<HTMLElement>('[data-menu-free] [data-autofocus]')
    ;(auto ?? menuItems().find(el => el.getAttribute('aria-checked') === 'true') ?? menuItems()[0])?.focus()
  }, [open, pos])

  // ── 하위 메뉴·펼침 패널(C6) ──
  const [sub, setSub] = useState<{ key: string; focus: boolean } | null>(null)
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null)
  const subRef = useRef<HTMLDivElement | null>(null)
  const subRow = useRef<HTMLElement | null>(null)
  const subTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const subItem = sub ? items.find(x => x.key === sub.key) : undefined
  const subUid = `${uid}-sub`
  // 모바일 시트: 하위 메뉴·패널은 한 단계 들어가서 보여 준다
  const [sheetPath, setSheetPath] = useState<string | null>(null)
  const sheetItem = sheetPath ? items.find(x => x.key === sheetPath) : undefined

  function clearSubTimer() { if (subTimer.current) { clearTimeout(subTimer.current); subTimer.current = null } }
  function openSub(it: UiMenuItem, row: HTMLElement, focus: boolean) {
    clearSubTimer()
    subRow.current = row
    setSubPos(null)
    setSub({ key: it.key, focus })
  }
  function closeSub(focusRow: boolean) {
    clearSubTimer()
    setSub(null)
    if (focusRow) subRow.current?.focus()
  }
  function hoverRow(it: UiMenuItem, row: HTMLElement) {
    clearSubTimer()
    const canSub = hasSubOf(it) && !it.disabled
    if (canSub && sub?.key === it.key) return
    if (canSub) subTimer.current = setTimeout(() => openSub(it, row, false), 150)
    else if (sub) subTimer.current = setTimeout(() => closeSub(false), 250)
  }
  function placeSub() {
    const panel = subRef.current, row = subRow.current, main = panelRef.current
    if (!panel || !row || !main) return
    const { vw, vh } = viewportCss()
    const r = toCssRect(row.getBoundingClientRect()), m = toCssRect(main.getBoundingClientRect())
    const w = panel.offsetWidth, h = panel.offsetHeight
    const right = m.right + 2, left = m.left - 2 - w
    const sd = L.current.subSide
    let x = sd === 'left' ? left : right
    if (sd === 'right' && right + w > vw - 8 && left >= 8) x = left
    if (sd === 'left' && left < 8 && right + w <= vw - 8) x = right
    x = Math.max(8, Math.min(x, vw - w - 8))
    const y = Math.max(8, Math.min(r.top - 5, vh - h - 8))
    setSubPos({ left: x, top: y })
  }
  useLayoutEffect(() => {
    if (!sub) return
    placeSub()
    if (sub.focus) {
      const el = subRef.current
      const target = el?.querySelector<HTMLElement>('[data-autofocus]')
        ?? el?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')
        ?? el?.querySelector<HTMLElement>(FOCUSABLE)
      target?.focus()
    }
  }, [sub])

  function close(returnFocus = true) {
    if (!openRef.current) return
    openRef.current = false
    setOpen(false)
    setSub(null)
    setSheetPath(null)
    clearSubTimer()
    L.current.onClose?.()
    if (returnFocus && !L.current.useSheet) {
      const trig = rootRef.current?.querySelector<HTMLElement>('button,[tabindex]')
      ;(L.current.anchored ? opener.current : (trig ?? opener.current))?.focus?.()
    }
  }

  function toggle() { if (openRef.current) close(); else show() }

  function pick(it: UiMenuItem) {
    if (it.disabled || it.heading) return
    if (hasSubOf(it)) {
      if (L.current.useSheet) { setSheetPath(it.key); return }
      const row = panelRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(it.key)}"]`)
      if (row) openSub(it, row, true)
      return
    }
    // select 를 먼저 — 기준형 부모는 close 에서 메뉴 상태를 비우므로(onSelect 가 사라지기 전에 부른다)
    L.current.onSelect?.(it.key)
    // 다중 토글은 열린 채(포커스도 그 항목에 그대로) — 연달아 켜고 끈다
    if (menuKeepsOpen(it, L.current.closeOnSelect)) return
    close()
    if (it.to) void navigateTo(it.to)
  }

  /** 자유 내용 안 Tab — 그 상자 안에서 돈다 */
  function trapTab(e: KeyboardEvent<HTMLElement>, box: HTMLElement | null) {
    const els = Array.from(box?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (!els.length) { e.preventDefault(); return }
    const first = els[0], last = els[els.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  function subItemEls(): HTMLElement[] {
    return Array.from(subRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])
  }
  function onSubKeydown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation()
    const free = subItem?.panel !== undefined
    if (e.key === 'Escape' || (e.key === 'ArrowLeft' && !free)) { e.preventDefault(); closeSub(true); return }
    if (free) { if (e.key === 'Tab') trapTab(e, subRef.current); return }
    const els = subItemEls()
    const i = els.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Tab') { close(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); els[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus() }
  }

  /** 하위 메뉴 항목 고름 — 같은 onSelect(하위 항목 key), 메뉴 전체 닫기(다중 토글은 열린 채) */
  function pickLeaf(it: UiMenuItem) {
    if (it.disabled || it.heading) return
    L.current.onSelect?.(it.key)
    if (menuKeepsOpen(it, L.current.closeOnSelect)) return
    close()
    if (it.to) void navigateTo(it.to)
  }

  const panelApi: UiMenuPanelApi = {
    close: () => close(),
    back: () => { if (sub) closeSub(true); else if (sheetPath) setSheetPath(null); else close() },
  }
  const renderFree = (c: ReactNode | ((api: UiMenuPanelApi) => ReactNode)) => (typeof c === 'function' ? (c as (api: UiMenuPanelApi) => ReactNode)(panelApi) : c)

  // ── 타입어헤드 ──
  const typed = useRef('')
  const typedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function typeahead(ch: string) {
    typed.current += ch.toLowerCase()
    if (typedTimer.current) clearTimeout(typedTimer.current)
    typedTimer.current = setTimeout(() => { typed.current = '' }, 500)
    const els = menuItems()
    if (!els.length) return
    const cur = els.indexOf(document.activeElement as HTMLElement)
    // 같은 글자를 거듭 치면 다음 일치로 돈다
    const tp = typed.current
    const same = tp.length > 1 && [...tp].every(c => c === tp[0])
    const needle = same ? tp[0] : tp
    const start = same || tp.length === 1 ? cur + 1 : Math.max(cur, 0)
    for (let k = 0; k < els.length; k++) {
      const el = els[(start + k) % els.length]
      if ((el.dataset.label ?? '').trim().toLowerCase().startsWith(needle)) { el.focus(); return }
    }
  }

  function onKeydown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    // 자유 내용(content) 안: 입력이 키를 받는다 — Tab 만 메뉴 안에서 돈다
    if (inFree(e.target)) { if (e.key === 'Tab') trapTab(e, panelRef.current); return }
    const els = menuItems()
    const cur = document.activeElement as HTMLElement | null
    const i = els.indexOf(cur as HTMLElement)
    const curItem = cur?.dataset.key !== undefined ? items.find(x => x.key === cur.dataset.key) : undefined
    if (e.key === 'Tab') { close(false) }
    else if (e.key === 'ArrowRight' && curItem && hasSubOf(curItem) && !curItem.disabled) { e.preventDefault(); openSub(curItem, cur!, true) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); els[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus() }
    else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeahead(e.key) }
  }

  // 문서 리스너는 마운트 동안 한 번 — 최신 함수를 부른다
  const fns = useRef({ show, close, place, placeSub })
  fns.current = { show, close, place, placeSub }
  useEffect(() => {
    // 트리거형 바깥 클릭
    const onDocPointer = (e: PointerEvent) => {
      if (!openRef.current || L.current.anchored || L.current.useSheet) return
      const tg = e.target as Node
      if (panelRef.current?.contains(tg) || rootRef.current?.contains(tg) || subRef.current?.contains(tg)) return
      fns.current.close(false)
    }
    const onViewport = () => { if (openRef.current) { fns.current.place(); fns.current.placeSub() } }
    document.addEventListener('pointerdown', onDocPointer, true)
    window.addEventListener('resize', onViewport)
    window.addEventListener('scroll', onViewport, true)
    if (L.current.anchored) fns.current.show()
    return () => {
      document.removeEventListener('pointerdown', onDocPointer, true)
      window.removeEventListener('resize', onViewport)
      window.removeEventListener('scroll', onViewport, true)
      if (typedTimer.current) clearTimeout(typedTimer.current)
      if (subTimer.current) clearTimeout(subTimer.current)
      // 기준형은 부모가 조건부로 떼므로 여기서 연 요소로 돌려준다
      if (L.current.anchored && openRef.current && !L.current.useSheet) opener.current?.focus?.()
    }
  }, [])

  // 항목 수가 바뀌면 자리 다시(Vue watch items.length → nextTick(place))
  const firstLen = useRef(true)
  useLayoutEffect(() => {
    if (firstLen.current) { firstLen.current = false; return }
    if (openRef.current) place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])

  useImperativeHandle(ref, () => ({ toggle, open: show, close }))

  const rowClass = cn(
    'flex w-full items-center gap-2 rounded-sm px-2.5 text-left text-[13px] outline-hidden transition-colors disabled:cursor-not-allowed disabled:opacity-40',
    dense ? 'h-8' : 'min-h-9',
  )

  return (
    /* 루트 하나(바깥 className 이 붙도록). 기준형은 자리를 차지하지 않는다(contents) */
    <div {...rest} ref={rootRef} className={cn(anchored ? 'contents' : 'relative inline-flex', className)}>
      {!anchored && (trigger
        ? trigger({ toggle, open, controls: uid })
        : (
          <UiIconButton
            label={menuLabel}
            icon={triggerIcon}
            size={triggerSize}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={uid}
            onClick={toggle}
          />
        ))}

      {/* 모바일: 바닥 시트 */}
      {open && useSheet && !sheetItem && (
        <UiActionSheet
          label={title || menuLabel}
          title={title}
          items={items}
          header={sheetHeader}
          onSelect={(k: string) => { const it = items.find(x => x.key === k); if (it) pick(it) }}
          onClose={() => close(false)}
        >
          {content != null && <div data-menu-free="" className="px-4 pt-2">{renderFree(content)}</div>}
        </UiActionSheet>
      )}
      {/* 모바일: 하위 메뉴·패널 한 단계 — 맨 위 "뒤로" */}
      {open && useSheet && sheetItem && (
        <UiActionSheet
          key={sheetItem.key}
          label={sheetItem.label}
          title={sheetItem.label}
          items={[{ key: SHEET_BACK, label: t('common.back'), icon: 'chevron-left' }, ...(sheetItem.children ?? [])]}
          onSelect={(k: string) => {
            if (k === SHEET_BACK) { setSheetPath(null); return }
            const c = sheetItem.children?.find(x => x.key === k)
            if (c) pickLeaf(c)
          }}
          onClose={() => close(false)}
        >
          {sheetItem.panel !== undefined && <div data-menu-free="" className="px-4 pt-2">{renderFree(sheetItem.panel)}</div>}
        </UiActionSheet>
      )}

      {/* 데스크톱: 팝오버 */}
      {open && !useSheet && createPortal(
        <>
          {anchored && <div className="fixed inset-0 z-overlay" aria-hidden="true" onClick={() => close(false)} onContextMenu={(e) => { e.preventDefault(); close(false) }} />}
          <div
            id={uid}
            ref={panelRef}
            role="menu"
            aria-label={title || menuLabel}
            className="fixed z-overlay max-h-[calc(100dvh-16px)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-foreground shadow-md"
            style={{ width: `${width}px`, left: `${pos?.left ?? 0}px`, top: `${pos?.top ?? 0}px`, visibility: pos ? 'visible' : 'hidden' }}
            onKeyDown={onKeydown}
          >
            {content != null && <div data-menu-free="" className="p-1.5">{renderFree(content)}</div>}
            {items.map(it => (
              <MenuRow
                key={it.key}
                it={it}
                rowClass={rowClass}
                onPick={pick}
                onHover={hoverRow}
                subOpen={sub?.key === it.key}
                subControls={sub?.key === it.key ? subUid : undefined}
              />
            ))}
          </div>
          {/* 하위 메뉴 / 펼침 패널 */}
          {subItem && (
            <div
              id={subUid}
              ref={subRef}
              role={subItem.panel !== undefined ? 'dialog' : 'menu'}
              aria-label={subItem.label}
              data-menu-free={subItem.panel !== undefined ? '' : undefined}
              className="fixed z-overlay max-h-[calc(100dvh-16px)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-foreground shadow-md"
              style={{ width: `${subItem.panelWidth ?? width}px`, left: `${subPos?.left ?? 0}px`, top: `${subPos?.top ?? 0}px`, visibility: subPos ? 'visible' : 'hidden' }}
              onKeyDown={onSubKeydown}
              onMouseEnter={clearSubTimer}
            >
              {subItem.panel !== undefined
                ? renderFree(subItem.panel)
                : (subItem.children ?? []).map(c => (
                  <MenuRow key={c.key} it={c} rowClass={rowClass} onPick={pickLeaf} />
                ))}
            </div>
          )}
        </>,
        document.body,
      )}
    </div>
  )
}

function MenuRow({ it, rowClass, onPick, onHover, subOpen, subControls }: {
  it: UiMenuItem
  rowClass: string
  onPick: (it: UiMenuItem) => void
  onHover?: (it: UiMenuItem, row: HTMLElement) => void
  subOpen?: boolean
  subControls?: string
}) {
  const hasSub = hasSubOf(it)
  return (
    <>
      {it.separated && <div className="-mx-1 my-1 h-px bg-border" role="separator" />}
      {it.heading
        ? <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold text-muted-foreground">{it.label}</p>
        : (
          <button
            type="button"
            role={menuItemRole(it)}
            aria-checked={it.checked}
            aria-haspopup={hasSub ? (it.panel !== undefined ? 'dialog' : 'menu') : undefined}
            aria-expanded={hasSub ? !!subOpen : undefined}
            aria-controls={subControls}
            disabled={it.disabled}
            data-label={it.label}
            data-key={it.key}
            className={cn(
              rowClass,
              it.description ? 'py-1.5' : '',
              it.danger ? 'text-danger hover:bg-danger/10 focus-visible:bg-danger/10' : 'hover:bg-accent focus-visible:bg-accent',
              subOpen ? 'bg-accent' : '',
            )}
            onClick={() => onPick(it)}
            onMouseEnter={onHover ? (e) => onHover(it, e.currentTarget) : undefined}
          >
            {it.icon && <UiIcon name={it.icon} className={cn('h-4 w-4 shrink-0', it.danger ? '' : 'text-muted-foreground')} />}
            {it.description
              ? (
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn('truncate', it.checked ? 'font-semibold' : '')}>{it.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{it.description}</span>
                </span>
              )
              : <span className={cn('min-w-0 flex-1 truncate', it.checked ? 'font-semibold' : '')}>{it.label}</span>}
            {it.badge && <UiBadge tone="neutral" tint size={18} className="shrink-0">{it.badge}</UiBadge>}
            {it.hint && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{it.hint}</span>}
            {!!it.keys?.length && <span className="flex shrink-0 gap-0.5">{it.keys.map(k => <UiKeycap key={k} size={20}>{k}</UiKeycap>)}</span>}
            {it.checked && <UiIcon name="check" className="h-3.5 w-3.5 shrink-0 text-primary" strokeWidth={2.4} />}
            {hasSub && <UiIcon name="chevron-right" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          </button>
        )}
    </>
  )
}

export default UiMenu
