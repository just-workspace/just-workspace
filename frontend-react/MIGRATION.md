# React 전환 — 이식 규칙과 대응표

Vue(Nuxt 3) `frontend/` → React `frontend-react/`. 공통 지시는 `REACT-BRIEF.md`(오케스트레이터 보관, 리포 밖)가 기준이고, 이 문서는
**토대가 정한 실제 규약**과 **Vue → React 파일 대응표**다. 모듈 에이전트는 자기 모듈 섹션에만 줄을 더한다.

> **상태(전환 완료)**: nginx 가 쿠키와 무관하게 전부 `frontend-react` 를 서빙하고, 앱 기본값도 `JW_WEB=react` 다.
> `frontend/`(Vue) 는 리포에서 빠졌다(번역 원본도 React 쪽). 이 문서의 "Vue 와 같게" 규칙은
> 이식 당시의 동등성 기준이며, 이후 변경(대시보드 재설계·유동 레이아웃·Tailwind 4·React Router 8 등)은 React 쪽에서만 일어난다.

---

## 1. 이식 규칙 요약 (모듈 에이전트 필독)

### 1-1. 파일 위치·이름

| Vue | React |
|---|---|
| `frontend/pages/<경로>.vue` | `src/pages/<같은 경로>.tsx` (default export 컴포넌트 하나). **라우트 표 `src/router/routes.ts` 는 건드리지 않는다** — URL·레이아웃·ownMobileHeader·redirect 가 이미 Vue 와 같게 들어 있다. |
| `components/<dir>/<Name>.vue` (Nuxt 자동 이름 `<DirName>`) | `src/components/<dir>/<Name>.tsx` — **export 이름은 Nuxt 자동 이름 그대로**: `components/ui/Button.vue` → `export function UiButton`, `components/layout/TopBar.vue` → `LayoutTopBar`, `components/mail/MailList.vue` → `MailList`. named + default export 둘 다. |
| `composables/useX.ts` | `src/composables/useX.ts` — zustand store `xStore` + 동작 함수 + `useX()` hook (아래 1-3) |
| `utils/x.ts`, `lib/x.ts` | `src/utils/x.ts`, `src/lib/x.ts` — **자동 import 없음**. 쓰는 곳에서 명시 import. |
| `frontend/tests/**` | `tests/**` (같은 경로). vitest + @testing-library/react. |

### 1-2. 문법 대응

| Vue | React |
|---|---|
| `const { t } = useI18n()` / `$t('k')` | `import { useI18n } from '~/i18n'` → `const { t } = useI18n()`. 호출 형태(`t(k, {x})`, `t(k, n)`, `tm`/`rt`/`te`, `locale`, `setLocale`)는 vue-i18n 과 같다. **locales JSON·키·문구 수정 금지** |
| `useNuxtApp().$i18n.t` (컴포넌트 밖) | `import { i18n } from '~/i18n'` → `i18n.t(...)` |
| `$fetch<T>(url, opts)` | `import { $fetch } from '~/lib/api'` — 같은 ofetch, 같은 옵션(`method/body/query/headers/credentials/responseType`). 번들 앱(VITE_API_BASE) 분기는 이 안에서 처리 |
| `<img :src="'/api/…'">` 처럼 $fetch 를 안 거치는 주소 | Vue 와 같은 문자열 그대로(웹은 same-origin). 번들 앱 대응이 필요한 곳은 `apiUrl()`(`~/lib/runtimeConfig`) |
| `useRoute()` / `useRouter()` / `navigateTo()` | `import { useRoute, useRouter, navigateTo } from '~/lib/router'` — `route.path/query/params/hash/fullPath/meta` 모양 같음. `navigateTo` 는 컴포넌트 밖에서도 됨. `window.history.state.back` → `historyBackPath()` |
| `<NuxtLink :to>` | `import { NuxtLink } from '~/components/NuxtLink'` |
| `useHead({ title: computed(...) })` | `import { useHead } from '~/lib/head'` → `useHead({ title: \`…\` })` |
| `useState<T>('key', init)` (Nuxt) | `useSharedState<T>('key', init)` → `[value, setValue]` (`~/lib/state`). 새 전역 상태는 이름 있는 store 로 |
| `useColorMode()` · `colorMode.preference = x` | `useColorMode()` (`~/composables/useColorMode`) · `setPreference(x)` |
| `useIsMobile()` → `isMobile.value` | `useIsMobile()` → boolean |
| `ref/reactive` (컴포넌트 지역) | `useState` / `useReducer` |
| `computed` | 렌더 중 계산 또는 `useMemo` |
| `watch(src, fn)` / `watchEffect` | `useEffect(fn, [deps])` (immediate 아닌 watch 는 첫 실행을 건너뛰는 ref 로) |
| `onMounted` / `onBeforeUnmount` | `useEffect(() => { …; return () => … }, [])` |
| `v-model` (컴포넌트) | props `modelValue` + `onUpdateModelValue` (아래 1-4) |
| `v-click-outside` | `useClickOutside(ref, handler)` (`~/lib/dom`) |
| `<Teleport to="body">` | `createPortal(node, document.body)` |
| `<Transition>` | 같은 Tailwind 클래스로 마운트/언마운트(필요하면 상태 2단계). 새 애니메이션 라이브러리 금지 |
| `<ClientOnly>` | 그냥 렌더(앱이 SPA) |
| `import.meta.client` | 항상 참 — 조건 제거 |
| `definePageMeta` | `routes.ts` 에 이미 반영 — 페이지 파일에서는 지운다 |
| 페이지 `onErrorCaptured` | 레이아웃·앱 오류 경계(`AppErrorBoundary`)가 같은 토스트를 낸다 |

### 1-3. store 규칙 (composable → hook + store)

Vue 의 모듈 수준 `ref` 싱글턴 composable 하나 = React 파일 하나:

```ts
// src/composables/useFoo.ts
export const fooStore = createStore<FooState>()(() => ({ items: [], loading: false }))   // zustand vanilla
export async function fetchFoo() { … fooStore.setState({ … }) }                        // 동작은 모듈 함수(컴포넌트 밖에서도 호출)
export function useFoo() {                                                              // hook: Vue 와 같은 멤버 이름, 값은 .value 없이
  const items = useStore(fooStore, s => s.items)
  return { items, fetchFoo }
}
```
- 멤버 이름은 Vue composable 이 돌려주던 이름 그대로(`useChat().messages`, `useMail().selectMessage`).
- Vue 의 `x.value = v` 대입이 바깥에서 일어나던 상태는 `setX(v)` 함수를 같이 내보낸다.
- 큰 store 는 hook 이 쓰는 필드만 selector 로 구독(`useStore(store, s => s.field)`), 객체 묶음은 `useShallow`.
- 화면 하나에서만 쓰는 서버 데이터는 TanStack Query 도 된다(`~/lib/query` — 재시도·포커스 재조회 꺼 둠, Vue 와 같음).
  **쿼리 키 규칙: `[모듈, 자원, ...매개변수]`** 예) `['mail', 'messages', { folder }]`. 여러 화면이 같은 키를 쓰면 키 팩토리를 그 모듈 composable 에.
  요청 순서·주소·본문은 Vue 와 같아야 한다.

### 1-4. 컴포넌트 props·이벤트·슬롯 규칙 (UI 키트와 같은 규칙)

- props 이름은 Vue props 의 camelCase 그대로(`backTo`, `hideTabbar`). 기본값도 같게.
- 이벤트 `emit('close')` → `onClose`, `emit('row-click', x)` → `onRowClick(x)`, `emit('update:open', v)` → `onUpdateOpen(v)`.
- `v-model` → `modelValue` + `onUpdateModelValue`. `v-model:open` → `open` + `onUpdateOpen`.
- 기본 슬롯 → `children`. 이름 있는 슬롯 `#footer` → `footer?: ReactNode`(같은 이름 prop 이 이미 있으면 `footerSlot`).
  scoped slot → 같은 이름의 함수 prop `(scope) => ReactNode`.
- `class`·`$attrs` 전달 → `className` 을 `cn()` 으로 루트에 합치고, 나머지 속성(`...rest`)은 Vue 가 붙이던 요소에 그대로.
- 각 export 컴포넌트·props 에 JSDoc(디자인 에이전트가 읽는다).

### 1-5. 금지
- `frontend/`(Vue)·`backend/` 수정. 공용 파일(`src/router/*`, `src/lib/*`, `src/i18n/*`, `src/composables/` 의 토대 파일, `src/components/ui|layout|auth/*`, `src/App.tsx`, `src/main.tsx`, `package.json`, `src/assets/css/app.css`(Tailwind 4 설정·토큰), `src/assets/css/main.css`) 수정 —
  필요하면 이유와 함께 보고(오케스트레이터가 토대에 반영).
- 새 디자인·"더 낫게" 고치기. 원본 버그는 고치지 말고 보고.
- 사설 플러그인 이름을 공개 리포 어디에도 쓰기.
- `React.StrictMode` 를 전제로 한 코드(앱은 StrictMode 없이 돈다 — 소켓·통화 세션 싱글턴).

---

## 2. 토대(r0/foundation) — Vue → React 대응표

모든 hook 은 Vue composable 과 **같은 멤버 이름**, 값은 `.value` 없이. 아래는 파일 대응과 **이름이 새로 생기거나 달라진 것**만.

### 2-1. 앱 골격
| Vue | React |
|---|---|
| `nuxt.config.ts`(head·PWA·devProxy·runtimeConfig) | `index.html`(메타·컬러 모드 머리 스크립트), `vite.config.ts`(PWA·프록시·`APP_NAME`/`BRAND_COLOR`/`VITE_API_BASE`) |
| `app.vue` | `src/App.tsx`(브랜드 색·기본 테마·파비콘·제목 기본값·오류 경계·토스트·다이얼로그·MailComposeHost) |
| `error.vue` / 라우트 없음 | 라우터 `errorElement` / `*` → `AuthErrorScreen` |
| `pages/**`(57) | `src/router/routes.ts`(표) + `src/pages/**`(같은 경로 .tsx, 이식 전은 `NotPortedYet`) |
| `layouts/default·admin·settings.vue` | `src/layouts/default.tsx` `DefaultLayout` · `admin.tsx` `AdminLayout` · `settings.tsx` `SettingsLayout` (admin/settings 는 default 의 pathless 자식) |
| `middleware/auth·module-guard·setup.global.ts` + `plugins/auth.ts` | `src/router/guards.ts`(루트 loader 가 매 이동마다 같은 순서로) |
| `plugins/app-api.client.ts` | `src/lib/api.ts`(`$fetch`, 번들 앱 분기) + `src/lib/bundledApp.ts`(SW 정리) |
| `plugins/mobile.client.ts` · `useIsMobile` | `src/composables/useIsMobile.ts` (`installMobileListener`, `isMobileNow`) |
| `plugins/click-outside.ts` | `src/lib/dom.ts` `useClickOutside` |
| `plugins/plugin-runtime.client.ts` | `src/plugins/hostGlobals.ts`(`__REACT__`·`__REACT_DOM__`·`__WS_SHELL__`) + `src/plugins/pluginHost.tsx`(v1 Vue 런타임 지연 로드) |
| @nuxtjs/i18n | `src/i18n/index.ts`(`useI18n`, `i18n`, `setLocale`, `onLocaleChange`) + `compile.ts`(vue-i18n 문법). 메시지 `src/i18n/locales/*.json` = 원본(전환 후 Vue 사본 동기화 폐지) |
| @nuxtjs/color-mode | `src/composables/useColorMode.ts`(`nuxt-color-mode` 키, `setPreference`) |
| `useState` · `useHead` · `useRoute/useRouter/navigateTo` · `<NuxtLink>` | `src/lib/state.ts` · `src/lib/head.ts` · `src/lib/router.ts`(+`historyBackPath`, `queryString`) · `src/components/NuxtLink.tsx` |
| — | `src/lib/query.ts`(TanStack Query 클라이언트), `src/composables/useTrackedStore.ts`(큰 store 를 읽은 필드만 구독) |

### 2-2. 공용 composable
| Vue | React(store) | 새로 생기거나 달라진 것 |
|---|---|---|
| useAuth | `authStore` | `onBeforeLogout(fn)`, `setUser` |
| useSiteConfig | `siteConfigStore` | — |
| usePlatform | `platformStore` | 컴포넌트 밖 `isModuleEnabled` |
| useToast | `toastStore` | `addToast`·`toast`·`removeToast` 직접 import 가능 |
| useDialog | `dialogStore` | `alertBox`·`confirmBox`·`promptBox`·`choose` 직접 import 가능 |
| usePwa | `pwaStore` | `initPwa`, `subscribePush` 등 모듈 export |
| useShell | `shellStore` | `setActivityOpen`·`setShortcutsOpen`·`setUserMenuOpen`·`setCommandPaletteOpen`·`setMiniCallWidth` |
| useSidebar | `sidebarStore` | `initSidebar`·`toggleSidebarPin` |
| useBreadcrumb | `breadcrumbStore` | `useBreadcrumb(값)` 이 소유(언마운트 때 비움), `setBreadcrumb`·`clearBreadcrumb`. ※ React 는 자식 effect 가 먼저라 레이아웃과 페이지가 둘 다 부르면 레이아웃이 이긴다(Vue 반대) — 지금 admin/settings 페이지 중 부르는 곳 없음 |
| useOwnMobileHeader | `ownMobileHeaderStore` | `useOwnMobileHeader(조건)`, `useOwnMobileHeaderActive()` → boolean |
| useDesktopShell | — | `isDesktopShellNow()` |
| useShellHeaderActions | `headerActionsStore` | `getHeaderActions()` |
| useNav · useCommands · useRecents · useSettingsNav · useAttention · useAdminOps | (각 store) | `isNavActive`·`navHome`, `pushRecent`, `refreshAdminOps`·`ensureAdminOps` |
| useShortcuts | — | `usePageShortcuts(title, items)`(렌더마다 현재 목록), `registerPageShortcuts(title, items\|fn) → off`, `usePageShortcutGroups()` |
| useCapsLock | — | — |
| useChat | `chatStore` | `initChat()`·`cleanupChat()`(로그아웃 때 자동), setter `setShowMemberPanel`·`setShowPinsPanel`·`setShowSearchPanel`·`setSearchQuery`·`setShowNotifyBanner`, 밖용 선택자 `selectSelectedChannel`·`selectSortedChannels`·`selectUnreadSummary`·`selectActiveThreadDraft`·`selectSelectedChannelDraft` |
| useNotifications | `notificationsStore` | `setShowDropdown` |
| useMyStatus | — | `myStatusSnapshot()` |
| useUserPrefs | `userPrefsStore` | `ensureUserPrefs()`, `setPref`·`setX` |
| useMeetings | `meetingsStore` | `setIsHost`·`setMeetingsError`·`setMeetingsState({…})` |
| useMeetingCall | `meetingCallStore` | `setReturnPath`·`setCorner`·`setLastSpeaker`, `openRoom`·`expand`·`leaveRoomPage`·`roomPath` |
| useMediaDevices · useNativeMeeting · useWakeLock · useMeetingSessionStats | `mediaDevicesStore` | `refreshMediaDevices`, `nativeMeetingApi`, `createWakeLock()`, `useMeetingSessionStats(getCount, key)` |
| useMail | `mailStore` | `setSelectedAccountId`·`setSelectedIds`·`setQuickFilters`, 밖용 `mailTotalPages`·`mailTotalUnread`… |
| useMailCompose | `mailComposeStore` | 모듈 함수는 `openCompose`·`closeCompose`·`resetCompose`…(hook 멤버는 Vue 이름), 로그아웃 때 자동 reset |
| useMailSignature | `mailSignatureStore` | — |
| useFiles | `filesStore` | `setViewMode`·`setSelectedItems`·`setInlineEdit`, 모듈 함수 `navigateToPath`(hook 멤버는 `navigateTo`), `uploadFiles` 직접 import |
| useTransfers | `transfersStore` | `getTransfer`·`patchTransfer`·`transfersActiveCount()` |
| useShareUpload · useOfficeEditor | — | `shareUpload`, `isOfficeFileName`·`openEditor` |

### 2-3. 공용 utils·lib
`lib/utils`(cn) · `lib/date` · `lib/files` · `lib/chatEvents` · `utils/icons` · `errText` · `passwordRules` · `boardFormat` · `taskQuick` · `calendarLayout` · `categoryColor` · `gitRoute` · `apiDownload` · `mailQuery` · `myStatus` · `miniCall` · `meetingTime` — 같은 경로, 내용 그대로(Nuxt 자동 import 만 명시 import 로).

### 2-4. 컴포넌트
| Vue | React |
|---|---|
| `components/ui/*.vue` 33개 | `src/components/ui/<같은 이름>.tsx` `Ui<이름>`. 이름이 달라진 슬롯·이벤트: ActionSheet `header`; EditorToolbar `onImage`·`end`; EmptyState `onAction`·`iconSlot`·`extra`; ErrorTile `onRetry`·`onSecondary`; Input `onCopied`·`trailing`; Menu `trigger({toggle,open,controls})`·`sheetHeader`·ref `{toggle,open,close}`; Modal `titleSlot`·`footer`·`actions`; PasswordInput `capsLock`+`onUpdateCapsLock`; Tabs `trailing`; Chip `onRemove`. 내부 도우미 `ui/internal.ts`(전환 단계) |
| `components/layout/*.vue` 11개 | `src/components/layout/<이름>.tsx` `Layout<이름>` (MobileDetailBar `titleSlot`·`actions`·`onBack`; ActivityList ref `{markAllAsRead, reload}`). 전환 도우미 `layout/shellTransition.tsx` |
| `components/CommandPalette.vue` | `src/components/CommandPalette.tsx` (`onClose`) |
| `components/auth/*.vue` 10개 | `src/components/auth/<이름>.tsx` `Auth<이름>`(ServerErrorScreen → `AuthServerErrorScreen`, GuestCard `metaSlot`, Alert `action`), `AuthShell.css` |
| `components/pwa/InstallBanner.vue` | `src/components/pwa/InstallBanner.tsx` `PwaInstallBanner` |
| `components/settings/SettingsCard.vue` | `src/components/settings/SettingsCard.tsx` (`header`, `onSave`, `onReset`) |
| `components/meetings/MeetingsTrackMedia.vue` | `src/components/meetings/MeetingsTrackMedia.tsx` |
| `pages/p/[id].vue` + `usePluginPage` | `src/pages/p/[id].tsx` + `src/plugins/pluginHost.tsx` (v2 계약: `docs/plugin-v2.md`) |
| `pages/error.vue` · `profile`·`git`·`admin/plugins`(리다이렉트) | `src/pages/error.tsx` · 라우트 표 `redirect` |

### 2-5. 화면 작성 시 주의(토대 검수에서 나온 것)
- 포털(Modal·ActionSheet·Menu) 안 클릭도 React 트리를 따라 부모로 올라간다 — 행 `onClick` 안에 메뉴가 있으면 `e.stopPropagation()`.
- 키트 입력의 `modelValue` 에 `undefined` 를 주면 "제어 안 함"(자체 상태)으로 바뀐다 — 빈 값은 `''`/`null`.
- hook 이 준 값은 렌더 시점 값 — 이벤트 처리기에서 "지금" 값이 필요하면 `xxxStore.getState()`.
- Vue 가 배열 안 객체를 제자리에서 고치던 곳은 새 객체로 바꿔 넣는다(store 들이 이미 그렇게 함).

## 3. 모듈별 섹션 (모듈 에이전트가 채움)

### 3-1. 인증·설정 첫 화면(login·register·setup·…)
| Vue | React | 비고 |
|---|---|---|
| `pages/login.vue` | `src/pages/login.tsx` | 초록 "Git 바로가기"(bg-success)·배경(AuthShell 월페이퍼) 그대로. 2단계 인증·미인증 재발송·redirect 검증 동일 |
| `pages/register.vue` | `src/pages/register.tsx` | 초대 토큰 확인·닫힌 가입 리다이렉트 동일 |
| `pages/setup.vue` | `src/pages/setup.tsx` | `useState('setup-status')` → `setSharedState('setup-status')`(가드와 같은 키) |
| `pages/consent.vue` | `src/pages/consent.tsx` | `<i18n-t>` 슬롯 → 페이지 안 `slotted()`(원본 메시지 `{user}`·`{host}` 자리에 노드) |
| `pages/forgot-password.vue` · `reset-password.vue` · `verify-email.vue` | `src/pages/forgot-password.tsx` · `reset-password.tsx` · `verify-email.tsx` | |
| `components/auth/*` · `ServerErrorScreen` · `pwa/InstallBanner` · `pages/error|profile|git` | (토대가 옮김 — 2-4) | |
| 테스트 | `tests/auth/pages.test.tsx` | Git 버튼 유지·2단계·redirect 차단·동의 슬롯 |

### 3-2. 대시보드
| Vue | React | 비고 |
|---|---|---|
| `pages/index.vue` | `src/pages/index.tsx` → `src/components/dashboard/DashboardHome.tsx` | **handover 17 로 다시 그림**(시안 Dash17) — 주 줄 + 열 쌓기, 칩 줄, 운영 띠, 편집 모드. 배치 규칙 `src/lib/dashLayout.ts` |
| `components/dashboard/DashboardCard.vue` | `src/components/dashboard/DashCard.tsx` | 17: 카드 문법 하나(머리 48 · 행 44/56 · 1차 행동) + 높이 재기 |
| `DashboardGreeting.vue` | `DashboardGreeting.tsx` | 17: 빠른 만들기 버튼 행 + 편집 버튼(3열 미만은 아이콘 2개) |
| `DashboardChecklist.vue` | `DashboardStart.tsx` | 17: 띠 → "시작하기" 카드(신규 사용자 주 줄 2칸) |
| `DashboardInbox.vue` | `DashboardInbox.tsx` | 17: 범위 우선/전체 · 호버 [읽음] |
| `DashboardToday.vue` | `DashboardToday.tsx` | `@count` → `onCount` |
| `DashboardTasks.vue` · `DashboardRecentMail.vue` | 같은 이름 `.tsx` | |
| `DashboardNotices.vue` | `DashboardMoreCards.tsx`(DashboardNotices) | 17: 기본 관리자 고정 |
| `DashboardRecentGit.vue` | `DashboardGitActivity.tsx` | 17(Q4): 계정 없으면 [전체] 하나(공개 저장소) |
| (17 새 카드) | `DashboardFocus`(AI 브리핑) · `DashboardContinue` · `DashboardLater` · `DashboardTeam` · `DashboardBriefing`(칩·운영 띠) · MoreCards 의 게시글·채널·저장 공간·회의·둘러볼 채널 | 최근 파일·최근 위키 카드는 이어서 하기로 흡수 |
| (17 새 화면) | `src/pages/admin/dashboard-layout.tsx` | 관리 › 설정 › 대시보드 = 같은 편집 화면(mode="admin") |
| 테스트 | `tests/dashboard/dashboard.test.tsx` · `tests/lib/dashLayout.test.ts` | 카드 요청·빈 상태 보고·칩·AI 상태·판 조립·배치 규칙 |
### 3-3. 메일
| Vue 원본 | React | 비고 |
|---|---|---|
| `pages/mail/index.vue` | `src/pages/mail/index.tsx` | 단축키는 document keydown(처리기는 ref 로 최신값), `?compose`·`?open`·셸 `?account&mailbox` 처리 동일 |
| `pages/mail/[id].vue` | `src/pages/mail/[id].tsx` | 모바일 ⋯ 항목은 `MailReader onMobileMoreItems` 로 받는다(Vue 는 ref 의 computed 를 직접 읽음) |
| `pages/mail/compose.vue` | `src/pages/mail/compose.tsx` | 데스크톱이면 작성기를 마운트하지 않고 바로 `/mail?compose=` 로(아래 차이 표) |
| `pages/mail/accounts.vue` | `src/pages/mail/accounts.tsx` | |
| `components/mail/MailComposeHost.vue` | `src/components/mail/MailComposeHost.tsx` | 토대 자리 표시를 실구현으로 교체(export 이름 유지, App.tsx 그대로) |
| `MailComposeWindow.vue` | `MailComposeWindow.tsx` | 최소화 = `MailComposer show={false}`(Vue v-show) |
| `MailComposer.vue` | `MailComposer.tsx` + `composeText.ts` | 순수 함수(주소·인용·전달·Re/Fwd·전체 답장 받는이)는 `composeText.ts` 로 떼어 테스트. ref `{close, send, saveDraft, setReplyAll, focus}`, 새 prop `show` |
| `MailComposeEditor.vue` | `MailComposeEditor.tsx` + `MailComposeEditor.css` | v-model:html/text → `onUpdateHtml`/`onUpdateText`, 슬롯 `#below`→`below`, `#toolbar-end`→`toolbarEnd`, ref `{focus, setContent}` |
| `MailRecipientField.vue` | `MailRecipientField.tsx` | 슬롯 `#actions` → `actions` |
| `MailComposeAttachment.vue` · `MailComposeQuota.vue` · `MailSignaturePicker.vue` · `MailScheduleDialog.vue` | 같은 이름 `.tsx` | `@remove`→`onRemove`, `@confirm`→`onConfirm(iso)` |
| `MailList.vue` | `MailList.tsx` | `@open-folders`→`onOpenFolders`, ref `{bulk, focusSearch}` |
| `MailReader.vue` | `MailReader.tsx` | `@archived/@deleted`→`onArchived/onDeleted`, ref `{reply, forward, archive, remove, markUnread, star, spam, onMore, mobileMoreItems}` |
| `MailBody.vue` | `MailBody.tsx` + `MailBody.css` | 종이 토큰·어둡게 보기(A·B 색 바꿈, C iframe 반전) 그대로 |
| `MailSidebar.vue` · `MailSidebarFolder.vue` | 같은 이름 `.tsx` | `@navigate`→`onNavigate`, 폴더 `#actions`→`actions` |
| `MailScheduledList.vue` · `MailAttachmentPreview.vue` | 같은 이름 `.tsx` | |
| `MailFilterRules.vue` | `MailFilterRules.tsx` | `@count`→`onCount`. 설정 › 메일 화면이 import 해서 쓴다(4-1) |
| (테스트) | `tests/mail/mail.test.tsx` | 글 도우미·본문 3경로·작성기 보내기 본문(가짜 API)·받는이 칩·목록 칩·작성 창 호스트 |

- 모듈 안 class 잇기는 `clsx`(Vue `class`+`:class` 처럼 그냥 잇는다). `cn`(tailwind-merge)은 `text-xl leading-[1.35]` 같은 짝에서 앞의 것을 지워 Vue 와 1px 씩 어긋났다.
- 쓰는 store 는 토대의 `useMail`·`useMailCompose`·`useMailSignature` 그대로(수정 없음).
### 3-4. 채팅
| Vue | React | 비고 |
|---|---|---|
| `pages/chat.vue` | `src/pages/chat.tsx` | 모바일 단계 ↔ 주소 도우미는 `src/utils/chatStage.ts`(stageFromState·stageFromQuery·depthOf·sameStage·panelOf) |
| `components/chat/ChatSidebar.vue` | `src/components/chat/ChatSidebar.tsx` `ChatSidebar` | `onNavigate`·`onCreateChannel`·`onSearch` |
| `components/chat/ChatChannelItem.vue` | `ChatChannelItem.tsx` `ChatChannelItem` | 나머지 버튼 속성(`onClick` 등)은 루트 `<button>` 으로 |
| `components/chat/ChatConversation.vue` | `ChatConversation.tsx` `ChatConversation` | `onBack` |
| `components/chat/ChatHeader.vue` | `ChatHeader.tsx` `ChatHeader` | `onBack`, `className`. 패널 전환 `openChatPanel(kind)` 도 export |
| `components/chat/ChannelTabs.vue` | `ChannelTabs.tsx` `ChatChannelTabs` | v-model → `modelValue`+`onUpdateModelValue`, `onManage` |
| `components/chat/ChannelTabsManage.vue` | `ChannelTabsManage.tsx` `ChatChannelTabsManage` | `onClose`·`onSaved(summary)` |
| `components/chat/ChannelFilesTab.vue` | `ChannelFilesTab.tsx` `ChatChannelFilesTab` | `onManage`·`onSwitch(tab)`·`onChanged`. 공유는 `FileShareModalBridge.tsx`(아래) |
| `components/chat/ChannelWikiTab.vue` | `ChannelWikiTab.tsx` `ChatChannelWikiTab` | `onManage` |
| `components/chat/ChannelLinkedTab.vue` | `ChannelMeetingsTab.tsx` `ChatChannelMeetingsTab` · `ChannelTasksTab.tsx` `ChatChannelTasksTab` | R4(12 답 A6): 회의·작업 탭을 시안 R12Channel 대로 둘로 나눔(`onChanged`). 탭 줄은 UiTabs + 톱니, 순서·끄기는 서버 layout, 위키 탭은 스페이스 단위(`wiki_space`) |
| `components/chat/ChatMessageList.vue` | `ChatMessageList.tsx` `ChatMessageList` | `onLoadMore`·`onOpenThread(id)` |
| `components/chat/ChatMessage.vue` | `ChatMessage.tsx` `ChatMessage`(memo) | `#footer` → `footer`, `onOpenThread(id)` |
| `components/chat/ChatFileMessage.vue` | `ChatFileMessage.tsx` `ChatFileMessage`(memo) | |
| `components/chat/ChatMessageActions.vue` | `ChatMessageActions.tsx` `ChatMessageActions` | `onReply`·`onEdit`·`onDelete`·`onDownload`·`onClose`·`onHold(held)` |
| `components/chat/ChatReactions.vue` | `ChatReactions.tsx` `ChatReactions` | |
| `components/chat/ChatThreadSummary.vue` | `ChatThreadSummary.tsx` `ChatThreadSummary` | `onOpen` |
| `components/chat/ChatSystemMessage.vue` | `ChatSystemMessage.tsx` `ChatSystemMessage` | |
| `components/chat/ChatChannelIntro.vue` | `ChatChannelIntro.tsx` `ChatChannelIntro` | |
| `components/chat/ChatInput.vue` | `ChatInput.tsx` `ChatInput` | `onSend(content, type?, meta?)`·`onTyping`·`onFilesSent` |
| `components/chat/ChatTypingIndicator.vue` | `ChatTypingIndicator.tsx` `ChatTypingIndicator` | |
| `components/chat/ChatConnectionBanner.vue` · `ChatNotifyBanner.vue` | `ChatConnectionBanner.tsx` · `ChatNotifyBanner.tsx` | |
| `components/chat/ChatThreadPanel.vue` · `ChatSearchPanel.vue` · `ChatMemberPanel.vue` · `ChatPinsPanel.vue` | 같은 이름 `.tsx` | 바깥 대입(`showXPanel.value = false`)은 useChat setter |
| `components/chat/ChatCollectionView.vue` | `ChatCollectionView.tsx` `ChatCollectionView` | `onBack` |
| `components/chat/ChatCreateModal.vue` · `ChatInviteModal.vue` · `ChatNotifySheet.vue` | 같은 이름 `.tsx` | `ChatCreateModal` 은 `onClose` |
| `composables/useChatUi.ts` | `src/composables/useChatUi.ts` — `chatUiStore` | Nuxt `useState('chat-ui-*')` 7개 → store 하나. setter `setCollection`·`setNotifySheetChannelId`·`setInviteOpen`·`setUnreadAnchor`·`setEditRequest`·`setThreadWide`, 밖용 `dmPartner(ch, users?, me?)`·`initialOf`·`openFilePicker`·`chatListTime`·`chatClock` |
| `composables/useChatAttachments.ts` | `src/composables/useChatAttachments.ts` — `chatAttachmentsStore` | `forChannel(id, pid)` 는 렌더 시점 배열(Vue computed 아님), `onThreadFileSent(cb)` 는 해제 함수를 돌려준다. 모듈 함수 `addFiles`·`retry`·`remove`·`clear`·`sendThreadFiles`·`buildFileMeta`·`selectTray` |
| `composables/useChannelTabs.ts` | `src/composables/useChannelTabs.ts` | 상태 없음 — 모듈 함수 + 같은 멤버의 `useChannelTabs()` |
| `utils/chatMarkdown.ts` | `src/utils/chatMarkdown.ts` | 그대로 |
| `<i18n-t keypath>` (채팅 화면들) | `src/components/chat/ChatI18nT.tsx` `ChatI18nT` | 토대에 같은 부품이 없어 모듈 안 임시 도우미(`slots={{ n: … }}`). 토대 요청 |
| `components/files/FileShareModal`(파일 모듈 소유) | `src/components/chat/FileShareModalBridge.tsx` | `import.meta.glob('../files/FileShareModal.tsx')` — 파일 모듈 것이 합쳐지면 자동 연결, 없으면 자리 표시 모달 |
| `tests/lib/channelTabs.test.ts` | `tests/lib/channelTabs.test.ts` | 그대로 + `tests/chat/chatLogic.test.ts`·`chatComponents.test.tsx` |

메모: 채팅 모듈은 Vue `:class` 를 `clsx`(tailwind-merge 없음)로 옮겼다 — `cn()` 은 겹치는 클래스(예: `gap-1.5 gap-1`)를 하나로 줄여 CSS 순서로 정해지던 원본과 2px 씩 어긋났다.
### 3-5. 회의
| Vue | React | 비고 |
|---|---|---|
| `pages/meetings/index.vue` | `src/pages/meetings/index.tsx` | 목록·예약/지금 시작/수정·RSVP·종료·삭제·FAB 시트·알림 연동·30초 폴링 |
| `pages/meetings/room/[name].vue` | `src/pages/meetings/room/[name].tsx` | 장치 확인→회의→종료, 작게 보기(미니 통화), 대기실 1.5초 폴링. 방 이름으로 key(Nuxt 라우트 키와 같게 매개변수 바뀌면 새로 마운트) |
| `pages/meetings/join/[token].vue` | `src/pages/meetings/join/[token].tsx` | 손님 입장·대기 배너·결과 화면(만료·거절·종료·비밀번호 틀림·실패). 토큰으로 key |
| `components/meetings/MeetingsList.vue` | `src/components/meetings/MeetingsList.tsx` | `onJoin·onCopy·onDelete·onEdit·onEnd·onRsvp(room, r)·onCalendar` |
| `components/meetings/MeetingsInviteModal.vue` | `src/components/meetings/MeetingsInviteModal.tsx` | `onClose·onCreate(payload)·onUpdate(patch)`, `MeetingCreatePayload` 타입도 여기서 export |
| `components/meetings/MeetingsCreatedSheet.vue` | `src/components/meetings/MeetingsCreatedSheet.tsx` | `onClose·onJoin` |
| `components/meetings/MeetingsResultScreen.vue` | `src/components/meetings/MeetingsResultScreen.tsx` | 기본 슬롯 → `children` |
| `components/meetings/MeetingsDeviceSetup.vue` | `src/components/meetings/MeetingsDeviceSetup.tsx` | 기본 슬롯 → `children`, `#status` → `status`, `onJoin(sel)·onCancel`, ref `{ getSelection, stopPreview }`(defineExpose) |
| `components/meetings/MeetingsDeviceMenu.vue` | `src/components/meetings/MeetingsDeviceMenu.tsx` | `onClose` |
| `components/meetings/MeetingsControls.vue` | `src/components/meetings/MeetingsControls.tsx` | `onToggleCamera…onToggleSidebar(tab)`, `onSetBackground(file\|null)`, `MeetingsSidebarTab` 타입 |
| `components/meetings/MeetingsSidebar.vue` | `src/components/meetings/MeetingsSidebar.tsx` | `v-model:activeTab` → `activeTab`+`onUpdateActiveTab`, `onClose` |
| `components/meetings/MeetingsVideoGrid.vue` | `src/components/meetings/MeetingsVideoGrid.tsx` | |
| `components/meetings/MeetingsParticipant.vue` | `src/components/meetings/MeetingsParticipant.tsx` | `class` → `className` |
| `components/meetings/MeetingChatPanel.vue` | `src/components/meetings/MeetingChatPanel.tsx` | Vue 에서도 호출처 없음(1:1 보존) |
| `components/meetings/MeetingsTrackMedia.vue` | (토대) `src/components/meetings/MeetingsTrackMedia.tsx` | |
| `composables/useGridLayout.ts` | `src/composables/useGridLayout.ts` | `useGridLayout(el, count, gap)` — el 은 콜백 ref 로 받은 요소(state). 순수 계산 `gridLayoutFor` 추가 export |
| useMeetings · useMeetingCall · useMediaDevices · useNativeMeeting · useMeetingSessionStats | (토대) | 회의 모듈은 그대로 사용. `tests/meetings/nativeMeeting.test.ts` 로 브리지 검증 |
| — | `tests/meetings/*.test.tsx` | 그리드 계산·예약 창 페이로드/수정 diff·목록 ⋮·컨트롤·사이드바·결과 화면·입장 화면 흐름 |

메모: `MeetingsDeviceSetup` 의 Vue `watch`(선택 장치·켜짐)는 "live ref + 지난번 본 값" 비교(`useWatchLive`)로 같은 순서·조건을 재현했고,
장치 열거 직후 한 번 `flushSync` 로 Vue 의 await 경계 flush 를 흉내 낸다(처음 열 때 스트림을 다시 받지 않게).
### 3-6. 파일·오피스·공유
브랜치 `r1/files-office`. store 는 토대 것(useFiles·useTransfers·useOfficeEditor) 그대로, 모듈 안에서 새로 만든 공용 코드는 `components/files/internal.ts` 하나.

| Vue | React | 비고 |
|---|---|---|
| `pages/files.vue` | `src/pages/files.tsx` | 셸 위치(`?path`·`?view`)·끌어다 놓기 업로드/이동·Esc 선택 해제·모바일 시트·FAB |
| `pages/office/open.vue` | `src/pages/office/open.tsx` | `<i18n-t keypath="office.open.slowHint">` → 문구를 `{link}` 자리에서 나눠 버튼 끼움 |
| `pages/s/[token].vue` | `src/pages/s/[token].tsx` | 손님 문(정보·비밀번호·같이 편집·내려받기·결과 화면) |
| `components/files/FileBreadcrumb.vue` | `components/files/FileBreadcrumb.tsx` `FilesFileBreadcrumb` | `onDropMove` |
| `components/files/FileCommandBar.vue` | `FileCommandBar.tsx` `FilesFileCommandBar` | `onUpload·onNewFolder·onNewDoc·onNewSheet·onNewSlide·onBulkShare·onBulkMove·onBulkDownload·onBulkDelete·onEmptyTrash·onDropMove` |
| `components/files/FileCommentsPanel.vue` | `FileCommentsPanel.tsx` `FilesFileCommentsPanel` | `path` · `state`(R4: 상세 패널이 가진 댓글 상태 — 탭 숫자 공유). R4(12 답 A1): 내 권한 줄 · 답글/해결 · 위치 조각 · UiMentionList(권한 표시) · 보기 권한 안내 + 권한 요청, 모바일 ⋮ 행 · 보내기 버튼. 권한 배지 톤 `ROLE_TONE` export |
| `components/files/FileContextMenu.vue` | `FileContextMenu.tsx` `FilesFileContextMenu` | `onAction(key,item)`·`onClose`. 항목 규칙은 `fileMenuItems()` 로도 낸다(테스트) |
| `components/files/FileDetailPanel.vue` | `FileDetailPanel.tsx` `FilesFileDetailPanel` | `v-model:tab` → `tab`+`onUpdateTab`, `onClose·onShare·onStar` · `onRenamed`(R4: 공동 소유자 정보 탭 이름 바꾸기). R4: 폭 360, 탭 정보·댓글(n)·버전·활동(모바일 활동 없음) |
| `components/files/FileGridView.vue` | `FileGridView.tsx` `FilesFileGridView` | 목록과 같은 이벤트 |
| `components/files/FileLinksView.vue` | `FileLinksView.tsx` `FilesFileLinksView` | |
| `components/files/FileList.vue` | `FileList.tsx` `FilesFileList` | `onOpen·onMenu·onDetail·onDropMove·onCommitNewFolder·onCommitRename` |
| `components/files/FileMobileHeader.vue` | `FileMobileHeader.tsx` `FilesFileMobileHeader` | `onOpenViewSheet` |
| `components/files/FileMobileSelectBar.vue` | `FileMobileSelectBar.tsx` `FilesFileMobileSelectBar` | `onShare·onMove·onDownload·onDelete` |
| `components/files/FileMoveDialog.vue` | `FileMoveDialog.tsx` `FilesFileMoveDialog` | `paths·roots`, `onClose·onDone` |
| `components/files/FileOfficeEditor.vue` | `FileOfficeEditor.tsx` `FilesFileOfficeEditor` | `session·filePath·onClose` — 공유 손님 화면이 import |
| `components/files/FilePreviewModal.vue` | `FilePreviewModal.tsx` `FilesFilePreviewModal` | `onClose·onOpenEditor` |
| `components/files/FileQuickView.vue` | `FileQuickView.tsx` `FilesFileQuickView` | `kind`·`onOpen` |
| `components/files/FileShareModal.vue` | `FileShareModal.tsx` `FilesFileShareModal` | `items·initialTab·onClose` — **채팅 모듈이 import**(채널 파일 탭, `initialTab="people"`) |
| `components/files/FileSharedView.vue` | `FileSharedView.tsx` `FilesFileSharedView` | `onOpen·onMenu`, ref `{ reload }` |
| `components/files/FileSidebar.vue` | `FileSidebar.tsx` `FilesFileSidebar` | `onNavigate·onDropMove` |
| `components/files/FileTrashView.vue` | `FileTrashView.tsx` `FilesFileTrashView` | |
| `components/files/FileTypeIcon.vue` | `FileTypeIcon.tsx` `FilesFileTypeIcon` | `item`·`kind`·`strokeWidth` |
| `components/files/TransferPanel.vue` | `TransferPanel.tsx` `FilesTransferPanel` | `raised` |
| (FileList·FileGridView 의 같은 코드) | `components/files/internal.ts` | 인라인 편집·길게 누르기·행 끌기 hook |
| `composables/useFileComments.ts` | `src/composables/useFileComments.ts` | 호출마다 새 상태(싱글턴 아님) → 컴포넌트 지역 hook. 인자는 문자열 path |
| `composables/useDocMeta.ts` | `src/composables/useDocMeta.ts` | 호출처 없음(자체 오피스 폐기 잔재) — 그대로 옮김 |
| `utils/docExtensions.ts`·`docObjects.ts`·`ribbonIcons.ts` | `src/utils/` 같은 이름 | 글자 그대로(호출처 없음) |
| `components/editor/RichEditor.vue` | — | 오피스와 무관(게시판 전용, 4-1 표) — 이 모듈에서 옮기지 않음 |
| — | `tests/files/files.test.tsx` | 메뉴 규칙·댓글 hook·목록 클릭/선택/이름 바꾸기·전송 패널·공유 모달 기본 탭·오피스 여는 중·손님 문 |
### 3-7. 캘린더

| Vue | React | 비고 |
|---|---|---|
| `pages/calendar.vue` | `src/pages/calendar.tsx` | `?new=1&attendee=&name=` · `?date=` · `?event=` 처리, 동기화 오류 띠, T 단축키 그대로 |
| `composables/useCalendar.ts` | `src/composables/useCalendar.ts` | `calendarStore` + 모듈 함수 + `useCalendar()`(읽은 필드만 구독). 바깥 대입하던 ref 는 setter: `setShowEventModal`·`setShowShareModal`·`setMobileMenuOpen`·`setIcsMode`(viewMode 는 `setViewMode`, selectedDate 는 `selectDate`). 밖용 `selectVisibleEvents(state)`·`eventsOnDayOf(list, day)`·`useWeekStart()` |
| `utils/calendarAttendees.ts` | `src/utils/calendarAttendees.ts` | 내용 그대로 |
| `components/calendar/CalendarSidebar.vue` | `src/components/calendar/CalendarSidebar.tsx` | |
| `components/calendar/CalendarMiniMonth.vue` | `…/CalendarMiniMonth.tsx` | `selectedDate`, `onSelect` |
| `components/calendar/CalendarMoreMenu.vue` | `…/CalendarMoreMenu.tsx` | |
| `components/calendar/CalendarMonthView.vue` | `…/CalendarMonthView.tsx` | |
| `components/calendar/CalendarWeekView.vue` | `…/CalendarWeekView.tsx` | `days` 1·7 |
| `components/calendar/CalendarDayView.vue` | `…/CalendarDayView.tsx` | |
| `components/calendar/CalendarAgendaView.vue` | `…/CalendarAgendaView.tsx` | |
| `components/calendar/CalendarAgendaRow.vue` | `…/CalendarAgendaRow.tsx` | `onClick(event, el)` |
| `components/calendar/CalendarEventChip.vue` | `…/CalendarEventChip.tsx` | `onClick(event, el)` · `onEdit(event)` |
| `components/calendar/CalendarDaySheet.vue` | `…/CalendarDaySheet.tsx` | |
| `components/calendar/CalendarEventPopover.vue` | `…/CalendarEventPopover.tsx` | |
| `components/calendar/CalendarEventModal.vue` | `…/CalendarEventModal.tsx` | |
| `components/calendar/CalendarAttendeesInput.vue` | `…/CalendarAttendeesInput.tsx` | v-model → `modelValue`+`onUpdateModelValue`, 타입 `AttendeeChip` 도 여기서 export |
| `components/calendar/CalendarScopeModal.vue` | `…/CalendarScopeModal.tsx` | `onClose` · `onConfirm(scope, notify)` |
| `components/calendar/CalendarShareModal.vue` | `…/CalendarShareModal.tsx` | |
| `components/calendar/CalendarIcsModal.vue` | `…/CalendarIcsModal.tsx` | `mode`, `onClose` |
| `components/calendar/CalendarMobileMenu.vue` | `…/CalendarMobileMenu.tsx` | |
| `tests/lib/calendarAttendees.test.ts` | `tests/lib/calendarAttendees.test.ts` | 그대로 |
| — | `tests/composables/useCalendar.test.ts` · `tests/calendar/calendarPage.test.tsx` | 범위 삭제·수정 요청 모양, 범주 색·빗금, 동기화 띠, 보기 전환 |
### 3-8. 연락처
| Vue 원본 | React | 비고 |
|---|---|---|
| `pages/contacts.vue` | `src/pages/contacts.tsx` | `mobile-detail-open` 은 `setSharedState` |
| `composables/useContacts.ts` | `src/composables/useContacts.ts` | `contactsStore` + 모듈 함수 + `useContacts()`. 바깥 대입 → `setSelectedContact`·`setSelectedBookId`·`setSortBy`·`setMobileMenuOpen`·`setShowEditModal`. 밖용 `contactsScope()`·`contactsScopeLabel()` |
| `utils/contactsIndex.ts` | `src/utils/contactsIndex.ts` | 그대로 |
| `components/contacts/ContactsSidebar.vue` · `ContactsList.vue` · `ContactsDetail.vue` · `ContactsMobileMenu.vue` · `ContactsTransferPanel.vue` | 같은 이름 `.tsx` | TransferPanel `touch`·`className` |
| `components/contacts/ContactsEditModal.vue` | `ContactsEditModal.tsx` | 열려 있을 때만 본체(`ContactsEditForm`)를 마운트해 Vue `watch(showEditModal, immediate)` 초기화와 같은 시점에 폼을 채운다 |
| `tests/lib/contactsIndex.test.ts` | `tests/lib/contactsIndex.test.ts` | + `tests/composables/useContacts.test.ts`, `tests/contacts/contacts.test.tsx` |
### 3-9. 작업

| Vue | React | 비고 |
|---|---|---|
| `pages/tasks.vue` | `src/pages/tasks.tsx` | `?task=` 선택, `?status=`·`?priority=`(데스크톱 셸) 그대로 |
| `composables/useTasks.ts` | `src/composables/useTasks.ts` | Vue 처럼 목록 상태(tasks·total·loading·error)는 hook 을 부른 컴포넌트 지역, 담당자 후보·facets 는 `tasksStore`. 모듈 함수 `loadUsers`·`loadFacets`·`rememberFacets`·`createTask`·`updateTask`·`deleteTask`·`toggleTask`·`fetchSubtasks`, 순수 규칙 `upsertInto`·`removeFrom` |
| `components/tasks/TasksRow.vue` | `src/components/tasks/TasksRow.tsx` | `onSelect`·`onToggle`·`onStatus(rect)`·`onMenu(rect)` |
| `components/tasks/TasksQuickInput.vue` | `…/TasksQuickInput.tsx` | ref `{ clear, focus }`(`TasksQuickInputHandle`), `onSubmit(parsed)` |
| `components/tasks/TasksTagEditor.vue` | `…/TasksTagEditor.tsx` | `onCommit(tags)` |
| `components/tasks/TasksDetail.vue` | `…/TasksDetail.tsx` | `onPatch`·`onClose`·`onDuplicate`·`onRemove`·`onSubtasksChanged` (페이지가 `key=작업 id`) |
| `components/work/WorkStateChip.vue` | `src/components/work/WorkStateChip.tsx` | **코드(Git) 모듈이 import** — `state`·`label`·`size` |
| `components/work/WorkStateIcon.vue` | `src/components/work/WorkStateIcon.tsx` | **코드(Git) 모듈이 import** — `state`, 크기는 `className` |
| `tests/lib/taskQuick.test.ts` | (토대가 이미 옮김) | |
| — | `tests/tasks/tasksPage.test.tsx` | 목록 규칙·빠른 입력 @담당·칩 재조회·완료 토글·?task= 상세 |
### 3-10. 위키
| Vue | React | 비고 |
|---|---|---|
| `pages/wiki.vue` | `src/pages/wiki.tsx` | 비동기 처리기(자동 저장·주소 동기화)가 지금 값을 읽도록 화면 상태 일부를 `useRefState`(useState+ref 거울)로. `onBeforeRouteLeave` → `useBlocker`(다른 경로로 갈 때만 — 쿼리 변경 제외). `<style>` → `components/wiki/wiki.css` |
| `components/wiki/WikiCollabEditor.vue` | `src/components/wiki/WikiCollabEditor.tsx` `WikiCollabEditor` | Yjs 프레임 0~3·고정 clientID(0) 시드·awareness 그대로(Vue 판과 한 방에서 같이 편집됨 — 실측). `defineExpose` → ref 핸들 `WikiCollabEditorHandle`(getContent·save·scrollToHeading·editor·connected·peers) + 반응형 값은 `onUpdateState({ editor, connected, peers })`. CSS `v-bind` 자리표시 → `--wiki-collab-placeholder` |
| `components/wiki/WikiPageTreeNode.vue` | `src/components/wiki/WikiPageTreeNode.tsx` `WikiPageTreeNode` (+ `TreeNode`·`DropPosition` 타입) | 이벤트 `onSelect/onAddChild/onMenu(node, ev)/onRename/onCancelRename/onCreateDraft/onCancelDraft/onMove` |
| `components/wiki/WikiSidebar.vue` | `src/components/wiki/WikiSidebar.tsx` `WikiSidebar` | 위 이벤트 + `onSpaceMenu/onNewPage/onSearch/onCreateSpace/onOpenSettings` |
| `components/wiki/WikiRail.vue` | `src/components/wiki/WikiRail.tsx` `WikiRail` | 백링크 GET 은 컴포넌트 안 그대로. `onJump/onHistory` |
| `components/wiki/WikiVersionPanel.vue` | `src/components/wiki/WikiVersionPanel.tsx` `WikiVersionPanel` | `onSelect/onClose` |
| `components/wiki/WikiSpaceSettings.vue` | `src/components/wiki/WikiSpaceSettings.tsx` `WikiSpaceSettings` | `onClose/onDeleted/onMembers(n)` |
| `composables/useWiki.ts` | `src/composables/useWiki.ts` `wikiStore` + `useWiki()` | 바깥 대입용 `setCurrentSpace/setPageTree/setCurrentPage/setVersions`, 테스트용 `_resetWikiStore` |
| `utils/htmlDiff.ts` · `utils/htmlToc.ts` | `src/utils/htmlDiff.ts` · `src/utils/htmlToc.ts` | 내용 그대로 |
| `tests/lib/htmlDiff.test.ts` | `tests/lib/htmlDiff.test.ts` | 그대로 통과. 추가: `tests/composables/useWiki.test.ts`, `tests/wiki/wiki.test.tsx` |

### 3-11. 게시판
| Vue | React | 비고 |
|---|---|---|
| `pages/board/index.vue` | `src/pages/board/index.tsx` | 보조 보기(필독·북마크·내 글·검색) 같은 분기 |
| `pages/board/[boardId]/index.vue` | `src/pages/board/[boardId]/index.tsx` | Nuxt 는 경로 매개변수가 바뀌면 페이지를 새로 만든다 → 안쪽 컴포넌트를 `key={boardId}` 로 다시 마운트(아래 두 화면도 같음) |
| `pages/board/[boardId]/[postId].vue` | `src/pages/board/[boardId]/[postId].tsx` | `key={boardId/postId}` |
| `pages/board/[boardId]/write.vue` | `src/pages/board/[boardId]/write.tsx` | `?edit=` 은 마운트 때 한 번 읽음(Vue setup 과 같음). ★`RICH_EDITOR_RESOLVES=false` — Vue 원본 버그(아래) 1:1 재현 스위치 |
| `components/board/BoardShell.vue` · `BoardSidebar.vue` | `src/components/board/BoardShell.tsx` · `BoardSidebar.tsx` | 북마크 수는 `useSharedState('board-bookmark-count')` 그대로 |
| `components/board/BoardCommandBar.vue` | `src/components/board/BoardCommandBar.tsx` | 기본 슬롯 → `children`, `#actions` → `actions`, `onSearch(q)` |
| `components/board/BoardCategoryTabs.vue` · `BoardPagination.vue` · `BoardPostRow.vue` | 같은 이름 `.tsx` | `onSelect` · `onGo` |
| `components/board/BoardAttachments.vue` · `BoardReactions.vue` | 같은 이름 `.tsx` | `v-click-outside` → `useClickOutside` |
| `components/board/BoardCommentList.vue` · `BoardCommentItem.vue` · `BoardCommentInput.vue` | 같은 이름 `.tsx` | 멘션 자동완성(GET /mention-users, 150ms) 그대로. `onDone/onCancel` |
| `components/board/BoardCreateModal.vue` | `src/components/board/BoardCreateModal.tsx` | `#title` → `titleSlot`, `#footer` → `footer` |
| `components/editor/RichEditor.vue`(4-1: 게시판 전용) | `src/components/editor/RichEditor.tsx` `RichEditor` + `RichEditor.css` | `v-model:html/text` → `html`+`onUpdateHtml` / `text`+`onUpdateText`, `defineExpose({ editor, insertImage })` → ref 핸들 `RichEditorHandle` + `onUpdateEditor(editor)`(모바일 툴바용). Nuxt 자동 이름은 `EditorRichEditor` 지만 Vue 쓰는 곳 이름(`RichEditor`)으로 내보낸다 |
| `composables/useBoard.ts` | `src/composables/useBoard.ts` `boardStore` + `useBoard()` | 모든 동작 모듈 export, 테스트용 `_resetBoardStore`. 추가 테스트: `tests/composables/useBoard.test.ts`, `tests/board/board.test.tsx` |

**발견한 Vue 원본 버그(고치지 않음)**: `write.vue` 의 `<RichEditor>` 는 Nuxt 자동 이름(`EditorRichEditor`)과 달라 해석되지 않는다 — 화면에 본문 편집기가 없고 빈 `<richeditor>` 만 남는다. 본문 필수 검사에 막혀 글을 올릴 수 없다. React 판도 같은 화면을 내고(`RICH_EDITOR_RESOLVES=false`), 고치기로 하면 그 상수만 `true` 로.

### 3-12. 코드(Git)
| Vue | React |
|---|---|
| `pages/code/[...slug].vue` | `src/pages/code/[...slug].tsx` |
| `composables/useGit.ts` | `src/composables/useGit.ts` (`gitStore`; setter `setSearchQuery`·`setIssueState`·`setLabelFilter`·`setPullState`; `computeLabelCounts`) |
| `utils/gitLanguages.ts` · `utils/labelColor.ts` | `src/utils/gitLanguages.ts` · `src/utils/labelColor.ts` |
| `components/git/Git*.vue` 19개 | `src/components/git/Git*.tsx` (같은 이름). 이벤트: IssueList `onCreateIssue`, CreateIssueModal `onClose`·`onCreated`, LabelPicker `onUpdateModelValue`·`onCommit`, AssigneePicker `onCommit` |
| GitFileViewer `<style scoped>` | `src/components/git/GitFileViewer.css` |
| `<i18n-t>`(RepoList·FileViewer) | `src/components/git/i18nSlots.tsx` (모듈 임시 — 토대에 공용 부품이 생기면 교체) |
| `components/work/WorkStateIcon·WorkStateChip.vue` | `src/components/work/WorkStateIcon.tsx`·`WorkStateChip.tsx` |
| `tests/lib/gitLanguages.test.ts` | 같은 경로 + `tests/composables/useGit.test.ts`, `tests/lib/i18nSlots.test.tsx` |
### 3-13. AI
| Vue | React |
|---|---|
| `pages/ai.vue` | `src/pages/ai.tsx` |
| `components/ai/AiComposer.vue` | `src/components/ai/AiComposer.tsx` `AiComposer` (v-model → `modelValue`+`onUpdateModelValue`, `onSend`·`onStop`, ref `{focus}`) |
| `components/ai/AiEmptyChat.vue` | `src/components/ai/AiEmptyChat.tsx` `AiEmptyChat` (`onPick`) |
| `components/ai/AiMessage.vue` | `src/components/ai/AiMessage.tsx` `AiMessage` + `AiMessage.css`(전역 &lt;style&gt; 그대로) |
| `components/ai/AiMessageItem.vue` | `src/components/ai/AiMessageItem.tsx` `AiMessageItem` (`onCopy`·`onRegenerate`·`onEdit`) |
| `components/ai/AiMobileList.vue` | `src/components/ai/AiMobileList.tsx` `AiMobileList` (`onSelect`·`onCreate`·`onRename`·`onRemove`) |
| `components/ai/AiModelPicker.vue` | `src/components/ai/AiModelPicker.tsx` `AiModelPicker` (`onToggleTools`·`onClose`) |
| `components/ai/AiSidebar.vue` | `src/components/ai/AiSidebar.tsx` `AiSidebar` (`onSelect`·`onCreate`·`onCollapse`·`onRename`·`onRemove`) |
| `components/ai/AiAdminSettings.vue` | `src/components/ai/AiAdminSettings.tsx` `AiAdminSettings` — 관리 모듈의 `pages/admin/ai` 가 import |
| `composables/useAiLabels.ts` | `src/composables/useAiLabels.ts` (멤버 같음) |
| `utils/aiAssist.ts` · `utils/aiHighlighter.ts` | `src/utils/aiAssist.ts` · `src/utils/aiHighlighter.ts` (내용 그대로) |
| `tests/utils/aiAssist.test.ts` | `tests/utils/aiAssist.test.ts` + `tests/pages/ai.test.tsx` · `tests/components/AiAdminSettings.test.tsx` |
### 3-14. 개인 설정(settings/*)
화면은 "UI 키트 + 작은 설정 조각" 조합(디자인 싱크 시범). 조각은 전부 `src/components/settings/`, JSDoc 있음.

| Vue | React | 비고 |
|---|---|---|
| `pages/settings/index.vue` | `src/pages/settings/index.tsx` | 조각 `SettingsProfileHead`·`SettingsNavGroupCard`(`SettingsMobileIndex.tsx`) |
| `pages/settings/account.vue` | `src/pages/settings/account.tsx` | 조각 `SettingsAvatarRow` + `SettingsDevices` |
| `pages/settings/security.vue` | `src/pages/settings/security.tsx` | 비밀번호 카드를 `SettingsPasswordCard` 로 분리(동작 포함) |
| `pages/settings/display.vue` | `src/pages/settings/display.tsx` | `SettingsDensityPicker` · `SettingsRow` |
| `pages/settings/notifications.vue` | `src/pages/settings/notifications.tsx` | `SettingsNotifyParts.tsx`(권한 행·방해 금지 행·체크 표·일정 모달) |
| `pages/settings/apps.vue` | `src/pages/settings/apps.tsx` | `SettingsAppsParts.tsx`(앱·앱 비밀번호·토큰 행, 새/발급 모달). `<i18n-t>` → `SettingsI18nT` |
| `pages/settings/ai.vue` | `src/pages/settings/ai.tsx` | `SettingsAiParts.tsx`(모델 라디오·가림 키·연결 확인) · 도구 행은 `SettingsRow layout="inline"` |
| `pages/settings/mail.vue` | `src/pages/settings/mail.tsx` | `SettingsMailParts.tsx`. 필터 탭 = `SettingsMailFilterRules`(메일 모듈 `MailFilterRules` 대기 — 임시 `SettingsPendingSlot`) |
| `components/settings/SettingsHeader.vue` | `src/components/settings/SettingsHeader.tsx` | |
| `components/settings/SettingsDevices.vue` | `src/components/settings/SettingsDevices.tsx` | 행 `SettingsDeviceRow`, 글자 버튼 `SettingsTextAction` |
| `components/settings/SettingsSessionsTable.vue` | `src/components/settings/SettingsSessionsTable.tsx` | 행 `SettingsSessionRow` |
| `components/settings/SettingsTwoFactor.vue` | `src/components/settings/SettingsTwoFactor.tsx` | 모달 `SettingsTwoFactorSetupModal`·`ManageModal`·`CodesModal`, 코드 칸 `SettingsOtpCodeField` |
| `composables/useMySessions.ts` | `src/composables/useMySessions.ts` | Vue 도 비싱글턴 → 컴포넌트 지역 상태 hook. 꾸미기 순수 함수 `sessionBaseName`·`sessionName`·`sessionKind`·`sessionIcon`·`sessionWhen` export |
| — | `SettingsRow`·`SettingsSavedMark`·`SettingsTextAction`·`SettingsI18nT`·`SettingsPendingSlot` | 새 공용 조각(설정·관리 모듈 안). `SettingsI18nT` 는 토대 `I18nT` 가 생기면 그쪽으로 |
| (테스트) | `tests/settings/settingsModule.test.tsx` | |
| — (R4 신설, Vue 없음) | `src/pages/settings/calendar.tsx` | 시안 R12Settings #calendar(S1). 조각 `SettingsCalendarParts.tsx`(`SettingsSubscriptionRow`·`SettingsSubscriptionAddModal`). 라우트 `reactOnly` |
| — (R4 신설, Vue 없음) | `src/pages/settings/chat.tsx` | 시안 R12Settings #chat(S2). 키워드 규칙 `utils/chatKeywords.ts`. 방해 금지 = `/api/notifications/dnd-schedule` 공유 |
| `components/settings/SettingsTwoFactor.vue` (R4 개편) | `src/components/settings/SettingsTwoFactor.tsx` | 시안 #on1·#on1err·#on2·#off·#regen(T1~T5). 모달 `SetupModal`(1/2)·`CodesModal`(2/2)·`OffModal`·`RegenModal`. `SettingsOtpCodeField` 삭제 |
| (R4) 세션 | `SettingsSessionsTable.tsx`·`SettingsSessionRow.tsx` | "접속 주소"(호스트, 없으면 IP · mono, B7) + 모바일 카드 `SettingsSessionCard`(TM1) |
| (R4) 비밀번호 | `SettingsPasswordCard.tsx` | 체크 목록(B6) — 흔한 비밀번호는 `POST /api/auth/password-check` 응답 뒤 |
| (R4) 개인 설정 키 | `composables/useUserPrefs.ts` | `calendar.default_view`·`calendar.default_reminder`·`chat.enter_key`·`chat.link_preview`·`chat.media_autoexpand`·`chat.keywords`, 주 시작 `sat` |
| (테스트) | `tests/settings/settingsR4.test.tsx` | |

### 3-15. 관리(admin/*)
| Vue | React | 비고 |
|---|---|---|
| `components/admin/AdminPageShell.vue` | `src/components/admin/AdminPageShell.tsx` | 슬롯 #actions → `actions` |
| `components/admin/AdminAnalytics*.vue` 8개 | `src/components/admin/AdminAnalytics*.tsx` | react-chartjs-2. 표시 함수 `analyticsFormat.ts`. Lazy 3개는 일반 import |
| `components/admin/AdminInviteModal.vue` | `src/components/admin/AdminInviteModal.tsx` | `onClose`·`onChanged`. `parseInviteEmails`·`badInviteEmails`·`sortInvites` export |
| `components/admin/AdminUserDeleteModal.vue` | `src/components/admin/AdminUserDeleteModal.tsx` | `onClose`·`onDeleted` |
| `components/admin/AdminLoginMethods.vue` | `src/components/admin/AdminLoginMethods.tsx` | 순서 계산 `normalizeAuthOrder`·`dropOrder`·`moveOrder`·`ldapChangeCount` |
| `components/admin/AdminBackup.vue` | `src/components/admin/AdminBackup.tsx` | `fmtBackupSize`·`kstFromUtc`·`utcFromKst` |
| `components/admin/AdminAppBuild.vue` | `src/components/admin/AdminAppBuild.tsx` | `fmtAppSize`·`fmtDay` |
| `components/admin/AdminMailOAuth.vue` | `src/components/admin/AdminMailOAuth.tsx` | |
| `composables/useAdminAnalytics.ts` | `src/composables/useAdminAnalytics.ts` | 비싱글턴 hook. `fetchAccessLogs` 가 결과 반환, `periodDays` 추가 |
| `composables/useChartTokens.ts` | `src/composables/useChartTokens.ts` | `hslOf` export |
| `composables/useServices.ts` | `src/composables/useServices.ts` | `servicesStore` + `fetchServices` |
| `pages/admin/index.vue` · `dashboard.vue` · `users.vue` · `logs.vue` | `src/pages/admin/같은 이름.tsx` | 조각 `AdminOpsTile`·`AdminServiceStatusCard`·`AdminUsersTable`·`AdminUsersBulkBar`·`AdminUserCard`·`AdminUserSessionsModal`, 로직 `adminUsers.ts`·`dashboardTiles.ts` |
| `pages/admin/security·settings·storage·system·mail·modules·groups·app-build.vue` | `src/pages/admin/같은 이름.tsx` | storage `<i18n-t>` → `SettingsI18nT`. settings 의 `#general` 링크는 직접 스크롤 |
| `pages/admin/branding.vue` | `src/pages/admin/branding.tsx` | 이미지 칸 `BrandingImageField`(페이지 안), 대비 계산 `brandingContrast.ts` |
| `pages/admin/ai.vue` | `src/pages/admin/ai.tsx` | `AiAdminSettings`(AI 모듈) 대기 — 임시 `SettingsPendingSlot` |
| `pages/admin/plugins.vue` | (라우트 표 redirect) | 토대 |
| (테스트) | `tests/admin/adminLogic.test.ts`·`adminRender.test.tsx`·`adminSettingsParts.test.tsx` | |
| (R4 · 답변서 B5) 기존 기능 위치 | `pages/admin/groups.tsx` · `branding.tsx` · `security.tsx` · `AdminBackup.tsx` · `storage.tsx` · `AiAdminSettings.tsx` · `AdminAppBuild.tsx` · `pages/settings/ai.tsx` | 그룹 삭제 = 상세 ⋮ · 브랜딩 맨 위 "기본" 카드 테마 UiSegment, 이미지 ✕, 로그인 배경 타일 4장 + 끌기 순서(`brandingWallpapers.ts`, `PUT …/wallpapers/order`) · 2단계 필수 대상 UiSelect(없음/관리자/전체) + [인증서 올리기] → 모달 · 백업 카드 맨 위 행(자동 백업 스위치·시각), "외부 저장소" 카드 · AI 모델 행 ⋮ 첫 항목 "설정" · 앱 빌드 서버 주소 읽기 전용 UiInput · 설정 AI 개인 키 카드 푸터 [되돌리기][저장] 상시, 외부 AI 동의 카드 = 개인 키 카드 바로 아래 |

### 3-16. 활동
| Vue | React | 비고 |
|---|---|---|
| `pages/activity.vue` | `src/pages/activity.tsx` | 목록은 토대의 `LayoutActivityList`(mobile) |

---

## 4. 모듈 전용으로 남긴 composable·utils (해당 모듈 에이전트가 이식)

한 모듈만 쓰는 것은 토대에서 옮기지 않았다. 그 모듈 에이전트가 `src/` 같은 경로로 옮기고(규칙 1-3), 딸린 Vue 테스트도 옮긴다.

| 모듈 | composable | utils / lib | 딸린 Vue 테스트 |
|---|---|---|---|
| 관리 | `useAdminAnalytics`, `useChartTokens`, `useServices` | `sheetFormula`(colName 등 — admin/users 가 쓰는지 확인) | — |
| AI | `useAiLabels` | `aiAssist`, `aiHighlighter` | `tests/utils/aiAssist.test.ts` |
| 게시판 | `useBoard` | — (boardFormat 은 토대) | — |
| 캘린더 | `useCalendar` | `calendarAttendees` (calendarLayout·categoryColor 는 토대) | `tests/lib/calendarAttendees.test.ts` |
| 채팅 | `useChannelTabs`, `useChatAttachments`, `useChatUi` (useChat 은 토대) | `chatMarkdown` | `tests/lib/channelTabs.test.ts` |
| 연락처 | `useContacts` | `contactsIndex` | `tests/lib/contactsIndex.test.ts` |
| 파일·오피스 | `useFileComments`, `useDocMeta`(현재 호출처 없음) | `docExtensions`, `docObjects`, `ribbonIcons` | — |
| 코드(Git) | `useGit` | `gitLanguages`, `labelColor` (gitRoute 는 토대) | `tests/lib/gitLanguages.test.ts` |
| 회의 | `useGridLayout` (세션·통화·장치는 토대) | — (meetingTime 은 토대) | — |
| 개인 설정 | `useMySessions` | — | — |
| 작업 | `useTasks` | — (taskQuick 은 토대) | — |
| 위키 | `useWiki` | `htmlDiff`, `htmlToc` | `tests/lib/htmlDiff.test.ts` |

### 4-1. 모듈 사이에 걸친 컴포넌트(주인 모듈이 옮기고, 쓰는 모듈은 그 파일을 import)
| 컴포넌트(주인) | 쓰는 곳 | 비고 |
|---|---|---|
| `components/mail/MailComposeHost`(메일) | 앱 루트 `src/App.tsx` | 토대가 자리 표시 `src/components/mail/MailComposeHost.tsx`(null) 를 두었다 — 메일 에이전트가 그 파일을 진짜로 바꾼다(export 이름 유지) |
| `components/mail/MailFilterRules`(메일) | 개인 설정 › 메일 | 설정 에이전트는 메일 쪽 파일이 생긴 뒤 연결 |
| `components/files/FileShareModal`(파일) | 채팅 | |
| `components/files/FileOfficeEditor`(파일) | `pages/s/[token]`(공유) | |
| `components/ai/AiAdminSettings`(AI) | `pages/admin/ai` | |
| `components/editor/RichEditor` | 게시판 | 게시판 전용(디렉터리만 공용 이름) |
| `components/work/WorkState*` | 코드(Git) | Git 전용 |
| `components/settings/SettingsCard` | 설정·관리·AI·메일 | **토대가 옮김** (`src/components/settings/SettingsCard.tsx`) |
| `components/meetings/MeetingsTrackMedia` | 미니 통화·회의 | **토대가 옮김** |

## 5. 앱 번들(데스크톱·모바일) — r2/apps

### 5-1. 앱이 웹을 싣는 방식(실제)
- 데스크톱(Electron, `apps/desktop`)과 안드로이드(Capacitor, `apps/mobile`) 모두 **서버 웹을 원격으로 연다**(번들 SPA 가 아니다). 데스크톱은 `WebContentsView.loadURL(서버)`, 안드로이드는 `server.url = 서버`(bake-site.cjs).
- 병행 기간에는 서버 nginx 의 `jw_ui` 쿠키가 UI 를 골랐고, 앱은 빌드 값 `JW_WEB`(vue|react)으로 **첫 로드 전에 그 쿠키를 심었다** — 데스크톱 `src/main/webUi.ts`, 안드로이드 `WebUiPlugin.java`(+ 런처 `www/index.html`). 전환 때 기본값(`DEFAULT_WEB` — `apps/desktop/scripts/site.mjs`, `apps/mobile/capacitor.config.ts`, `apps/mobile/scripts/bake-site.cjs`)을 `react` 로 바꿨고, 지금 nginx 는 쿠키를 무시한다(`/__ui/*` 는 쿠키를 지우고 `/` 로).
- 번들 모드(선택, 안드로이드·React 만): CLI `.env` 의 `ANDROID_WEB_BUNDLE=1`(스크립트 내부 변수는 `JW_WEB_BUNDLE`) → `apps/mobile/scripts/bundle-web.cjs` 가 이 앱을 `VITE_API_BASE=<사이트>` 로 빌드해 `www-react/` 에 넣는다(SW 없음 검사). origin `https://localhost`, 라우팅은 Capacitor html5mode(확장자 없는 경로 → index.html)라 해시 라우터 불필요.

### 5-2. 네이티브 브리지 대조
| Vue 원본 | React | 비고 |
|---|---|---|
| `composables/useNativeMeeting.ts`(Capacitor `Meeting` 플러그인) | `src/composables/useNativeMeeting.ts` + `useMeetings` 의 `nativeMeetingApi` | 같음 |
| `composables/useDesktopShell.ts`(UA `JustWorkspaceDesktop`, `nav=shell`) | `src/composables/useDesktopShell.ts` — layout·chat·calendar·files·mail | 같음 |
| `plugins/app-api.client.ts`(apiBase + Bearer, SW 정리) | `src/lib/api.ts` + `src/lib/bundledApp.ts` | 같음 + `$fetch.raw` 도 Bearer(아래) |
| 푸시(`@capacitor/push-notifications`) | — | Vue 웹도 호출 없음(앱 README "다음 단계") |
| 외부 링크·다운로드 | — | 웹 쪽 코드 없음. 데스크톱은 셸이 `setWindowOpenHandler`/`will-navigate` 로 처리 |

### 5-3. Vue 와 다르게 한 것(번들 모드에서만 영향, 웹은 동일)
| 위치 | 변경 |
|---|---|
| `lib/runtimeConfig.ts` | `wsUrl()`·`bundledToken()`·`bundledAuthHeaders()` 추가 |
| `lib/api.ts` | `apiRawFetch()` 추가. `$fetch.raw` 가 번들 앱에서 Bearer 도 붙인다(Vue 는 주소만 바꿔 `utils/apiDownload` 가 401) |
| `composables/useChat.ts` `connectWS` | `/ws/chat` → apiBase 호스트. 토큰은 쿼리가 아니라 `Sec-WebSocket-Protocol`(`jw.bearer, jw.token.<base64url>`)로 — 2026-10-18 에 쿼리 토큰 폐기 |
| `components/wiki/WikiCollabEditor.tsx` | `/ws/wiki/collab` → apiBase 호스트(+token). **백엔드가 쿠키만 받아 번들 앱에선 여전히 인증 실패** |
| `plugins/pluginHost.tsx` `pluginBundleUrl` | apiBase 를 붙인다(공개 자산, CORS) |
| `composables/useFiles.ts` | 업로드 XHR·다운로드(단일·여러 개·공유받은)·미리보기 주소에 apiBase + Bearer |
| `composables/useMail.ts` | 첨부·zip 주소에 apiBase, 내려받기는 번들 앱에서 `downloadApi`(blob + Bearer) |
| `components/chat/ChatFileMessage.tsx` | 파일 메시지 다운로드·미리보기 주소에 apiBase, 번들 앱 다운로드는 `downloadApi` |
| 테스트 | `tests/lib/bundledApp.test.ts` |

## 6. 마무리(r3/polish) — 동등성 검수 후속

### 6-1. 의도된 차이(Vue 와 다르게 둔 것)
| 위치 | Vue | React | 이유 |
|---|---|---|---|
| `/settings` → `/settings/account`, `/admin` → `/admin/dashboard` 리다이렉트 뒤 데스크톱 breadcrumb | `워크스페이스 / 설정`, `워크스페이스 / 관리` | `워크스페이스 / 설정 / 계정`, `워크스페이스 / 관리 / 개요` | Vue 원본 버그로 판단. 같은 주소로 직접 들어가면 Vue 도 `설정 / 계정` 을 보인다 — index 페이지의 `navigateTo(replace)` 뒤 레이아웃 `useBreadcrumb(() => labelFor(route.path))` 가 갱신되지 않음(`frontend/layouts/settings.vue:6`, `frontend/layouts/admin.vue:8`, `frontend/pages/settings/index.vue:23`). React(`src/layouts/settings.tsx`, `src/layouts/admin.tsx`)가 맞으므로 그대로 둔다(검수 보고서 불일치-2). |
| 메인 번들 | 회의 라이브러리가 엔트리에 없음(Nuxt 청크 분할) | `livekit-client` 를 `useMeetings.loadLivekit()` 로 지연 로드(통화 시작·회의실/초대 화면 진입 때) | 동작 동일, 메인 청크 크기만 줄임 |

### 6-2. 고친 것(Vue 와 같아지도록)
| 위치 | 내용 |
|---|---|
| `lib/head.ts` | 제목 쌓임 순서를 effect 순서 대신 첫 렌더 순서(id)로 — 직접 진입·새로고침에도 `페이지 \| 앱이름`(unhead 와 같음). 테스트 `tests/lib/head.test.tsx` |
| `lib/router.ts`·`components/NuxtLink.tsx` | 쿼리 직렬화를 vue-router 4 `encodeQueryKey/encodeQueryValue` 규칙으로(`/`·`=` 그대로, `&`·`#`·`+` 만 인코딩, 공백 `+`). 문자열 주소도 정규화하고 첫 진입 주소창도 replaceState 로 맞춤(vue-router 첫 내비게이션 replace 와 같음). `office/open` 의 직접 `history.replaceState` 는 Vue 도 `%2F` 라 그대로. 테스트 `tests/router/query.test.tsx` |
| JSX 공백 | Vue 템플릿은 텍스트/`{{ }}`↔요소 사이 줄바꿈을 공백 1칸으로 남기고 JSX 는 지운다. 화면에 보이는 곳은 `{' '}` 로 보충(SettingsNotifyParts·UiRadioCard·ChatCreateModal·settings/account). 새 화면을 옮길 때도 같은 자리에서 `{' '}` 를 챙길 것(부모가 flex/grid 면 공백이 렌더되지 않으니 불필요) |
