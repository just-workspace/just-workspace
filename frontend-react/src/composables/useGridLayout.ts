/**
 * 참가자 그리드의 열·행 수를 컨테이너 크기에 맞춰 고른다.
 *
 * N명을 c열 × r행으로 깔았을 때 타일 하나가 16:9 로 얼마나 커질 수 있는지를
 * 모든 c 에 대해 계산하고, 가장 큰 c 를 고른다. Tailwind 의 grid-cols-* 단계
 * 방식은 컨테이너 높이를 모르기 때문에 6명부터 행이 넘쳐 겹쳤다.
 *
 * React: const { style } = useGridLayout(gridEl, count, 8)
 *   containerEl 은 콜백 ref 로 받은 요소(state) — 요소가 바뀌면 다시 관찰한다.
 */
import { useEffect, useState } from 'react'

/** 측정한 폭·높이로 열·행 고르기(순수 함수 — 테스트용으로 따로 내보낸다) */
export function gridLayoutFor(count: number, width: number, height: number, gapPx = 8): { cols: number; rows: number } {
  const n = Math.max(1, count)
  const w = width
  const h = height
  if (w <= 0 || h <= 0) {
    // 아직 측정 전 — 예전 단계식 폴백
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
    // 첫 측정 — observer 콜백은 다음 프레임에 오므로 그 전에 한 번 읽어 둔다
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
