import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// PWA·개발 서버 프록시·브랜딩 설정.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const appName = env.APP_NAME || env.VITE_APP_NAME || 'Workspace'
  const brandColor = env.BRAND_COLOR || env.VITE_BRAND_COLOR || '#3B82F6'
  // 번들 SPA 앱(apiBase 설정)에선 SW 끔(옛 SW 가 구번들을 영구 precache 하는 사고 방지)
  const apiBase = env.VITE_API_BASE || env.NUXT_PUBLIC_API_BASE || ''
  const backend = env.DEV_BACKEND || 'http://localhost:8000'

  return {
    define: {
      'import.meta.env.VITE_APP_NAME': JSON.stringify(appName),
      'import.meta.env.VITE_BRAND_COLOR': JSON.stringify(brandColor),
      'import.meta.env.VITE_API_BASE': JSON.stringify(apiBase),
      // v1(Vue) 플러그인용 지연 로드 Vue 런타임의 기능 플래그 — Nuxt 기본값과 같게(옵션 API 켬, 운영 devtools 끔)
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    resolve: {
      alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    plugins: [
      tailwindcss(),
      react(),
      {
        // index.html 의 %VITE_APP_NAME% · %VITE_BRAND_COLOR% (APP_NAME/BRAND_COLOR 환경변수 폴백 포함)
        name: 'jw-html-brand',
        transformIndexHtml: (html: string) =>
          html.replaceAll('%VITE_APP_NAME%', appName).replaceAll('%VITE_BRAND_COLOR%', brandColor),
      },
      VitePWA({
        disable: !!apiBase,
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        manifest: {
          name: appName,
          short_name: appName,
          description: 'Self-hosted all-in-one workspace',
          theme_color: brandColor,
          background_color: '#ffffff',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          scope: '/',
          icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
        },
        workbox: {
          navigateFallback: '/',
          // /api·/oauth·/ws·/git 등 서버 경로는 SPA 로 떨어지면 안 된다
          navigateFallbackDenylist: [/^\/api\//, /^\/oauth\//, /^\/ws\//, /^\/git\//, /^\/dav\//, /^\/sso\//, /^\/onlyoffice\//, /^\/livekit\//, /^\/audiorelay\//, /^\/\.well-known\//],
          globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
          maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
          // 웹푸시 표시(push · notificationclick) — generateSW 는 push 처리기를 만들지 않는다. public/push-sw.js
          importScripts: ['/push-sw.js'],
          // /api/** 런타임 캐시는 두지 않는다 — 캐시 키가 주소뿐이라 사용자 구분이 없고(로그아웃 뒤에도 남아 다음 사용자에게
          // 이전 사용자 응답이 나갈 수 있다) 파일 내려받기까지 통째로 복제됐다.
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/.*\/assets\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'react-assets',
                expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: { enabled: false },
      }),
    ],
    server: {
      port: 3000,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/oauth': { target: backend, changeOrigin: true },
        '/ws': { target: backend, changeOrigin: true, ws: true },
      },
    },
    preview: {
      port: 3000,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/oauth': { target: backend, changeOrigin: true },
        '/ws': { target: backend, changeOrigin: true, ws: true },
      },
    },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 4096,
    },
  }
})
