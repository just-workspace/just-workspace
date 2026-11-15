# 플러그인 프런트 v2 (React) — 작성법

React 호스트(`frontend-react/`)는 플러그인 번들을 두 계약으로 연다.

| 계약 | 번들 | 호스트가 하는 일 |
|---|---|---|
| **v1 (Vue)** — 지금까지의 모든 플러그인 | `plugins/build-plugin.mjs` 산출물. `const {…} = window.__VUE__` 로 시작, default export = Vue 컴포넌트 | v1 플러그인을 열 때만 Vue 런타임을 지연 로드(별도 청크)해 `window.__VUE__` 를 세우고 `createApp(...).mount(div)`. `inject('pluginApi')` 모양은 Vue 호스트와 같다 |
| **v2 (React)** | react 를 external 로 두고 `window.__REACT__` / `window.__REACT_DOM__` 사용. default export = React 컴포넌트 | 호스트 React 트리 안에서 `<Plugin pluginApi={…} />` 로 그린다(같은 React 인스턴스라 hook 이 그대로 동작) |

로더: `src/plugins/pluginHost.tsx`, 페이지: `src/pages/p/[id].tsx`.

## 1. 번들 주소·캐싱 (v1 과 같음)

- 주소는 `/api/plugin-assets/<id>/bundle.mjs` (백엔드가 `plugins/<folder>/frontend/dist/plugin.mjs` 를 준다).
- **캐시버스터를 붙이지 않는다.** 백엔드가 ETag + `Cache-Control: no-cache` 를 주고 `If-None-Match` 를 직접 처리하므로
  안정 URL 이면 재방문은 304(수백 바이트), 새로 빌드하면 mtime 이 바뀌어 자동 반영된다. 자세한 이유는 `docs/plugin-frontend.md` "번들 캐싱".
- 번들은 **파일 하나**로 만든다(코드 분할 금지 — 청크 경로를 호스트가 모른다). CSS 는 JS 에 인라인(아래 빌드 예).

## 2. 계약 버전 판정

1. 모듈 목록(`/api/platform/modules`)의 manifest 필드 `frontend_api`(`1`·`2`·`"vue"`·`"react"`) — **지금 백엔드는 이 필드를 넘기지 않는다**
   (`backend/app/modules/registry.py` 가 고정 필드만 복사). 나중에 넘어오면 그것을 믿는다. manifest 에 미리 적어 두는 건 무해하다.
2. 없으면 호스트가 번들 **소스를 fetch** 해서 본다: `jwPlugin` export·`window.__REACT__` → v2, `window.__VUE__` → v1.
   v1 번들은 맨 위에서 `window.__VUE__` 를 구조분해하므로 import **전에** 알아야 하기 때문이다.
   같은 URL 이라 HTTP 캐시를 같이 쓰고 두 번째 요청은 304 로 끝난다.
3. import 후 `export const jwPlugin = { api: 2 }` 가 있으면 최종 v2. 표식도 전역 참조도 없으면 v1 로 본다.

→ **v2 번들은 반드시 표식을 export 한다**:

```ts
export const jwPlugin = { api: 2 } as const
```

## 3. 컴포넌트와 pluginApi

```tsx
// plugins/<name>/frontend/page.tsx
import { useEffect, useState } from 'react'

interface PluginApiV2 { /* 아래 표 — 호스트 src/plugins/pluginHost.tsx 의 PluginApiV2 를 복사해 써도 된다 */ }

export const jwPlugin = { api: 2 } as const

export default function NotesPage({ pluginApi }: { pluginApi: PluginApiV2 }) {
  const [notes, setNotes] = useState<{ id: string; title: string }[]>([])
  useEffect(() => {
    if (!pluginApi.user) return
    pluginApi.$fetch('/api/plugins/notes').then((r: any) => setNotes(r.notes))
  }, [pluginApi.user])

  // 상단바 버튼 — 마운트 중에만 등록, 언마운트 때 해제
  useEffect(() => pluginApi.setHeaderActions([
    { id: 'new', label: '새 메모', text: '새 메모', icon: 'plus', onClick: () => { /* … */ } },
  ]), [])

  return <ul>{notes.map(n => <li key={n.id}>{n.title}</li>)}</ul>
}
```

| 멤버 | 타입 | 설명 |
|---|---|---|
| `version` | `2` | 계약 버전 |
| `pluginId` | `string` | 지금 열린 플러그인 id (`/p/<id>`) |
| `user` | `User \| null` | 로그인 사용자 — **값**(v1 은 Vue ref). 바뀌면 새 props 로 다시 그려진다 |
| `appName` | `string` | 사이트 이름(브랜딩) — **값** |
| `$fetch` | `(url, opts?) => Promise` | 호스트 API 클라이언트(ofetch). 번들 앱(apiBase·Bearer)도 처리. 옵션은 ofetch 와 같다(`method/body/query/headers`) |
| `setHeaderActions` | `(actions, owner = 'plugin') => () => void` | 상단바 버튼·칩 등록. 돌려준 함수로 해제 |
| `clearHeaderActions` | `(owner = 'plugin') => void` | 상단바 항목 해제 |
| `setTitle` | `(title: string \| null, owner = 'plugin') => () => void` | 상단바 제목 덮어쓰기(데스크톱 경로 마지막 칸 · 모바일 머리). `null`·`''` = 원복. 돌려준 함수로 원복 |
| `clearTitle` | `(owner = 'plugin') => void` | 상단바 제목 원복 |
| `navigateTo` | `(to, opts?) => Promise<void>` | 호스트 라우터 이동(새로고침 없음). `to` 는 경로 문자열 또는 `{ path, query, hash }` |
| `t` | `(key, a?, b?) => string` (선택) | 호스트 i18n. 키는 호스트 locales 기준 — 플러그인 고유 문구는 플러그인이 갖는다 |

- `pluginApi` 객체는 user·appName·언어가 바뀔 때 새로 만들어진다. effect 의존성에 통째로 넣으면 그때마다 다시 돈다.
- 호스트는 페이지를 떠날 때·다른 플러그인으로 바꿀 때 상단바 항목·제목을 **전부** 지운다(해제를 잊어도 남지 않음).
- 렌더 중 예외는 플러그인 영역만 "Failed to load plugin" 으로 바뀌고 셸은 산다.

### 전역 (v1 과 동일)

| 전역 | 내용 |
|---|---|
| `window.__REACT__` | 호스트 `react` 모듈(네임스페이스) |
| `window.__REACT_DOM__` | `react-dom` + `react-dom/client` 를 합친 객체(`createPortal`, `flushSync`, `createRoot` …) |
| `window.__WS_SHELL__` | `{ version: 1, setHeaderActions, clearHeaderActions, setTitle, clearTitle }` — `docs/plugin-frontend.md` "상단바 확장 자리"·"상단바 제목" 과 같은 API. `pluginApi` 의 같은 이름 함수와 같은 상태를 바꾼다 |
| `window.__WS_UI__` | 호스트 UI 키트 `{ version: 1, UiButton, UiModal, UiMenu, …, useToast, toast, useDialog, confirmBox, … }` — 아래 7절 |

## 4. 번들 빌드 설정 예 (react external + 전역 치환)

`plugins/build-plugin.mjs` 가 vue 에 하는 것과 같은 방식이다. JSX 는 **classic 런타임**(`React.createElement`)으로 내보내면
`react/jsx-runtime` 을 따로 치환할 필요가 없다.

```js
// plugins/build-plugin-react.mjs (예시)
import { build } from 'vite'
import react from '@vitejs/plugin-react'

function reactGlobals() {
  const map = { react: 'window.__REACT__', 'react-dom': 'window.__REACT_DOM__', 'react-dom/client': 'window.__REACT_DOM__', '@jw/ui': 'window.__WS_UI__' }
  return {
    name: 'react-globals',
    renderChunk(code) {
      // import X, { a as b } from "react"  /  import * as X from "react"  →  전역에서 꺼내기
      return code
        .replace(/import\s*\*\s*as\s*(\w+)\s*from\s*["'](react(?:-dom(?:\/client)?)?|@jw\/ui)["']\s*;?/g,
          (_m, ns, mod) => `const ${ns} = ${map[mod]};`)
        .replace(/import\s*(\w+)\s*,?\s*(?:\{([^}]*)\})?\s*from\s*["'](react(?:-dom(?:\/client)?)?|@jw\/ui)["']\s*;?/g,
          (_m, def, named, mod) => `const ${def} = ${map[mod]};` + (named ? `const {${named.replace(/\bas\b/g, ':')}} = ${map[mod]};` : ''))
        .replace(/import\s*\{([^}]*)\}\s*from\s*["'](react(?:-dom(?:\/client)?)?|@jw\/ui)["']\s*;?/g,
          (_m, named, mod) => `const {${named.replace(/\bas\b/g, ':')}} = ${map[mod]};`)
    },
  }
}

await build({
  root: pluginDir,
  plugins: [react({ jsxRuntime: 'classic' }), reactGlobals()],
  build: {
    lib: { entry: `${pluginDir}/frontend/page.tsx`, formats: ['es'], fileName: () => 'plugin.mjs' },
    outDir: `${pluginDir}/frontend/dist`,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@jw/ui'],
      output: { inlineDynamicImports: true, assetFileNames: '[name][extname]' },
    },
  },
})
// CSS 인라인은 build-plugin.mjs 의 "Inline emitted CSS" 단계를 그대로 쓴다.
```

빌드 후 확인: `dist/plugin.mjs` 에 `from "react"`·`from "@jw/ui"` 가 **남아 있지 않아야** 하고, `jwPlugin` export 가 있어야 한다.

## 5. 스타일 제약 (v1 과 같음)

`docs/plugin-frontend.md` 의 제약이 그대로 적용된다:

- 호스트 Tailwind 는 호스트 소스만 스캔한다 → 플러그인에서 쓴 클래스는 **호스트도 쓰고 있을 때만** CSS 가 있다.
- **반응형 variant(`sm:` `md:` `lg:`)에 기대지 말 것** — `window.matchMedia('(max-width: 767px)')` 로 JS 판정(호스트 `useIsMobile` 과 같은 기준).
- transform 처럼 값이 다양한 건 인라인 `style` 로.
- 새 클래스는 브라우저에서 실제로 먹는지 확인(`getComputedStyle`).

## 6. v1(Vue) 플러그인은 그대로 동작한다

- 번들을 다시 빌드할 필요가 없다. 호스트가 판정(위 2) → `import('vue')`(별도 청크, v1 을 열 때만) → `window.__VUE__ = Vue` →
  번들 import → `createApp(default).provide('pluginApi', { user, $fetch, appName, setHeaderActions, clearHeaderActions, setTitle, clearTitle }).mount(div)`.
  `user`·`appName` 은 Vue `ref` 이고 호스트 상태(로그인·브랜딩)와 동기화된다. 페이지를 떠나면 `app.unmount()`.
- 마운트 자리는 `display: contents` div 라 플러그인 루트의 `h-full` 등이 Vue 호스트와 같게 먹는다.
- Vue 렌더러는 처음 만들어질 때 `globalThis.__VUE__ = true`(devtools 표식)를 쓴다. 호스트는 렌더러를 먼저 만든 뒤 전역을 세워
  두 번째 v1 플러그인도 깨지지 않게 한다.
- 한계(Vue 호스트에서도 없던 것): Nuxt 전용 API(`useNuxtApp`, `useRoute`, 자동 import 컴포넌트), 호스트 전역 디렉티브.
  Vue 호스트에서도 번들에 들어가지 않으므로 지금 v1 플러그인이 쓰고 있을 리 없다.

## 7. 호스트 UI 키트 (`window.__WS_UI__`)

v2 플러그인은 자기 버튼·모달·메뉴를 따로 만들지 말고 **호스트 키트를 그대로** 쓴다. 같은 React 인스턴스·같은 토큰 CSS 라
모양·키보드·접근성이 호스트 화면과 똑같고, 위 5절의 "호스트가 안 쓰는 클래스는 CSS 가 없다" 문제도 키트 안쪽 클래스에는 없다
(키트는 호스트 소스라 Tailwind 가 이미 스캔한다).

### 쓰는 법

번들에서는 가상 모듈 `@jw/ui` 로 import 하고, 빌드 때 react 와 같이 **external + 전역 치환**한다(4절 설정에 이미 들어 있다).

```tsx
import { useState } from 'react'
import { UiButton, UiModal, UiMenu, UiTrans, toast, confirmBox } from '@jw/ui'

export const jwPlugin = { api: 2 } as const

export default function NotesPage({ pluginApi }: { pluginApi: PluginApiV2 }) {
  const [open, setOpen] = useState(false)
  async function remove() {
    if (!(await confirmBox('메모를 지울까요?', { danger: true, confirmLabel: '삭제' }))) return
    await pluginApi.$fetch('/api/plugins/notes/1', { method: 'DELETE' })
    toast({ type: 'success', title: '메모를 지웠습니다', action: { label: '되돌리기', onClick: () => { /* … */ } } })
  }
  return (
    <>
      <UiButton size="xs" onClick={() => setOpen(true)}>새 메모</UiButton>
      <UiMenu items={[{ key: 'del', label: '삭제', icon: 'trash', danger: true }]} onSelect={k => { if (k === 'del') void remove() }} />
      {open && <UiModal title="새 메모" size="sm" onClose={() => setOpen(false)}>…</UiModal>}
    </>
  )
}
```

치환 결과는 `const { UiButton, UiModal, … } = window.__WS_UI__;` 다. 런타임에 직접 꺼내 써도 된다:
`const { UiButton } = window.__WS_UI__`.

### 들어 있는 것

| 묶음 | 이름 |
|---|---|
| 부품 | `UiActionSheet` `UiAppRail` `UiAvatar` `UiBadge` `UiButton` `UiCard` `UiCardContent` `UiCardHeader` `UiCardTitle` `UiCheckbox` `UiChip` `UiEditorToolbar` `UiEmptyState` `UiErrorTile` `UiFab` `UiIcon` `UiIconButton` `UiInput` `UiKeycap` `UiMentionList` `UiMenu` `UiModal` `UiPasswordInput` `UiRadio` `UiRadioCard` `UiSegment` `UiSelect` `UiSkeleton` `UiSplitButton` `UiStatusDot` `UiSwitch` `UiTabbar` `UiTabs` `UiTextarea` `UiTooltip` `UiTopbar` `UiTrans` |
| 훅 | `useUiMentionList` |
| 토스트 | `useToast()` · `toast({ type, title, description?, action?: { label, onClick }, duration? })`(행동이 있으면 기본 6초) · `addToast(type, message, duration?)` · `removeToast(id)` |
| 대화상자 | `useDialog()` · `alertBox(msg, opts?)` · `confirmBox(msg, { danger?, confirmLabel?, size?: 'sm' \| '400' \| '440' })` · `promptBox(msg, opts?)` · `choose({ title?, message?, actions })` — 모두 Promise |

- 토스트·대화상자는 호스트가 이미 화면에 그리고 있다(`UiToast`·`UiDialogHost` 는 키트에 없다 — 다시 그리면 두 번 뜬다).
- 각 부품의 props 는 호스트 소스 `frontend-react/src/components/ui/*.tsx` 의 JSDoc 이 기준이다.
- 런타임 객체에는 `version`(지금 `1`)이 있다 — 키를 빼거나 props 를 깨는 변경이면 호스트가 올린다.
- v1(Vue) 플러그인은 React 부품을 쓸 수 없다(이 전역은 v2 전용).
