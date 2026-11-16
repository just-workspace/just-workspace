/**
 * 화면 배율·실효 크기 — 앱 전역 단일.
 *
 * - 배율은 루트 한 곳(<html> 의 CSS zoom)에 적용한다. 레이아웃 판단은 배율 적용 후의 실효 폭·높이만으로 수행한다(lib/fluid).
 * - 자동 = min(폭 구간, 높이 구간). 설정 › 표시 › 화면 크기(자동·100·125·150·200·300%)에서 변경할 수 있다.
 *   실효 폭이 1280 미만이 되는 배율은 선택할 수 없으며, 화면 변경으로 범위를 벗어나면 자동으로 복귀시키고 토스트를 표시한다.
 *   기기별(localStorage ws.uiScale) — 계정 동기화 대상 아님.
 * - 모바일(<768)에는 배율을 적용하지 않는다.
 * - zoom 적용 시 vh·dvh·vw 는 배율만큼 커진다 → 빌드 시 postcss(viewportZoomUnits)가 `÷ var(--ui-zoom)` 로 변환한다.
 *   따라서 본 모듈에서 `--ui-zoom` 도 함께 설정한다.
 * - getBoundingClientRect·clientX 는 화면(배율 적용 후) 좌표이며, style.left/top 및 innerWidth 와 기준이 상이하다 →
 *   플로팅 부품(메뉴·툴팁·팝오버)은 toCssRect()/viewportCss() 로 CSS px 로 변환하여 사용한다.
 *
 * React: const { scale, width, height, portrait, low, pref } = useViewport()
 * 컴포넌트 외부: getUiZoom() · viewportStore.getState()
 */
import { useEffect, useState } from 'react'
import { createStore, useStore } from 'zustand'
import { effective, resolveScale, autoScale, uiScaleAllowed, MOBILE_MAX, UI_SCALE_CHOICES, type Effective, type UiScalePref } from '~/lib/fluid'
import { addToast } from '~/composables/useToast'
import { i18n } from '~/i18n'

const KEY = 'ws.uiScale'

interface ViewportState extends Effective {
  /** 창 CSS 크기(배율 적용 전 — window.innerWidth/innerHeight) */
  rawWidth: number
  rawHeight: number
  /** 설정 값 */
  pref: UiScalePref
  /** 이 화면의 자동 배율(설정 hint "자동: 이 화면에서 N%") */
  auto: number
}

function readPref(): UiScalePref {
  try {
    const v = localStorage.getItem(KEY)
    if (!v || v === 'auto') return 'auto'
    const n = Number(v)
    return (UI_SCALE_CHOICES as readonly (string | number)[]).includes(n) ? (n as UiScalePref) : 'auto'
  } catch { return 'auto' }
}

function compute(rawWidth: number, rawHeight: number, pref: UiScalePref): ViewportState {
  const scale = resolveScale(pref, rawWidth, rawHeight)
  const eff = effective(rawWidth, rawHeight, scale)
  // 낮은 화면 규칙은 데스크톱 셸 전용 — 모바일(가로로 회전한 휴대폰 등)에는 적용하지 않는다
  return { ...eff, low: eff.low && rawWidth > MOBILE_MAX, rawWidth, rawHeight, pref, auto: autoScale(rawWidth, rawHeight) }
}

const initW = typeof window !== 'undefined' ? window.innerWidth : 1440
const initH = typeof window !== 'undefined' ? window.innerHeight : 900
export const viewportStore = createStore<ViewportState>()(() => compute(initW, initH, 'auto'))

let _zoom = 1
/** 현재 루트 배율(1 = 없음) */
export function getUiZoom(): number { return _zoom }

/** <html data-vp-low> — Tailwind low: 변형(낮은 화면 띠 36 등) */
function applyFlags(low: boolean) {
  if (typeof document === 'undefined') return
  document.documentElement.toggleAttribute('data-vp-low', low)
}

function applyZoom(scale: number) {
  _zoom = scale
  if (typeof document === 'undefined') return
  const el = document.documentElement
  if (scale === 1) { el.style.removeProperty('zoom'); el.style.removeProperty('--ui-zoom') }
  else { el.style.setProperty('zoom', String(scale)); el.style.setProperty('--ui-zoom', String(scale)) }
}

/** 복귀 토스트 — 첫 렌더 전(언어 메시지 로드 전)에 복귀한 경우 메시지 로드 시까지 일시 대기한다 */
function notifyReverted(tries = 0) {
  const key = 'settings.display.uiScaleReverted'
  if (i18n.te(key) || tries >= 50) { addToast('info', i18n.t(key)); return }
  setTimeout(() => notifyReverted(tries + 1), 100)
}

function update(pref = viewportStore.getState().pref) {
  // 화면 변경으로 선택한 배율이 범위를 벗어나면(실효 폭 < 1280) 자동으로 복귀시킨다
  if (!uiScaleAllowed(pref, window.innerWidth)) {
    pref = 'auto'
    try { localStorage.setItem(KEY, 'auto') } catch { /* 이번 세션에만 적용 */ }
    notifyReverted()
  }
  const next = compute(window.innerWidth, window.innerHeight, pref)
  const cur = viewportStore.getState()
  if (next.scale !== _zoom) applyZoom(next.scale)
  applyFlags(next.low)
  if (cur.rawWidth !== next.rawWidth || cur.rawHeight !== next.rawHeight || cur.pref !== next.pref || cur.scale !== next.scale) {
    viewportStore.setState(next)
  }
}

let _installed = false
/** main.tsx 가 첫 렌더 전에 호출한다 — 첫 렌더부터 배율이 적용되도록 */
export function installViewportListener() {
  if (_installed || typeof window === 'undefined') return
  _installed = true
  update(readPref())
  window.addEventListener('resize', () => update())
  // 다른 탭에서 변경한 값도 반영한다
  window.addEventListener('storage', (e) => { if (e.key === KEY) update(readPref()) })
}

/** 설정 › 표시 › 화면 크기 — 즉시 적용 + 이 기기에 저장 */
export function setUiScalePref(pref: UiScalePref) {
  try { localStorage.setItem(KEY, String(pref)) } catch { /* 저장 실패 시에도 이번 세션에는 적용 */ }
  if (typeof window === 'undefined') { viewportStore.setState({ pref }); return }
  update(pref)
}

export function useViewport(): ViewportState {
  return useStore(viewportStore)
}

// ── 좌표 변환(플로팅 부품용) ──

export interface CssRect { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number }

/** getBoundingClientRect·clientX 계열(화면 좌표) → position:fixed 의 style 에 넣을 CSS px */
export function toCssRect(r: { left: number; top: number; width: number; height: number }): DOMRect {
  const z = _zoom
  const left = r.left / z, top = r.top / z, width = r.width / z, height = r.height / z
  if (z === 1 && typeof DOMRect !== 'undefined' && r instanceof DOMRect) return r
  const out: CssRect = { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }
  return out as unknown as DOMRect
}

/** 화면 좌표 한 점 → CSS px */
export function toCssPoint(x: number, y: number): { x: number; y: number } {
  return { x: x / _zoom, y: y / _zoom }
}

/** 창 크기(CSS px, 배율 적용 후) — position:fixed 부품을 화면 안으로 보정할 때 사용 */
export function viewportCss(): { vw: number; vh: number } {
  return { vw: window.innerWidth / _zoom, vh: window.innerHeight / _zoom }
}

// ── 요소 폭(CSS px) — 페이지별 "본문 폭" 규칙(lib/fluid)에 사용한다 ──

/**
 * 요소의 안쪽 폭을 추적한다(ResizeObserver, 배율 적용 후 CSS px). 첫 측정 전에는 fallback.
 * @example const [ref, w] = useElementWidth<HTMLDivElement>(fallback)
 */
export function useElementWidth<T extends HTMLElement>(fallback: number): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null)
  const [w, setW] = useState<number | null>(null)
  useEffect(() => {
    if (!el) return
    setW(el.clientWidth || null)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { setW(el.clientWidth || null) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, w ?? fallback]
}
