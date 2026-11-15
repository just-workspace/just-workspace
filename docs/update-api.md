# 업데이트 내부 API — 계약

설치된 서버의 업데이트는 **설치 관리자**가 한다(설치 뒤에도 컨테이너로 남아 내부 API 8444 를 연다 — [installer.md](installer.md) 5·6절).
이 문서는 그 업데이트 엔진이 열 내부 API(`/internal/update/*`)와, backend·nginx·화면이 그것과 맞물리는 자리를 정한다.

> **상태.** 업데이트 엔진은 아직 없다. 이 문서는 엔진을 구현할 때의 기준이고, backend 의 대신 부르기(`backend/app/system/update_router.py`)와 관리 › 업데이트 화면은 이 계약에 맞춰 이미 만들어져 있다(가짜 응답으로 검증). 실제 엔진과 붙여 확인한 것은 없다. nginx 쪽 설정(7절)도 적어만 두었고 넣지 않았다.

관련 문서: 채널·릴리스 목록의 형식과 검증([releases.md](releases.md)), 스키마 버전·백업·복원([data-safety.md](data-safety.md)).

## 1. 확정된 동작

- 제품 전체가 한 버전이다. 채널은 `stable` / `beta`. Beta 채널은 Stable 릴리스도 받는다.
- 적용 방식은 수동(기본) / 자동. 자동은 적용 시간대(기본 03:00~05:00, 서버 시간) 안에서, **나온 지 3일 지난 릴리스만** 적용한다.
- 적용 순서(단계 id 는 고정): `preflight`(사전 점검) → `backup`(자동 백업) → `pull`(이미지 받기) → `migrate`(DB 변경) → `switch`(구역 교체) → `verify`(상태 확인).
  단계 상태는 `pending` / `running` / `done` / `failed` 넷뿐이다.
- 자동 백업은 `pre-update` 종류다 — DB + 설정 + 암호화 키. **파일은 백업하지 않고 되돌리지도 않는다.**
- 실패했을 때
  - `migrate` **이전** 단계(`preflight`·`backup`·`pull`)에서 실패: 작업이 멈추고 관리자가 "이 단계부터 다시"(`retry`)와 "되돌리기"(`rollback`) 중 고른다.
  - `migrate` 부터(`migrate`·`switch`·`verify`) 실패: 선택 없이 자동 되돌림 — 이전 이미지로 + DB 는 직전 백업 복원.
  - **자동 업데이트**는 어느 단계든 자동 되돌림. 그 뒤 자동 업데이트는 멈추고(`auto.paused`), 관리자가 "다시 켜기"를 눌러야 다음 시간대부터 다시 시도한다.
- 중간 버전: 목표까지 거쳐야 하는 버전이 있으면 한 번의 확인으로 이어서 진행한다. 버전마다 백업하고 버전마다 여섯 단계를 처음부터 돈다.
- Stable 로 돌아오기: 채널만 바꾸면 Stable 의 최신이 현재 버전 이상이 될 때까지 기다린다(`available.state = "wait"`). "시험판 이전 상태로 복원"(Beta 로 올리기 직전에 따로 보관한 백업)도 된다.
- 호환이 확인되지 않은 플러그인은 업데이트 뒤 꺼진 채로 시작한다.
- 사전 예고: 수동 업데이트·수동 복원을 시작하면 5분 카운트다운 뒤에 시작한다. 관리자는 "지금 바로 시작"·"취소"를 할 수 있다. 자동 업데이트도 시작 5분 전에 카운트다운을 연다. 카운트가 끝나면 점검 상태다.
- 오프라인: 묶음 파일을 올리거나 서버에 있는 경로를 지정 → 서명·버전 검증 → 추가로 필요한 이미지를 모두 갖춤 → 적용.
- 기록은 1년 보관한다.

## 2. 공통

- 주소: `http://jw-installer:8444`. 워크스페이스 내부망에서만 닿는다(호스트에 게시하지 않는다).
- 인증: 기존 내부 API 와 같다 — 공유 키(`X-JW-Installer-Key`) **그리고** 내부 대역의 출발지. 아니면 `404`. 예외는 키 없이 열리는 `GET /internal/update/maintenance` 하나다(7절).
- 오류 응답: `{"code": "…", "vars": {…}}`. 화면은 `code` 로 문구를 고른다.
- 시각: UTC, `YYYY-MM-DDTHH:MM:SSZ`. 화면이 브라우저 시간대로 바꿔 보인다. 적용 시간대(`window`)만 서버 시간의 `HH:MM` 이다.
- 용량은 바이트(정수), 시간은 초(정수).
- 바꾸는 요청은 본문에 `actor` 를 실어 보낸다: `{"id": "<사용자 id>", "name": "<표시 이름>"}`. 엔진은 기록의 "누가"에 쓴다. 자동 업데이트의 `actor` 는 `null`.
- 한 번에 한 작업만 돈다. 구역 작업(켜기·끄기)과도 겹치지 않는다 — 겹치면 `409 busy`.
- 엔진의 상태(설정, 작업, 기록, 오프라인 준비물)는 설치 관리자의 상태 폴더에 남아 설치 관리자·backend 가 다시 떠도 이어진다.

공통 오류 코드:

| 상태 | code | 뜻 |
|---|---|---|
| 404 | `not_found` | 키가 다르거나 내부 대역 밖(이유를 숨긴다) |
| 404 | `job_unknown` · `restore_point_unknown` · `history_unknown` · `image_unknown` | 없는 대상 |
| 409 | `busy` | 다른 작업이 진행 중. `vars.job` = 그 작업 id |
| 409 | `action_not_allowed` | 지금 상태에서 할 수 없는 제어. `vars.status`, `vars.allowed[]` |
| 409 | `not_available` | 받을 버전이 없다(또는 대기·막힘 상태) |
| 409 | `target_stale` | 화면이 본 목표와 지금의 목표가 다르다. `vars.target` = 지금의 목표 |
| 409 | `offline_incomplete` | 묶음이 검증되지 않았거나 필요한 이미지가 빠졌다. `vars.blockers[]` |
| 409 | `restore_point_missing` | 시험판 이전 백업이 없다 |
| 409 | `not_installed` | 설치가 끝나지 않은 설치 관리자 |
| 413 | `too_large` | 올린 파일이 상한을 넘는다. `vars.limit` |
| 422 | `settings_invalid` | `vars.errors[] = {"field", "code"}` |
| 422 | `invalid` | 본문 형식이 틀렸다. `vars.field` |
| 507 | `no_space` | 받을 자리가 모자란다. `vars.need`, `vars.free` |

## 3. 상태·확인·설정

### `GET /internal/update/status`

```json
{
  "current": {"version": "1.0.0", "channel": "stable", "applied_at": "2026-01-10T18:02:11Z", "previous_version": null},
  "settings": {"mode": "manual", "window": {"start": "03:00", "end": "05:00"}, "channel": "stable", "min_age_days": 3},
  "check": {"state": "idle", "last_at": "2026-01-12T00:00:04Z", "ok": true, "error": null},
  "available": {"state": "none"},
  "job": null,
  "auto": {"paused": false, "paused_at": null, "reason": null},
  "last_auto": null,
  "server_time": "2026-01-12T01:23:45Z"
}
```

| 항목 | 뜻 |
|---|---|
| `current.channel` | 지금 설치된 버전이 속한 채널(버전 글자에 `-beta.N` 이 있으면 `beta`) |
| `current.previous_version` | 바로 전 버전(없으면 `null`) |
| `settings` | 4절의 설정과 같은 값 |
| `check.state` | `idle` / `checking` |
| `check.ok` · `check.error` | 마지막 확인의 성패. 실패면 `error = {"code", "detail"}` — code: `channel_unreachable`(연결 실패), `channel_invalid`(서명·형식·만료·순번 — releases.md 의 `VerifyError` 종류), `manifest_invalid` |
| `available` | 받을 수 있는 버전(아래) — 마지막으로 **성공한** 확인의 결과다. 확인이 실패해도 지우지 않는다 |
| `job` | 진행 중이거나 관리자의 선택을 기다리는 작업(5절의 작업 모양 그대로). 없으면 `null` |
| `auto.paused` | 자동 업데이트가 실패 뒤 멈춰 있는가. `reason = {"job", "step", "version"}` |
| `last_auto` | 마지막 자동 업데이트의 결과: `{"job", "result", "version", "from_version", "finished_at", "downtime_seconds", "failed_step"}`. `result` 는 6절 기록의 값. 없으면 `null` |

`available` 은 `verify.plan_update()` 의 결과와 일대일이다:

| `state` | `plan_update` | 내용 |
|---|---|---|
| `none` | `current` | 최신이다 |
| `update` | `update` | 아래 표 |
| `wait` | `wait` | `{"state": "wait", "channel_latest": "1.1.4", "resume_from": "1.2.0"}` — 채널의 최신이 현재보다 낮다. `resume_from` 은 다시 받기 시작하는 가장 낮은 버전(현재가 `X.Y.Z-beta.N` 이면 `X.Y.Z`) |
| `blocked` | `blocked` | `{"state": "blocked", "version": "2.0.0", "reason": {"code": "no_upgrade_path", "vars": {"min_upgrade_from": "1.5.0"}}}` |

`state = "update"`:

```json
{
  "state": "update",
  "version": "1.2.0",
  "channel": "stable",
  "published": "2026-01-08T09:00:00Z",
  "summary": "요약 한 줄",
  "path": ["1.1.0", "1.2.0"],
  "download_bytes": 1288490188,
  "downtime_seconds": 240,
  "zones": [{"id": "core", "name": {"ko": "기본", "en": "Core"}}, {"id": "mail", "name": {"ko": "메일", "en": "Mail"}}],
  "plugin_warnings": [{"id": "sample-plugin", "name": "Sample", "reason": "unverified"}],
  "changelog": "- 변경 1\n- 변경 2",
  "auto_eligible_at": "2026-01-11T09:00:00Z"
}
```

| 항목 | 뜻 |
|---|---|
| `path` | 차례로 설치할 버전(마지막이 `version`). 길이 1 이면 한 번에 간다 |
| `download_bytes` | 경로 전체에서 새로 받아야 하는 이미지의 합(이미 있는 계층 제외는 엔진 재량 — 모르면 `null`) |
| `downtime_seconds` | 예상 중단 시간(경로 전체). 모르면 `null` |
| `zones` | 이미지가 바뀌는 구역 중 **켜진** 것. 이름은 `zones.json` 의 것 |
| `plugin_warnings` | 새 버전과 맞는지 확인되지 않은 플러그인 — 업데이트 뒤 꺼진 채로 시작한다 |
| `changelog` | manifest 의 변경 내용(마크다운). 경로에 중간 버전이 있어도 목표 버전의 것 |
| `auto_eligible_at` | 자동 적용이 받기 시작하는 때(`published` + `min_age_days`) |

### `POST /internal/update/check`

지금 채널을 받아 확인한다. `202` + 위 상태(`check.state = "checking"`). 끝나면 `check`·`available` 이 바뀐다 — 화면은 상태를 다시 읽는다. 작업이 도는 중이면 `409 busy`.

### 적용된 버전의 변경 내용 — `GET /internal/update/releases/<버전>`

```json
{"version": "1.0.0", "channel": "stable", "published": "…", "changelog": "- …", "applied_at": "…", "trigger": "auto",
 "downtime_seconds": 212, "previous_version": "0.9.4", "disabled_plugins": [{"id": "sample-plugin", "name": "Sample"}]}
```

지금 설치된 버전과 기록에 남은 버전만 답한다(그 밖은 `404 history_unknown`). `applied_at` 이하는 그 버전을 적용한 기록이 있을 때만.

## 4. 설정

### `GET /internal/update/settings`

```json
{
  "mode": "manual",
  "window": {"start": "03:00", "end": "05:00"},
  "channel": "stable",
  "min_age_days": 3,
  "beta": {"since": null, "restore_point": null}
}
```

`beta.since` 는 Beta 채널로 바꾼 시각, `beta.restore_point` 는 그 직전에 보관한 백업(`{"id", "version", "created_at", "size_bytes"}`). Beta 를 쓴 적이 없거나 그 백업이 없으면 `null`.
`min_age_days` 는 읽기 전용이다(3).

### `PUT /internal/update/settings`

```json
{"mode": "auto", "window": {"start": "03:00", "end": "05:00"}, "channel": "beta", "stable_return": null, "actor": {"id": "…", "name": "…"}}
```

- 보낸 항목만 바뀐다. `window` 는 `HH:00` 꼴의 정시, `start ≠ end`. `start > end` 면 자정을 넘는 시간대다.
- `channel: "beta"` 로 바꾸면 **다음 확인부터** Beta 릴리스를 받는다. 그 뒤 Beta 버전으로 처음 올릴 때 엔진은 그 직전 백업을 "시험판 이전 백업"으로 따로 보관한다(보관 기한 없음 — Stable 로 돌아와 Stable 이 현재 버전 이상이 되면 지운다).
- `channel: "stable"` 로 돌아올 때 `stable_return` 을 같이 보낸다.
  - `"wait"`(기본): 채널만 바꾼다. 응답의 `effect.wait` 에 대기 내용이 온다.
  - `"restore"`: 시험판 이전 백업으로 복원하는 작업을 시작한다(카운트다운부터). 채널은 복원이 끝날 때 `stable` 이 된다. 백업이 없으면 `409 restore_point_missing`.

응답 `200`(복원을 시작했으면 `202`):

```json
{
  "settings": {"mode": "manual", "window": {"start": "03:00", "end": "05:00"}, "channel": "stable", "min_age_days": 3,
               "beta": {"since": "2026-01-02T03:04:05Z", "restore_point": {"id": "rp-beta", "version": "1.0.0", "created_at": "2026-01-02T03:04:00Z", "size_bytes": 73400320}}},
  "effect": {"channel": "to_stable_wait", "wait": {"channel_latest": "1.1.4", "resume_from": "1.2.0"}, "job": null}
}
```

`effect.channel`: `null`(채널 그대로) / `to_beta` / `to_stable_wait` / `to_stable_restore`(이때 `effect.job` 에 복원 작업). 오류: `422 settings_invalid`, `409 busy`, `409 restore_point_missing`.

## 5. 적용과 작업

### `POST /internal/update/apply`

```json
{"target": "1.2.0", "start": "countdown", "actor": {"id": "…", "name": "…"}}
```

- `target` 은 화면이 본 `available.version`. 지금의 것과 다르면 `409 target_stale`.
- `start`: `countdown`(기본 — 5분 예고 뒤 시작) / `now`(예고 없이).
- `202` + 작업. 오류: `409 busy` · `not_available` · `target_stale`.

### 작업

```json
{
  "id": "b7e2c1d09a4f5e63",
  "kind": "update",
  "trigger": "manual",
  "status": "running",
  "from_version": "1.0.0",
  "target_version": "1.2.0",
  "path": ["1.1.0", "1.2.0"],
  "version_index": 0,
  "countdown": null,
  "steps": [
    {"id": "preflight", "status": "done", "started_at": "…", "finished_at": "…", "detail": {}},
    {"id": "backup", "status": "done", "started_at": "…", "finished_at": "…", "detail": {}},
    {"id": "pull", "status": "running", "started_at": "…", "finished_at": null,
     "detail": {"images": [{"name": "frontend", "status": "done", "percent": 100},
                           {"name": "backend", "status": "pulling", "percent": 62},
                           {"name": "mailserver", "status": "pending", "percent": 0}]}},
    {"id": "migrate", "status": "pending"},
    {"id": "switch", "status": "pending"},
    {"id": "verify", "status": "pending"}
  ],
  "error": null,
  "choices": [],
  "rollback_job": null,
  "restore": null,
  "expected_seconds": 240,
  "started_at": "2026-01-12T01:30:00Z",
  "maintenance_started_at": "2026-01-12T01:35:00Z",
  "finished_at": null,
  "actor": {"id": "…", "name": "…"}
}
```

| 항목 | 뜻 |
|---|---|
| `kind` | `update` / `rollback`(실패한 업데이트를 되돌리는 작업) / `restore`(관리자가 고른 복원) |
| `trigger` | `manual` / `auto` / `offline` |
| `status` | `countdown`(예고 중) → `running` → `done`. 그 밖에 `failed`, `cancelled`(예고 중 취소) |
| `path` · `version_index` | 거칠 버전과 지금 몇 번째(0 부터)인가. `steps` 는 **지금 버전**의 단계다 — 다음 버전으로 넘어가면 전부 `pending` 으로 돌아간다 |
| `countdown` | `status = "countdown"` 일 때 `{"ends_at": "…", "seconds": 300}`. 그 밖엔 `null` |
| `steps[].detail.images` | `pull` 단계의 이미지별 진행. `status`: `pending`/`pulling`/`done`/`failed`, `percent` 0~100 |
| `error` | 실패했을 때 `{"step", "cause", "detail", "vars"}`. `cause` 는 문구 키, `detail` 은 원문 한 줄 |
| `choices` | 지금 관리자가 고를 수 있는 제어: `retry`, `rollback`. 자동 되돌림이면 빈 배열 |
| `rollback_job` | 이 업데이트를 되돌리는 작업의 id(되돌림이 시작됐을 때) |
| `restore` | `kind = "restore"` 일 때 `{"point": "<복원 지점 id>", "version": "1.0.0", "reason": "manual"}`. `reason`: `manual` / `beta`(시험판 이전 상태로) |
| `expected_seconds` | 예상 중단 시간 |
| `maintenance_started_at` | 점검이 시작된 시각(카운트다운이 끝난 때). 아직이면 `null` |

`kind` 가 `rollback`·`restore` 인 작업의 단계(id 고정): `stop`(구역 멈추기) → `images`(이전 이미지로 바꾸기) → `restore_db`(백업에서 DB 되돌리기) → `start`(구역 시작) → `verify`(상태 확인). `rollback` 은 `from_version` 이 실패한 목표 버전, `target_version` 이 돌아갈 버전이고 `parent_job` 에 되돌리는 업데이트 작업의 id 가 온다. `rollback`·`restore` 가 실패하면 `choices = ["retry"]` 뿐이다(워크스페이스는 멈춘 상태로 남는다). `error.vars.backup_location` 에 백업 파일의 위치를 싣는다.

실패 규칙(1절)과 작업 값의 대응:

| 경우 | 업데이트 작업 | 그 뒤 |
|---|---|---|
| 수동·오프라인, `migrate` 전 실패 | `status: "failed"`, `choices: ["retry", "rollback"]` | 관리자의 선택을 기다린다. 점검 상태는 유지 |
| 수동·오프라인, `migrate` 부터 실패 | `status: "failed"`, `choices: []`, `rollback_job` 채움 | 되돌림 작업이 바로 시작된다 |
| 자동, 어느 단계든 | 위와 같다 | 되돌림이 끝나면 `auto.paused = true` |

### `GET /internal/update/jobs/<id>`

위 작업. 끝난 작업도 기록 보관 기간 동안 같은 id 로 읽힌다.

### `POST /internal/update/jobs/<id>/action`

```json
{"action": "retry", "actor": {"id": "…", "name": "…"}}
```

| `action` | 할 수 있을 때 | 하는 일 |
|---|---|---|
| `start_now` | `status = "countdown"` | 예고를 끝내고 바로 시작 |
| `cancel` | `status = "countdown"` | 취소 — `status: "cancelled"`. 자동 업데이트의 예고를 취소하면 그 시간대는 건너뛴다(멈춤은 아니다) |
| `retry` | `choices` 에 있을 때 | 실패한 단계부터 다시. 같은 작업이 `running` 으로 돌아간다 |
| `rollback` | `choices` 에 있을 때 | 되돌림 작업을 만든다. 응답은 **업데이트 작업**(`rollback_job` 채움) |

할 수 없는 제어는 `409 action_not_allowed`.

### `GET /internal/update/jobs/<id>/log[?tail=N][&format=text]`

`{"lines": ["[pull] 시작", "…"]}`. `format=text` 면 `text/plain` 전체(내려받기용). 비밀값은 가린다.

### `POST /internal/update/auto/resume`

멈춘 자동 업데이트를 다시 켠다. `200` + `{"auto": {"paused": false, …}, "window": {"start": "03:00", "end": "05:00"}}`. 멈춰 있지 않아도 성공한다.

### 복원 지점

`GET /internal/update/restore-points`

```json
{"points": [{"id": "rp-20260110", "kind": "pre-update", "version": "1.0.0", "created_at": "2026-01-10T18:00:02Z", "size_bytes": 73400320}]}
```

새것부터. `kind`: `pre-update` / `pre-beta`. `version` 은 그 백업을 만들 때 설치돼 있던 버전(= 복원하면 돌아가는 버전).

`POST /internal/update/restore` `{"point": "rp-20260110", "start": "countdown", "actor": {…}}` → `202` + 작업(`kind: "restore"`). 오류: `404 restore_point_unknown`, `409 busy`.

## 6. 오프라인·기록·앱

### 오프라인

`GET /internal/update/offline`

```json
{
  "bundle": {
    "source": "upload", "filename": "just-workspace-1.2.0-offline.tar", "size_bytes": 2147483648,
    "state": "verified", "percent": 100,
    "version": "1.2.0", "current_version": "1.0.0",
    "contains": {"images": true, "apps": ["windows-desktop", "android"]},
    "downtime_seconds": 240, "error": null
  },
  "images": [
    {"id": "postgres", "name": {"ko": "데이터베이스", "en": "Database"}, "reason": "always", "zone": null, "zone_enabled": true,
     "state": "present", "command": "docker pull …@sha256:… && docker save … -o postgres.tar", "filename": "postgres.tar"},
    {"id": "onlyoffice", "name": {"ko": "문서 편집기", "en": "Document editor"}, "reason": "zone",
     "zone": {"id": "docs", "name": {"ko": "문서", "en": "Documents"}}, "zone_enabled": true,
     "state": "missing", "command": "…", "filename": "onlyoffice.tar"}
  ],
  "download_url": "https://…/just-workspace-1.2.0-offline.tar",
  "accept": ".tar",
  "ready": false,
  "blockers": ["images_missing"]
}
```

| 항목 | 값 |
|---|---|
| `bundle` | 없으면 `null` |
| `bundle.state` | `uploading`(올리는 중) / `verifying`(검증 중) / `verified` / `signature_mismatch` / `version_too_low` / `file_missing`(경로에 없거나 읽을 수 없다) / `invalid`(묶음이 아니거나 색인·해시가 어긋난다) |
| `bundle.percent` | `uploading`·`verifying` 의 진행(모르면 `null`) |
| `bundle.version` | 서명이 확인된 뒤에만(그 전엔 `null`) |
| `images[]` | 묶음에 들어 있지 않은 남의 구성 요소. 묶음이 `verified` 가 된 뒤에만 채운다(그 전엔 빈 배열) |
| `images[].reason` | `always`(데이터베이스·캐시·웹 서버) / `zone`(그 구역의 구성 요소) |
| `images[].state` | `present`(있음) / `missing`(없음) / `verifying`(검증 중) / `hash_mismatch`(해시 불일치) / `not_needed`(꺼진 구역의 것) |
| `images[].command` | 인터넷이 되는 PC 에서 그 이미지를 파일로 받는 명령 |
| `download_url` | 묶음 파일을 받는 주소(설정값 — 없으면 `null`) |
| `ready` | 적용할 수 있는가: 묶음이 `verified` 이고 `not_needed` 가 아닌 이미지가 전부 `present` |
| `blockers` | `bundle_missing` / `bundle_not_verified` / `bundle_rejected` / `images_missing` / `images_verifying` / `images_mismatch` |

검증 순서는 [releases.md](releases.md) 의 오프라인 묶음 절과 같다(묶음 서명 → manifest → 파일별 해시). 버전은 `plan_update` 와 같은 기준으로 본다 — 현재보다 높지 않으면 `version_too_low`, 한 번에 갈 수 없으면 `invalid` + `error.code = "no_upgrade_path"`.

| 메서드·경로 | 하는 일 |
|---|---|
| `POST /internal/update/offline/bundle` | 묶음 올리기. 본문은 파일 그대로(`application/octet-stream`), 파일 이름은 `X-JW-Filename`(URL 인코딩). 다 받으면 `202` + 위 상태(`verifying`) — 검증은 뒤에서 돈다. 받는 동안 다른 조회에는 `uploading` 으로 보인다 |
| `POST /internal/update/offline/bundle-path` `{"path"}` | 서버에 있는 파일 지정. 설치 관리자 컨테이너에서 보이는 경로여야 한다(3절 [installer.md](installer.md) — 호스트의 설치 폴더가 `/data` 로 붙는다). `202` + 상태(`verifying`). 없거나 못 읽으면 `200` + `bundle.state = "file_missing"` |
| `DELETE /internal/update/offline/bundle` | 준비물을 비운다(올리는 중이면 중단) |
| `POST /internal/update/offline/images/<id>` | 이미지 파일 올리기(본문은 파일 그대로). `202` + 상태(그 줄이 `verifying`) |
| `POST /internal/update/offline/apply` `{"start", "actor"}` | 적용 시작 → `202` + 작업(`trigger: "offline"`). `ready` 가 아니면 `409 offline_incomplete` |

오프라인 적용의 `pull` 단계는 내려받는 대신 묶음과 올린 파일을 `docker load` 한다(단계 id 는 같다).

### 기록

`GET /internal/update/history[?limit=50][&before=<id>]`

```json
{"items": [{"id": "b7e2c1d09a4f5e63", "kind": "update", "trigger": "auto", "version": "1.2.0", "from_version": "1.1.0",
            "result": "rolled_back", "started_at": "…", "finished_at": "…", "duration_seconds": 412, "downtime_seconds": 388,
            "actor": null}],
 "retention_days": 365, "more": false}
```

`result`: `success` / `rolled_back`(실패 뒤 되돌림 성공) / `rollback_failed`(되돌림도 실패) / `restored`(복원) / `restore_failed` / `cancelled`. 되돌림 작업은 따로 줄을 만들지 않고 그 업데이트의 줄에 붙는다. `actor` 가 `null` 이면 자동.

`GET /internal/update/history/<id>` — 그 줄 + 단계별 기록:

```json
{"id": "…", "…": "…",
 "versions": [{"version": "1.2.0", "steps": [
   {"id": "preflight", "status": "done", "duration_seconds": 4, "note": null},
   {"id": "migrate", "status": "failed", "duration_seconds": 31, "note": "…오류 한 줄…"},
   {"id": "switch", "status": "pending", "duration_seconds": null, "note": null}]}],
 "rollback": {"result": "done", "steps": [{"id": "stop", "status": "done", "duration_seconds": 6, "note": null}]}}
```

기록 내려받기는 `GET /internal/update/jobs/<id>/log?format=text`.

### 앱

`GET /internal/update/apps`

```json
{"version": "1.0.0", "download_page": "/settings/apps",
 "apps": [{"kind": "windows-desktop", "version": "1.0.0", "filename": "JustWorkspace-Setup-1.0.0.exe", "size_bytes": 98566144, "url": "/downloads/JustWorkspace-Setup-1.0.0.exe"}]}
```

manifest 의 `apps[]` 에 실린 것만 온다 — **빈 배열일 수 있다.** `kind`: `windows-desktop` / `android`. `url` 은 로그인한 브라우저가 열 수 있는 주소(같은 출처의 경로 또는 전체 주소). `download_page` 는 사용자에게 알릴 화면 경로(없으면 `null`).

## 7. backend 가 내려가 있는 동안

`switch` 단계는 backend 컨테이너를 바꾼다. 그동안 backend 의 대신 부르기는 답하지 못한다. 진행 화면과 점검 화면을 어떻게 살릴지의 선택지:

| | 방식 | 장점 | 단점 |
|---|---|---|---|
| A | nginx 가 진행 조회 전체를 설치 관리자로 넘긴다(읽기 전용) | 관리자가 끊김 없이 단계를 본다 | 인증 없이 열리는 조회에 버전·단계·오류가 실린다. 관리자만 보게 하려면 backend 없이 세션을 확인할 방법이 필요하다 |
| B | backend 를 맨 마지막에 바꾸고, 끊긴 사이는 "다시 연결 중" | 새로 여는 것이 없다 | 일반 사용자의 점검 화면이 뜰 근거가 없다(무엇이 진행 중인지 물을 곳이 없다) |
| **C(권장)** | B + **공개 점검 상태 하나**만 nginx 가 설치 관리자로 넘긴다 | 여는 것은 "점검 중인가"뿐. 일반 사용자의 점검 화면과 관리자의 재연결이 같은 조회를 쓴다 | 관리자는 backend 가 내려간 1~2분 동안 단계 진행을 못 본다(마지막으로 본 상태 + "다시 연결 중") |

**권장안 C 를 계약으로 한다.**

1. 엔진은 `switch` 에서 **backend 를 맨 마지막에** 바꾼다. 작업 상태는 설치 관리자가 갖고 있으므로 backend 가 다시 뜨면 같은 작업 id 로 이어 읽힌다.
2. 관리자의 진행 화면은 1.5초마다 `GET /api/admin/system/update/jobs/<id>` 를 읽고, 실패하면 "다시 연결 중"으로 둔 채 계속 읽는다. 그 사이 공개 점검 상태가 `active: false` 가 되면(끝났다) 곧바로 작업을 한 번 더 읽어 결과를 보인다.
3. 일반 사용자의 화면은 API 호출이 실패하면(연결 실패·502·503·504) 공개 점검 상태를 물어, `active` 이면 점검 화면으로 바뀐다. `active: false` 가 되고 `/api/health` 가 답하면 화면을 새로 연다.
4. 새로 접속한 브라우저에는 nginx 가 정적 점검 페이지를 내준다(아래).

### 공개 점검 상태 — `GET /internal/update/maintenance` (키 없음)

```json
{"active": true, "phase": "running", "kind": "update", "started_at": "2026-01-12T01:35:00Z", "expected_seconds": 240,
 "countdown_ends_at": null, "contact": "내선 1234"}
```

| 항목 | 값 |
|---|---|
| `active` | 점검 중인가 — 카운트다운이 끝난 때부터 작업이 끝날 때까지(관리자의 선택을 기다리는 `failed` 와 되돌림 포함) |
| `phase` | `idle` / `countdown` / `running` |
| `kind` | `update` / `rollback` / `restore`. `idle` 이면 `null` |
| `started_at` | 점검이 시작된 시각 |
| `expected_seconds` | 예상 시간. 모르면 `null` |
| `countdown_ends_at` | `phase = "countdown"` 일 때 |
| `contact` | 관리자가 넣어 둔 연락처 한 줄. 없으면 `null` |

**버전·단계·오류·사용자 이름은 싣지 않는다.** 응답은 `Cache-Control: no-store`. 이 경로는 키를 요구하지 않지만 내부 대역 검사는 그대로다(바깥에서는 nginx 를 거쳐서만 닿는다).

연락처는 backend 가 관리자의 설정을 받아 `PUT /internal/update/maintenance/contact` `{"contact": "…" | null}`(키 필요, 200자 이하 한 줄)로 넘긴다.

### nginx 에 필요한 설정(넣지 않았다 — 엔진과 함께 넣는다)

```nginx
# 공개 점검 상태 — 이 경로 하나만, GET 만. 설치 관리자가 없는 설치에서도 nginx 가 뜨도록 런타임 resolve.
location = /maintenance/status {
    limit_except GET { deny all; }
    limit_req zone=api burst=20 nodelay;
    set $jw_installer http://jw-installer:8444;
    proxy_pass $jw_installer/internal/update/maintenance;
    proxy_connect_timeout 3s;
    proxy_read_timeout 5s;
    add_header Cache-Control "no-store" always;
}

# 정적 점검 페이지 — frontend 컨테이너가 아니라 nginx 가 직접 가진 파일이어야 한다(frontend 도 바뀌는 중일 수 있다).
location = /maintenance.html {
    root /etc/nginx/static;
    add_header Cache-Control "no-store" always;
}

# 화면(문서) 요청이 502·503·504 로 끝나면 점검 페이지를 그 주소 그대로 내준다. /api/ 에는 걸지 않는다 —
# 앱은 API 의 실패 상태를 보고 스스로 점검 상태를 묻는다.
location / {
    # …기존 내용…
    proxy_intercept_errors on;
    error_page 502 503 504 =503 /maintenance.html;
}
```

- `frontend-react/public/maintenance.html` 이 그 정적 페이지다. 엔진(또는 설치 단계)이 이 파일을 nginx 가 직접 읽는 자리(`/etc/nginx/static/`)에 놓는다. 페이지는 `/maintenance/status` 를 5초마다 묻고, 점검이 끝나고 `/api/health` 가 답하면 같은 주소를 다시 연다. 스크립트가 막혀도 30초마다 새로 고친다.
- 묶음 올리기는 크다. `location = /api/admin/system/update/offline/bundle` 과 `…/offline/images/` 에 `client_max_body_size 0; proxy_request_buffering off; proxy_read_timeout 3600s;` 가 필요하다(앞단 프록시가 있으면 거기도). 그렇지 않으면 413 이다 — 그런 설치는 "서버에 있는 파일 경로" 방식을 쓴다.
- 점검 중 쓰기 차단: 백업을 뜬 뒤의 변경은 되돌림 때 사라진다. 그래서 점검이 시작되면(`backup` 전에) 일반 사용자의 요청을 막아야 한다. 권장은 엔진이 nginx 를 점검 모드로 바꾸는 것이다 — 관리자의 진행 화면이 쓰는 경로(`/api/auth/`, `/api/admin/system/update/`, `/api/system/update-notice`, 정적 자산, `/maintenance/status`)만 통과시키고 나머지 `/api/` 는 `503 {"code": "maintenance"}`. **이 부분은 정해지지 않았다**(8절).

## 8. backend 쪽 — 이미 있는 것

### 관리자용 대신 부르기 `/api/admin/system/update/*`

관리자만. 경로는 내부 API 에서 `/internal/update` 를 `/api/admin/system/update` 로 바꾼 것과 같고, 본문에 `actor` 를 채워 넘긴다.

| backend | 내부 API | 감사 로그 |
|---|---|---|
| `GET /status` | `GET /status` | |
| `POST /check` | `POST /check` | |
| `GET /releases/<버전>` | 같음 | |
| `GET /settings` · `PUT /settings` | 같음 | `system.update.settings` |
| `POST /apply` | 같음 | `system.update.apply` |
| `GET /jobs/<id>` · `GET /jobs/<id>/log` | 같음 | |
| `GET /jobs/<id>/log/download` | `GET /jobs/<id>/log?format=text` | |
| `POST /jobs/<id>/action` | 같음 | `system.update.start_now` · `.cancel` · `.retry` · `.rollback` |
| `POST /auto/resume` | 같음 | `system.update.auto_resume` |
| `GET /restore-points` · `POST /restore` | 같음 | `system.update.restore` |
| `GET /offline` · `POST /offline/bundle` · `POST /offline/bundle-path` · `DELETE /offline/bundle` · `POST /offline/images/<id>` · `POST /offline/apply` | 같음 | `system.update.offline_bundle` · `.offline_image` · `.offline_clear` · `.offline_apply` |
| `GET /history` · `GET /history/<id>` | 같음 | |
| `GET /apps` | 같음 | |
| `GET /contact` · `PUT /contact` | (DB 설정) + `PUT /maintenance/contact` | `system.update.contact` |

오류는 `{"code", "vars", "detail"}`. 설치 관리자의 오류 코드는 그대로 내려간다. 덧붙는 것:

| 상태 | code | 때 |
|---|---|---|
| 503 | `update_unavailable` · `vars.reason = "no_installer"` | 설치 관리자 없이 구성한 설치 |
| 501 | `update_unavailable` · `vars.reason = "unsupported"` | 설치 관리자가 이 경로를 모른다(404·405·501) |
| 503 · 504 · 502 | `installer_unreachable` · `installer_timeout` · `installer_rejected` · `installer_error` | 기존과 같다 |

### 설치 관리자 → backend 알림 `POST /api/internal/system/update-event`

카운트다운과 점검을 전 사용자의 화면에 알리려면 backend 의 실시간 소켓이 필요하다. 엔진은 상태가 바뀔 때 backend 에 알린다.

- 보호: 기존 `/api/internal/*` 와 같은 두 겹 — nginx 가 바깥에 `404`, backend 가 키를 상수 시간 비교. 키는 설치 관리자와 backend 가 이미 나눠 가진 `JW_INSTALLER_KEY`(헤더 `X-JW-Installer-Key`)다. 키가 비어 있으면 `404`, 다르면 `401`.
- 본문:

| `type` | 그 밖의 항목 | backend 가 하는 일 |
|---|---|---|
| `countdown` | `job`, `kind`, `trigger`, `ends_at`, `expected_seconds` | 예고를 기억하고 전 사용자에게 `system.update_countdown` |
| `cancelled` | `job` | 예고를 지우고 `system.update_cancelled` |
| `maintenance` | `job`, `kind`, `started_at`, `expected_seconds` | 점검을 기억하고 `system.maintenance`(`active: true`) |
| `finished` | `job`, `kind`, `trigger`, `result`, `version`, `from_version`, `failed_step`, `downtime_seconds` | 지우고 `system.maintenance`(`active: false`, `result`). `trigger = "auto"` 면 관리자 전원에게 알림 한 건 |

- 응답 `200 {"ok": true}`. 엔진은 실패하면 몇 번 다시 보내되(backend 가 다시 뜨는 중일 수 있다) 작업을 멈추지는 않는다. `maintenance` 는 backend 를 내리기 **전에**, `finished` 는 `verify` 가 끝난 **뒤에** 보낸다.
- 알림이 유실돼도 화면이 갇히지 않게, backend 는 기억해 둔 예고·점검을 내줄 때 설치 관리자의 공개 점검 상태와 대조해 끝났으면 지운다.

실시간 이벤트(소켓 `/ws/chat`, 전 사용자):

```json
{"type": "system.update_countdown", "job": "…", "kind": "update", "ends_at": "…", "expected_seconds": 240}
{"type": "system.update_cancelled", "job": "…"}
{"type": "system.maintenance", "active": true, "kind": "update", "started_at": "…", "expected_seconds": 240}
{"type": "system.maintenance", "active": false, "result": "success"}
```

### `GET /api/system/update-notice` (로그인한 누구나)

새로 접속한 화면이 지금의 예고·점검을 아는 길.

```json
{"state": "countdown", "job": "…", "kind": "update", "ends_at": "…", "started_at": null, "expected_seconds": 240, "contact": null}
```

`state`: `none` / `countdown` / `maintenance`. 작업 id 말고는 버전·단계를 싣지 않는다.

## 9. 엔진 구현자가 지킬 것

1. 단계 id(`preflight`·`backup`·`pull`·`migrate`·`switch`·`verify`, 되돌림 `stop`·`images`·`restore_db`·`start`·`verify`)와 상태 넷은 바꾸지 않는다. 화면이 이 값으로 문구를 고른다.
2. `choices` 가 실패 규칙의 단일 출처다. 화면은 `choices` 에 있는 버튼만 그린다 — 단계 이름으로 추측하지 않는다.
3. 자동 되돌림은 실패한 작업의 응답에 `rollback_job` 이 **이미 채워진 채로** 나와야 한다(화면이 그 id 로 넘어간다).
4. `switch` 는 backend 를 맨 마지막에 바꾼다. `maintenance` 알림은 backend 를 내리기 전에 보낸다.
5. 작업·기록의 id 는 같다. 끝난 작업을 `GET /jobs/<id>` 로 읽을 수 있어야 한다(진행 화면을 다시 열었을 때).
6. 공개 점검 상태에는 버전·단계·오류를 싣지 않는다.
7. 채널 검증은 `release/jwrelease/verify.py` 의 함수를 그대로 쓴다. 검증을 통과한 `sequence` 를 저장해 다음 검증에 넘긴다. `available` 은 `plan_update` 의 결과에서만 만든다.
8. 자동 적용은 `published + 3일 ≤ 지금` 이고 서버 시간이 `window` 안일 때만 카운트다운을 연다. 실패하면 `auto.paused` 를 켜고, `POST /auto/resume` 전에는 다시 시도하지 않는다.
9. 중간 버전을 거칠 때 버전마다 `pre-update` 백업을 뜬다. 중간에 실패하면 **그 버전의 직전**으로 되돌린다(이미 끝낸 앞 버전은 그대로 둔다) — 기록의 `version` 은 실제로 도달한 버전이다.
10. 백업·복원은 [data-safety.md](data-safety.md) 의 명령을 부른다(`backup create --kind pre-update --json`, 이전 이미지의 일회용 컨테이너에서 `restore`). 복원 지점의 `version` 과 백업의 스키마 버전이 어긋나면 복원을 시작하지 않는다.
11. 호환이 확인되지 않은 플러그인을 끄는 것은 `switch` 에서 한다. 끈 목록은 `GET /releases/<버전>` 의 `disabled_plugins` 로 남긴다.
12. 기록은 365일 지난 것을 지운다. 로그에 비밀값을 남기지 않는다.

## 10. 정해지지 않은 것

- **점검 중 쓰기 차단**(7절 끝): nginx 점검 모드로 할지, backend 가 읽기 전용 모드를 가질지.
- 정적 점검 페이지를 nginx 가 읽는 자리에 놓는 주체(설치 단계의 렌더링 / 엔진의 `switch`).
- `download_bytes`·`downtime_seconds` 를 어디서 얻는가 — manifest 에 그런 항목이 없다(추가하거나 엔진이 추정).
- 플러그인 호환 판정 — manifest 의 `plugin_api` 는 아직 자리뿐이다.
- 앱 설치 파일을 서버에서 내주는 경로(`apps[].url`).
- 오프라인 묶음과 이미지 파일의 크기 상한, 올리다 끊긴 파일의 이어 올리기(지금 계약에는 없다 — 큰 파일은 경로 방식).
