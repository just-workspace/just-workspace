/**
 * 차트 색(시안 관리 5 ①) — Vue 판 composables/useChartTokens.ts 그대로.
 * CSS 변수(primary·success·warning·danger)를 Chart.js 에 주입. 축 글자 = muted-foreground, 격자 = border.
 * 브랜드 primary 를 바꾸거나 테마를 바꾸면 따라 바뀐다. hex 하드코딩 금지.
 * 범주 색은 --cat-1…8(11-A1) 순서대로 — 계열 1부터, 9개 이상이면 다시 1부터(범례·툴팁의 이름으로 구분).
 *
 * React: const { tokens } = useChartTokens()   — 컴포넌트마다 따로(Vue 도 인스턴스별)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useColorMode } from '~/composables/useColorMode'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { Chart as ChartJS } from 'chart.js'
import { getUiZoom } from '~/composables/useViewport'

// 화면 배율(루트 zoom) 아래에서 캔버스가 흐려지지 않게 — 그림 해상도를 배율만큼 올린다
// (마우스 위치는 Chart.js 가 사각형 폭으로 나눠 계산하므로 그대로 맞는다)
// 타입은 number 지만 Chart.js 기본값 자체가 (context) => number 함수다(core.defaults) — 차트를 그릴 때마다 읽힌다
;(ChartJS.defaults as unknown as { devicePixelRatio: () => number }).devicePixelRatio = () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio) * getUiZoom()

export interface ChartTokens {
  primary: string
  success: string
  warning: string
  danger: string
  primarySoft: string
  axis: string
  grid: string
  category: string[]
}

/** CSS 변수 `--name`("220 90% 56%") → Chart.js 가 읽는 쉼표 문법 hsl()/hsla(). 값이 없으면 transparent */
export function hslOf(name: string, alpha?: number): string {
  if (typeof document === 'undefined') return 'transparent'
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()
  if (!raw) return 'transparent'
  const parts = raw.split(/\s+/).filter(Boolean)
  return alpha == null ? `hsl(${parts.join(', ')})` : `hsla(${parts.join(', ')}, ${alpha})`
}

function readTokens(): ChartTokens {
  const muted = hslOf('muted-foreground')
  return {
    primary: hslOf('primary'),
    success: hslOf('success'),
    warning: hslOf('warning'),
    danger: hslOf('danger'),
    primarySoft: hslOf('primary', 0.12),
    axis: muted,
    grid: hslOf('border'),
    category: [1, 2, 3, 4, 5, 6, 7, 8].map(n => hslOf(`cat-${n}`)),
  }
}

export function useChartTokens() {
  const colorMode = useColorMode()
  const { config } = useSiteConfig()
  const [tick, setTick] = useState(0)

  // onMounted(tick++) + watch([colorMode.value, config]) — 테마 클래스·브랜드 색이 DOM 에 반영된 뒤 다시 읽는다
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; setTick(n => n + 1); return }
    const id = setTimeout(() => setTick(n => n + 1), 0)
    return () => clearTimeout(id)
  }, [colorMode.value, config])

  // tick 이 바뀔 때마다 CSS 변수를 다시 읽는다
  const tokens = useMemo(() => { void tick; return readTokens() }, [tick])
  return { tokens }
}
