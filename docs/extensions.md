# Extensions & Module System

## 모듈 시스템 개요

just-workspace의 모든 기능은 **모듈**로 등록됩니다.
관리자가 `/admin/modules` 페이지에서 개별 모듈을 활성화/비활성화할 수 있습니다.

## 내장 모듈

| ID | 이름 | 라우트 | API 접두사 | 기본 상태 |
|----|------|--------|-----------|----------|
| `mail` | 메일 | `/mail` | `/api/mail` | 활성 |
| `chat` | 채팅 | `/chat` | `/api/chat` | 활성 |
| `meetings` | 화상회의 | `/meetings` | `/api/meetings` | 활성 |
| `files` | 파일 | `/files` | `/api/files` | 활성 |
| `calendar` | 캘린더 | `/calendar` | `/api/calendar` | 활성 |
| `contacts` | 연락처 | `/contacts` | `/api/contacts` | 활성 |
| `git` | Git | `/git` | `/api/git` | 활성 |
| `board` | 게시판 | `/board` | `/api/board` | 활성 |
| `tasks` | 할 일 (하위작업) | `/tasks` | `/api/tasks` | 활성 |
| `wiki` | 위키 | `/wiki` | `/api/wiki` | 활성 |
| `ai` | AI | `/ai` | `/api/ai` | 활성 |

정본은 `backend/app/modules/registry.py`. 오피스(WOPI, `/api/wopi`)는 별도 모듈이 아니라 파일 모듈 안에 있고 `onlyoffice` 프로파일이 있을 때 동작한다.
Git 화면 라우트는 `/code`(`/git` 은 리다이렉트).

## 모듈 상태 저장

`system_settings` 테이블에 `module.<id>.enabled` 키로 저장됩니다.

```sql
-- 예시
INSERT INTO system_settings (key, value) VALUES ('module.mail.enabled', 'false');
```

서버 재시작 불필요 — API 호출 시 즉시 반영됩니다(`/api/platform/modules` 응답은 Redis 60초 캐시).

## 백엔드 가드

`@require_module` 데코레이터로 API 엔드포인트를 보호합니다:

```python
from app.modules.registry import require_module

@router.get("/mailboxes")
@require_module("mail")
async def list_mailboxes(...):
    ...
```

비활성 모듈의 API 호출 시:
```json
HTTP 403
{"detail": "이 기능은 비활성화되어 있습니다"}
```

## 프론트엔드 가드

### 네비게이션 동적화

`usePlatform()`(`frontend-react/src/composables/usePlatform.ts`, `platformStore`)이 `/api/platform/modules`에서 모듈·플러그인 목록을 가져와
사이드바 레일·모바일 탭바가 동적으로 메뉴를 그립니다. 플러그인은 manifest `order` 순으로 내장 모듈 뒤에 놓입니다.

### 페이지 가드

`src/router/guards.ts`(루트 loader)가 매 이동마다 인증 → 설정 마법사 → 모듈 가드 순으로 검사해 비활성 모듈의 페이지 접근을
대시보드(`/`)로 리다이렉트합니다. 컴포넌트 밖에서는 `isModuleEnabled(id)`.

---

## 플러그인 시스템

v4.2.0부터 **런타임 플러그앤플레이** 방식의 플러그인 시스템을 지원합니다.
프론트엔드 리빌드 없이 플러그인을 추가/제거할 수 있습니다. 프런트 계약은 두 가지입니다 —
**v1(Vue)**: `window.__VUE__` 를 쓰는 기존 번들(React 호스트가 Vue 런타임을 지연 로드해 그대로 띄운다),
**v2(React)**: `window.__REACT__` + 호스트 UI 키트 `window.__WS_UI__`(`@jw/ui`) 를 쓰는 번들. 새 플러그인은 v2 로 쓴다 →
[frontend-react/docs/plugin-v2.md](../frontend-react/docs/plugin-v2.md). 공통 제약은 [plugin-frontend.md](plugin-frontend.md).

### 플러그인 디렉토리 구조

```
plugins/
├── package.json              # v1 빌드 의존성 (vite 8, vue 3.5, @vitejs/plugin-vue)
├── build-plugin.mjs          # 단일 플러그인 빌드 (v1 Vue)
├── build-all.mjs             # 전체 플러그인 일괄 빌드
└── sample-notes/             # 플러그인 디렉토리 (리포에 동봉된 유일한 예제)
    ├── manifest.json          # 플러그인 매니페스트 (필수)
    ├── backend/
    │   ├── router.py          # FastAPI APIRouter (필수)
    │   └── models.py          # SQLAlchemy 모델 (선택)
    └── frontend/
        ├── page.vue           # v1 Vue 소스 (v2 는 page.tsx — plugin-v2.md 4절 빌드 예)
        └── dist/
            └── plugin.mjs     # 빌드된 번들 (자동 생성, 파일 하나·CSS 인라인)
```

직접 만든 플러그인은 이 리포에 두지 않는다 — `.gitignore` 허용목록(`sample-notes`·`remote-desktop` + 빌드 도구)만 추적된다.

### manifest.json

```json
{
  "id": "notes",
  "name": "메모",
  "name_en": "Notes",
  "version": "1.0.0",
  "description": "간단한 메모 관리",
  "author": "just-workspace",
  "icon": "edit-3",
  "route": "/p/notes",
  "api_prefix": "/api/plugins/notes",
  "requires": [],
  "frontend": true
}
```

| 필드 | 필수 | 설명 |
|------|------|------|
| `id` | O | 플러그인 고유 ID (영숫자, 하이픈, 언더스코어) |
| `name` | O | 한글 표시명 |
| `route` | O | 프론트엔드 라우트 (`/p/` 접두사) |
| `api_prefix` | O | API 경로 접두사 (`/api/plugins/` 필수) |
| `frontend` | X | 프론트엔드 UI 보유 여부 (기본 false) |
| `frontend_api` | X | `1`/`2`(`"vue"`/`"react"`). 지금은 백엔드가 넘기지 않아 호스트가 번들 소스로 판정한다 — 적어 두는 것은 무해 |
| `requires` | X | 의존 모듈 ID 목록 |
| `fullscreen` | X | 화면 하단까지 자기 컨트롤로 쓰는 페이지 — 모바일 탭바를 숨긴다 (기본 false) |
| `order` | X | 레일·모바일 메뉴·관리 › 모듈의 플러그인 순서. 정수, 작을수록 위 (예: `10`, `20`) |

**순서(`order`)**: `order` 가 있는 플러그인이 먼저(작은 순), 없는 플러그인은 그 뒤에 폴더 이름순으로 온다.
같은 `order` 끼리도 폴더 이름순. 정수가 아니면(`"1"`, `1.5`, `true`) 경고 로그를 남기고 없는 것으로 친다.
레일에서는 카테고리 묶음 안의 내장 모듈 뒤에 놓인다(내장 모듈 순서는 바뀌지 않는다).
순서만 바뀌고 로드(라우터 마운트) 순서는 늘 폴더 이름순이다. 사이에 끼울 자리를 남기려면 10 단위로 매긴다.
`/api/platform/modules`·`/api/admin/plugins` 응답의 플러그인 항목에 `order`(없으면 `null`)가 실린다.

### 플러그인 프론트엔드 계약

**v2(React)** — default export 가 `({ pluginApi }) => JSX`, `export const jwPlugin = { api: 2 }` 표식 필수. `pluginApi` 는
`user`·`appName`(값)·`$fetch`(ofetch, 쿠키/Bearer 자동)·`navigateTo`·`t`·`setHeaderActions`·`setTitle` 등 — 표는 plugin-v2.md 3절.

**v1(Vue)** — 호스트 composable·auto-import 를 쓸 수 없고 `inject('pluginApi')` 로 받습니다:

```vue
<script setup lang="ts">
import { ref, computed, onMounted, inject } from 'vue'   // 빌드 시 window.__VUE__ 로 치환

const api = inject<any>('pluginApi')
const user = api.user         // Ref<User | null>
const $fetch = api.$fetch     // ofetch instance (쿠키/인증 자동 포함)
const appName = api.appName   // Ref<string>
</script>
```

### 플러그인 빌드

```bash
cd plugins
npm install                           # 최초 1회
node build-plugin.mjs sample-notes    # 단일 빌드 (v1 Vue)
node build-all.mjs                    # 전체 빌드
```

빌드 결과: `plugins/<name>/frontend/dist/plugin.mjs`
- Vite library mode 로 ES module 번들 하나 생성(코드 분할 없음, CSS 인라인)
- v1: `vue` 는 external → `window.__VUE__` 글로벌 참조로 대체(호스트가 같은 3.5 Vue 런타임을 지연 로드)
- v2: `react`·`react-dom`·`@jw/ui` 를 external → `window.__REACT__`·`__REACT_DOM__`·`__WS_UI__` 로 치환(plugin-v2.md 4절 설정 예)

### 플러그인 백엔드

`backend/router.py`에서 `router` (FastAPI `APIRouter`)를 export합니다.
매니페스트의 `api_prefix`에 마운트됩니다.

```python
from fastapi import APIRouter
router = APIRouter()

@router.get("")
async def list_items(...):
    ...
```

### 플러그인 추가 흐름 (프론트엔드 리빌드 불필요)

```
1. plugins/<name>/ 디렉토리 생성 (manifest.json + backend/ + frontend/)
2. cd plugins && node build-plugin.mjs <name>
3. docker compose restart backend
4. → 자동 발견 → 모듈 등록 → 프론트엔드에서 런타임 로딩
```

### 번들 서빙

백엔드가 빌드된 번들을 정적 파일로 서빙합니다:

```
GET /api/plugin-assets/{plugin_id}/bundle.mjs
```

호스트 `src/plugins/pluginHost.tsx`(페이지 `src/pages/p/[id].tsx`)가 이 URL 에서 `import()` 로 동적 로딩합니다.
백엔드가 ETag + `If-None-Match` 를 직접 처리하므로 **캐시버스터를 붙이지 않습니다**(재방문 304).

---

## 플러그앤플레이 설치 (v4.4+)

관리자가 **관리 → 플러그인** 화면에서 **패키지(.zip)를 업로드**하면 파일 복사·CLI 없이 설치됩니다.

```
패키지(.zip) 구조 — 루트 또는 단일 폴더 안에:
  manifest.json            (필수)
  backend/router.py        (필수, APIRouter export)
  backend/models.py        (선택)
  frontend/dist/plugin.mjs (frontend:true 인 경우 — 빌드 산출물 포함, v1·v2 모두 가능)
```

흐름: 업로드 → 검증(manifest·api_prefix=/api/plugins/…·backend/router.py) → 쓰기가능
볼륨 `/plugins-data` 에 압축 해제(경로 탈출 방지) → **백엔드 자동 재시작(~20초)** → 로드 →
nav 자동 노출. 삭제도 같은 화면에서(업로드 설치분만; 번들 플러그인은 삭제 불가).

> 멀티워커(8) 구조라 "무재시작 즉시 반영"은 불가 → 업로드 후 백엔드를 자동 재시작하는
> 방식으로 플러그앤플레이를 구현. 프론트는 재시작 동안 대기 후 자동 갱신.

API: `POST /api/admin/plugins/install`(multipart `file`), `DELETE /api/admin/plugins/{id}`.

## 라이프사이클 훅 (선택)

`backend/router.py` 에 함수를 정의하면 호출됩니다(인자 `db`, sync/async 모두 가능):

| 훅 | 시점 |
|----|------|
| `on_install(db)` | 최초 설치 1회(설치 플래그로 추적). 테이블 시드 등 |
| `on_enable(db)` | 모듈 활성화 시 |
| `on_disable(db)` | 모듈 비활성화 시 |
| `on_uninstall(db)` | 삭제 시 — 정리(테이블/파일 삭제 등) |

> DB 테이블은 모델 import 시 `create_all`로 자동 생성됩니다. 삭제 정리는 `on_uninstall`에서.

## AI 도구(MCP) 등록

플러그인이 AI 도구를 등록하면 내장 AI 채팅과 MCP 서버(claude.ai 커넥터, [CONNECTOR.md](CONNECTOR.md))가 **같은 게이트웨이를 통해** 호출합니다
(모듈 on/off·그룹 권한·스코프(`mcp:read`/`mcp:write`)·도구 호출 확인 게이트 적용). 외부 데이터를 돌려주는 도구는 결과를 `untrusted` 로 감싸
모델이 지시가 아니라 데이터로 다루게 합니다.

```python
from app.plugins.sdk import register_tool

async def _do(user, query: str):
    return {"result": "..."}

register_tool("myplugin_search", "내 플러그인 검색", {
    "type": "object",
    "properties": {"query": {"type": "string"}},
    "required": ["query"],
}, _do)
```

## 그룹 권한(RBAC)

플러그인도 일반 모듈과 동일하게 **관리 → 그룹/권한**에서 그룹에 부여할 수 있습니다.
권한을 부여하면 해당 그룹원만 사용(권한 미지정 시 전체 공개). 예: "회계 플러그인 → 회계팀만".

## SDK 편의 모듈

```python
from app.plugins.sdk import APIRouter, get_current_user, get_db, require_module, register_tool, User
```

## 보안 모델 ⚠

플러그인 `backend/router.py` 는 **백엔드 프로세스 권한으로 실행**(DB·앱 전체 접근). 따라서
**신뢰할 수 있는 플러그인만 설치**하세요(현재는 샌드박스 없음 — 사내/검증된 패키지 가정).
공개 마켓/서드파티 배포를 한다면 코드 심사 절차가 필요합니다.
