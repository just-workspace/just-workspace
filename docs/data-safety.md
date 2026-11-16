# 데이터 안전 — 스키마 버전, 백업, 복원

본 문서는 DB 스키마의 변경 방식, 백업의 구성과 형식, 복원 절차와 실패 시 동작을 기술한다. 업데이트 롤백 시 세 요소의 상호 관계는 5절에 기술한다.

코드: `backend/app/db/`(스키마), `backend/app/backup/`(백업·복원), `scripts/backup.sh` · `scripts/restore.sh`(래퍼 스크립트).

---

## 1. 스키마 버전

### 구성 요소

| 항목 | 위치 | 정의 |
|---|---|---|
| `SCHEMA_VERSION` | `backend/app/db/schema_version.py` | 이 코드가 요구하는 DB 스키마 버전(정수) |
| `schema_migrations` 표 | DB | 적용된 단계의 기록: `version`, `name`, `applied_at`, `app_version`(적용한 제품 버전), `notes`(생략된 선택 항목의 경고) |
| 기준선(버전 1) | `backend/app/db/baseline.py` | 버전 기록 도입 이전의 스키마 전체 |
| 변경 단계(버전 2~) | `backend/app/db/migrations.py` 의 `STEPS` | 기준선 이후의 변경. 번호 순으로만 추가된다 |
| 실행기 | `backend/app/db/migrate.py` | 잠금, 순차 적용, 기록, 기동 시 판정 |

DB 의 버전은 `schema_migrations` 의 최대 `version` 값이다.

### 기준선

버전 기록 도입 이전에는 서버 기동 시마다 `create_all`(신규 테이블) + 누락 컬럼 `ADD COLUMN` + 수동 작성 ALTER·백필을 실행하였다. 이 작업 집합 전체를 **기준선 = 1** 로 정의한다.

- **신규 설치**(빈 DB): 기준선 작업 집합을 실행해 현재 모델과 동일한 스키마를 생성하고 1 로 기록한 후, 2 번 이후의 단계를 순차 적용한다.
- **기존 설치**(테이블은 존재하나 `schema_migrations` 가 없음): 동일한 작업 집합을 1회 실행한다. 작업은 모두 멱등이므로 누락분만 보충한다(데이터는 삭제하지 않는다). 이후 1 로 기록하고 후속 단계를 적용한다. 결과는 종전의 기동 시 처리와 동일하다.

기준선 내의 **필수** 항목(테이블 생성, 누락 컬럼 추가, 채팅 메시지 순번)이 실패하면 기준선으로 기록하지 않고 중단한다. **선택** 항목(인덱스·확장·시드·백필)은 종전과 같이 생략하고 해당 경고를 기록의 `notes` 에 남긴다 — 예컨대 중복 행으로 인해 유니크 인덱스를 생성할 수 없는 기존 설치가 업데이트 후 기동 불능 상태가 되는 것을 방지하기 위함이다. 생략된 항목은 `migrate --status` 에 표시되며 `migrate --repair` 로 재시도한다.

`baseline.py` 에는 신규 변경을 추가하지 않는다. 해당 파일은 "버전 1"의 정의다.

### 변경 단계 작성법

1. 모델(`backend/app/**/models.py`)을 수정한다.
2. `backend/app/db/migrations.py` 의 `STEPS` 끝에 다음 번호의 단계를 추가한다.

   ```python
   async def _0003_user_title(conn):
       await add_column(conn, "users", "title")     # 모델에 선언된 컬럼을 그대로 더한다
       await run_sql(conn, "CREATE INDEX IF NOT EXISTS ix_users_title ON users(title)")

   STEPS = (
       Step(2, "…", _0002_state_out_of_redis),      # 이미 있는 단계는 그대로 둔다
       Step(3, "users.title 추가", _0003_user_title),
   )
   ```

3. `schema_version.py` 의 `SCHEMA_VERSION` 을 해당 번호로 올리고, `MODELS_FINGERPRINT` 를 `python -m app.cli schema-version --fingerprint` 의 출력값으로 변경한다.

준수 사항:

- **멱등으로 작성한다.** 신규 설치는 현재 모델로 테이블을 생성한 후(기준선) 모든 단계를 거치므로, 단계가 추가하려는 컬럼이 이미 존재한다. 보조 함수(`add_column`, `create_tables`, `has_column`, `run_sql` + `IF NOT EXISTS`)는 이를 전제로 동작한다.
- **릴리스된 단계는 수정하지 않는다.** 수정이 필요한 경우 다음 번호의 단계로 추가한다.
- 단계 하나는 **하나의 트랜잭션**이며 버전 기록도 동일 트랜잭션에 포함된다. PostgreSQL 은 DDL 도 롤백하므로, 실패한 단계는 흔적을 남기지 않으며 버전은 증가하지 않는다. `CREATE INDEX CONCURRENTLY` 와 같이 트랜잭션 내에서 실행할 수 없는 작업은 `Step(..., transactional=False)` 로 분리한다.
- `add_column` 은 기존 행과의 호환을 위해 항상 NULL 허용으로 추가한다. NOT NULL 이 필요한 경우 값을 채운 후 동일 단계에서 제약을 설정한다.
- **역방향 단계(down)는 두지 않는다.** 업데이트가 실패하면 직전 백업으로 복원한다(5 절).
- 삭제·이름 변경·타입 축소는 가급적 두 릴리스에 나누어 수행한다(먼저 사용을 중단하고, 다음 릴리스에서 삭제한다).
- `run_sql` 은 기본적으로 PostgreSQL 에서만 실행된다(테스트의 SQLite 에서는 생략된다).
- 모델 파일을 신규 생성한 경우 `migrate.py` 의 `MODEL_MODULES` 에 추가한다.

테스트(`backend/tests/test_schema_migrate.py`)의 검증 항목: 단계 번호가 1 씩 증가하고 마지막 번호가 `SCHEMA_VERSION` 과 일치하는지, 모델 지문이 기록과 일치하는지(모델을 수정하고 단계를 누락하면 여기서 검출된다), 모든 모델 파일이 `MODEL_MODULES` 에 등록되어 있는지.

플러그인은 자체 테이블을 직접 생성한다(코어의 스키마 버전에 포함되지 않는다).

### 명령

```
python -m app.cli migrate             # 대기 단계 적용
python -m app.cli migrate --check     # 적용하지 않고 판정
python -m app.cli migrate --status    # 현재 버전·대기 단계·기록·빠진 테이블/컬럼 (--json)
python -m app.cli migrate --repair    # 기준선 보정을 다시 돌린 뒤 대기 단계 적용
python -m app.cli migrate --on-start  # 컨테이너 기동용(entrypoint 가 부른다)
python -m app.cli schema-version      # 코드가 요구하는 버전 — 숫자만, DB 없이
```

| 종료 코드 | 의미 |
|---|---|
| 0 | 적용 완료 또는 대기 단계 없음 |
| 1 | 단계 실패(실패한 단계와 원인은 표준 오류에 출력) / `--check` 에서 대기 단계 존재 / DB 버전이 낮으나 자동 적용이 비활성화됨 |
| 3 | DB 스키마가 코드보다 높음 — 백업에서 복원하여야 한다 |
| 4 | 버전은 일치하나 모델에 선언된 테이블·컬럼이 DB 에 없음 — `--repair` |

동시에 하나의 프로세스만 실행된다. PostgreSQL 세션 advisory lock 을 획득하며, 다른 프로세스가 이미 보유 중이면 해제될 때까지 대기한 후 상태를 다시 조회한다(대기 단계가 없으면 그대로 종료한다).

### 서버 기동 시 동작

컨테이너의 entrypoint 가 워커를 기동하기 **전에 1회** `migrate --on-start` 를 실행한다. 각 워커도 기동 시 버전을 확인한다(통상 조회 1회).

| DB 의 상태 | 동작 |
|---|---|
| 코드와 동일 | 그대로 기동한다 |
| 낮음, `JW_MIGRATE_ON_START` 미설정(기본) | 잠금을 획득해 적용한 후 기동한다. 수동 `docker compose up` 설치가 그대로 동작한다 |
| 낮음, `JW_MIGRATE_ON_START=0` | 적용하지 않으며 **기동하지 않는다**. 설치 관리자가 `migrate` 를 별도로 호출하는 구성용이다 |
| 적용 실패 | **기동하지 않는다**. 실패한 단계와 원인을 로그에 기록하고 종료 코드 1 로 종료한다 |
| 코드보다 높음 | **기동하지 않는다**. 이미지는 이전 버전으로 복원되었으나 DB 는 신규 버전인 상태를 의미한다 — 백업에서 복원하도록 안내한다 |
| 버전은 동일하나 모델의 테이블·컬럼이 없음 | **기동하지 않는다**. `migrate --repair` 를 안내한다 |

종전에는 실패 시에도 5회 재시도 후 예외 없이 서버가 기동하였다(부분 적용된 스키마 상태로). 현재는 DB 에 연결할 수 없는 경우에 한해 최대 30초간 대기하며, 그 밖의 실패는 대기 없이 중단한다.

코드가 요구하는 버전과 워커가 확인한 버전은 로그인된 요청의 `/api/health` 응답 `schema_version: {required, current}` 로 제공된다.

---

## 2. 백업 형식

형식은 단일하다. 관리 화면의 백업, `scripts/backup.sh`, `python -m app.cli backup create`, 설치 관리자의 업데이트 전 백업이 모두 동일한 형식을 생성하고 판독한다.

백업은 **단일 디렉터리**다.

```
20260101_030000-full/
  manifest.json
  db.dump                pg_dump -Fc
  config.tar             설정 묶음(.env 포함). 암호를 주면 config.tar.enc
  mail-config.tar.gz     메일 계정·DKIM 키
  mail-data.tar.gz       메일함
  mail-state.tar.gz      메일 상태
  gitea-db.dump          코드 저장소 DB
  gitea-data.tar.gz      코드 저장소 데이터
  plugins-data.tar.gz
  certs.tar.gz
  app-signing.tar.gz     모바일 앱 서명 키
  files.tar              파일 저장소(선택)
```

이전 시에는 해당 디렉터리를 **단일 tar 파일**(`.jwbak`, 무압축)로 패키징한다(`backup pack`, `backup create --pack`, 관리 화면의 다운로드). `manifest.json` 이 첫 번째 멤버이므로 요약은 파일을 추출하지 않고 선두부만 판독한다. 판독 측은 두 형태를 모두 허용한다.

파일은 소유자만 읽을 수 있도록(600, 디렉터리 700) 생성한다.

### manifest.json

| 필드 | 의미 |
|---|---|
| `format` | 형식 버전(현재 1). 미지원 버전이면 판독을 거부한다 |
| `kind` | `full` 또는 `pre-update` |
| `created_at` | 생성 시각(UTC, ISO 8601) |
| `product_version` | 생성한 제품 버전 |
| `schema_version` | 생성 시점의 DB 스키마 버전 — 복원 가능 여부의 판정 기준 |
| `postgres_version` | 덤프를 생성한 PostgreSQL 버전(`server_version_num`) |
| `install_id` | 설치 id(`JW_INSTALL_ID`) |
| `domain`, `app_url` | 생성한 서버 |
| `zones` | 설치되어 있던 구역 |
| `storage` | 파일 저장소: `{"kind": "local"}` 또는 `{"kind": "nfs", "server", "export"}` |
| `stats` | `users`(사용자 수), `db_bytes`(DB 크기), `storage_bytes`(파일 저장소 크기 — 전체 백업·로컬 저장소인 경우에 한함) |
| `secret_key_fingerprint` | 암호화 키의 지문(값은 노출되지 않는다). 복원 시 키의 동일 여부를 확인한다 |
| `items` | 항목 id → `{"files": [{"name", "role", "size", "sha256"}], …}`. `config` 에는 `encrypted` |
| `skipped` | 포함되지 않은 항목 → 사유(`nfs`, `not-requested`, `failed`, 또는 설명) |
| `warnings` | 생성 시의 경고 |

### 항목

| 항목 | 내용 | 생성 방법 |
|---|---|---|
| `db` | 제품 DB 전체 | `pg_dump -Fc`(일관된 스냅숏, 서비스 무중단) |
| `config` | compose 프로젝트 폴더의 `.env` 와 사이트 설정(`docker-compose.override.yml`, `docker-compose.site.yml`, `nginx/site.d`, `nginx/private.d`, `livekit/livekit.yaml` 중 존재하는 것) | tar |
| `mail` | 메일 계정·DKIM 키(`mailserver/config`), 메일함, 메일 상태 | tar(서비스 무중단 — Maildir 은 메시지 단위 파일이므로 백업 중 수신된 메일만 누락된다) |
| `gitea` | 코드 저장소의 DB 와 데이터 볼륨 | **일시 중지 후** DB 덤프 + 볼륨 tar, 완료 후 재기동한다. 실행 중에 생성하면 저장소와 DB 가 불일치할 수 있다 |
| `plugins-data` | 플러그인 데이터 볼륨 | tar |
| `certs` | 인증서 볼륨 | tar |
| `app-signing` | 모바일 앱 서명 키 볼륨(존재하는 경우) — 유실 시 설치된 앱을 갱신할 수 없다 | tar |
| `files` | 파일 저장소 | tar(무압축). **선택** 항목이며 로컬 저장소인 경우에 한한다 |

구역이 설치되어 있지 않으면 해당 항목은 `skipped` 에 사유와 함께 기록된다.

### 백업 종류

| | `pre-update` | `full` |
|---|---|---|
| 용도 | 업데이트 직전 자동 백업 | 정기 백업, 서버 이전 |
| 항목 | `db`, `config` | 전체(`files` 는 선택) |
| 서비스 정지 | 없음 | 코드 저장소에 한해 일시 정지 |

관리 화면의 "지금 백업"과 예약 백업은 `full` 이다. 파일 저장소의 포함 여부는 예약 설정의 `include_files`(기본 활성)로 지정한다.

### 백업 제외 대상

- **Redis.** 세션·캐시·잠금·실시간 전달 용도다. 복원 후에는 모든 사용자의 재로그인이 필요하다. 문서·채팅·메일·회의·토큰 갱신 정보는 PostgreSQL 또는 디스크에 저장된다. 수일~수개월간 유지되는 편의 정보(최근 수신자 추천, 대화별 도구 허용, 알려진 기기 목록)는 초기화된다.

  종전에는 Redis 에만 저장되고 만료가 없는 값이 세 가지 있었다. 스키마 버전 2 부터 DB 에 저장되며 백업에 포함된다(아래 "Redis 에서 DB 로 옮긴 값").
- **NFS 의 파일.** 파일 저장소가 NFS 인 경우 파일은 백업에 포함하지 않는다. 파일은 이미 별도 장비에 저장되어 있으며, 이를 서버의 로컬 디스크로 복사하는 것은 통상 용량과 목적 모두에 부합하지 않는다. manifest 에는 저장소 정보(`server`, `export`)만 기록된다. 파일은 NAS 측의 스냅숏·복제로 별도 보호한다. 복원은 DB 만 복원하므로, **DB 백업 시점과 NFS 의 파일 상태가 다르면** 그 사이에 삭제된 파일은 목록에만 남고 그 사이에 업로드된 파일은 목록에 나타나지 않는다.
- **설치된 플러그인의 코드**(`plugins/`), 컨테이너 이미지, 로그.
- **회의 녹화 볼륨**(파일 저장소로 이동되기 전의 임시 출력).

### Redis 에서 DB 로 옮긴 값

| 값 | 현재 저장 위치 | 종전 Redis 키 |
|---|---|---|
| 개인 잠금 PIN(해시) | `privacy_pins` 표 | `privacy:pin:<사용자 id>` |
| POP3 계정의 읽음·별표 | `mail_pop3_state` 표(계정 + UIDL) | `mail:pop3:read:<계정 id>`, `mail:pop3:flag:<계정 id>` (집합) |
| 새 메일 감시의 최종 확인 위치 | `mail_accounts.last_seen_uid` | `mail:lastuid:<계정 id>` |

스키마 변경 단계 2 는 저장 위치만 생성한다(변경 단계는 DB 만 조작할 수 있다). 값의 이전은 backend 가 수행한다 — **기동 약 20초 후 1회 전수 조회해** 잔여분을 모두 이전하며(`backend/app/db/redis_handoff.py`), 그 전에 조회 요청이 발생하면 해당 시점에 이전한다.

- **읽기**: DB 에 값이 있으면 그 값만 사용한다. 없으면 종전 Redis 키를 1회 조회하고, 값이 있으면 DB 에 기록한 후 그 값을 사용한다. POP3 의 읽음·별표는 "행 없음"이 "읽은 항목 없음"을 의미할 수도 있으므로 계정별 이전 완료 표시(`mail_accounts.pop3_state_imported`)를 별도로 두고 1회만 이전한다. 다수의 워커가 동시에 접근하더라도 하나만 이전을 수행한다.
- **쓰기**: DB 에 기록하고, 종전 Redis 키에도 동일한 값을 기록한다. Redis 측은 **조회하지 않는 사본**이다. 이전 후에도 종전 키를 삭제하지 않는다.
- **사본을 유지하는 사유**: 업데이트가 실패하면 이전 버전의 이미지로 롤백하는데(5 절), 해당 버전은 Redis 의 키만 조회한다. 키가 삭제되었거나 갱신되지 않은 상태이면 롤백된 서버에서 PIN 이 소실되거나, 읽은 메일이 읽지 않음으로 표시되거나, 그 사이의 메일이 새 메일로 재알림된다. 사본은 Redis 를 사용할 수 없는 경우에도(쓰기 실패) 동작에 영향을 주지 않는다.
- **과거 값의 재적용 가능성**: DB 에 값(또는 이전 완료 표시)이 생성된 이후에는 Redis 를 조회하지 않는다. DB 에 값이 없는 경우는 아직 이전하지 않은 경우뿐이며, 그 시점의 Redis 값이 곧 현재 값이다. 스키마 버전 1 에서 생성한 백업을 복원한 경우도 동일하다 — DB 에 값이 없으므로 Redis 에 남아 있는 값(존재하는 경우)을 이전한다.
- Redis 를 초기화하더라도(복원, 볼륨 유실) 이미 이전한 값은 유지된다. 업데이트된 backend 가 1회 기동한 후에는 미이전 값이 남지 않는다 — 기동 시의 전수 조회가 실패한 경우(로그 `[handoff]`) 다음 기동 시 또는 해당 값이 최초 조회될 때 다시 이전한다.

### 암호화 키

`config` 항목의 `.env` 에는 `SECRET_KEY` 가 포함된다. DB 내의 다음 값들이 이 키로 암호화되어 있다: 외부 메일 계정 비밀번호, 2단계 인증 비밀, 저장소 접근 키, AI 제공자 키 등.

- **키를 유실하면** DB 를 복원하더라도 해당 값들은 복호화할 수 없다. 사용자는 외부 메일 계정을 다시 연결하고 2단계 인증을 다시 등록하여야 하며, 관리자는 저장소·AI 키를 다시 입력하여야 한다. 이에 따라 백업에는 키가 **포함된다**.
- 따라서 **백업 파일의 보유자는 서버의 모든 데이터를 열람할 수 있다.** 파일 권한을 600 으로 설정하며, 생성 시마다 경고를 출력한다.
- **암호 보호(선택)**: 암호를 지정하면 `config` 항목을 AES-256-GCM 으로 암호화한다(키는 scrypt 로 암호에서 유도한다). 파일명은 `config.tar.enc` 가 되며 manifest 에 `encrypted: true` 가 기록된다. 암호는 명령 인자가 아니라 `--password-file <파일>` 또는 환경변수 `JW_BACKUP_PASSWORD` 로 지정한다. **이 암호를 유실하면 설정 항목은 추출할 수 없다.** DB 덤프 등 다른 항목은 암호화하지 않는다 — 백업 전체를 보호하려면 보관 위치를 암호화한다.
- 복원 시 백업의 키 지문이 현재 서버의 키와 다르면 중단하고 확인을 요구한다(4 절).

### 생성 전 검사 및 생성 후 검증

- 시작 전에 대상 위치의 **쓰기 가능 여부**와 **여유 공간이 예상 크기를 충분히 상회하는지** 확인한다(예상 크기는 압축 전 크기 기준으로 보수적으로 산정한다). 부족하면 시작하지 않고 사유를 출력한다.
- 생성 완료 후 manifest 의 해시로 **자체 검증**한다. 검증에 실패하면 백업을 보존하지 않는다.
- `db` 항목의 생성에 실패하면 백업 전체가 실패한다(디렉터리를 남기지 않는다). 다른 항목이 실패하면 해당 항목을 제외하고 **"일부"** 로 보고한다(제외된 항목은 manifest 의 `skipped`·`warnings` 와 종료 코드 2 로 확인한다).
- 관리 화면의 백업은 서버의 백업 볼륨에 저장된다. **동일 서버에만 보관된 백업은 해당 서버의 디스크 장애 시 함께 유실된다** — `scripts/backup.sh <폴더>` 로 반출하거나 다운로드해 별도 위치에 보관한다.

### 명령

```
python -m app.cli backup create [--kind full|pre-update] [--include-files] [--dest DIR] [--pack] [--json]
python -m app.cli backup list [--json]
python -m app.cli backup inspect <백업> [--json]         # 내용 요약 — 풀지 않는다, DB·docker 없이
python -m app.cli backup verify <백업>                   # 모든 파일을 manifest 의 SHA-256 과 견준다
python -m app.cli backup pack <백업 폴더> [<파일>]
python -m app.cli backup extract-config <백업> --out DIR # 설정 묶음만 꺼낸다 — DB·docker 없이
python -m app.cli backup plan [--kind …] [--json]        # 실행할 단계 목록만
```

`create` 는 backend 컨테이너 내에서 실행된다(`docker exec ws-backend …`). 종료 코드: 0 성공, 1 실패, 2 일부 항목이 제외된 백업.

호스트에서는 `sudo bash scripts/backup.sh [받을-폴더] [--kind …] [--include-files] [--password-file F]` 를 사용한다 — 백업을 생성해 단일 tar 파일로 패키징하고, 호스트 폴더로 반출하고, 반출한 파일의 해시를 검증하고, 30일이 경과한 백업을 삭제한다.

### 구조: 계획과 실행의 분리

- `backup/plan.py` — 순수 함수. 입력은 구성(`StackConfig`: 컨테이너 이름, DB, 볼륨 위치, 구역), 출력은 단계 목록(`Step`: 명령 인자, 출력/입력 파일, 허용 종료 코드, "실패 시에도 계속 진행" 표시)이다. 어떠한 것도 실행하지 않는다. `to_dict()` 로 JSON 으로 직렬화된다.
- `backup/runner.py` — 구성을 탐지하고(`discover`), 주입된 실행기로 단계를 실행하고, 결과를 형식에 맞게 패키징한다. 기본 실행기는 backend 컨테이너의 docker CLI 다.
- `backup/format.py` — manifest·해시·암호·패키징·요약. 표준 라이브러리와 `cryptography` 만 사용한다.

설치 관리자는 backend 컨테이너에서 CLI 를 호출하거나, `backup plan --json` 의 단계 목록을 자체 실행기로 실행할 수 있다.

---

## 3. 내용 요약

`backup.format.summarize(path)`(= `backup inspect --json`)는 백업을 추출하지 않고 manifest 만 판독해 반환한다. 설치 마법사의 "백업에서 복원" 확인 화면이 사용한다.

`created_at`, `product_version`(= `backup_version`), `schema_version`, `postgres_version`, `install_id`, `domain`, `source_url`, `zones`, `users`, `data_bytes`, `storage`, `storage_bytes`, `files_included`, `files_bytes`, `items`, `skipped`, `config_included`, `config_encrypted`, `size_bytes`, `kind`.

사용자 수·데이터 크기는 백업 생성 시 manifest 에 기록한 값이다.

---

## 4. 복원

```
sudo bash scripts/restore.sh <백업 파일 또는 폴더> [--items a,b] [--with-config] [--password-file F] [--yes]
sudo bash scripts/restore.sh <백업> --inspect      # 내용만 본다
```

스크립트는 backend 이미지의 **일회용 컨테이너**에서 `python -m app.cli restore` 를 호출한다. 리포 폴더에서 직접 구성한 서버용이다. 설치 관리자로 설치한 서버에서는 `docker exec jw-installer jw restore <백업> [--yes]` 가 동일한 작업을 수행한다(설정은 복원하지 않는다 — [installer.md](installer.md) 6절의 "같은 서버에 되돌리기").

**앱 내에서는 복원을 수행하지 않는다.** 복원은 backend 를 중지하고 DB 를 교체한 후 재기동하는 작업이며, 실행 중인 backend 는 자신을 중지할 수 없다. 따라서 복원 API 와 화면은 앱에 존재하지 않는다(실행 중인 DB 에 덤프를 덮어쓰던 종전의 앱 내 복원 기능은 제거되었다). 실행 중인 backend 컨테이너 내에서 `restore` 를 호출하면 어떠한 변경도 가하지 않고 거부한다.

### 절차

| 단계 | 수행 내용 | 해당 단계 실패 시 |
|---|---|---|
| `verify` | 형식 버전, 모든 파일의 크기·SHA-256, (설정 복원 시) 암호 | 변경된 것이 없다 |
| `compat` | 버전 판정(아래), 암호화 키 지문, 복원 대상 위치 확인 | 〃 |
| `extract` | tar 인 경우 작업 폴더에 추출한다(공간 확인) | 〃 |
| `safety-dump` | **현재 DB 를 덤프한다** → `<백업 위치>/_pre-restore/<시각>.dump` | 〃 |
| `stop` | DB 를 사용하는 서비스(backend, SSO, LDAP)와 복원 대상 항목의 서비스(메일, 코드 저장소)를 중지한다 | 재기동한다 |
| `db-load` | 덤프를 **임시 DB**(`<이름>_restore_new`)에 적재한다. 오류가 하나라도 발생하면 중단한다 | 임시 DB 를 삭제하고 서비스를 재기동한다. 기존 DB 는 변경되지 않는다 |
| `db-swap` | 기존 DB 를 `<이름>_restore_old` 로 변경하고 신규 DB 를 원래 이름으로 변경한다(이름 변경) | 이름을 원상 복구한다 |
| `migrate` | 복원한 DB 에 스키마 변경 단계를 적용한다 | **원래 DB 로 복구한다** |
| `items` | DB 외의 항목을 복원한다(볼륨을 비우고 백업 시점 상태로 추출한다) | 실패로 보고한다. 복원한 DB 는 유지하며, 복원 전 DB 의 위치를 안내한다 |
| `config` | `--with-config` 지정 시 설정 묶음을 프로젝트 폴더에 추출한다 | 〃 |
| `start` | 중지한 서비스를 역순으로 기동한다 | 실패로 보고 |
| `check` | backend 가 정상 상태가 될 때까지 대기한다(기본 300초) | 실패로 보고 |
| 정리 | 이름을 변경해 둔 원래 DB 와 작업 폴더를 삭제한다. **안전 덤프는 보존한다**(최근 2개) | |

어느 단계에서든 실패하면 종료 코드 1 과 `복원 실패 — 단계 '<이름>': <원인> (<그 뒤의 상태>)` 를 출력한다. `--json` 지정 시 `{"ok": false, "stage", "error", "state", "done"}` 을 출력한다.

DB 는 `migrate` 단계까지 통과하여야 확정된다. 그 이전의 실패에서는 기존 DB 가 변경되지 않았거나 원상 복구된다. DB 외의 항목은 원상 복구가 불가하므로 원상 복구가 가능한 단계가 모두 완료된 **이후에** 수행한다.

안전 덤프는 복원 성공 후에도 보존된다 — 잘못된 백업을 복원한 경우의 복구 수단이다(`pg_restore` 로 직접 적재하거나, 해당 덤프로 백업 폴더를 구성해 다시 복원한다).

### 버전 판정

- 백업의 `schema_version` **≤** 현재 코드의 `SCHEMA_VERSION` → 복원 후 `migrate` 가 차이를 적용한다.
- **더 높으면 거부**한다. 해당 백업을 생성한 버전 이상의 제품에서 복원하여야 한다.
- 백업을 생성한 PostgreSQL 의 메이저 버전이 현재 버전보다 높은 경우에도 거부한다.

### 설정과 암호화 키

기본적으로 `config` 는 복원하지 않는다(동일 서버에서 DB 만 복원하는 경우가 일반적이며, `.env` 는 그 사이에 변경되었을 수 있다).

- 백업과 현재 서버의 **암호화 키가 다르면** `compat` 단계에서 중단한다. 그대로 복원하면 DB 내의 암호화된 값을 복호화할 수 없기 때문이다. `--with-config` 로 설정까지 복원하거나, 이를 인지하고 진행하려면 `--allow-key-mismatch` 를 지정한다.
- `--with-config` 는 `.env` 를 덮어쓴다. 컨테이너는 생성 시점의 환경으로 동작하므로 완료 후 스택을 재생성하여야 한다(`scripts/restore.sh` 가 `docker compose up -d` 를 호출한다).

### 신규 서버로의 이전

설치 마법사의 시작 방식 **"백업에서 복원"** 이 아래 절차를 일괄 수행한다([installer.md](installer.md) §14). 응답 파일(`"mode": "restore"`)로도 수행할 수 있다.

1. 원래 서버에서 전체 백업을 생성한다: `backup create --kind full --include-files --pack`(파일 저장소가 NFS 인 경우 `--include-files` 를 생략한다 — 파일은 해당 저장소에 있다). 관리 화면의 "지금 백업" → 다운로드도 동일하다.
2. 신규 서버에 설치 관리자를 기동하고 "백업에서 복원"을 선택한다. 백업 파일을 업로드하거나, 서버에 미리 복사해 둔 파일의 경로를 지정한다.
3. 내용(생성한 서버·버전·구역·파일 포함 여부)을 확인하고, 이 서버에서 재지정이 필요한 항목만 지정한다 — 접속 주소, 네트워크 구성(화면 표기: 연결 형태), 파일 저장 위치. 원래 저장소가 NFS 였던 경우 동일한 공유를 다시 연결한다(저장소 마커의 설치 id 로 동일 공유 여부를 확인한다).
4. 설치 관리자가 백업의 설정에서 암호화 키·DB 비밀번호·구역·설치 id 를 추출해 스택을 구성하고, 빈 DB 에 `restore` 로 데이터를 적재한 후 스키마를 맞추고, 파일을 복원하고, 구역을 기동한다.
5. 접속 주소의 DNS 레코드를 신규 서버로 변경하고, 확인 후 원래 서버를 중지한다.

수동 수행 시의 절차도 동일하다: `backup extract-config <백업> --out <프로젝트 폴더>` 로 설정을 **먼저** 추출하고(`.env` 의 DB 비밀번호와 암호화 키가 있어야 이후 단계가 정합한다. 접속 주소에 종속된 값은 신규 서버에 맞게 수정한다) → 해당 설정으로 스택을 기동하고(빈 DB) → `restore <백업>`(설정은 이미 일치하므로 `--with-config` 없이) → 파일 저장소가 NFS 였던 경우 동일한 저장소를 마운트한다. 파일 저장소의 저장소 마커에는 백업을 생성한 설치의 id 가 기록되어 있으므로 신규 서버의 `JW_INSTALL_ID` 가 동일하여야 한다(추출한 `.env` 를 그대로 사용하면 동일하다).

### 구 형식 백업

본 형식 이전에 생성한 백업(`postgres_*.sql.gz`, 또는 `postgres.dump` + `storage.tar.gz` 폴더)은 `manifest.json` 이 없어 `restore` 가 판독하지 않는다. 필요한 경우 수동으로 적재한다: backend 를 중지하고, 빈 DB 를 생성해 `psql`(sql.gz) 또는 `pg_restore`(dump)로 적재한 후 `python -m app.cli migrate` 를 실행한다.

---

## 5. 업데이트 및 롤백

설치 관리자의 업데이트 절차와 본 문서의 구성 요소가 대응되는 지점은 다음과 같다.

| 순서 | 호출 대상 |
|---|---|
| 사전 점검 | `migrate --check`(대기 단계 존재 여부), `backup inspect`·여유 공간 |
| 자동 백업 | `backup create --kind pre-update --json` — `db` + `config` |
| 이미지 pull | 신규 릴리스 manifest 의 `db_schema` = 해당 릴리스의 `schema-version` 출력 |
| **DB 변경** | 신규 이미지로 `migrate` 를 실행한다. 종료 코드가 0 이 아니면 이 단계에서 중단한다 |
| 구역 교체 | `JW_MIGRATE_ON_START=0` 으로 기동하면 backend 는 스키마를 변경하지 않고 버전만 확인한다 |
| 상태 확인 | `/api/health`, `migrate --status` |

**롤백**: 역방향 마이그레이션은 두지 않는다. 실패하면 이전 이미지로 복원하고 **DB 는 직전 백업으로 복원**한다.

- 단계가 실패하면 해당 단계는 트랜잭션 단위로 롤백되나, **앞서 성공한 단계는 적용된 상태로 유지된다.** 따라서 DB 는 이전 코드가 인식하는 버전보다 높아져 있을 수 있다.
- 이 상태에서 이전 이미지를 기동하면 backend 는 **기동하지 않는다**("DB 스키마 버전이 코드가 요구하는 버전보다 높습니다"). 불일치한 스키마로 동작을 지속하는 대신 중단하도록 설계되어 있다.
- 따라서 롤백은 다음 두 작업의 조합이다: 이전 이미지 + `restore <직전 pre-update 백업>`(이전 이미지의 일회용 컨테이너에서 실행). 백업의 스키마 버전은 이전 코드의 버전과 동일하므로 판정을 통과한다.
- 업데이트 시작 시점부터 롤백 시점까지 발생한 변경은 소실된다. 업데이트 중의 쓰기 차단은 설치 관리자의 책임이다.

---

## 6. 검증

- 스키마: `backend/tests/test_schema_migrate.py`(SQLite), `backend/tests/test_schema_migrate_pg.py`(실제 PostgreSQL — 환경변수 `JW_TEST_PG_URL` 이 설정된 경우에만 실행된다: 신규 DB, 기존 DB 무손실 편입, 동시 실행 8개, 잠금 대기, 실패 단계의 DDL 롤백).
- 백업·복원: `backend/tests/test_backup_restore.py`(모의 실행기로 형식·해시·암호·공간 부족·손상·버전 판정·단계별 실패와 원상 복구).
- 실제 `pg_dump`/`pg_restore`·볼륨 왕복은 docker 가 설치된 장비에서 임시 스택으로 확인한다.
