// 하네스 번들(스파이크 전용) — client/dist/{index.html,harness.js}
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(resolve(here, 'dist'), { recursive: true })
await build({
  entryPoints: [resolve(here, 'harness/harness.ts')],
  bundle: true, format: 'esm', target: 'es2022', sourcemap: true,
  outfile: resolve(here, 'dist/harness.js'),
})
copyFileSync(resolve(here, 'harness/index.html'), resolve(here, 'dist/index.html'))
console.log('client harness built → client/dist')
