/**
 * 차트 색.
 * CSS 변수(primary·success·warning·danger)를 Chart.js 에 주입. 축 글자 = muted-foreground, 격자 = border.
 * 브랜드 primary 또는 테마를 변경하면 연동되어 변경된다. hex 하드코딩 금지.
 * 범주 색은 --cat-1…8 순서 — 계열 1부터, 9개 이상이면 다시 1부터(범례·툴팁의 이름으로 구분).
 *
 * React: const { tokens } = useChartTokens()   — 컴포넌트별 독립
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useColorMode } from '~/composables/useColorMode'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { Chart as ChartJS } from 'chart.js'
import { getUiZoom } from '~/composables/useViewport'

// 화면 배율(루트 zoom) 적용 시 캔버스가 흐려지지 않도록 렌더링 해상도를 배율만큼 높인다
// (마우스 위치는 Chart.js 가 사각형 폭으로 나눠 계산하므로 그대로 일치한다)
// 타입은 number 이나 Chart.js 기본값 자체가 (context) => number 함수이다(core.defaults) — 차트 렌더링 시마다 평가된다
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

  // onMounted(tick++) + watch([colorMode.value, config]) — 테마 클래스·브랜드 색이 DOM 에 반영된 후 재조회한다
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; setTick(n => n + 1); return }
    const id = setTimeout(() => setTick(n => n + 1), 0)
    return () => clearTimeout(id)
  }, [colorMode.value, config])

  // tick 변경 시마다 CSS 변수를 재조회한다
  const tokens = useMemo(() => { void tick; return readTokens() }, [tick])
  return { tokens }
}
