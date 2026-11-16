# 플러그인 프런트엔드 — 제약 사항 및 구현 지침

플러그인의 화면(`plugins/<폴더>/frontend/page.tsx` 또는 `page.vue`)은 워크스페이스 본체 화면(이하 "호스트", `frontend-react/`)과 **별도로 빌드**된다.
호스트는 화면 진입 시 `/api/plugin-assets/<id>/bundle.mjs` 를 동적 import 하며, 프레임워크는 전역 객체로 공유한다(v2 React `window.__REACT__`, v1 Vue `window.__VUE__`).
이 구조로 인하여 호스트 화면 개발과는 다른 규칙이 적용되며, **이를 준수하지 않으면 오류 없이 스타일이 적용되지 않는다.**

플러그인의 전체 구조(manifest·백엔드·설치)는 [extensions.md](extensions.md), v2(React) 작성 지침은 [frontend-react/docs/plugin-v2.md](../frontend-react/docs/plugin-v2.md)를 참조한다.
본 문서는 두 계약에 공통으로 적용되는 제약을 기술한다. 예제 코드에는 v1(Vue)과 v2(React)가 혼재하나 원리는 동일하다.

## 제약 1 — Tailwind 클래스의 부재 가능성

호스트는 Tailwind 4(CSS-first)를 사용한다. `frontend-react/src/assets/css/app.css` 가 자동 탐색을 비활성화하고(`source(none)`) 호스트 소스만 스캔한다:

```css
@import 'tailwindcss' source(none);
@source '../../../index.html';
@source '../../';            /* = frontend-react/src — 워크스페이스 plugins/ 는 아니다 */
```

Tailwind 는 **스캔한 소스에서 발견한 문자열에 한하여** 유틸리티를 생성한다. 따라서 플러그인에서 사용한 클래스는
**호스트가 동일한 클래스를 사용하고 있는 경우에만** 실제 CSS 로 존재한다. 플러그인 소스는 `frontend-react/` 이미지 빌드 범위의
**외부**에 있으므로(관리 화면에서 업로드한 플러그인은 서버에 소스 자체가 없다) `@source` 추가로는 해결되지 않는다.

발생하는 현상:

| 클래스 | 결과 | 사유 |
|---|---|---|
| 호스트가 사용 중인 클래스(예: `w-72`, `bg-scrim`, `z-drawer`) | 동작 | 호스트 CSS 에 이미 존재한다 |
| 호스트가 사용하지 않는 클래스(예: 음수 `-translate-x-full` 은 존재하나 양수 `translate-x-full` 은 없는 경우) | 적용되지 않음 | CSS 가 생성되지 않았다 |
| `md:*` · `sm:*` 등 반응형 조합 | 호스트가 **동일한 조합**(`md:w-72` 등)을 사용하는 경우에만 동작 | 조합별로 개별 생성된다 |

특정 클래스의 호스트 내 존재 여부는 호스트 버전에 따라 달라진다. 위 표의 예시에 의존하지 말고 아래 3번의 방법으로 직접 확인한다.

### 준수 사항

1. **반응형 variant(`md:` `sm:` `lg:`)에 의존하지 않는다.** 호스트가 동일한 조합을 사용하는 경우에만 CSS 에 존재하며, 호스트의 리팩터링 시 예고 없이 제거될 수 있다.
   호스트와 동일한 기준으로 **JS 에서 판정**한다(아래는 v1 Vue 예 — v2 는 `useState` + `matchMedia` 로 동일하게 구현한다):
   ```ts
   const isMobile = ref(false)
   let _mq: MediaQueryList | null = null
   onMounted(() => {
     _mq = window.matchMedia('(max-width: 767px)')   // 호스트 useIsMobile 과 같은 기준
     isMobile.value = _mq.matches
     _mq.addEventListener('change', _onMq)
   })
   onBeforeUnmount(() => _mq?.removeEventListener('change', _onMq))
   ```
2. **transform 과 같이 값의 종류가 다양한 유틸리티는 인라인 스타일로 지정한다**(Vue `:style`, React `style`). 클래스의 존재 여부에 의존하지 않는다.
   ```html
   :style="isMobile ? { transform: open ? 'translateX(0)' : 'translateX(-100%)' } : {}"
   ```
3. 신규 클래스는 사용 전에 **브라우저에서 실제 적용 여부를 확인**한다:
   ```js
   const d = document.createElement('div'); d.className = 'z-drawer';
   document.body.appendChild(d); getComputedStyle(d).zIndex   // '200' 이면 존재
   ```

> v2 는 호스트 UI 키트(`@jw/ui` → `window.__WS_UI__`)를 사용하면 이 문제의 대부분이 해소된다 — 키트 내부의 클래스는 호스트 소스이므로 이미 스캔되어 있다.
> 플러그인 번들이 자체 Tailwind CSS 를 생성하여 포함하는 방식은 지원하지 않는다.

## 제약 2 — `<style>` 블록 (v1)

`plugins/build-plugin.mjs` 는 빌드에서 생성된 CSS 를 `plugin.mjs` 에 인라인한다(화면 진입 시 `<style>` 로 삽입된다). `<style scoped>` 는 정상 처리되나
전역 `<style>` 은 빌드 실패를 유발할 수 있다. 스타일이 반드시 필요한 경우 `scoped` 로 작성하고, 가급적 **유틸리티 클래스 + 인라인 style** 로 처리한다.

## 모바일 화면

- 데스크톱의 고정폭 사이드 패널 → 모바일에서는 **드로어**
  (`fixed inset-y-0 (left|right)-0 z-drawer w-72 max-w-[82%]` + 인라인 transform + `bg-scrim` 스크림)
- 상단바 버튼 행이 넘치는 경우 → `overflow-x-auto` + 자식 요소에 `shrink-0`
- 주 액션 실행 시 드로어를 닫아 결과가 표시되도록 한다

## 번들 캐싱

호스트 로더(`frontend-react/src/plugins/pluginHost.tsx`)는 번들 주소에 **버전 쿼리 문자열(`?v=…`)을 부가하지 않는다.** 주소가 매번 달라지면
브라우저 캐시를 재사용할 수 없어 화면 진입 시마다 번들 전체를 다시 내려받게 되기 때문이다.

대신 백엔드(`backend/app/plugins/router.py`)가 ETag(파일 수정 시각 + 크기)와 `Cache-Control: no-cache` 를 제공하고 `If-None-Match` 를 직접 처리한다.
재방문 시에는 304(수백 바이트)로 응답하며, 플러그인을 재빌드하면 파일이 변경되어 새 번들이 자동으로 적용된다. 플러그인 측에서 필요한 조치는 없다 —
번들 내부에서 자신의 주소에 쿼리 문자열을 부가하여 재로드하는 코드만 작성하지 않으면 충분하다.

## 화면 경로

플러그인 화면의 주소는 `/p/<id>` 다 — 기준은 manifest 의 `id` 이며 폴더 이름이 아니다(manifest `route` 도 `/p/<id>` 로 일치시킨다).
폴더가 `my-plugin` 이더라도 id 가 `myplugin` 이면 경로는 `/p/myplugin` 이다.

화면 하단까지 자체 컨트롤로 사용하는 페이지는 manifest 에 `"fullscreen": true` 를 지정한다.
호스트 셸(`frontend-react/src/layouts/default.tsx`)이 해당 경로에서 모바일 하단 탭바를 숨긴다.

사이드바·모바일 메뉴에서의 표시 위치는 manifest 의 `"order"`(정수, 값이 작을수록 상단)로 지정한다 — 미지정 시 폴더 이름순으로 후순위에 배치된다.
상세 규칙은 [extensions.md](extensions.md) 의 manifest 표를 참조한다.

## 상단바 확장 자리 — 플러그인 버튼·칩

플러그인 페이지는 호스트 상단바 우측(데스크톱 TopBar 검색 앞 · 모바일 헤더 우측)에 버튼 또는 칩을 등록할 수 있다.
번들은 호스트 코드를 import 할 수 없으므로 전역 객체 `window.__WS_SHELL__` 를 통해 호출한다(동일한 함수가 v2 `pluginApi`, v1 `inject('pluginApi')` 에도 제공된다).

```ts
// window.__WS_SHELL__ (호스트 frontend-react/src/plugins/hostGlobals.ts 가 붙인다)
interface ShellHeaderAction {
  id: string              // owner 안에서 고유
  label: string           // aria-label·툴팁(필수)
  icon?: string           // 호스트 아이콘 이름(예: 'wand', 'sliders'). text 가 없으면 필수
  text?: string           // 있으면 아이콘 버튼 대신 칩
  tone?: 'default' | 'primary' | 'warning' | 'danger' | 'success'
  pressed?: boolean       // 토글이면 true/false(aria-pressed), 일반 버튼이면 생략
  disabled?: boolean
  onClick?: (e: MouseEvent) => void
}
__WS_SHELL__.setHeaderActions(actions: ShellHeaderAction[], owner = 'plugin'): () => void  // 해제 함수를 돌려줌
__WS_SHELL__.clearHeaderActions(owner = 'plugin'): void
__WS_SHELL__.version // 1
```

사용 예(v1 플러그인 `page.vue` — v2 는 [plugin-v2.md](../frontend-react/docs/plugin-v2.md) 3절의 `useEffect` 예):

```ts
const { ref, onMounted, onBeforeUnmount, watch } = window.__VUE__
const panelOpen = ref(false)
let off = () => {}
function sync() {
  off = window.__WS_SHELL__?.setHeaderActions([
    { id: 'panel', label: '설정 패널', icon: 'sliders', pressed: panelOpen.value, onClick: () => { panelOpen.value = !panelOpen.value } },
    { id: 'run', label: '실행', text: '실행', icon: 'wand', onClick: run },
  ]) ?? (() => {})
}
onMounted(sync)
watch(panelOpen, sync)          // 상태가 바뀌면 같은 owner 로 다시 set(통째로 바뀜)
onBeforeUnmount(() => off())
```

- **마운트 상태에서만 등록**한다. 해제를 누락하더라도 호스트(`frontend-react/src/pages/p/[id].tsx`)가 페이지 이탈 시·다른 플러그인으로의 전환 시 전부 제거한다.
- 렌더링은 호스트 규격을 따른다: 아이콘 버튼 = UiIconButton(데스크톱 32 · 모바일 44), 칩 = UiChip(데스크톱 32 · 모바일 36 + 히트 44).
  칩 톤은 선택(`pressed: true`) 색상으로 primary·warning·success 를 사용한다(success 는 체크 표시 대신 icon 을 success 색상으로 표시 — 열림·연결 등 활성 상태). 아이콘 버튼은 tone 이 글자색에 적용된다.
- icon `search` 를 등록하면 모바일에서 호스트의 이동·검색(Ctrl K) 돋보기 아이콘은 숨겨진다(헤더의 돋보기 아이콘은 하나로 유지된다).
- 최대 4개(초과 시 앞에서부터 적용). 모바일 헤더는 폭이 좁으므로 1~2개를 권장한다.
- 복수 버전의 워크스페이스에서 실행될 플러그인은 `window.__WS_SHELL__?.…` 와 같이 존재 여부를 확인한 후 호출한다.

## 상단바 제목 — 현재 표시 대상의 명칭

플러그인 페이지는 호스트 상단바 제목을 일시적으로 대체할 수 있다(예: 편집 중인 문서·프로젝트 이름).
데스크톱에서는 3단 경로의 마지막 항목(워크스페이스 / 모듈 / **제목**)에, 모바일에서는 헤더 제목 한 줄에 그대로 표시된다.
플러그인 화면 내부에 동일한 제목을 중복 표시할 필요가 없다(특히 모바일).

```ts
// window.__WS_SHELL__ (상단바 버튼·칩과 같은 객체)
__WS_SHELL__.setTitle(title: string | null, owner = 'plugin'): () => void  // 해제(원복) 함수를 돌려줌
__WS_SHELL__.clearTitle(owner = 'plugin'): void
```

```ts
// React(v2) 플러그인 예
useEffect(() => {
  const off = window.__WS_SHELL__?.setTitle?.(doc ? doc.title : null) ?? (() => {})
  return off
}, [doc?.title])
```

- `null` 또는 빈 문자열을 전달하면 해당 owner 의 설정을 해제하여 **호스트 기본 제목으로 원복**한다. 연속된 공백은 한 칸으로 정규화하며 200자에서 절단한다.
- 동일한 owner 로 재호출하면 값이 갱신된다. 복수의 owner 가 설정한 경우 **마지막으로 설정한 값**이 표시되며, 이를 해제하면 직전 값이 다시 표시된다.
- 해제를 누락하더라도 호스트가 페이지 이탈 시·다른 플러그인으로의 전환 시 전부 제거한다.
- 동일한 함수가 v2 `pluginApi.setTitle`·`clearTitle`, v1 `inject('pluginApi')` 에도 제공된다(동일한 상태를 공유한다).
- 복수 버전의 워크스페이스에서 실행될 플러그인은 `__WS_SHELL__?.setTitle?.(…)` 와 같이 존재 여부를 확인한 후 호출하고, 함수가 없는 경우 화면 내부의 제목을 유지한다.
