// Tailwind 4 는 vite 플러그인(@tailwindcss/vite, vite.config.ts)이 처리한다 — 본 파일에는 후처리 플러그인만 둔다.
// 접두사(autoprefixer)는 Tailwind 4 내장 Lightning CSS 가 담당한다.

// 화면 배율(composables/useViewport — <html> 의 CSS zoom) 적용 시 vh·dvh·vw 는 배율만큼 확대된다
// (zoom 2 이면 100vh 가 창 높이의 2배). 선언 값의 뷰포트 단위를 `÷ var(--ui-zoom, 1)` 로 변환하여
// 배율과 무관하게 항상 창 크기와 일치시킨다. Tailwind 임의값(max-h-[90dvh])·라이브러리 CSS 모두 본 단계에서 일괄 처리한다.
// @supports (height:100dvh) 같은 at-rule 조건은 변경하지 않는다(선언만 대상).
// 숫자 앞이 글자·#·점이면(파일 이름 …D4vh.woff 등) 단위로 취급하지 않는다. url() 이 포함된 값은 전체를 제외한다.
const UNIT = /(?<![\w#.-])(-?\d*\.?\d+)(dvh|svh|lvh|vh|dvw|svw|lvw|vw|vmin|vmax)\b/g
const HAS_UNIT = /\d(dvh|svh|lvh|vh|dvw|svw|lvw|vw|vmin|vmax)\b/

/** @type {import('postcss').PluginCreator<void>} */
const viewportZoomUnits = () => ({
  postcssPlugin: 'viewport-zoom-units',
  Declaration(decl) {
    if (decl.value.includes('--ui-zoom') || decl.value.includes('url(') || !HAS_UNIT.test(decl.value)) return
    decl.value = decl.value.replace(UNIT, (_m, n, u) => `calc(${n}${u} / var(--ui-zoom, 1))`)
  },
})
viewportZoomUnits.postcss = true

export default {
  plugins: [viewportZoomUnits()],
}
