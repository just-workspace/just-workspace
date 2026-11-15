// Tailwind 4 는 vite 플러그인(@tailwindcss/vite, vite.config.ts)이 처리한다 — 여기엔 뒤처리 플러그인만.
// 접두사(autoprefixer)는 Tailwind 4 안의 Lightning CSS 가 맡는다.

// 화면 배율(composables/useViewport — <html> 의 CSS zoom) 아래에서 vh·dvh·vw 는 배율만큼 커진다
// (zoom 2 면 100vh 가 창 높이의 두 배). 선언 값의 뷰포트 단위를 `÷ var(--ui-zoom, 1)` 로 바꿔
// 배율과 상관없이 늘 창 크기가 되게 한다. Tailwind 임의값(max-h-[90dvh])·라이브러리 CSS 모두 여기서 한 번에.
// @supports (height:100dvh) 같은 at-rule 조건은 건드리지 않는다(선언만).
// 숫자 앞이 글자·#·점이면(파일 이름 …D4vh.woff 등) 단위가 아니다. url() 이 든 값은 통째로 건너뛴다.
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
