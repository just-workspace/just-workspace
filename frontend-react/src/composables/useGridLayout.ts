/**
 * 참가자 그리드의 열·행 수를 컨테이너 크기에 맞춰 결정한다.
 *
 * N명을 c열 × r행으로 배치했을 때 타일 하나가 16:9 로 확보 가능한 최대 크기를
 * 모든 c 에 대해 계산하고, 그 값이 가장 큰 c 를 선택한다. Tailwind 의 grid-cols-* 단계
 * 방식은 컨테이너 높이를 알 수 없어 6명부터 행이 넘쳐 겹쳤다.
 *
 * React: const { style } = useGridLayout(gridEl, count, 8)
 *   containerEl 은 콜백 ref 로 받은 요소(state) — 요소 변경 시 재관찰한다.
 */
import { useEffect, useState } from 'react'

/** 측정한 폭·높이로 열·행 결정(순수 함수 — 테스트용으로 별도 export) */
export function gridLayoutFor(count: number, width: number, height: number, gapPx = 8): { cols: number; rows: number } {
  const n = Math.max(1, count)
  const w = width
  const h = height
  if (w <= 0 || h <= 0) {
    // 측정 전 — 이전 단계식 폴백
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3
    return { cols, rows: Math.ceil(n / cols) }
  }
  let best = { cols: 1, rows: n, tile: 0 }
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c)
    const tw = (w - gapPx * (c - 1)) / c
    const th = (h - gapPx * (r - 1)) / r
    // 16:9 를 유지했을 때 실제 타일 폭
    const tile = Math.min(tw, th * 16 / 9)
    if (tile > best.tile) best = { cols: c, rows: r, tile }
  }
  return { cols: best.cols, rows: best.rows }
}

export function useGridLayout(containerEl: HTMLElement | null, count: number, gapPx = 8) {
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = containerEl
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (!box) return
      setSize({ width: box.width, height: box.height })
    })
    ro.observe(el)
    // 최초 측정 — observer 콜백은 다음 프레임에 도착하므로 그 전에 1회 읽는다
    setSize({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [containerEl])

  const { cols, rows } = gridLayoutFor(count, size.width, size.height, gapPx)
  const style = {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
  }

  return { cols, rows, style, width: size.width, height: size.height }
}
