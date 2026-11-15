# 플러그인 프론트엔드 — 제약과 관용구

플러그인의 화면(`plugins/<폴더>/frontend/page.tsx` 또는 `page.vue`)은 워크스페이스 본체 화면(이하 "호스트", `frontend-react/`)과 **따로 빌드**된다.
호스트는 화면을 열 때 `/api/plugin-assets/<id>/bundle.mjs` 를 동적 import 하고, 프레임워크는 전역으로 나눠 쓴다(v2 React `window.__REACT__`, v1 Vue `window.__VUE__`).
이 구조 때문에 호스트 화면을 짤 때와 규칙이 다르고, **모르고 짜면 오류 없이 조용히 안 먹는다.**

플러그인 전체 그림(manifest·백엔드·설치)은 [extensions.md](extensions.md), v2(React) 작성법은 [frontend-react/docs/plugin-v2.md](../frontend-react/docs/plugin-v2.md).
이 문서는 두 계약에 공통인 제약을 다룬다. 예제 코드는 v1(Vue)과 v2(React)가 섞여 있다 — 원리는 같다.

## 제약 1 — Tailwind 클래스가 없을 수 있다

호스트는 Tailwind 4(CSS-first)다. `frontend-react/src/assets/css/app.css` 가 자동 탐색을 끄고(`source(none)`) 호스트 소스만 스캔한다:

```css
@import 'tailwindcss' source(none);
@source '../../../index.html';
@source '../../';            /* = frontend-react/src — 워크스페이스 plugins/ 는 아니다 */
```

Tailwind 는 **스캔한 소스에서 발견한 문자열만** 유틸리티를 생성한다. 따라서 플러그인에서 쓴 클래스는
**호스트가 같은 클래스를 어딘가에서 쓰고 있을 때만** 실제 CSS 로 존재한다. 플러그인 소스는 `frontend-react/` 이미지 빌드 범위
**밖**이라(관리 화면에서 올린 플러그인은 서버에 소스조차 없다) `@source` 를 더하는 것으로는 해결되지 않는다.

어떤 일이 생기나:

| 클래스 | 결과 | 이유 |
|---|---|---|
| 호스트가 쓰고 있는 클래스(예: `w-72`, `bg-scrim`, `z-drawer`) | 동작 | 호스트 CSS 에 이미 있다 |
| 호스트가 안 쓰는 클래스(예: 음수 `-translate-x-full` 은 있는데 양수 `translate-x-full` 은 없는 경우) | 아무 일도 안 일어남 | CSS 가 만들어지지 않았다 |
| `md:*` · `sm:*` 같은 반응형 조합 | 호스트가 **똑같은 조합**(`md:w-72` 등)을 쓸 때만 동작 | 조합마다 따로 만들어진다 |

어느 클래스가 "지금 호스트에 있는지"는 호스트 버전마다 달라진다. 위 표의 예를 믿지 말고 아래 3번처럼 직접 확인한다.

### 그래서 지켜야 할 것

1. **반응형 variant(`md:` `sm:` `lg:`)에 기대지 말 것.** 호스트가 같은 조합을 쓰고 있을 때만 CSS 에 있고, 호스트가 리팩터링하면 소리 없이 사라진다.
   호스트와 같은 기준으로 **JS 에서 판정**한다(아래는 v1 Vue 예 — v2 는 `useState` + `matchMedia` 로 같은 일을 한다):
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
2. **transform 처럼 값이 다양한 유틸은 인라인 스타일로**(Vue `:style`, React `style`). 클래스 존재 여부에 걸지 않는다.
   ```html
   :style="isMobile ? { transform: open ? 'translateX(0)' : 'translateX(-100%)' } : {}"
   ```
3. 새 클래스를 쓰기 전에 **브라우저에서 실제로 먹는지 확인**한다:
   ```js
   const d = document.createElement('div'); d.className = 'z-drawer';
   document.body.appendChild(d); getComputedStyle(d).zIndex   // '200' 이면 존재
   ```

> v2 는 호스트 UI 키트(`@jw/ui` → `window.__WS_UI__`)를 쓰면 이 문제의 대부분이 사라진다 — 키트 안쪽 클래스는 호스트 소스라 이미 스캔돼 있다.
> 플러그인 번들이 자기 Tailwind CSS 를 따로 만들어 싣는 길은 제공하지 않는다.

## 제약 2 — `<style>` 블록 (v1)

`plugins/build-plugin.mjs` 는 빌드에서 나온 CSS 를 `plugin.mjs` 안에 넣어 준다(화면을 열 때 `<style>` 로 붙는다). `<style scoped>` 는 잘 처리되지만
전역 `<style>` 은 빌드가 깨질 수 있다. 스타일이 꼭 필요하면 `scoped` 로 쓰고, 웬만하면 **유틸 클래스 + 인라인 style** 로 해결한다.

## 모바일 화면

- 데스크탑의 고정폭 사이드 패널 → 모바일에선 **드로어**
  (`fixed inset-y-0 (left|right)-0 z-drawer w-72 max-w-[82%]` + 인라인 transform + `bg-scrim` 스크림)
- 상단바 버튼 줄이 넘치면 → `overflow-x-auto` + 자식들에 `shrink-0`
- 주 액션 실행 시 드로어를 닫아 결과가 보이게 한다

## 번들 캐싱

호스트 로더(`frontend-react/src/plugins/pluginHost.tsx`)는 번들 주소에 **버전 꼬리표(`?v=…`)를 붙이지 않는다.** 주소가 매번 달라지면
브라우저가 캐시를 다시 쓰지 못해 화면을 열 때마다 번들 전체를 다시 받게 되기 때문이다.

대신 백엔드(`backend/app/plugins/router.py`)가 ETag(파일 수정 시각 + 크기)와 `Cache-Control: no-cache` 를 주고 `If-None-Match` 를 직접 처리한다.
다시 열면 304(수백 바이트)로 끝나고, 플러그인을 새로 빌드하면 파일이 바뀌어 자동으로 새 번들을 받는다. 플러그인 쪽에서 할 일은 없다 —
번들 안에서 자기 주소에 꼬리표를 붙여 다시 불러오는 식의 코드만 쓰지 않으면 된다.

## 화면 경로

플러그인 화면의 주소는 `/p/<id>` 다 — manifest 의 `id` 이지 폴더 이름이 아니다(manifest `route` 도 `/p/<id>` 로 맞춘다).
폴더가 `my-plugin` 이어도 id 가 `myplugin` 이면 경로는 `/p/myplugin` 이다.

화면 하단까지 자기 컨트롤로 쓰는 페이지는 manifest 에 `"fullscreen": true` 를 둔다.
호스트 셸(`frontend-react/src/layouts/default.tsx`)이 그 경로에서 모바일 하단 탭바를 숨긴다.

사이드바·모바일 메뉴에서의 자리는 manifest 의 `"order"`(정수, 작을수록 위)로 정한다 — 없으면 폴더 이름순으로 뒤에.
자세한 규칙은 [extensions.md](extensions.md) 의 manifest 표.

## 상단바 확장 자리 — 플러그인 버튼·칩

플러그인 페이지는 호스트 상단바 오른쪽(데스크톱 TopBar 검색 앞 · 모바일 머리 오른쪽)에 버튼이나 칩을 넣을 수 있다.
번들은 호스트 코드를 import 할 수 없으므로 전역 객체 `window.__WS_SHELL__` 로 부른다(같은 함수가 v2 `pluginApi`, v1 `inject('pluginApi')` 에도 있다).

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

- **마운트 중에만 등록**한다. 해제를 잊어도 호스트(`frontend-react/src/pages/p/[id].tsx`)가 페이지를 떠날 때·다른 플러그인으로 바뀔 때 전부 지운다.
- 렌더는 호스트 규격 그대로: 아이콘 버튼 = UiIconButton(데스크톱 32 · 모바일 44), 칩 = UiChip(데스크톱 32 · 모바일 36 + 히트 44).
  칩 톤은 선택(`pressed: true`) 색으로 primary·warning·success 를 쓴다(success 는 ✓ 대신 icon 을 success 색으로 — 열림·연결 같은 켜짐 상태). 아이콘 버튼은 tone 이 글자색.
- icon `search` 를 등록하면 모바일에서 호스트의 이동·검색(Ctrl K) 돋보기는 숨겨진다(머리에 돋보기 하나).
- 최대 4개(넘치면 앞에서부터). 모바일 머리는 좁으니 1~2개를 권장.
- 여러 버전의 워크스페이스에서 돌 플러그인이라면 `window.__WS_SHELL__?.…` 처럼 있는지 보고 부른다.

## 상단바 제목 — 지금 보고 있는 것의 이름

플러그인 페이지는 호스트 상단바 제목을 잠시 덮어쓸 수 있다(예: 편집 중인 문서·프로젝트 이름).
데스크톱은 3단 경로의 마지막 칸(워크스페이스 / 모듈 / **제목**), 모바일은 머리 제목 한 줄에 그대로 보인다.
플러그인 화면 안에 같은 제목을 또 그릴 필요가 없다(특히 모바일).

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

- `null`·빈 문자열을 주면 그 owner 몫을 풀어 **호스트 기본 제목으로 원복**한다. 공백은 한 칸으로 다듬고 200자에서 자른다.
- 같은 owner 로 다시 부르면 바뀐다. 여러 owner 가 걸면 **마지막에 건 것**이 보이고, 그것을 풀면 앞의 것이 다시 보인다.
- 해제를 잊어도 호스트가 페이지를 떠날 때·다른 플러그인으로 바뀔 때 전부 지운다.
- 같은 함수가 v2 `pluginApi.setTitle`·`clearTitle`, v1 `inject('pluginApi')` 에도 있다(같은 상태).
- 여러 버전의 워크스페이스에서 돌 플러그인이라면 `__WS_SHELL__?.setTitle?.(…)` 처럼 있는지 보고 부르고, 없으면 화면 안 제목을 그대로 둔다.
