# 모듈과 플러그인

Just Workspace 의 기능은 세 층으로 나뉜다.

| 층 | 무엇 | 누가 정하나 |
|---|---|---|
| **구역** | 설치 단위. 구역마다 필요한 컨테이너·API·백그라운드 작업이 함께 올라온다(메일, 채팅, 회의 …). 선언은 `backend/app/zones.json` | 설치할 때, 또는 관리 › 구역 |
| **모듈** | 화면·API 한 묶음(메일, 파일, 위키 …). 설치된 구역의 모듈만 목록에 나오고, 관리자가 하나씩 켜고 끈다 | 관리 › 모듈·플러그인 |
| **플러그인** | 리포 밖에서 만든 기능을 모듈로 얹는 것. 백엔드 라우터 + 프런트 번들 한 쌍 | 관리 › 모듈·플러그인에서 설치 |

이 문서는 모듈이 동작하는 방식과 플러그인을 만드는 법을 다룬다. 구역 설치는 [install.md](install.md), 용어는 [glossary.md](glossary.md).

> **플러그인 설치는 서버 권한을 주는 것과 같다.** 플러그인의 백엔드 코드는 워크스페이스 백엔드 프로세스 안에서 그대로 실행되어
> 데이터베이스·저장소·비밀값·도커 소켓에 모두 닿는다. 격리(샌드박스)도 서명 검사도 없다. 코드를 읽어 본 플러그인,
> 만든 사람을 믿는 플러그인만 설치한다. 자세한 것은 아래 [보안 모델](#보안-모델).

## 내장 모듈

| ID | 이름 | 화면 경로 | API 접두사 | 속한 구역 | 처음 상태 |
|----|------|--------|-----------|----------|----------|
| `files` | 파일 | `/files` | `/api/files` | 기본 | 켜짐 |
| `mail` | 메일 | `/mail` | `/api/mail` | 메일 | 켜짐 |
| `chat` | 채팅 | `/chat` | `/api/chat` | 채팅 | 켜짐 |
| `calendar` | 캘린더 | `/calendar` | `/api/calendar` | 일정·연락처·할 일 | 켜짐 |
| `contacts` | 연락처 | `/contacts` | `/api/contacts` | 일정·연락처·할 일 | 켜짐 |
| `tasks` | 할 일 | `/tasks` | `/api/tasks` | 일정·연락처·할 일 | 켜짐 |
| `wiki` | 위키 | `/wiki` | `/api/wiki` | 문서 편집·위키·게시판 | 켜짐 |
| `board` | 게시판 | `/board` | `/api/board` | 문서 편집·위키·게시판 | 켜짐 |
| `meetings` | 화상회의 | `/meetings` | `/api/meetings` | 회의 | 켜짐 |
| `git` | Git | `/code` | `/api/git` | 코드 저장소 | 켜짐 |
| `ai` | AI | `/ai` | `/api/ai` | AI 도우미 | **꺼짐** — AI 제공자를 설정한 뒤 켠다 |
| `rbi` | 격리 브라우저 | `/rbi` | `/api/rbi` | 격리 브라우저(애드온) | **꺼짐** — [rbi.md](rbi.md) |

정본은 `backend/app/modules/registry.py`(`BUILTIN_MODULES`)이고, 어느 모듈이 어느 구역 것인지는 `backend/app/zones.json` 의 `modules` 가 정한다.
문서 편집(`/api/wopi`)은 따로 켜고 끄는 모듈이 아니라 "문서 편집·위키·게시판" 구역이 설치돼 있으면 파일 화면 안에서 동작한다.

## 모듈 상태

- 저장: `system_settings` 테이블의 `module.<id>.enabled`(값 `true`/`false`). 관리 › 모듈·플러그인의 스위치가 이 값을 바꾼다.
- 반영: 서버를 다시 시작하지 않아도 된다. 모듈 목록 응답(`GET /api/platform/modules`)은 Redis 에 60초 캐시되고 스위치를 누르면 바로 비워진다.
- 설치되지 않은 구역의 모듈은 DB 에 켜짐으로 남아 있어도 목록에서 빠지고 늘 꺼진 것으로 본다(`JW_ZONES` 환경변수 — 비어 있으면 모든 구역).
- 그룹 권한: 관리 › 그룹에서 모듈을 특정 그룹에만 줄 수 있다. 아무 그룹에도 주지 않은 모듈은 모두가 쓴다. 플러그인 모듈도 같다.

### 백엔드 가드

`@require_module` 데코레이터가 꺼진 모듈의 API 를 막는다.

```python
from app.modules.registry import require_module

@router.get("/mailboxes")
@require_module("mail")
async def list_mailboxes(...):
    ...
```

꺼진 모듈의 API 를 부르면:

```json
HTTP 403
{"detail": "이 기능은 비활성화되어 있습니다"}
```

### 프런트엔드 가드

- 내비게이션: `usePlatform()`(`frontend-react/src/composables/usePlatform.ts`)이 `/api/platform/modules` 에서 모듈·플러그인 목록을 받아
  사이드바와 모바일 탭바를 그린다. 플러그인은 manifest `order` 순으로 내장 모듈 뒤에 놓인다.
- 페이지: `frontend-react/src/router/guards.ts` 가 화면을 옮길 때마다 로그인 → 초기 설정 → 모듈 순으로 검사해, 꺼진 모듈의 화면은 대시보드(`/`)로 돌려보낸다.
  컴포넌트 밖에서는 `isModuleEnabled(id)`.

---

## 플러그인

플러그인은 **폴더 하나**다. 백엔드가 뜰 때 폴더를 읽어 API 를 붙이고, 프런트는 화면을 열 때 그 플러그인의 번들을 내려받아 그린다.
그래서 워크스페이스 프런트를 다시 빌드하지 않고 플러그인을 더하고 뺄 수 있다.

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

리포에는 견본 둘과 빌드 도구만 들어 있다(`.gitignore` 가 `plugins/` 아래 다른 폴더를 추적하지 않는다). 직접 만든 플러그인은 자기 저장소에서 관리한다.

백엔드가 플러그인을 찾는 곳은 두 군데다.

| 컨테이너 경로 | 무엇 | 지울 수 있나 |
|---|---|---|
| `/plugins` | 리포의 `plugins/` 폴더(읽기 전용 마운트) | 관리 화면에서는 못 지운다 |
| `/plugins-data` | 관리 화면에서 올린 플러그인(도커 볼륨 `ws-plugins-data`) | 관리 화면에서 지운다 |

같은 `id` 가 두 곳에 있으면 `/plugins` 것이 올라오고 다른 하나는 건너뛴다.

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
| `id` | O | 고유 ID(영문·숫자·`-`·`_`). 모듈 ID 로도 쓰인다 |
| `name` | O | 표시 이름 |
| `route` | O | 화면 경로. `/p/<id>` 로 둔다(호스트의 플러그인 화면이 `/p/<id>` 하나다) |
| `api_prefix` | O | API 접두사. 반드시 `/api/plugins/` 로 시작 |
| `name_en` · `version` · `description` · `author` · `icon` | X | 관리 화면과 내비게이션에 보이는 값. `icon` 은 호스트 아이콘 이름(없으면 `puzzle`) |
| `zones` | X | 이 플러그인이 기대는 **구역 id 목록**(`backend/app/zones.json` 의 id — `mail` `chat` `calendar` `docs` `meetings` `git` `ai` `sso` `rbi`). 하나라도 설치돼 있지 않으면 플러그인을 **아예 올리지 않는다** — 아래 설명 |
| `order` | X | 내비게이션과 관리 화면에서의 순서. 정수, 작을수록 위 |
| `fullscreen` | X | 화면 아래까지 자기 컨트롤로 쓰는 페이지 — 모바일 하단 탭바를 숨긴다(기본 false) |
| `requires` | X | 의존 모듈 ID 목록. 지금은 목록에 실리기만 하고 검사하지 않는다 — 구역 의존은 `zones` 로 적는다 |
| `frontend` · `frontend_api` | X | 적어 두는 값일 뿐 백엔드가 읽지 않는다. 프런트가 있는지는 `frontend/dist/plugin.mjs` 파일이 있는지로, 프런트 계약 버전은 번들을 보고 판정한다 |

**`zones`**: 플러그인이 다른 구역의 기능을 쓴다면(예: 견본 `remote-desktop` 은 화면 전송에 회의 구역의 LiveKit 을 쓴다 → `"zones": ["meetings"]`)
여기에 적는다. 백엔드는 뜰 때 설치된 구역(`JW_ZONES`)과 견줘, 빠진 구역이 있으면 그 플러그인의 라우터·모델·모듈을 올리지 않고 로그에
`필요한 구역이 설치되지 않아 건너뜀` 을 남긴다. 건너뛴 플러그인과 빠진 구역은 `GET /api/admin/plugins` 응답의 `skipped`
(`[{id, name, reason: "zone_not_installed", missing_zones}]`)에 실린다. 필드가 없거나 빈 배열이면 구역과 무관하게 올라온다.

**`order`**: `order` 가 있는 플러그인이 먼저(작은 순), 없는 플러그인은 그 뒤에 폴더 이름순으로 온다. 같은 값끼리도 폴더 이름순.
정수가 아니면(`"1"`, `1.5`, `true`) 경고 로그를 남기고 없는 것으로 친다. 사이에 끼울 자리를 남기려면 10 단위로 매긴다.
내장 모듈의 순서는 바뀌지 않고, 백엔드가 라우터를 붙이는 순서도 늘 폴더 이름순이다.

### 백엔드

`backend/router.py` 가 `router`(FastAPI `APIRouter`)를 내놓으면 manifest 의 `api_prefix` 아래에 붙는다.

```python
from fastapi import Depends
from app.plugins.sdk import APIRouter, get_current_user, get_db, User

router = APIRouter()

@router.get("")
async def list_items(user: User = Depends(get_current_user)):
    ...
```

`app.plugins.sdk` 는 자주 쓰는 것을 모아 다시 내보낸다: `APIRouter` · `get_current_user` · `get_db` · `require_module` · `register_tool` · `User`.
플러그인 코드는 `app.*` 의 무엇이든 import 할 수 있다 — 그만큼 코어가 바뀌면 깨질 수 있다.

- **모델**: `backend/models.py` 가 있으면 라우터보다 먼저 `plugin_<id>_models` 라는 모듈 이름으로 불러온다(`id` 의 `-` 도 그대로).
  라우터에서는 `from plugin_notes_models import Note` 처럼 가져온다.
- **테이블**: 코어는 플러그인 테이블을 만들어 주지 않는다. 견본처럼 플러그인 전용 `DeclarativeBase` 를 두고 첫 요청 때
  `create_all` 을 직접 부른다. 열을 바꾸는 마이그레이션도 플러그인 몫이다.
- **꺼짐 검사**: 관리자가 플러그인을 꺼도 라우터는 붙어 있다. 각 엔드포인트에서 `@require_module("<id>")` 또는 `is_module_enabled("<id>")` 로 막는다(견본 참고).
- **이름 겹침**: 테이블은 `plugin_<이름>_…` 처럼 접두사를 붙여 코어·다른 플러그인과 겹치지 않게 한다.

#### 라이프사이클 훅 (선택)

`backend/router.py` 에 아래 이름의 함수가 있으면 불린다. 인자는 DB 세션 하나, 동기·비동기 모두 된다. 훅이 실패하면 로그만 남고 계속 진행한다.

| 훅 | 시점 |
|----|------|
| `on_install(db)` | 처음 올라올 때 한 번(`system_settings` 의 `plugin.<id>.installed` 로 기억). 다시 올리면 다시 불린다 |
| `on_enable(db)` | 관리자가 켤 때 |
| `on_disable(db)` | 관리자가 끌 때 |
| `on_uninstall(db)` | 관리 화면에서 지울 때 — 테이블·파일 정리는 여기서 |

#### AI 도구 등록 (선택)

플러그인이 AI 도구를 등록하면 내장 AI 와 외부 MCP 커넥터([CONNECTOR.md](CONNECTOR.md))가 같은 관문을 거쳐 부른다.

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

- `backend/router.py`(또는 `models.py`)를 읽는 동안 부른 `register_tool` 은 도구를 **그 플러그인의 모듈**(manifest 의 `id`)에 묶는다 —
  접근 판정의 표 `TOOL_MODULE`(`backend/app/mcp/access.py`)에 `도구 → 플러그인 id` 가 들어간다. 판정은 내장 도구와 같다:
  플러그인이 꺼져 있거나, 사용자의 그룹에 그 플러그인 권한이 없거나, 사용자 없이 부르는 호출이면 보이지도 불리지도 않는다.
  외부 AI 제공자로 내용이 나가는 것을 막는 관리자 정책·사용자 동의에서는 개인 데이터를 다루는 도구로 취급한다.
- 도구 이름은 전체에서 하나다. 내장 도구나 다른 플러그인이 이미 쓰는 이름이면 등록하지 않고 `False` 를 돌려주며 로그에 남긴다 —
  이름 앞에 플러그인 id 를 붙인다(`myplugin_…`).
- 플러그인을 올리다 실패하면(라우터를 읽지 못함 등) 그 플러그인이 등록한 도구도 함께 걷어 낸다.
- 표에 없는 도구는 노출되지 않는다는 규칙은 그대로다. 플러그인을 읽는 중이 아닐 때(요청 처리 중 등) 부른 `register_tool` 은
  모듈에 묶이지 않아 어디에도 보이지 않는다 — 도구는 모듈을 읽을 때 등록한다.
- `register_tool` 로 등록한 도구는 읽기 도구(`mcp:read`)다. 쓰기 도구(승인 절차를 거치는 `mcp:write`)나, 결과를 "믿을 수 없는 외부 내용"으로
  감싸는 표시(`untrusted_output`)가 필요하면 `app.mcp.server` 의 `Tool`·`register` 를 직접 쓰고 `TOOL_MODULE` 에도 직접 넣는다.

### 프런트엔드

프런트 번들은 호스트(`frontend-react`)와 **따로 빌드한 ES 모듈 파일 하나**(`frontend/dist/plugin.mjs`)다. 계약은 두 가지이고 호스트가 번들을 보고 알아서 고른다.

| 계약 | 소스 | 프레임워크를 받는 곳 | 호스트 API 를 받는 법 | 견본 |
|---|---|---|---|---|
| **v2 (React)** — 새 플러그인은 이것으로 | `frontend/page.tsx` | `window.__REACT__` · `window.__REACT_DOM__` · UI 키트 `window.__WS_UI__` | props `pluginApi` | `plugins/remote-desktop` |
| **v1 (Vue)** | `frontend/page.vue` | `window.__VUE__` — 호스트가 이 계약의 플러그인을 열 때만 Vue 런타임을 내려받는다 | `inject('pluginApi')` | `plugins/sample-notes` |

- v2 작성법·`pluginApi` 표·UI 키트·빌드 설정: [frontend-react/docs/plugin-v2.md](../frontend-react/docs/plugin-v2.md)
- 두 계약에 공통인 제약(스타일·캐싱·상단바 버튼과 제목): [plugin-frontend.md](plugin-frontend.md)

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

v2(React) — 공용 빌드 스크립트가 없다. 플러그인이 자기 빌드 스크립트를 둔다. 견본:

```bash
cd frontend-react && npm install      # 견본 스크립트가 여기의 esbuild·typescript 를 빌려 쓴다
node plugins/remote-desktop/frontend/build.mjs     # 리포 루트에서
```

어느 쪽이든 결과는 `plugins/<폴더>/frontend/dist/plugin.mjs` 하나다(코드 분할 없음, CSS 는 JS 안에). 프레임워크는 번들에 넣지 않고
호스트 전역에서 꺼내 쓰도록 바꾼다 — v1 은 `vue` → `window.__VUE__`, v2 는 `react`·`react-dom`·`@jw/ui` → `window.__REACT__`·`__REACT_DOM__`·`__WS_UI__`.
`build-all.mjs` 는 `page.vue` 가 없는 플러그인(v2)을 건너뛴다.

### 번들이 서빙되는 길

```
GET /api/plugin-assets/{plugin_id}/bundle.mjs      # 로그인 없이 받을 수 있는 정적 파일
```

호스트의 `frontend-react/src/plugins/pluginHost.tsx`(화면은 `src/pages/p/[id].tsx`)가 이 주소를 동적 `import()` 로 불러온다.
백엔드가 ETag 와 `If-None-Match` 를 처리하므로 주소에 버전 꼬리표를 붙이지 않는다 — 다시 열면 304, 새로 빌드하면 자동으로 새 번들.
번들에 비밀값을 넣지 않는다(누구나 받을 수 있다).

---

## 플러그인 설치

### 관리 화면에서 올리기

관리 › 모듈·플러그인에서 패키지(.zip)를 올린다.

```
패키지(.zip) — 맨 위 또는 폴더 하나 안에:
  manifest.json            (필수)
  backend/router.py        (필수)
  backend/models.py        (선택)
  frontend/dist/plugin.mjs (화면이 있는 플러그인 — 빌드 산출물을 넣는다. 서버는 빌드하지 않는다)
```

1. 검사: zip 크기(100MB 이하)·풀었을 때 크기(300MB 이하)·항목 수, `manifest.json` 의 `id`·`route`·`api_prefix`, `backend/router.py` 가 있는지.
2. `/plugins-data/<id>/` 에 푼다. 같은 `id` 가 이미 있으면 덮어쓴다.
3. **백엔드가 스스로 다시 시작한다**(약 20초 — 그동안 워크스페이스 전체의 API 가 잠깐 끊긴다). 백엔드는 워커 여러 개로 돌아서, 모든 워커가 새 플러그인을 읽게 하려면 재시작이 필요하다.
4. 다시 뜨면 플러그인이 올라오고(`on_install`) 내비게이션에 나타난다.

지우기도 같은 화면에서 한다(올려서 설치한 것만). `on_uninstall` 을 부르고 폴더를 지운 뒤 백엔드가 다시 시작한다.

검사는 **형식만** 본다. 코드가 무엇을 하는지는 보지 않는다. `zones` 도 올릴 때는 검사하지 않고, 다시 뜰 때 빠진 구역이 있으면 조용히 건너뛴다 —
올렸는데 나타나지 않으면 백엔드 로그(`[Plugins]`)나 `GET /api/admin/plugins` 의 `skipped` 를 본다.

API: `GET /api/admin/plugins` · `POST /api/admin/plugins/install`(multipart `file`) · `PATCH /api/admin/plugins/{id}` `{enabled}` · `DELETE /api/admin/plugins/{id}`. 모두 관리자 전용.

### 폴더로 두기

서버에 손이 닿으면 리포의 `plugins/<폴더>/` 에 직접 둔다.

```
1. plugins/<폴더>/ 에 manifest.json · backend/ · frontend/ 를 둔다
2. 프런트를 빌드한다(위 "빌드")
3. docker compose restart backend
```

---

## 보안 모델

플러그인은 **신뢰 경계 안쪽**이다. 설치한 순간 그 코드는 워크스페이스 자신이 된다.

- 백엔드 코드(`backend/*.py`)는 백엔드 프로세스에 import 되어 **같은 권한**으로 돈다. 모든 사용자의 메일·파일·채팅이 있는 데이터베이스,
  저장소 볼륨, `.env` 의 비밀값, 그리고 백엔드에 마운트된 도커 소켓에 닿는다 — 사실상 서버 호스트 권한이다.
- import 되는 순간 실행된다. 관리 화면에서 플러그인을 "꺼도" 코드는 내려가지 않는다(끄는 것은 화면과, 플러그인이 스스로 검사하는 API 뿐이다).
  내리려면 지우고 백엔드를 다시 시작한다.
- 프런트 번들은 워크스페이스 화면과 **같은 출처**에서 돈다. 화면을 연 사용자의 권한으로 모든 API 를 부를 수 있다.
- 격리(샌드박스)·권한 선언·서명 검사·코드 심사는 없다. 올릴 때의 검사는 형식과 크기뿐이다.
- 설치·삭제는 관리자만 할 수 있다. 따라서 **관리자 계정이 넘어가면 서버가 넘어간다** — 관리자 계정에는 2단계 인증을 건다.

그래서: 출처를 아는 플러그인만, 가능하면 코드를 읽고 설치한다. 다른 사람이 만든 플러그인을 받아 쓰는 구조를 운영한다면 코드 심사를 직접 해야 한다.
취약점 신고는 리포 루트의 `SECURITY.md`.
