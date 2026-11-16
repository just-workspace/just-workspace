// 원격 데스크톱 v2(React) 번들 빌드 — frontend/dist/plugin.mjs 단일 파일.
//   node plugins/remote-desktop/frontend/build.mjs
// · react / react-dom / @jw/ui 는 external → 호스트 전역(window.__REACT__ / __REACT_DOM__ / __WS_UI__)으로 치환한다(frontend-react/docs/plugin-v2.md 4절).
// · JSX 는 classic(React.createElement) — react/jsx-runtime 치환이 불필요하다.
// · livekit-client 는 번들에 포함한다(호스트가 전역으로 제공하지 않는다) — 코어 frontend-react/node_modules 에서 탐색한다.
// · 도구(esbuild·typescript)는 코어 frontend-react/node_modules 의 것을 사용한다(이 폴더에 node_modules 를 두지 않는다).
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const core = resolve(here, '../../..')  // plugins/remote-desktop/frontend → 코어 루트
const host = resolve(core, 'frontend-react')
const req = createRequire(resolve(host, 'package.json'))
const esbuild = req('esbuild')

// 1) 타입 검사(선택: --no-check 로 비활성화)
if (!process.argv.includes('--no-check')) {
  const tsc = req.resolve('typescript/bin/tsc')
  try {
    execFileSync(process.execPath, [tsc, '-p', resolve(here, 'tsconfig.json')], { stdio: 'inherit' })
  } catch {
    console.error('[remote-desktop] 타입 검사 실패 — 고치거나 --no-check')
    process.exit(1)
  }
}

// 2) 번들
const outDir = resolve(here, 'dist')
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
const r = await esbuild.build({
  entryPoints: [resolve(here, 'page.tsx')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  platform: 'browser',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@jw/ui'],
  nodePaths: [resolve(host, 'node_modules')],
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: 'none',
  charset: 'utf8',
  write: false,
  logLevel: 'warning',
})
let code = r.outputFiles[0].text

// 3) external import → 호스트 전역
const map = { react: 'window.__REACT__', 'react-dom': 'window.__REACT_DOM__', 'react-dom/client': 'window.__REACT_DOM__', '@jw/ui': 'window.__WS_UI__' }
const MOD = `(react(?:-dom(?:\\/client)?)?|@jw\\/ui)`
code = code
  .replace(new RegExp(`import\\s*\\*\\s*as\\s*([\\w$]+)\\s*from\\s*["']${MOD}["']\\s*;?`, 'g'), (_m, ns, mod) => `const ${ns}=${map[mod]};`)
  .replace(new RegExp(`import\\s*([\\w$]+)\\s*,\\s*\\{([^}]*)\\}\\s*from\\s*["']${MOD}["']\\s*;?`, 'g'),
    (_m, def, named, mod) => `const ${def}=${map[mod]};const{${named.replace(/\bas\b/g, ':')}}=${map[mod]};`)
  .replace(new RegExp(`import\\s*([\\w$]+)\\s*from\\s*["']${MOD}["']\\s*;?`, 'g'), (_m, def, mod) => `const ${def}=${map[mod]};`)
  .replace(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${MOD}["']\\s*;?`, 'g'), (_m, named, mod) => `const{${named.replace(/\bas\b/g, ':')}}=${map[mod]};`)

// 4) 검사 — 잔여 bare import 가 없어야 하며 표식이 존재해야 한다
const left = code.match(/from\s*["'](react[^"']*|@jw\/ui)["']/)
if (left) { console.error('[remote-desktop] 치환되지 않은 import:', left[0]); process.exit(1) }
if (!/\bexport\b[^;]*\bjwPlugin\b/.test(code)) { console.error('[remote-desktop] jwPlugin 표식 export 가 없다'); process.exit(1) }

const banner = '// remote-desktop v2(React) — built ' + new Date().toISOString() + '\n'
await writeFile(resolve(outDir, 'plugin.mjs'), banner + code, 'utf8')
console.log(`[remote-desktop] dist/plugin.mjs ${(code.length / 1024).toFixed(1)} KB`)
if (!existsSync(resolve(outDir, 'plugin.mjs'))) process.exit(1)
