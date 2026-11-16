# 플러그인 프런트 v2 (React) — 작성 지침

워크스페이스 본체 화면(이하 "호스트", `frontend-react/`)은 플러그인 번들을 두 종류의 계약으로 로드한다. 신규 플러그인은 **v2** 로 작성한다.

| 계약 | 번들 | 호스트의 처리 |
|---|---|---|
| **v2 (React)** | react 를 번들에 포함하지 않고 `window.__REACT__` / `window.__REACT_DOM__` 을 참조한다. default export = React 컴포넌트 | 호스트 React 트리 내에서 `<Plugin pluginApi={…} />` 로 렌더링한다(동일한 React 인스턴스이므로 hook 이 그대로 동작) |
| **v1 (Vue)** | `plugins/build-plugin.mjs` 산출물. `const {…} = window.__VUE__` 로 시작, default export = Vue 컴포넌트 | v1 플러그인을 로드할 때에 한하여 Vue 런타임을 내려받아(별도 청크) `window.__VUE__` 를 설정하고 `createApp(...).mount(div)` 로 마운트한다. 호스트 API 는 `inject('pluginApi')` |

견본: v2 는 `plugins/remote-desktop`, v1 은 `plugins/sample-notes`. 로더는 `src/plugins/pluginHost.tsx`, 화면은 `src/pages/p/[id].tsx`(본 문서의 `src/…` 는 `frontend-react/src/…` 를 의미한다).
플러그인의 전체 구조(manifest·백엔드·설치·보안)는 [docs/extensions.md](../../docs/extensions.md), 두 계약의 공통 제약은 [docs/plugin-frontend.md](../../docs/plugin-frontend.md)를 참조한다.

> 라이선스: 호스트는 AGPL-3.0-or-later 로 배포되며 플러그인에 대한 예외는 없다 — 배포하는 플러그인에 적용되는 조건은 [docs/extensions.md](../../docs/extensions.md)의 "플러그인의 라이선스"를 참조한다.

## 1. 번들 주소·캐싱 (v1 과 동일)

- 주소는 `/api/plugin-assets/<id>/bundle.mjs` (백엔드가 `plugins/<folder>/frontend/dist/plugin.mjs` 를 제공한다).
- **캐시버스터를 부가하지 않는다.** 백엔드가 ETag + `Cache-Control: no-cache` 를 제공하고 `If-None-Match` 를 직접 처리하므로
  URL 이 고정되어 있으면 재방문 시 304(수백 바이트)로 응답하고, 재빌드 시 mtime 이 변경되어 자동으로 반영된다. 상세 사항은 [plugin-frontend.md](../../docs/plugin-frontend.md) "번들 캐싱"을 참조한다.
- 번들은 **단일 파일**로 생성한다(코드 분할 금지 — 호스트는 청크 경로를 알 수 없다). CSS 는 JS 에 인라인한다(아래 빌드 예 참조).

## 2. 계약 버전 판정

1. 모듈 목록(`/api/platform/modules`)에 `frontend_api`(`1`·`2`·`"vue"`·`"react"`) 값이 있으면 해당 값을 따른다. **현재 백엔드는 manifest 의 이 필드를 목록에 포함하지 않으므로**
   (`backend/app/modules/registry.py` 가 지정된 필드만 복사) 실제로는 항상 2번 절차로 진행된다. manifest 에 기재하여도 무방하다.
2. 호스트가 번들 **소스를 fetch** 하여 판정한다: `jwPlugin` export·`window.__REACT__` → v2, `window.__VUE__` → v1.
   v1 번들은 최상단에서 `window.__VUE__` 를 구조분해하므로 import **이전에** 판정하여야 하기 때문이다.
   동일한 URL 이므로 HTTP 캐시를 공유하며 두 번째 요청은 304 로 응답된다.
3. import 후 `export const jwPlugin = { api: 2 }` 가 있으면 최종적으로 v2 로 판정한다. 표식과 전역 참조가 모두 없으면 v1 로 간주한다.

→ **v2 번들은 반드시 표식을 export 하여야 한다**:

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
| `pluginId` | `string` | 현재 로드된 플러그인 id (`/p/<id>`) |
| `user` | `User \| null` | 로그인 사용자 — **값**(v1 은 Vue ref). 변경 시 새 props 로 재렌더링된다 |
| `appName` | `string` | 사이트 이름(브랜딩) — **값** |
| `$fetch` | `(url, opts?) => Promise` | 호스트 API 클라이언트(ofetch). 로그인 정보와 서버 주소를 자동으로 부가한다(웹·데스크톱·모바일 앱 공통). 옵션은 ofetch 와 동일하다(`method/body/query/headers`) |
| `setHeaderActions` | `(actions, owner = 'plugin') => () => void` | 상단바 버튼·칩 등록. 반환된 함수로 해제 |
| `clearHeaderActions` | `(owner = 'plugin') => void` | 상단바 항목 해제 |
| `setTitle` | `(title: string \| null, owner = 'plugin') => () => void` | 상단바 제목 대체(데스크톱 경로 마지막 항목 · 모바일 헤더). `null`·`''` = 원복. 반환된 함수로 원복 |
| `clearTitle` | `(owner = 'plugin') => void` | 상단바 제목 원복 |
| `navigateTo` | `(to, opts?) => Promise<void>` | 호스트 라우터 이동(새로고침 없음). `to` 는 경로 문자열 또는 `{ path, query, hash }` |
| `t` | `(key, a?, b?) => string` (선택) | 호스트 i18n. 키는 호스트 locales 기준 — 플러그인 고유 문구는 플러그인이 자체 보유한다 |

- `pluginApi` 객체는 user·appName·언어가 변경될 때 새로 생성된다. effect 의존성에 객체 전체를 지정하면 변경 시마다 재실행된다.
- 호스트는 페이지 이탈 시·다른 플러그인으로의 전환 시 상단바 항목·제목을 **전부** 제거한다(해제를 누락하여도 잔존하지 않음).
- 렌더링 중 예외가 발생하면 플러그인 영역만 "Failed to load plugin" 으로 대체되며 셸은 유지된다.

### 전역 (v1 과 동일)

| 전역 | 내용 |
|---|---|
| `window.__REACT__` | 호스트 `react` 모듈(네임스페이스) |
| `window.__REACT_DOM__` | `react-dom` + `react-dom/client` 를 합친 객체(`createPortal`, `flushSync`, `createRoot` …) |
| `window.__WS_SHELL__` | `{ version: 1, setHeaderActions, clearHeaderActions, setTitle, clearTitle }` — [plugin-frontend.md](../../docs/plugin-frontend.md) "상단바 확장 자리"·"상단바 제목" 과 동일한 API. `pluginApi` 의 동명 함수와 동일한 상태를 변경한다 |
| `window.__WS_UI__` | 호스트 UI 키트 `{ version: 1, UiButton, UiModal, UiMenu, …, useToast, toast, useDialog, confirmBox, … }` — 아래 7절 |

## 4. 번들 빌드 설정 예 (react external + 전역 치환)

v2 용 공용 빌드 스크립트는 리포에 포함되어 있지 않으며, 플러그인이 자체 빌드 스크립트를 보유한다. 처리 내용은 `plugins/build-plugin.mjs` 가 vue 에 대해 수행하는 것과 동일하다:
`react`·`react-dom`·`@jw/ui` 를 번들에서 제외하고(external), 잔존하는 import 문을 호스트 전역을 참조하는 코드로 치환한다.
JSX 를 **classic 런타임**(`React.createElement`)으로 출력하면 `react/jsx-runtime` 을 별도로 치환할 필요가 없다.

실제 동작하는 예는 견본의 `plugins/remote-desktop/frontend/build.mjs`(esbuild — 타입 검사, 번들, 전역 치환, 치환 누락·표식 검사를 단일 파일로 수행)다.
아래는 동일한 처리를 vite 로 구성한 설정 예다(리포에 포함되지 않은 파일 — 필요한 패키지 `vite`·`@vitejs/plugin-react` 는 직접 설치한다).

```js
// <플러그인 폴더>/frontend/build.mjs (예시)
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
// CSS 파일이 따로 나오면 plugins/build-plugin.mjs 끝의 "Inline emitted CSS" 단계처럼 plugin.mjs 안에 넣는다(서빙되는 것은 plugin.mjs 하나뿐이다).
```

빌드 후 확인: `dist/plugin.mjs` 에 `from "react"`·`from "@jw/ui"` 가 **잔존하지 않아야** 하며, `jwPlugin` export 가 존재하여야 한다.

## 5. 스타일 제약 (v1 과 동일)

[plugin-frontend.md](../../docs/plugin-frontend.md) 의 제약이 동일하게 적용된다:

- 호스트 Tailwind 는 호스트 소스만 스캔한다 → 플러그인에서 사용한 클래스는 **호스트도 사용 중인 경우에만** CSS 가 존재한다.
- **반응형 variant(`sm:` `md:` `lg:`)에 의존하지 않는다** — `window.matchMedia('(max-width: 767px)')` 로 JS 에서 판정한다(호스트 `useIsMobile` 과 동일한 기준).
- transform 과 같이 값의 종류가 다양한 속성은 인라인 `style` 로 지정한다.
- 신규 클래스는 브라우저에서 실제 적용 여부를 확인한다(`getComputedStyle`).

## 6. v1(Vue) 플러그인의 로드 방식

- 호스트가 판정(위 2절) → `import('vue')`(별도 청크, v1 로드 시에 한함) → `window.__VUE__ = Vue` →
  번들 import → `createApp(default).provide('pluginApi', { user, $fetch, appName, setHeaderActions, clearHeaderActions, setTitle, clearTitle }).mount(div)`.
  `user`·`appName` 은 Vue `ref` 이며 호스트 상태(로그인·브랜딩)와 동기화된다. 페이지 이탈 시 `app.unmount()` 를 호출한다.
- 마운트 지점은 `display: contents` div 이므로 플러그인 루트의 `h-full` 등 높이 지정이 그대로 적용된다.
- 호스트는 React 앱이다. v1 플러그인이 사용할 수 있는 호스트 기능은 위 `pluginApi` 와 `window.__WS_SHELL__` 에 한정된다 —
  Vue Router·Nuxt API·호스트 컴포넌트·호스트 디렉티브는 제공되지 않으며, v1 의 `pluginApi` 에는 `navigateTo`·`t` 도 포함되지 않는다.
- Vue 런타임 버전은 호스트가 결정한다(`frontend-react/package.json` 의 `vue`). 번들은 Vue 를 포함하지 않는다.

## 7. 호스트 UI 키트 (`window.__WS_UI__`)

v2 플러그인은 버튼·모달·메뉴를 자체 구현하지 않고 **호스트 키트를 그대로** 사용한다. 동일한 React 인스턴스와 동일한 토큰 CSS 를 사용하므로
외형·키보드 조작·접근성이 호스트 화면과 일치하며, 위 5절의 "호스트가 사용하지 않는 클래스는 CSS 가 존재하지 않는다"는 제약도 키트 내부의 클래스에는 해당하지 않는다
(키트는 호스트 소스이므로 Tailwind 가 이미 스캔한다).

### 사용 방법

번들에서는 가상 모듈 `@jw/ui` 로 import 하고, 빌드 시 react 와 동일하게 **external + 전역 치환**한다(4절의 설정에 이미 포함되어 있다).

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

치환 결과는 `const { UiButton, UiModal, … } = window.__WS_UI__;` 다. 런타임에 직접 참조하는 것도 가능하다:
`const { UiButton } = window.__WS_UI__`.

### 제공 항목

| 분류 | 이름 |
|---|---|
| 컴포넌트 | `UiActionSheet` `UiAppRail` `UiAvatar` `UiBadge` `UiButton` `UiCard` `UiCardContent` `UiCardHeader` `UiCardTitle` `UiCheckbox` `UiChip` `UiEditorToolbar` `UiEmptyState` `UiErrorTile` `UiFab` `UiIcon` `UiIconButton` `UiInput` `UiKeycap` `UiMentionList` `UiMenu` `UiModal` `UiPasswordInput` `UiRadio` `UiRadioCard` `UiSegment` `UiSelect` `UiSkeleton` `UiSplitButton` `UiStatusDot` `UiSwitch` `UiTabbar` `UiTabs` `UiTextarea` `UiTooltip` `UiTopbar` `UiTrans` |
| 훅 | `useUiMentionList` |
| 토스트 | `useToast()` · `toast({ type, title, description?, action?: { label, onClick }, duration? })`(action 지정 시 기본 6초) · `addToast(type, message, duration?)` · `removeToast(id)` |
| 대화상자 | `useDialog()` · `alertBox(msg, opts?)` · `confirmBox(msg, { danger?, confirmLabel?, size?: 'sm' \| '400' \| '440' })` · `promptBox(msg, opts?)` · `choose({ title?, message?, actions })` — 모두 Promise |

- 토스트·대화상자는 호스트가 이미 렌더링하고 있다(`UiToast`·`UiDialogHost` 는 키트에 포함되지 않는다 — 재차 렌더링하면 중복 표시된다).
- 각 컴포넌트의 props 는 호스트 소스 `frontend-react/src/components/ui/*.tsx` 의 JSDoc 이 기준이다.
- 런타임 객체에는 `version`(현재 `1`)이 포함된다 — 키의 제거 또는 props 의 호환성을 깨는 변경이 있는 경우 호스트가 이 값을 증가시킨다.
- v1(Vue) 플러그인은 React 컴포넌트를 사용할 수 없다(이 전역은 v2 전용이다).
