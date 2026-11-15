/**
 * 설치 마법사 빌드 — `npm run build:installer` → dist-installer/(installer.html · assets/ · icon.svg).
 * 워크스페이스 앱(vite.config.ts → dist/)과 따로 빌드한다. 설치 관리자 이미지가 이 폴더를 통째로 가져가 내준다.
 *
 *  - 들어가면 안 되는 것(워크스페이스 화면·셸·라우터·API 클라이언트·무거운 라이브러리)이 섞이면 빌드를 멈춘다(jw-installer-isolation).
 *  - 앱 번역 파일에서는 UI 키트가 읽는 common·ui 만 싣는다(jw-installer-locale-subset). 마법사 문구는 전용 파일(src/installer-app/i18n).
 *  - 자산 주소는 상대 경로(base './') — 설치 관리자가 어느 경로로 내줘도 된다.
 *  - 가짜 서버(src/installer-app/api/mock.ts)는 개발 서버와 `INSTALLER_MOCK=1` 빌드에만 실린다.
 *    `INSTALLER_MOCK=1 npx vite build -c vite.installer.config.ts` → dist-installer-mock/ (화면 확인용, 배포하지 않는다)
 *  - PWA·서비스워커 없음, public/ 복사 없음(icon.svg 하나만).
 */
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { installerForbiddenModules } from './installer-bundle-guard'

const src = fileURLToPath(new URL('./src', import.meta.url))
const KEEP_LOCALE_KEYS = ['common', 'ui']

function isolation(): Plugin {
  return {
    name: 'jw-installer-isolation',
    generateBundle(_o, bundle) {
      const ids: string[] = []
      for (const f of Object.values(bundle)) if (f.type === 'chunk') ids.push(...Object.keys(f.modules))
      const bad = installerForbiddenModules(ids)
      if (bad.length) this.error(`설치 마법사 번들에 워크스페이스 모듈이 섞였습니다:\n  ${bad.slice(0, 20).join('\n  ')}`)
    },
  }
}

function localeSubset(): Plugin {
  return {
    name: 'jw-installer-locale-subset',
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
    name: 'jw-installer-icon',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'icon.svg', source: readFileSync(fileURLToPath(new URL('./public/icon.svg', import.meta.url))) })
    },
  }
}

/** 개발 서버에서 / 와 /installer 를 installer.html 로 */
function devEntry(): Plugin {
  return {
    name: 'jw-installer-dev-entry',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (path === '/' || path === '/installer') req.url = '/installer.html' + (req.url ?? '').slice(path.length)
        next()
      })
    },
  }
}

export default defineConfig(({ command }) => {
  const mock = command === 'serve' || process.env.INSTALLER_MOCK === '1'
  return {
    base: './',
    define: {
      __INSTALLER_MOCK__: JSON.stringify(mock),
    },
    resolve: { alias: { '~': src } },
    publicDir: false,
    plugins: [localeSubset(), tailwindcss(), react(), isolation(), icon(), devEntry()],
    build: {
      target: 'es2022',
      outDir: mock ? 'dist-installer-mock' : 'dist-installer',
      emptyOutDir: true,
      chunkSizeWarningLimit: 1024,
      // 인라인 스크립트를 막는 CSP 아래에서 돈다 — 모듈 프리로드 폴리필(인라인)을 넣지 않는다
      modulePreload: { polyfill: false },
      // 글꼴·이미지를 data: 로 CSS 에 넣지 않는다 — 전부 assets/ 파일로
      assetsInlineLimit: 0,
      rollupOptions: { input: { installer: fileURLToPath(new URL('./installer.html', import.meta.url)) } },
    },
  }
})
