# 업데이트 내부 API — 계약

설치된 서버의 업데이트는 **설치 관리자**가 수행한다(설치 완료 후에도 컨테이너로 상주하며 내부 API 8444 를 제공한다 — [installer.md](installer.md) 5·6절).
본 문서는 해당 업데이트 엔진이 제공하는 내부 API(`/internal/update/*`)와, backend·nginx·화면이 이와 연동되는 접점을 규정한다.

> **구현 상태.** 엔진(`installer/app/update_*.py`, 경로는 `installer/app/api_update.py`), backend 의 중계 API(`backend/app/system/update_router.py`), 관리 › 업데이트 화면, nginx 설정(7절)이 모두 본 계약에 따라 구현되어 있다. 엔진의 구조(자기 교체, 번들, 복원 지점 보관)는 [installer.md](installer.md) 16절, 실서버 검증 범위는 동 문서 13절에 기술한다.

관련 문서: 채널·릴리스 목록의 형식과 검증([releases.md](releases.md)), 스키마 버전·백업·복원([data-safety.md](data-safety.md)).

## 1. 확정된 동작

- 제품 전체가 단일 버전을 가진다. 채널은 `stable` / `beta`. Beta 채널은 Stable 릴리스도 수신한다.
- 적용 방식은 수동(기본) / 자동. 자동은 적용 시간대(기본 03:00~05:00, 서버 시간) 내에서 **공개 후 3일이 경과한 릴리스만** 적용한다.
- 적용 순서(단계 id 는 고정): `preflight`(사전 점검) → `backup`(자동 백업) → `pull`(이미지 pull) → `migrate`(DB 변경) → `switch`(구역 교체) → `verify`(상태 확인).
  단계 상태는 `pending` / `running` / `done` / `failed` 의 네 가지로 한정한다.
- 자동 백업의 종류는 `pre-update` 다 — DB + 설정 + 암호화 키. **파일은 백업 대상도 롤백 대상도 아니다.**
- 실패 시 동작
  - `migrate` **이전** 단계(`preflight`·`backup`·`pull`)에서 실패: 작업이 중단되며 관리자가 "이 단계부터 다시"(`retry`)와 "되돌리기"(`rollback`) 중 하나를 선택한다.
  - `migrate` 이후(`migrate`·`switch`·`verify`) 실패: 선택 절차 없이 자동 롤백 — 이전 이미지로 교체 + DB 는 직전 백업으로 복원.
  - **자동 업데이트**는 단계와 무관하게 자동 롤백한다. 이후 자동 업데이트는 중지되며(`auto.paused`), 관리자가 "다시 켜기"를 선택하여야 다음 적용 시간대부터 재시도한다.
- 중간 버전: 목표 버전까지 경유 버전이 존재하면 1회의 확인으로 연속 진행한다. 버전마다 백업을 생성하고 버전마다 6개 단계를 처음부터 수행한다.
- Stable 채널 복귀: 채널만 변경하는 경우 Stable 의 최신 버전이 현재 버전 이상이 될 때까지 대기한다(`available.state = "wait"`). "시험판 이전 상태로 복원"(Beta 전환 직전에 별도 보관한 백업)도 가능하다.
- 호환성이 확인되지 않은 플러그인은 업데이트 이후 비활성화된 상태로 시작한다.
- 사전 공지: 수동 업데이트·수동 복원은 5분의 카운트다운 이후에 시작된다. 관리자는 "지금 바로 시작"·"취소"를 선택할 수 있다. 자동 업데이트도 시작 5분 전에 카운트다운을 개시한다. 카운트다운이 종료되면 점검 모드로 전환된다.
- 오프라인: 오프라인 번들을 업로드하거나 서버 내 경로를 지정 → 서명·버전 검증 → 추가로 필요한 이미지를 전부 확보 → 적용.
- 이력은 1년간 보관한다.

## 2. 공통 사항

- 주소: `http://jw-installer:8444`. 워크스페이스 내부망에서만 접근할 수 있다(호스트에 게시하지 않는다).
- 인증: 기존 내부 API 와 동일하다 — 공유 키(`X-JW-Installer-Key`) **및** 내부 대역의 출발지. 충족하지 않으면 `404`. 예외는 키 없이 접근 가능한 `GET /internal/update/maintenance` 하나다(7절).
- 오류 응답: `{"code": "…", "vars": {…}}`. 화면은 `code` 로 문구를 선택한다.
- 시각: UTC, `YYYY-MM-DDTHH:MM:SSZ`. 화면이 브라우저 시간대로 변환하여 표시한다. 적용 시간대(`window`)만 서버 시간의 `HH:MM` 이다.
- 용량은 바이트(정수), 시간은 초(정수).
- 변경 요청은 본문에 `actor` 를 포함한다: `{"id": "<사용자 id>", "name": "<표시 이름>"}`. 엔진은 이를 이력의 수행자 항목에 기록한다. 자동 업데이트의 `actor` 는 `null`.
- 동시에 하나의 작업만 실행된다. 구역 작업(활성화·비활성화)과도 병행되지 않는다 — 중복 시 `409 busy`.
- 엔진의 상태(설정, 작업, 이력, 오프라인 준비물)는 설치 관리자의 상태 폴더에 보존되어 설치 관리자·backend 가 재기동되어도 유지된다.

공통 오류 코드:

| 상태 | code | 의미 |
|---|---|---|
| 404 | `not_found` | 키 불일치 또는 내부 대역 외부(사유를 노출하지 않는다) |
| 404 | `job_unknown` · `restore_point_unknown` · `history_unknown` · `image_unknown` | 존재하지 않는 대상 |
| 409 | `busy` | 다른 작업이 진행 중. `vars.job` = 해당 작업 id |
| 409 | `action_not_allowed` | 현재 상태에서 허용되지 않는 제어. `vars.status`, `vars.allowed[]` |
| 409 | `not_available` | 적용 가능한 버전이 없다(또는 대기·차단 상태) |
| 409 | `target_stale` | 화면이 확인한 목표와 현재의 목표가 상이하다. `vars.target` = 현재의 목표 |
| 409 | `offline_incomplete` | 번들이 검증되지 않았거나 필요한 이미지가 누락되었다. `vars.blockers[]` |
| 409 | `restore_point_missing` | 시험판 이전 백업이 없다 |
| 409 | `not_installed` | 설치가 완료되지 않은 설치 관리자 |
| 413 | `too_large` | 업로드한 파일이 상한을 초과한다. `vars.limit` |
| 422 | `settings_invalid` | `vars.errors[] = {"field", "code"}` |
| 422 | `invalid` | 본문 형식 오류. `vars.field` |
| 507 | `no_space` | 저장 공간 부족. `vars.need`, `vars.free` |

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

| 항목 | 정의 |
|---|---|
| `current.channel` | 현재 설치된 버전이 속한 채널(버전 문자열에 `-beta.N` 이 포함되면 `beta`) |
| `current.previous_version` | 직전 버전(없으면 `null`) |
| `settings` | 4절의 설정과 동일한 값 |
| `check.state` | `idle` / `checking` |
| `check.ok` · `check.error` | 최종 확인의 성공 여부. 실패 시 `error = {"code", "detail"}` — code: `unconfigured`(서명을 검증할 공개 키가 없다 — 채널을 수신하지 않는다. `detail` 은 빈 문자열), `channel_unreachable`(연결 실패), `channel_invalid`(서명·형식·만료·순번 — releases.md 의 `VerifyError` 유형), `manifest_invalid`. 후자의 둘에는 `kind` 가 추가된다: `signature` / `expired` / `rollback`(순번 역행) / `hash` / `content` |
| `available` | 적용 가능한 버전(아래) — 최종적으로 **성공한** 확인의 결과다. 확인이 실패하더라도 삭제하지 않는다 |
| `job` | 진행 중이거나 관리자의 선택을 대기 중인 작업(5절의 작업 형식과 동일). 없으면 `null` |
| `auto.paused` | 자동 업데이트가 실패 이후 중지된 상태인지 여부. `reason = {"job", "step", "version"}` |
| `last_auto` | 최종 자동 업데이트의 결과: `{"job", "result", "version", "from_version", "finished_at", "downtime_seconds", "failed_step"}`. `result` 는 6절 이력의 값. 없으면 `null` |

`available` 은 `verify.plan_update()` 의 결과와 일대일로 대응한다:

| `state` | `plan_update` | 내용 |
|---|---|---|
| `none` | `current` | 최신 버전이다 |
| `update` | `update` | 아래 표 |
| `wait` | `wait` | `{"state": "wait", "channel_latest": "1.1.4", "resume_from": "1.2.0"}` — 채널의 최신 버전이 현재 버전보다 하위다. `resume_from` 은 수신이 재개되는 최저 버전(현재가 `X.Y.Z-beta.N` 이면 `X.Y.Z`) |
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

| 항목 | 정의 |
|---|---|
| `path` | 순차적으로 설치할 버전(마지막 요소가 `version`). 길이가 1 이면 직접 업데이트한다 |
| `download_bytes` | 경로상 manifest 에 기록된 `download_bytes` 의 합 — 해당 릴리스의 이미지를 전부 신규로 pull 하는 경우의 크기다(비활성화된 구역의 이미지도 포함되며 기존 계층을 차감하지 않으므로, 실제 수신량은 이보다 적다). manifest 에 값이 없으면 `null` |
| `downtime_seconds` | 예상 중단 시간(경로 전체) — 해당 서버의 직전 업데이트 실측값 × 경유 버전 수, 실측값이 없으면 버전당 240초 |
| `zones` | 이미지가 변경되는 구역 중 **활성화된** 구역. 이름은 `zones.json` 의 값 |
| `plugin_warnings` | 신규 버전과의 호환성이 확인되지 않은 플러그인 — 업데이트 이후 비활성화된 상태로 시작한다 |
| `changelog` | manifest 의 변경 내용(마크다운). 경로에 중간 버전이 존재하더라도 목표 버전의 내용 |
| `auto_eligible_at` | 자동 적용의 대상이 되는 시각(`published` + `min_age_days`) |

### `POST /internal/update/check`

채널을 즉시 수신하여 확인한다. `202` + 위 상태(`check.state = "checking"`). 완료되면 `check`·`available` 이 갱신된다 — 화면은 상태를 재조회한다. 작업이 실행 중이면 `409 busy`.

### 적용된 버전의 변경 내용 — `GET /internal/update/releases/<버전>`

```json
{"version": "1.0.0", "channel": "stable", "published": "…", "changelog": "- …", "applied_at": "…", "trigger": "auto",
 "downtime_seconds": 212, "previous_version": "0.9.4", "disabled_plugins": [{"id": "sample-plugin", "name": "Sample"}]}
```

현재 설치된 버전과 이력에 존재하는 버전에 대해서만 응답한다(그 외는 `404 history_unknown`). `applied_at` 이하의 항목은 해당 버전의 적용 이력이 존재하는 경우에만 포함된다.

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

`beta.since` 는 Beta 채널로 전환한 시각, `beta.restore_point` 는 그 직전에 보관한 백업(`{"id", "version", "created_at", "size_bytes"}`)이다. Beta 사용 이력이 없거나 해당 백업이 없으면 `null`.
`min_age_days` 는 읽기 전용이다(3).

### `PUT /internal/update/settings`

```json
{"mode": "auto", "window": {"start": "03:00", "end": "05:00"}, "channel": "beta", "stable_return": null, "actor": {"id": "…", "name": "…"}}
```

- 요청에 포함된 항목만 변경된다. `window` 는 `HH:00` 형식의 정시, `start ≠ end`. `start > end` 이면 자정을 경과하는 시간대다.
- `channel: "beta"` 로 변경하면 **다음 확인부터** Beta 릴리스를 수신한다. 이후 Beta 버전으로 최초 업데이트할 때 엔진은 그 직전 백업을 "시험판 이전 백업"으로 별도 보관한다(보관 기한 없음 — Stable 로 복귀하여 Stable 이 현재 버전 이상이 되면 삭제한다).
- `channel: "stable"` 로 복귀하는 경우 `stable_return` 을 함께 전송한다.
  - `"wait"`(기본): 채널만 변경한다. 응답의 `effect.wait` 에 대기 내용이 포함된다.
  - `"restore"`: 시험판 이전 백업으로 복원하는 작업을 시작한다(카운트다운부터 진행 — 본문에 `"start": "now"` 를 포함하면 사전 공지 없이 진행). 채널은 복원 완료 시점에 `stable` 로 변경된다. 백업이 없으면 `409 restore_point_missing`.

응답 `200`(복원을 시작한 경우 `202`):

```json
{
  "settings": {"mode": "manual", "window": {"start": "03:00", "end": "05:00"}, "channel": "stable", "min_age_days": 3,
               "beta": {"since": "2026-01-02T03:04:05Z", "restore_point": {"id": "rp-beta", "version": "1.0.0", "created_at": "2026-01-02T03:04:00Z", "size_bytes": 73400320}}},
  "effect": {"channel": "to_stable_wait", "wait": {"channel_latest": "1.1.4", "resume_from": "1.2.0"}, "job": null}
}
```

`effect.channel`: `null`(채널 변경 없음) / `to_beta` / `to_stable_wait` / `to_stable_restore`(이 경우 `effect.job` 에 복원 작업이 포함된다). 오류: `422 settings_invalid`, `409 busy`, `409 restore_point_missing`.

## 5. 적용 및 작업

### `POST /internal/update/apply`

```json
{"target": "1.2.0", "start": "countdown", "actor": {"id": "…", "name": "…"}}
```

- `target` 은 화면이 확인한 `available.version`. 현재 값과 상이하면 `409 target_stale`.
- `start`: `countdown`(기본 — 5분의 사전 공지 이후 시작) / `now`(사전 공지 없이 시작).
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

| 항목 | 정의 |
|---|---|
| `kind` | `update` / `rollback`(실패한 업데이트의 롤백 작업) / `restore`(관리자가 선택한 복원) |
| `trigger` | `manual` / `auto` / `offline` |
| `status` | `countdown`(사전 공지 중) → `running` → `done`. 그 외 `failed`, `cancelled`(사전 공지 중 취소) |
| `path` · `version_index` | 경유 버전 목록과 현재 진행 중인 버전의 인덱스(0 부터). `steps` 는 **현재 버전**의 단계다 — 다음 버전으로 진행하면 전부 `pending` 으로 초기화된다 |
| `countdown` | `status = "countdown"` 일 때 `{"ends_at": "…", "seconds": 300}`. 그 외에는 `null` |
| `steps[].detail.images` | `pull` 단계의 이미지별 진행 상태. `status`: `pending`/`pulling`/`done`/`failed`, `percent` 0~100 |
| `steps[].detail.percent` | 그 외 단계의 진행률을 산정할 수 있는 경우(0~100). 산정할 수 없으면 포함하지 않는다 |
| `steps[].detail` 의 그 외 항목 | `preflight`: `schema {current, target, changes}`·`plugin_warnings`·`free_bytes`, `backup`: `point`(복원 지점 id)·`path`·`size_bytes`, `switch`: `disabled_plugins`, `verify`: `version`·`schema_version`. 롤백에서 수행할 작업이 없어 생략된 단계는 `skipped: true`. 설치 관리자의 재기동으로 재수행된 단계에는 단계 자체에 `interrupted: true` 가 추가된다 |
| `error` | 실패 시 `{"step", "cause", "detail", "vars"}`. `cause` 는 문구 키, `detail` 은 원문 한 줄 |
| `choices` | 현재 관리자가 선택할 수 있는 제어: `retry`, `rollback`. 자동 롤백인 경우 빈 배열 |
| `rollback_job` | 해당 업데이트의 롤백 작업 id(롤백이 시작된 경우) |
| `restore` | `kind = "restore"` 일 때 `{"point": "<복원 지점 id>", "version": "1.0.0", "reason": "manual"}`. `reason`: `manual` / `beta`(시험판 이전 상태로) |
| `expected_seconds` | 예상 중단 시간 |
| `maintenance_started_at` | 점검 모드가 시작된 시각(카운트다운 종료 시점). 시작 전이면 `null` |

`kind` 가 `rollback`·`restore` 인 작업의 단계(id 고정): `stop`(구역 중지) → `images`(이전 이미지로 교체) → `restore_db`(백업으로 DB 복원) → `start`(구역 기동) → `verify`(상태 확인). `rollback` 은 `from_version` 이 실패한 목표 버전, `target_version` 이 복귀 대상 버전이며 `parent_job` 에 롤백 대상 업데이트 작업의 id 가 포함된다. `rollback`·`restore` 가 실패하면 `choices = ["retry"]` 만 제공된다(워크스페이스는 중지된 상태로 유지된다). `error.vars.backup_location` 에 백업 파일의 위치(backend 컨테이너 내 경로)를, `error.vars.manual` 에 수동 조치 사항의 문구 키(`restore_manually`)를 포함한다.

`error.cause` 의 값:

| 단계 | cause |
|---|---|
| `preflight` | `manifest_missing` · `manifest_invalid` · `manifest_incomplete`(설치 관리자·backend 이미지가 목록에 없음) · `other_job_running` · `backend_not_running` · `no_space`(`vars.need`·`free`) · `schema_downgrade`(`vars.current`·`target`) |
| `backup` | `backup_failed` |
| `pull` | `image_pull_failed`(`vars.image`) · `image_tag_failed` · `bundle_extract_failed` · 오프라인: `bundle_invalid` · `image_load_failed` · `image_missing` |
| `migrate` | `database_migrate_failed`(`vars.exit_code`) |
| `switch` · `start` | `stack_render_failed` · `compose_invalid` · `service_start_failed` · `service_not_ready`(`vars.container`) · `installer_replace_failed` · `previous_image_missing` |
| `verify` | `service_not_ready` · `backend_image_mismatch` · `version_mismatch` · `health_check_failed` · `schema_mismatch` · `installer_version_mismatch` |
| `stop` · `images` · `restore_db` | `service_stop_failed` · `restore_point_missing` · `previous_image_missing` · `restore_point_schema_mismatch` · `db_restore_failed` |
| 전 단계 공통 | `unexpected_error`(`vars.type`) |

실패 규칙(1절)과 작업 값의 대응 관계:

| 경우 | 업데이트 작업 | 후속 동작 |
|---|---|---|
| 수동·오프라인, `migrate` 이전 실패 | `status: "failed"`, `choices: ["retry", "rollback"]` | 관리자의 선택을 대기한다. 점검 모드는 유지 |
| 수동·오프라인, `migrate` 이후 실패 | `status: "failed"`, `choices: []`, `rollback_job` 설정 | 롤백 작업이 즉시 시작된다 |
| 자동, 전 단계 | 위와 동일 | 롤백이 완료되면 `auto.paused = true` |

### `GET /internal/update/jobs/<id>`

위 작업 형식으로 응답한다. 완료된 작업도 이력 보관 기간 동안 동일 id 로 조회할 수 있다.

### `POST /internal/update/jobs/<id>/action`

```json
{"action": "retry", "actor": {"id": "…", "name": "…"}}
```

| `action` | 허용 조건 | 동작 |
|---|---|---|
| `start_now` | `status = "countdown"` | 사전 공지를 종료하고 즉시 시작 |
| `cancel` | `status = "countdown"` | 취소 — `status: "cancelled"`. 자동 업데이트의 사전 공지를 취소하면 해당 시간대는 건너뛴다(중지 상태로 전환되지는 않는다) |
| `retry` | `choices` 에 포함된 경우 | 실패한 단계부터 재수행. 동일 작업이 `running` 으로 전환된다 |
| `rollback` | `choices` 에 포함된 경우 | 롤백 작업을 생성한다. 응답은 **업데이트 작업**(`rollback_job` 설정) |

허용되지 않는 제어는 `409 action_not_allowed`.

### `GET /internal/update/jobs/<id>/log[?tail=N][&format=text]`

`{"lines": ["[pull] 시작", "…"]}`. `format=text` 이면 `text/plain` 전체(다운로드용). 비밀값은 마스킹한다.

### `POST /internal/update/auto/resume`

중지된 자동 업데이트를 재개한다. `200` + `{"auto": {"paused": false, …}, "window": {"start": "03:00", "end": "05:00"}}`. 중지 상태가 아니더라도 성공으로 응답한다.

### 복원 지점

`GET /internal/update/restore-points`

```json
{"points": [{"id": "rp-20260110", "kind": "pre-update", "version": "1.0.0", "created_at": "2026-01-10T18:00:02Z", "size_bytes": 73400320}]}
```

최신순으로 정렬한다. `kind`: `pre-update` / `pre-beta`. `version` 은 해당 백업의 생성 시점에 설치되어 있던 버전(= 복원 시 복귀하는 버전).

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
| `bundle.state` | `uploading`(업로드 중) / `verifying`(검증 중) / `verified` / `signature_mismatch` / `version_too_low` / `file_missing`(경로에 존재하지 않거나 읽을 수 없음) / `invalid`(번들 형식이 아니거나 색인·해시 불일치) |
| `bundle.percent` | `uploading`·`verifying` 의 진행률(산정할 수 없으면 `null`) |
| `bundle.version` | 서명 검증 이후에만 설정(그 이전에는 `null`) |
| `images[]` | 번들에 포함되지 않은 외부 이미지. 번들이 `verified` 가 된 이후에만 설정한다(그 이전에는 빈 배열) |
| `images[].reason` | `always`(데이터베이스·캐시·웹 서버) / `zone`(해당 구역의 구성 요소) |
| `images[].state` | `present`(있음) / `missing`(없음) / `verifying`(검증 중) / `hash_mismatch`(해시 불일치) / `not_needed`(비활성화된 구역의 이미지) |
| `images[].command` | 인터넷에 연결된 PC 에서 해당 이미지를 파일로 저장하는 명령 |
| `download_url` | 오프라인 번들의 다운로드 주소(설정값 — 없으면 `null`) |
| `ready` | 적용 가능 여부: 번들이 `verified` 이고 `not_needed` 가 아닌 이미지가 전부 `present` |
| `blockers` | `bundle_missing` / `bundle_not_verified` / `bundle_rejected` / `images_missing` / `images_verifying` / `images_mismatch` |

검증 순서는 [releases.md](releases.md) 의 "오프라인 번들" 절과 동일하다(번들 서명 → manifest → 파일별 해시). 버전은 `plan_update` 와 동일한 기준으로 판정한다 — 현재 버전보다 상위가 아니면 `version_too_low`, 직접 업데이트할 수 없으면 `invalid` + `error.code = "no_upgrade_path"`.

| 메서드·경로 | 동작 |
|---|---|
| `POST /internal/update/offline/bundle` | 번들 업로드. 본문은 파일 원본(`application/octet-stream`), 파일 이름은 `X-JW-Filename`(URL 인코딩). 수신이 완료되면 `202` + 위 상태(`verifying`) — 검증은 백그라운드로 수행된다. 수신 중에는 다른 조회에 `uploading` 으로 표시된다 |
| `POST /internal/update/offline/bundle-path` `{"path"}` | 서버 내 파일 지정. 설치 관리자 컨테이너에서 접근 가능한 경로여야 한다([installer.md](installer.md) 3절 — 호스트의 설치 폴더가 `/data` 로 마운트된다). `202` + 상태(`verifying`). 파일이 없거나 읽을 수 없으면 `200` + `bundle.state = "file_missing"` |
| `DELETE /internal/update/offline/bundle` | 준비물을 삭제한다(업로드 중이면 중단) |
| `POST /internal/update/offline/images/<id>` | 이미지 파일 업로드(본문은 파일 원본). `202` + 상태(해당 항목이 `verifying`) |
| `POST /internal/update/offline/apply` `{"start", "actor"}` | 적용 시작 → `202` + 작업(`trigger: "offline"`). `ready` 상태가 아니면 `409 offline_incomplete` |

오프라인 적용의 `pull` 단계는 다운로드 대신 번들과 업로드된 파일을 `docker load` 한다(단계 id 는 동일하다).

### 이력

`GET /internal/update/history[?limit=50][&before=<id>]`

```json
{"items": [{"id": "b7e2c1d09a4f5e63", "kind": "update", "trigger": "auto", "version": "1.2.0", "from_version": "1.1.0",
            "result": "rolled_back", "started_at": "…", "finished_at": "…", "duration_seconds": 412, "downtime_seconds": 388,
            "actor": null}],
 "retention_days": 365, "more": false}
```

`result`: `success` / `rolled_back`(실패 후 롤백 성공) / `rollback_failed`(롤백 실패) / `restored`(복원) / `restore_failed` / `cancelled`. 롤백 작업은 별도 항목으로 생성하지 않고 해당 업데이트 항목에 포함한다. `actor` 가 `null` 이면 자동 업데이트다.

`GET /internal/update/history/<id>` — 해당 항목 + 단계별 기록:

```json
{"id": "…", "…": "…",
 "versions": [{"version": "1.2.0", "steps": [
   {"id": "preflight", "status": "done", "duration_seconds": 4, "note": null},
   {"id": "migrate", "status": "failed", "duration_seconds": 31, "note": "…오류 한 줄…"},
   {"id": "switch", "status": "pending", "duration_seconds": null, "note": null}]}],
 "rollback": {"result": "done", "steps": [{"id": "stop", "status": "done", "duration_seconds": 6, "note": null}]}}
```

로그 다운로드는 `GET /internal/update/jobs/<id>/log?format=text` 를 사용한다.

### 앱

`GET /internal/update/apps`

```json
{"version": "1.0.0", "download_page": "/settings/apps",
 "apps": [{"kind": "windows-desktop", "version": "1.0.0", "filename": "JustWorkspace-Setup-1.0.0.exe", "size_bytes": 98566144, "url": "/downloads/JustWorkspace-Setup-1.0.0.exe"}]}
```

manifest 의 `apps[]` 에 포함된 항목만 반환한다 — **빈 배열일 수 있다.** `kind`: `windows-desktop` / `android`. `url` 은 인증된 브라우저가 접근할 수 있는 주소(동일 출처의 경로 또는 전체 주소). `download_page` 는 사용자에게 안내할 화면 경로(없으면 `null`).

## 7. backend 중지 구간의 처리

`switch` 단계는 backend 컨테이너를 교체한다. 해당 구간에는 backend 의 중계 API 가 응답하지 못한다. 진행 화면과 점검 화면을 유지하기 위한 대안은 다음과 같다:

| | 방식 | 장점 | 단점 |
|---|---|---|---|
| A | nginx 가 진행 조회 전체를 설치 관리자로 전달한다(읽기 전용) | 관리자가 중단 없이 단계를 확인할 수 있다 | 인증 없이 접근 가능한 조회에 버전·단계·오류가 노출된다. 관리자에게만 제공하려면 backend 없이 세션을 검증하는 수단이 필요하다 |
| B | backend 를 최후에 교체하고, 중단 구간은 "다시 연결 중"으로 표시 | 신규로 노출되는 경로가 없다 | 일반 사용자의 점검 화면을 표시할 근거가 없다(진행 상태를 조회할 경로가 없다) |
| **C(권장)** | B + **공개 점검 상태 하나**만 nginx 가 설치 관리자로 전달한다 | 노출되는 정보는 점검 여부에 한정된다. 일반 사용자의 점검 화면과 관리자의 재연결이 동일한 조회를 사용한다 | 관리자는 backend 가 중지된 1~2분간 단계 진행을 확인할 수 없다(최종 확인 상태 + "다시 연결 중") |

**권장안 C 를 계약으로 채택한다.**

1. 엔진은 `switch` 에서 **backend 를 최후에** 교체한다. 작업 상태는 설치 관리자가 보유하므로 backend 가 재기동되면 동일 작업 id 로 조회가 재개된다.
2. 관리자의 진행 화면은 1.5초 주기로 `GET /api/admin/system/update/jobs/<id>` 를 조회하며, 실패 시 최종 확인 단계를 유지한 상태에서 "다시 연결 중"을 표시하고 조회를 지속한다. backend 가 복귀하면 동일 작업 id 로 재개된다. 해당 화면이 표시되는 동안에는 점검 화면으로 대체되지 않는다.
3. 일반 사용자의 화면은 API 호출이 실패하면(연결 실패·502·503·504) 공개 점검 상태를 조회하여, `active` 이면 점검 화면으로 전환한다. `active: false` 가 되고 `/api/health` 가 응답하면 화면을 새로 고친다.
4. 신규 접속한 브라우저에는 nginx 가 정적 점검 페이지를 제공한다(아래).

### 공개 점검 상태 — `GET /internal/update/maintenance` (키 없음)

```json
{"active": true, "phase": "running", "kind": "update", "started_at": "2026-01-12T01:35:00Z", "expected_seconds": 240,
 "countdown_ends_at": null, "contact": "내선 1234"}
```

| 항목 | 값 |
|---|---|
| `active` | 점검 모드 여부 — 카운트다운 종료 시점부터 작업 종료 시점까지(관리자의 선택을 대기 중인 `failed` 와 롤백 포함) |
| `phase` | `idle` / `countdown` / `running` |
| `kind` | `update` / `rollback` / `restore`. `idle` 이면 `null` |
| `started_at` | 점검 모드가 시작된 시각 |
| `expected_seconds` | 예상 소요 시간. 산정할 수 없으면 `null` |
| `countdown_ends_at` | `phase = "countdown"` 인 경우에 설정 |
| `contact` | 관리자가 등록한 연락처 한 줄. 없으면 `null` |

**버전·단계·오류·사용자 이름은 포함하지 않는다.** 응답은 `Cache-Control: no-store`. 본 경로는 키를 요구하지 않으나 내부 대역 검사는 동일하게 적용된다(외부에서는 nginx 를 경유하여야만 접근할 수 있다).

연락처는 backend 가 관리자의 설정을 수신하여 `PUT /internal/update/maintenance/contact` `{"contact": "…" | null}`(키 필요, 200자 이하 한 줄)로 전달한다.

### nginx 설정(`nginx/nginx.conf` 에 포함)

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

# 점검 모드 — 표식 파일이 있으면 관리자의 진행 화면이 쓰는 경로만 지나간다(server 블록 수준).
set $jw_maintenance "";
if (-f /etc/nginx/state/maintenance.on) { set $jw_maintenance "on"; }
if ($uri ~ "^/(api|ws|dav|oauth|sso|git|onlyoffice|livekit|audiorelay|rbi-login)(/|$)") { set $jw_maintenance "${jw_maintenance}:guarded"; }
if ($uri ~ "^/api/(auth/|admin/system/update/|system/update-notice$|health$)") { set $jw_maintenance "${jw_maintenance}:open"; }
if ($jw_maintenance = "on:guarded") { rewrite ^ /__jw_maintenance last; }      # → 503 {"code":"maintenance"} + Retry-After: 30
```

- **정적 점검 페이지.** `frontend-react/public/maintenance.html` 을 nginx 컨테이너가 직접 마운트한다(compose 의 `./frontend-react/public/maintenance.html:/etc/nginx/static/maintenance.html:ro`). 소스 빌드로 구성한 설치에서는 리포의 해당 파일이며, 설치 관리자로 설치한 서버에서는 번들에 포함되어 스택 폴더의 동일 경로에 배치된다(설치의 렌더링 단계가 배치하고, 업데이트의 `switch` 가 신규 버전의 파일로 교체한다). 페이지는 `/maintenance/status` 를 5초 주기로 조회하며, 점검이 종료되고 `/api/health` 가 응답하면 동일 주소를 다시 연다. 스크립트가 차단된 경우에도 30초 주기로 새로 고친다.
- **번들 업로드**는 대용량이다. `/api/admin/system/update/offline/bundle` 과 `…/offline/images/` 는 본문 상한 없이, 디스크에 버퍼링하지 않고 스트리밍으로 전달한다(`client_max_body_size 0; proxy_request_buffering off;`, 읽기·쓰기 3600초). 프런트 프록시가 존재하는 경우 해당 프록시의 상한도 해제하여야 한다 — 해제하지 않으면 413 이 반환되며, 그러한 설치에서는 "서버에 있는 파일 경로" 방식을 사용한다.
- **점검 중 쓰기 차단 — nginx 점검 모드.** 백업 생성 이후의 변경은 롤백 시 소실된다. 따라서 점검 모드가 시작되면(사전 공지 종료 시점, `backup` 이전) 엔진이 마커 파일(`stack/nginx/state/maintenance.on` → 컨테이너의 `/etc/nginx/state/maintenance.on`)을 생성하고, 작업이 종료되면 삭제한다. nginx 는 요청마다 해당 파일을 확인하므로 설정 리로드가 필요하지 않다. 마커가 존재하는 동안:
  - 허용 경로: `/api/auth/`, `/api/admin/system/update/`, `/api/system/update-notice`, `/api/health`, `/maintenance/status` 및 화면(정적 파일).
  - 차단 경로: 그 외의 `/api/`, `/ws/`, `/dav/`, `/oauth/`, `/sso/`, `/git/`, `/onlyoffice/`, `/livekit/`, `/audiorelay/` → `503 {"code": "maintenance", "detail": "…"}` + `Retry-After: 30`.
  - 화면 요청을 점검 페이지로 대체하지는 않는다. nginx 는 요청자가 관리자인지 식별할 수 없으며, 관리자는 진행 화면을 새로 열 수 있어야 한다. 일반 사용자의 화면은 API 의 503 응답을 근거로 공개 점검 상태를 조회하여 자체적으로 점검 화면으로 전환한다(위 3번).
  - 설치 관리자 없이 구성한 설치에서는 마커가 생성되지 않는다(빈 폴더가 마운트될 뿐이다).

## 8. backend 측 구현 사항

### 관리자용 중계 API `/api/admin/system/update/*`

관리자 전용이다. 경로는 내부 API 의 `/internal/update` 를 `/api/admin/system/update` 로 치환한 것과 동일하며, 본문에 `actor` 를 설정하여 전달한다.

| backend | 내부 API | 감사 로그 |
|---|---|---|
| `GET /status` | `GET /status` | |
| `POST /check` | `POST /check` | |
| `GET /releases/<버전>` | 동일 | |
| `GET /settings` · `PUT /settings` | 동일 | `system.update.settings` |
| `POST /apply` | 동일 | `system.update.apply` |
| `GET /jobs/<id>` · `GET /jobs/<id>/log` | 동일 | |
| `GET /jobs/<id>/log/download` | `GET /jobs/<id>/log?format=text` | |
| `POST /jobs/<id>/action` | 동일 | `system.update.start_now` · `.cancel` · `.retry` · `.rollback` |
| `POST /auto/resume` | 동일 | `system.update.auto_resume` |
| `GET /restore-points` · `POST /restore` | 동일 | `system.update.restore` |
| `GET /offline` · `POST /offline/bundle` · `POST /offline/bundle-path` · `DELETE /offline/bundle` · `POST /offline/images/<id>` · `POST /offline/apply` | 동일 | `system.update.offline_bundle` · `.offline_image` · `.offline_clear` · `.offline_apply` |
| `GET /history` · `GET /history/<id>` | 동일 | |
| `GET /apps` | 동일 | |
| `GET /contact` · `PUT /contact` | (DB 설정) + `PUT /maintenance/contact` | `system.update.contact` |

오류는 `{"code", "vars", "detail"}`. 설치 관리자의 오류 코드는 그대로 전달된다. 추가되는 오류 코드:

| 상태 | code | 발생 조건 |
|---|---|---|
| 503 | `update_unavailable` · `vars.reason = "no_installer"` | 설치 관리자 없이 구성한 설치 |
| 501 | `update_unavailable` · `vars.reason = "unsupported"` | 설치 관리자가 해당 경로를 지원하지 않는다(404·405·501) |
| 503 · 504 · 502 | `installer_unreachable` · `installer_timeout` · `installer_rejected` · `installer_error` | 기존과 동일 |

### 설치 관리자 → backend 알림 `POST /api/internal/system/update-event`

카운트다운과 점검 모드를 전체 사용자 화면에 통지하려면 backend 의 실시간 소켓이 필요하다. 엔진은 상태 변경 시 backend 에 통지한다.

- 보호: 기존 `/api/internal/*` 와 동일한 이중 보호 — nginx 가 외부 요청에 `404`, backend 가 키를 상수 시간으로 비교. 키는 설치 관리자와 backend 가 공유하는 `JW_INSTALLER_KEY`(헤더 `X-JW-Installer-Key`)다. 키가 비어 있으면 `404`, 불일치하면 `401`.
- 본문:

| `type` | 그 외 항목 | backend 의 동작 |
|---|---|---|
| `countdown` | `job`, `kind`, `trigger`, `ends_at`, `expected_seconds` | 사전 공지를 저장하고 전체 사용자에게 `system.update_countdown` |
| `cancelled` | `job` | 사전 공지를 삭제하고 `system.update_cancelled` |
| `maintenance` | `job`, `kind`, `started_at`, `expected_seconds` | 점검 모드를 저장하고 `system.maintenance`(`active: true`) |
| `finished` | `job`, `kind`, `trigger`, `result`, `version`, `from_version`, `failed_step`, `downtime_seconds` | 삭제하고 `system.maintenance`(`active: false`, `result`). `trigger = "auto"` 이면 관리자 전원에게 알림 1건 |

- 응답 `200 {"ok": true}`. 엔진은 실패 시 수회 재전송하되(backend 가 재기동 중일 수 있다) 작업을 중단하지는 않는다. `maintenance` 는 backend 중지 **이전에**, `finished` 는 `verify` 완료 **이후에** 전송한다.
- 알림이 유실되더라도 화면이 점검 상태에 고착되지 않도록, backend 는 저장된 사전 공지·점검 모드를 응답할 때 설치 관리자의 공개 점검 상태와 대조하여 종료된 경우 삭제한다.

실시간 이벤트(소켓 `/ws/chat`, 전체 사용자):

```json
{"type": "system.update_countdown", "job": "…", "kind": "update", "ends_at": "…", "expected_seconds": 240}
{"type": "system.update_cancelled", "job": "…"}
{"type": "system.maintenance", "active": true, "kind": "update", "started_at": "…", "expected_seconds": 240}
{"type": "system.maintenance", "active": false, "result": "success"}
```

### `GET /api/system/update-notice` (인증된 모든 사용자)

신규 접속한 화면이 현재의 사전 공지·점검 모드를 확인하는 경로다.

```json
{"state": "countdown", "job": "…", "kind": "update", "ends_at": "…", "started_at": null, "expected_seconds": 240, "contact": null}
```

`state`: `none` / `countdown` / `maintenance`. 작업 id 외에 버전·단계는 포함하지 않는다.

### 화면

| 대상 | 위치 |
|---|---|
| 관리 › 업데이트(`/admin/update` 와 탭) | `frontend-react/src/pages/admin/update.tsx`, `src/components/admin/update/` |
| 호출 및 타입 정의 | `src/composables/useSystemUpdate.ts` |
| 사전 공지 배너 · 점검 화면 | `src/components/layout/UpdateCountdownBanner.tsx` · `MaintenanceScreen.tsx`, 상태는 `src/composables/useUpdateNotice.ts` |
| 정적 점검 페이지 | `frontend-react/public/maintenance.html` |
| 계약에 따른 모의 응답(fixture) 집합 | `src/components/admin/update/fixtures.ts` — 화면의 모든 상태를 하나씩 포함한다. 엔진이 동일 형식으로 응답하면 화면이 수정 없이 연동된다 |

화면이 계약에 의존하는 사항: 실패 시의 버튼은 `choices` 로, 자동 롤백으로의 전환은 `rollback_job` 으로, 롤백·복원의 문구는 `kind` 와 `restore.reason` 으로 결정한다. 값이 `null` 인 항목(`download_bytes`, `downtime_seconds`, `expected_seconds`, `contact`, `download_url`, `download_page` …)은 해당 줄을 표시하지 않는다.

## 9. 엔진 구현 준수 사항

1. 단계 id(`preflight`·`backup`·`pull`·`migrate`·`switch`·`verify`, 롤백 `stop`·`images`·`restore_db`·`start`·`verify`)와 네 가지 상태는 변경하지 않는다. 화면이 해당 값으로 문구를 선택한다.
2. `choices` 가 실패 규칙의 단일 출처다. 화면은 `choices` 에 포함된 버튼만 표시한다 — 단계 이름으로 추정하지 않는다.
3. 자동 롤백의 경우 실패한 작업의 응답에 `rollback_job` 이 **설정된 상태로** 반환되어야 한다(화면이 해당 id 로 전환한다).
4. `switch` 는 backend 를 최후에 교체한다. `maintenance` 알림은 backend 중지 이전에 전송한다.
5. 작업과 이력의 id 는 동일하다. 완료된 작업을 `GET /jobs/<id>` 로 조회할 수 있어야 한다(진행 화면을 다시 여는 경우).
6. 공개 점검 상태에는 버전·단계·오류를 포함하지 않는다.
7. 채널 검증은 `release/jwrelease/verify.py` 의 함수를 그대로 사용한다(이미지 빌드가 `/app/jwrelease` 로 복사한다). 검증을 통과한 `sequence` 를 저장하여 다음 검증에 전달한다. `available` 은 `plan_update` 의 결과로만 생성한다.
8. 자동 적용은 `published + 3일 ≤ 현재 시각` 이고 서버 시간이 `window` 내인 경우에만 카운트다운을 개시한다. 실패 시 `auto.paused` 를 설정하고, `POST /auto/resume` 이전에는 재시도하지 않는다.
9. 중간 버전을 경유하는 경우 버전마다 `pre-update` 백업을 생성한다. 도중에 실패하면 **해당 버전의 직전 상태**로 롤백한다(완료된 선행 버전은 유지한다) — 이력의 `version` 은 실제로 도달한 버전이다.
10. 백업·복원은 [data-safety.md](data-safety.md) 의 명령을 호출한다(`backup create --kind pre-update --json`, 이전 이미지의 일회용 컨테이너에서 `restore`). 복원 지점의 `version` 과 백업의 스키마 버전이 불일치하면 복원을 시작하지 않는다.
11. 호환성이 확인되지 않은 플러그인의 비활성화는 `switch` 에서 수행한다. 비활성화한 목록은 `GET /releases/<버전>` 의 `disabled_plugins` 로 기록한다(판정 규칙이 확정되기 전까지는 항상 빈 배열 — 10절).
12. 365일이 경과한 이력은 삭제한다. 로그에 비밀값을 기록하지 않는다.

## 10. 미확정 사항

확정 사항:

- 점검 중 쓰기 차단은 nginx 점검 모드로 수행한다(7절).
- 정적 점검 페이지는 번들에 포함하며, 설치의 렌더링 단계가 배치하고 업데이트의 `switch` 가 교체한다(7절).
- `download_bytes` 는 manifest 의 선택 항목(`make-manifest --resolve-sizes`), `downtime_seconds` 는 엔진의 실측 기반 추정(3절).
- 플러그인 호환성: manifest 의 `plugin_api` 가 비어 있으면 판정하지 않는다(`plugin_warnings` 는 빈 배열).
- 앱 설치 파일은 최초 릴리스에 포함하지 않는다(`GET /apps` 의 `apps` 는 빈 배열, `download_page` 는 `null`). 서버가 제공하는 경로는 없다 — manifest 의 `apps[].url` 을 그대로 반환한다.
- 업로드 파일의 상한은 64GB(설치 관리자의 `JW_UPDATE_UPLOAD_MAX`).

잔여 과제:

- 플러그인 호환성 판정의 실제 규칙 — manifest 의 `plugin_api` 형식이 확정되면 구현한다. 현재 엔진에는 `plugin_api.version` 과 플러그인 `manifest.json` 의 `plugin_api` 를 문자열로 비교하는 예약 구현만 존재하며, `switch` 에서 플러그인을 비활성화하는 동작은 없다(`disabled_plugins` 는 항상 빈 배열).
- 중단된 업로드의 이어 올리기(미지원 — 대용량 파일은 경로 지정 방식을 사용한다).
- 사전 공지 시간(5분)은 고정값이다.
