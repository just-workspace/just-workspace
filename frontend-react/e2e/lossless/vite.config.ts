// e2e 하네스 빌드 — `npx vite build --config e2e/lossless/vite.config.ts` → e2e/lossless/dist
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: { alias: { '~': fileURLToPath(new URL('../../src', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  logLevel: 'warn',
})
