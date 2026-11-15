/**
 * 격리 브라우저 단독 앱 빌드(rbi 전용 출처) — `npm run build:rbi` → dist-rbi/(rbi.html · assets/ · icon.svg).
 * 워크스페이스 앱(vite.config.ts → dist/)과 따로 빌드한다 — rbi 출처에는 이 번들만 실린다(frontend-react 컨테이너의 3001 서버).
 *
 *  - 들어가면 안 되는 것(워크스페이스 셸·화면·모듈)이 번들에 섞이면 빌드를 멈춘다(jw-rbi-isolation).
 *  - i18n 메시지는 rbi·common·ui 만 싣는다(jw-rbi-locale-subset) — 워크스페이스 전체 문구를 내려보내지 않는다.
 *  - PWA·서비스워커 없음, public/ 복사 없음(icon.svg 하나만).
 */
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { rbiForbiddenModules } from './rbi-bundle-guard'

const src = fileURLToPath(new URL('./src', import.meta.url))
const KEEP_LOCALE_KEYS = ['rbi', 'common', 'ui']

function isolation(): Plugin {
  return {
    name: 'jw-rbi-isolation',
    generateBundle(_o, bundle) {
      const ids: string[] = []
      for (const f of Object.values(bundle)) if (f.type === 'chunk') ids.push(...Object.keys(f.modules))
      const bad = rbiForbiddenModules(ids)
      if (bad.length) this.error(`격리 브라우저 번들에 워크스페이스 모듈이 섞였습니다:\n  ${bad.slice(0, 20).join('\n  ')}`)
    },
  }
}

function localeSubset(): Plugin {
  return {
    name: 'jw-rbi-locale-subset',
    enforce: 'pre',
    load(id) {
      const n = id.replace(/\\/g, '/').split('?')[0]
      if (!/\/src\/i18n\/locales\/[a-z]{2}\.json$/.test(n)) return null
      const all = JSON.parse(readFileSync(n, 'utf8')) as Record<string, unknown>
      const keep: Record<string, unknown> = {}
      for (const k of KEEP_LOCALE_KEYS) if (k in all) keep[k] = all[k]
      return JSON.stringify(keep)
    },
  }
}

function icon(): Plugin {
  return {
    name: 'jw-rbi-icon',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'icon.svg', source: readFileSync(fileURLToPath(new URL('./public/icon.svg', import.meta.url))) })
    },
  }
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_NAME': JSON.stringify('격리 브라우저'),
    'import.meta.env.VITE_BRAND_COLOR': JSON.stringify('#3B82F6'),
    // 번들 앱 모드 아님 — 같은 출처 쿠키(rbi 세션)만
    'import.meta.env.VITE_API_BASE': JSON.stringify(''),
  },
  resolve: { alias: { '~': src } },
  publicDir: false,
  plugins: [localeSubset(), tailwindcss(), react(), isolation(), icon()],
  build: {
    target: 'es2022',
    outDir: 'dist-rbi',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
    // CSP 가 data: 스크립트를 막는다 — 모듈 프리로드 폴리필(인라인)을 넣지 않는다
    modulePreload: { polyfill: false },
    // 작은 글꼴·이미지를 data: 로 CSS 에 넣지 않는다 — 출처 CSP 가 font-src 'self'(data: 없음). 전부 /assets/ 파일로
    assetsInlineLimit: 0,
    rollupOptions: { input: { rbi: fileURLToPath(new URL('./rbi.html', import.meta.url)) } },
  },
})
