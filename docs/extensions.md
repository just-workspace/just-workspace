# 모듈과 플러그인

Just Workspace 의 기능은 세 계층으로 구성된다.

| 계층 | 정의 | 결정 주체·시점 |
|---|---|---|
| **구역** | 설치 단위. 구역별로 필요한 컨테이너·API·백그라운드 작업이 함께 기동된다(메일, 채팅, 회의 …). 선언은 `backend/app/zones.json` | 설치 시, 또는 관리 › 구역 |
| **모듈** | 화면·API 의 단위(메일, 파일, 위키 …). 설치된 구역의 모듈만 목록에 표시되며, 관리자가 개별적으로 활성화·비활성화한다 | 관리 › 모듈·플러그인 |
| **플러그인** | 리포 외부에서 개발한 기능을 모듈로 추가하는 확장. 백엔드 라우터와 프런트 번들의 쌍으로 구성된다 | 관리 › 모듈·플러그인에서 설치 |

본 문서는 모듈의 동작 방식과 플러그인 개발 방법을 기술한다. 구역 설치는 [install.md](install.md), 용어는 [glossary.md](glossary.md)를 참조한다.

> **플러그인 설치는 서버 권한의 부여와 동일하다.** 플러그인의 백엔드 코드는 워크스페이스 백엔드 프로세스 내에서 그대로 실행되며
> 데이터베이스·저장소·비밀값·도커 소켓에 모두 접근할 수 있다. 격리(샌드박스)와 서명 검증은 제공되지 않는다. 코드를 검토한 플러그인,
> 제작자를 신뢰할 수 있는 플러그인에 한하여 설치한다. 상세 사항은 아래 [보안 모델](#보안-모델)을 참조한다.

## 내장 모듈

| ID | 이름 | 화면 경로 | API 접두사 | 소속 구역 | 초기 상태 |
|----|------|--------|-----------|----------|----------|
| `files` | 파일 | `/files` | `/api/files` | 기본 | 활성 |
| `mail` | 메일 | `/mail` | `/api/mail` | 메일 | 활성 |
| `chat` | 채팅 | `/chat` | `/api/chat` | 채팅 | 활성 |
| `calendar` | 캘린더 | `/calendar` | `/api/calendar` | 일정·연락처·할 일 | 활성 |
| `contacts` | 연락처 | `/contacts` | `/api/contacts` | 일정·연락처·할 일 | 활성 |
| `tasks` | 할 일 | `/tasks` | `/api/tasks` | 일정·연락처·할 일 | 활성 |
| `wiki` | 위키 | `/wiki` | `/api/wiki` | 문서 편집·위키·게시판 | 활성 |
| `board` | 게시판 | `/board` | `/api/board` | 문서 편집·위키·게시판 | 활성 |
| `meetings` | 화상회의 | `/meetings` | `/api/meetings` | 회의 | 활성 |
| `git` | Git | `/code` | `/api/git` | 코드 저장소 | 활성 |
| `ai` | AI | `/ai` | `/api/ai` | AI 도우미 | **비활성** — AI 제공자 설정 후 활성화한다 |
| `rbi` | 격리 브라우저 | `/rbi` | `/api/rbi` | 격리 브라우저(애드온) | **비활성** — [rbi.md](rbi.md) |

정본은 `backend/app/modules/registry.py`(`BUILTIN_MODULES`)이며, 모듈의 소속 구역은 `backend/app/zones.json` 의 `modules` 가 규정한다.
문서 편집(`/api/wopi`)은 개별적으로 활성화·비활성화하는 모듈이 아니며, "문서 편집·위키·게시판" 구역이 설치된 경우 파일 화면 내에서 동작한다.

## 모듈 상태

- 저장: `system_settings` 테이블의 `module.<id>.enabled`(값 `true`/`false`). 관리 › 모듈·플러그인의 스위치가 이 값을 변경한다.
- 반영: 서버 재시작은 불필요하다. 모듈 목록 응답(`GET /api/platform/modules`)은 Redis 에 60초간 캐시되며, 스위치 조작 시 즉시 무효화된다.
- 미설치 구역의 모듈은 DB 에 활성 상태로 기록되어 있더라도 목록에서 제외되며 항상 비활성으로 간주한다(`JW_ZONES` 환경변수 — 비어 있으면 전체 구역).
- 그룹 권한: 관리 › 그룹에서 모듈을 특정 그룹에 한정하여 부여할 수 있다. 어느 그룹에도 부여하지 않은 모듈은 전체 사용자가 사용한다. 플러그인 모듈도 동일하다.

### 백엔드 가드

`@require_module` 데코레이터가 비활성 모듈의 API 를 차단한다.

```python
from app.modules.registry import require_module

@router.get("/mailboxes")
@require_module("mail")
async def list_mailboxes(...):
    ...
```

비활성 모듈의 API 를 호출한 경우의 응답:

```json
HTTP 403
{"detail": "이 기능은 비활성화되어 있습니다"}
```

### 프런트엔드 가드

- 내비게이션: `usePlatform()`(`frontend-react/src/composables/usePlatform.ts`)이 `/api/platform/modules` 에서 모듈·플러그인 목록을 조회하여
  사이드바와 모바일 탭바를 렌더링한다. 플러그인은 manifest `order` 순으로 내장 모듈 다음에 배치된다.
- 페이지: `frontend-react/src/router/guards.ts` 가 화면 전환 시마다 로그인 → 초기 설정 → 모듈 순으로 검사하며, 비활성 모듈의 화면은 대시보드(`/`)로 리다이렉트한다.
  컴포넌트 외부에서는 `isModuleEnabled(id)` 를 사용한다.

---

## 플러그인

플러그인은 **단일 폴더**로 구성된다. 백엔드는 기동 시 해당 폴더를 읽어 API 를 등록하고, 프런트는 화면 진입 시 해당 플러그인의 번들을 내려받아 렌더링한다.
따라서 워크스페이스 프런트를 재빌드하지 않고 플러그인을 추가·제거할 수 있다.

```
plugins/
├── package.json              # 빌드 의존성(vite, vue, @vitejs/plugin-vue)
├── build-plugin.mjs          # 플러그인 하나 빌드 — frontend/page.vue 가 있는 플러그인용
├── build-all.mjs             # frontend/page.vue 가 있는 플러그인 전부 빌드
├── sample-notes/             # 견본 — 메모(Vue 프런트)
│   ├── manifest.json          # 필수
│   ├── backend/
│   │   ├── router.py          # 필수 — FastAPI APIRouter 를 `router` 라는 이름으로
│   │   └── models.py          # 선택 — SQLAlchemy 모델
│   └── frontend/
│       ├── page.vue           # 소스
│       └── dist/plugin.mjs    # 빌드 산출물(파일 하나, CSS 포함) — 이것이 서빙된다
└── remote-desktop/           # 견본 — 원격 데스크톱(React 프런트, 자체 빌드 스크립트 frontend/build.mjs)
```

리포에는 견본 2종과 빌드 도구만 포함된다(`.gitignore` 가 `plugins/` 하위의 그 밖의 폴더를 추적 대상에서 제외한다). 자체 개발한 플러그인은 별도 저장소에서 관리한다.

백엔드의 플러그인 탐색 경로는 다음 두 곳이다.

| 컨테이너 경로 | 내용 | 삭제 가능 여부 |
|---|---|---|
| `/plugins` | 리포의 `plugins/` 폴더(읽기 전용 마운트) | 관리 화면에서 삭제 불가 |
| `/plugins-data` | 관리 화면에서 업로드한 플러그인(도커 볼륨 `ws-plugins-data`) | 관리 화면에서 삭제 |

동일한 `id` 가 두 경로에 모두 존재하면 `/plugins` 의 것이 로드되고 나머지는 제외된다.

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
  "zones": [],
  "frontend": true
}
```

| 필드 | 필수 | 설명 |
|------|------|------|
| `id` | O | 고유 ID(영문·숫자·`-`·`_`). 모듈 ID 로도 사용된다 |
| `name` | O | 표시 이름 |
| `route` | O | 화면 경로. `/p/<id>` 로 지정한다(호스트의 플러그인 화면은 `/p/<id>` 하나다) |
| `api_prefix` | O | API 접두사. 반드시 `/api/plugins/` 로 시작하여야 한다 |
| `name_en` · `version` · `description` · `author` · `icon` | X | 관리 화면과 내비게이션에 표시되는 값. `icon` 은 호스트 아이콘 이름(미지정 시 `puzzle`) |
| `zones` | X | 해당 플러그인이 의존하는 **구역 id 목록**(`backend/app/zones.json` 의 id — `mail` `chat` `calendar` `docs` `meetings` `git` `ai` `sso` `rbi`). 하나라도 미설치 상태이면 플러그인을 **로드하지 않는다** — 아래 설명 참조 |
| `order` | X | 내비게이션과 관리 화면에서의 표시 순서. 정수이며 값이 작을수록 상단에 배치된다 |
| `fullscreen` | X | 화면 하단까지 자체 컨트롤로 사용하는 페이지 — 모바일 하단 탭바를 숨긴다(기본 false) |
| `requires` | X | 의존 모듈 ID 목록. 현재는 목록에 포함될 뿐 검사하지 않는다 — 구역 의존성은 `zones` 에 기재한다 |
| `frontend` · `frontend_api` | X | 기재용 값이며 백엔드는 읽지 않는다. 프런트 존재 여부는 `frontend/dist/plugin.mjs` 파일의 존재 여부로, 프런트 계약 버전은 번들 내용으로 판정한다 |

**`zones`**: 플러그인이 다른 구역의 기능을 사용하는 경우(예: 견본 `remote-desktop` 은 화면 전송에 회의 구역의 LiveKit 을 사용한다 → `"zones": ["meetings"]`)
이 필드에 기재한다. 백엔드는 기동 시 설치된 구역(`JW_ZONES`)과 대조하여, 누락된 구역이 있으면 해당 플러그인의 라우터·모델·모듈을 로드하지 않고 로그에
`필요한 구역이 설치되지 않아 건너뜀` 을 기록한다. 제외된 플러그인과 누락된 구역은 `GET /api/admin/plugins` 응답의 `skipped`
(`[{id, name, reason: "zone_not_installed", missing_zones}]`)에 포함된다. 필드가 없거나 빈 배열이면 구역과 무관하게 로드된다.

**`order`**: `order` 가 지정된 플러그인이 먼저(오름차순), 미지정 플러그인은 그다음에 폴더 이름순으로 배치된다. 값이 같은 경우에도 폴더 이름순을 따른다.
정수가 아닌 값(`"1"`, `1.5`, `true`)은 경고 로그를 기록하고 미지정으로 처리한다. 이후 삽입할 여지를 두려면 10 단위로 지정한다.
내장 모듈의 순서는 변경되지 않으며, 백엔드의 라우터 등록 순서도 항상 폴더 이름순이다.

### 백엔드

`backend/router.py` 가 `router`(FastAPI `APIRouter`)를 노출하면 manifest 의 `api_prefix` 하위에 등록된다.

```python
from fastapi import Depends
from app.plugins.sdk import APIRouter, get_current_user, get_db, User

router = APIRouter()

@router.get("")
async def list_items(user: User = Depends(get_current_user)):
    ...
```

`app.plugins.sdk` 는 사용 빈도가 높은 항목을 재노출한다: `APIRouter` · `get_current_user` · `get_db` · `require_module` · `register_tool` · `User`.
플러그인 코드는 `app.*` 의 모든 항목을 import 할 수 있다 — 그만큼 코어 변경 시 호환성이 깨질 수 있다.

- **모델**: `backend/models.py` 가 존재하면 라우터보다 먼저 `plugin_<id>_models` 라는 모듈 이름으로 로드한다(`id` 의 `-` 도 그대로 유지).
  라우터에서는 `from plugin_notes_models import Note` 와 같이 import 한다.
- **테이블**: 코어는 플러그인 테이블을 생성하지 않는다. 견본과 같이 플러그인 전용 `DeclarativeBase` 를 두고 최초 요청 시
  `create_all` 을 직접 호출한다. 컬럼 변경에 따른 마이그레이션도 플러그인의 책임이다.
- **비활성 검사**: 관리자가 플러그인을 비활성화하더라도 라우터는 등록된 상태로 유지된다. 각 엔드포인트에서 `@require_module("<id>")` 또는 `is_module_enabled("<id>")` 로 차단한다(견본 참조).
- **이름 충돌**: 테이블에는 `plugin_<이름>_…` 형식의 접두사를 부여하여 코어 및 다른 플러그인과의 충돌을 방지한다.

#### 라이프사이클 훅 (선택)

`backend/router.py` 에 아래 이름의 함수가 정의되어 있으면 호출된다. 인자는 DB 세션 하나이며, 동기·비동기 함수를 모두 지원한다. 훅이 실패하면 로그만 기록하고 처리를 계속한다.

| 훅 | 시점 |
|----|------|
| `on_install(db)` | 최초 로드 시 1회(`system_settings` 의 `plugin.<id>.installed` 로 기록). 재설치하면 다시 호출된다 |
| `on_enable(db)` | 관리자가 활성화할 때 |
| `on_disable(db)` | 관리자가 비활성화할 때 |
| `on_uninstall(db)` | 관리 화면에서 삭제할 때 — 테이블·파일 정리는 이 훅에서 수행한다 |

#### AI 도구 등록 (선택)

플러그인이 AI 도구를 등록하면 내장 AI 와 외부 MCP 커넥터([CONNECTOR.md](CONNECTOR.md))가 동일한 게이트를 거쳐 호출한다.

```python
from app.plugins.sdk import register_tool

async def _search(user, query: str):
    return {"result": "..."}

register_tool("myplugin_search", "내 플러그인 검색", {
    "type": "object",
    "properties": {"query": {"type": "string"}},
    "required": ["query"],
}, _search)
```

- `backend/router.py`(또는 `models.py`)의 로드 중에 호출된 `register_tool` 은 도구를 **해당 플러그인의 모듈**(manifest 의 `id`)에 귀속시킨다 —
  접근 판정 테이블 `TOOL_MODULE`(`backend/app/mcp/access.py`)에 `도구 → 플러그인 id` 가 등록된다. 판정 기준은 내장 도구와 동일하다:
  플러그인이 비활성 상태이거나, 사용자의 그룹에 해당 플러그인 권한이 없거나, 사용자 없이 이루어지는 호출이면 노출되지도 호출되지도 않는다.
  외부 AI 제공자로의 내용 전송을 제한하는 관리자 정책·사용자 동의에서는 개인 데이터를 취급하는 도구로 분류한다.
- 도구 이름은 전체에서 유일하여야 한다. 내장 도구나 다른 플러그인이 이미 사용 중인 이름이면 등록하지 않고 `False` 를 반환하며 로그에 기록한다 —
  이름 앞에 플러그인 id 를 접두사로 부여한다(`myplugin_…`).
- 플러그인 로드가 실패하면(라우터 로드 실패 등) 해당 플러그인이 등록한 도구도 함께 제거한다.
- 테이블에 없는 도구는 노출되지 않는다는 규칙은 동일하게 적용된다. 플러그인 로드 중이 아닌 시점(요청 처리 중 등)에 호출된 `register_tool` 은
  모듈에 귀속되지 않아 어디에도 노출되지 않는다 — 도구는 모듈 로드 시점에 등록한다.
- `register_tool` 로 등록한 도구는 읽기 도구(`mcp:read`)다. 쓰기 도구(승인 절차를 거치는 `mcp:write`)나, 결과를 "신뢰할 수 없는 외부 내용"으로
  표시하는 플래그(`untrusted_output`)가 필요한 경우 `app.mcp.server` 의 `Tool`·`register` 를 직접 사용하고 `TOOL_MODULE` 에도 직접 등록한다.

### 프런트엔드

프런트 번들은 호스트(`frontend-react`)와 **별도로 빌드한 단일 ES 모듈 파일**(`frontend/dist/plugin.mjs`)이다. 계약은 두 종류이며 호스트가 번들 내용을 기준으로 자동 판정한다.

| 계약 | 소스 | 프레임워크 제공 위치 | 호스트 API 수신 방법 | 견본 |
|---|---|---|---|---|
| **v2 (React)** — 신규 플러그인의 표준 | `frontend/page.tsx` | `window.__REACT__` · `window.__REACT_DOM__` · UI 키트 `window.__WS_UI__` | props `pluginApi` | `plugins/remote-desktop` |
| **v1 (Vue)** | `frontend/page.vue` | `window.__VUE__` — 호스트는 이 계약의 플러그인을 로드할 때에 한하여 Vue 런타임을 내려받는다 | `inject('pluginApi')` | `plugins/sample-notes` |

- v2 작성 지침·`pluginApi` 표·UI 키트·빌드 설정: [frontend-react/docs/plugin-v2.md](../frontend-react/docs/plugin-v2.md)
- 두 계약의 공통 제약(스타일·캐싱·상단바 버튼 및 제목): [plugin-frontend.md](plugin-frontend.md)

v1 의 `pluginApi`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted, inject } from 'vue'   // 빌드할 때 window.__VUE__ 에서 꺼내는 코드로 바뀐다

const api = inject<any>('pluginApi')
const user = api.user         // Ref<User | null>
const appName = api.appName   // Ref<string>
const $fetch = api.$fetch     // 호스트 API 클라이언트(로그인 정보가 자동으로 붙는다)
// 그 밖에: api.setHeaderActions · clearHeaderActions · setTitle · clearTitle
</script>
```

### 빌드

v1(Vue) — `frontend/page.vue` 가 있는 플러그인:

```bash
cd plugins
npm install                           # 처음 한 번
node build-plugin.mjs sample-notes    # 하나만
node build-all.mjs                    # page.vue 가 있는 플러그인 전부
```

v2(React) — 공용 빌드 스크립트는 제공되지 않으며, 플러그인이 자체 빌드 스크립트를 보유한다. 견본:

```bash
cd frontend-react && npm install      # 견본 스크립트가 여기의 esbuild·typescript 를 빌려 쓴다
node plugins/remote-desktop/frontend/build.mjs     # 리포 루트에서
```

어느 계약이든 산출물은 `plugins/<폴더>/frontend/dist/plugin.mjs` 단일 파일이다(코드 분할 없음, CSS 는 JS 에 인라인). 프레임워크는 번들에 포함하지 않으며
호스트 전역을 참조하도록 치환한다 — v1 은 `vue` → `window.__VUE__`, v2 는 `react`·`react-dom`·`@jw/ui` → `window.__REACT__`·`__REACT_DOM__`·`__WS_UI__`.
`build-all.mjs` 는 `page.vue` 가 없는 플러그인(v2)을 제외한다.

### 번들 제공 경로

```
GET /api/plugin-assets/{plugin_id}/bundle.mjs      # 로그인 없이 받을 수 있는 정적 파일
```

호스트의 `frontend-react/src/plugins/pluginHost.tsx`(화면은 `src/pages/p/[id].tsx`)가 이 주소를 동적 `import()` 로 로드한다.
백엔드가 ETag 와 `If-None-Match` 를 처리하므로 주소에 버전 쿼리 문자열을 부가하지 않는다 — 재방문 시 304 로 응답하며, 재빌드 시 새 번들이 자동으로 적용된다.
번들에 비밀값을 포함하지 않는다(인증 없이 누구나 내려받을 수 있다).

---

### 플러그인의 라이선스

Just Workspace 는 AGPL-3.0-or-later 로 배포되며 **플러그인에 대한 예외는 없다.** backend 플러그인은 backend 와 동일 프로세스에서 `app.*` 과 플러그인 SDK 를 호출하고, 프런트 플러그인은 호스트 화면이 제공하는 모듈을 사용한다. 이와 같이 본 소프트웨어의 코드를 호출하는 플러그인을 **타인에게 배포하는 경우 AGPL-3.0 과 호환되는 조건으로 배포해야 한다는 것이 일반적인 해석**이다. 자체 서버에만 설치하여 사용하는 것은 배포에 해당하지 않는다. 다만 해당 서버를 타인이 네트워크로 이용하는 경우의 의무는 [licensing.md](licensing.md) 4절을 참조한다. 견본 플러그인(`plugins/sample-notes`, `plugins/remote-desktop`)에는 이 리포와 동일한 라이선스가 적용된다.

## 플러그인 설치

### 관리 화면을 통한 업로드 설치

관리 › 모듈·플러그인에서 패키지(.zip)를 업로드한다.

```
패키지(.zip) — 맨 위 또는 폴더 하나 안에:
  manifest.json            (필수)
  backend/router.py        (필수)
  backend/models.py        (선택)
  frontend/dist/plugin.mjs (화면이 있는 플러그인 — 빌드 산출물을 넣는다. 서버는 빌드하지 않는다)
```

1. 검사: zip 크기(100MB 이하)·압축 해제 후 크기(300MB 이하)·항목 수, `manifest.json` 의 `id`·`route`·`api_prefix`, `backend/router.py` 의 존재 여부.
2. `/plugins-data/<id>/` 에 압축을 해제한다. 동일한 `id` 가 이미 존재하면 덮어쓴다.
3. **백엔드가 자동으로 재시작된다**(약 20초 — 해당 시간 동안 워크스페이스 전체의 API 가 일시 중단된다). 백엔드는 다수의 워커로 실행되므로, 전체 워커가 신규 플러그인을 로드하려면 재시작이 필요하다.
4. 재기동 후 플러그인이 로드되고(`on_install`) 내비게이션에 표시된다.

삭제도 동일한 화면에서 수행한다(업로드로 설치한 플러그인에 한함). `on_uninstall` 을 호출하고 폴더를 삭제한 후 백엔드가 재시작된다.

검사 대상은 **형식에 한정된다.** 코드의 동작은 검사하지 않는다. `zones` 도 업로드 시에는 검사하지 않으며, 재기동 시 누락된 구역이 있으면 별도 통지 없이 로드에서 제외된다 —
업로드 후 플러그인이 표시되지 않는 경우 백엔드 로그(`[Plugins]`) 또는 `GET /api/admin/plugins` 의 `skipped` 를 확인한다.

API: `GET /api/admin/plugins` · `POST /api/admin/plugins/install`(multipart `file`) · `PATCH /api/admin/plugins/{id}` `{enabled}` · `DELETE /api/admin/plugins/{id}`. 모두 관리자 전용이다.

### 폴더 직접 배치

서버에 직접 접근할 수 있는 경우 리포의 `plugins/<폴더>/` 에 직접 배치한다.

```
1. plugins/<폴더>/ 에 manifest.json · backend/ · frontend/ 를 둔다
2. 프런트를 빌드한다(위 "빌드")
3. docker compose restart backend
```

---

## 보안 모델

플러그인은 **신뢰 경계의 내부**에 위치한다. 설치 시점부터 해당 코드는 워크스페이스 자체의 일부로 취급된다.

- 백엔드 코드(`backend/*.py`)는 백엔드 프로세스에 import 되어 **동일한 권한**으로 실행된다. 전체 사용자의 메일·파일·채팅이 저장된 데이터베이스,
  저장소 볼륨, `.env` 의 비밀값, 백엔드에 마운트된 도커 소켓에 접근할 수 있다 — 사실상 서버 호스트 권한에 해당한다.
- import 시점에 실행된다. 관리 화면에서 플러그인을 비활성화하더라도 코드는 언로드되지 않는다(비활성화의 대상은 화면과, 플러그인이 자체적으로 검사하는 API 에 한정된다).
  언로드하려면 플러그인을 삭제하고 백엔드를 재시작한다.
- 프런트 번들은 워크스페이스 화면과 **동일 출처**에서 실행된다. 화면에 접속한 사용자의 권한으로 모든 API 를 호출할 수 있다.
- 격리(샌드박스)·권한 선언·서명 검증·코드 심사는 제공되지 않는다. 업로드 시의 검사 대상은 형식과 크기에 한정된다.
- 설치·삭제는 관리자만 수행할 수 있다. 따라서 **관리자 계정의 탈취는 서버의 탈취와 동일하다** — 관리자 계정에는 2단계 인증을 적용한다.

따라서 출처가 확인된 플러그인에 한하여, 가능한 경우 코드를 검토한 후 설치한다. 제3자가 개발한 플러그인을 도입하는 체계를 운영하는 경우 코드 심사를 직접 수행하여야 한다.
취약점 신고는 리포 루트의 `SECURITY.md` 를 참조한다.
