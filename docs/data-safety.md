# 데이터 안전 — 스키마 버전, 백업, 복원

이 문서는 세 가지를 다룬다: DB 스키마가 어떻게 바뀌는지, 백업에 무엇이 어떻게 들어가는지, 복원이 어떤 순서로 돌고 실패하면 어떻게 되는지. 업데이트를 되돌릴 때 이 셋이 어떻게 맞물리는지는 맨 끝에 있다.

코드: `backend/app/db/`(스키마), `backend/app/backup/`(백업·복원), `scripts/backup.sh` · `scripts/restore.sh`(얇은 래퍼).

---

## 1. 스키마 버전

### 무엇이 있나

| 것 | 어디 | 뜻 |
|---|---|---|
| `SCHEMA_VERSION` | `backend/app/db/schema_version.py` | 이 코드가 요구하는 DB 스키마 버전(정수) |
| `schema_migrations` 표 | DB | 적용된 단계의 기록: `version`, `name`, `applied_at`, `app_version`(적용한 제품 버전), `notes`(건너뛴 선택 항목의 경고) |
| 기준선(버전 1) | `backend/app/db/baseline.py` | 버전 기록이 생기기 전의 스키마 전체 |
| 변경 단계(버전 2~) | `backend/app/db/migrations.py` 의 `STEPS` | 기준선 뒤의 변경. 번호 순서로만 는다 |
| 실행기 | `backend/app/db/migrate.py` | 잠금, 순서대로 적용, 기록, 기동 때의 판정 |

DB 의 버전은 `schema_migrations` 의 가장 큰 `version` 이다.

### 기준선

버전 기록이 없던 시절에는 서버가 뜰 때마다 `create_all`(새 테이블) + 누락 컬럼 `ADD COLUMN` + 손으로 쓴 ALTER·백필을 돌렸다. 그 묶음 전체를 **기준선 = 1** 로 정의한다.

- **새 설치**(빈 DB): 기준선 묶음을 돌려 지금 모델과 같은 스키마를 만들고 1 로 기록한 뒤, 2 번부터의 단계를 차례로 적용한다.
- **기존 설치**(테이블은 있는데 `schema_migrations` 가 없음): 같은 묶음을 한 번 돌린다. 묶음은 전부 멱등이라 빠진 것만 채운다(데이터는 지우지 않는다). 그 뒤 1 로 기록하고 이후 단계를 적용한다. 결과는 예전 기동 때 하던 것과 같다.

기준선 안에서 **필수**(테이블 만들기, 누락 컬럼 추가, 채팅 메시지 순번)가 실패하면 기준선으로 기록하지 않고 멈춘다. **선택**(인덱스·확장·시드·백필)은 예전처럼 건너뛰고 그 경고를 기록의 `notes` 에 남긴다 — 예컨대 중복 행 때문에 유니크 인덱스를 못 만드는 기존 설치가 업데이트 뒤 아예 못 뜨는 일을 피하려는 것이다. 건너뛴 것은 `migrate --status` 에 보이고 `migrate --repair` 로 다시 시도한다.

`baseline.py` 에는 새 변경을 더하지 않는다. 그 파일은 "버전 1"의 정의다.

### 변경 단계 작성법

1. 모델(`backend/app/**/models.py`)을 고친다.
2. `backend/app/db/migrations.py` 의 `STEPS` 끝에 다음 번호의 단계를 더한다.

   ```python
   async def _0003_user_title(conn):
       await add_column(conn, "users", "title")     # 모델에 선언된 컬럼을 그대로 더한다
       await run_sql(conn, "CREATE INDEX IF NOT EXISTS ix_users_title ON users(title)")

   STEPS = (
       Step(2, "…", _0002_state_out_of_redis),      # 이미 있는 단계는 그대로 둔다
       Step(3, "users.title 추가", _0003_user_title),
   )
   ```

3. `schema_version.py` 의 `SCHEMA_VERSION` 을 그 번호로 올리고, `MODELS_FINGERPRINT` 를 `python -m app.cli schema-version --fingerprint` 값으로 바꾼다.

지켜야 할 것:

- **멱등으로 쓴다.** 새 설치는 지금 모델로 테이블을 만든 뒤(기준선) 모든 단계를 지나가므로, 단계가 더하려는 컬럼이 이미 있다. 도우미(`add_column`, `create_tables`, `has_column`, `run_sql` + `IF NOT EXISTS`)는 그렇게 동작한다.
- **한 번 릴리스된 단계는 고치지 않는다.** 고칠 것이 있으면 다음 번호의 단계로.
- 단계 하나는 **한 트랜잭션**이고 버전 기록도 같은 트랜잭션에 들어간다. PostgreSQL 은 DDL 도 되돌리므로, 실패한 단계는 흔적 없이 사라지고 버전은 오르지 않는다. `CREATE INDEX CONCURRENTLY` 처럼 트랜잭션 안에서 못 도는 것은 `Step(..., transactional=False)` 로 따로 뗀다.
- `add_column` 은 기존 행을 깨지 않게 늘 NULL 허용으로 더한다. NOT NULL 이 필요하면 채운 뒤 같은 단계에서 건다.
- **되돌리는 단계(down)는 없다.** 업데이트가 실패하면 직전 백업으로 복원한다(5 절).
- 지우기·이름 바꾸기·타입 좁히기는 되도록 두 릴리스에 나눈다(먼저 쓰지 않게 하고, 다음에 지운다).
- `run_sql` 은 기본으로 PostgreSQL 에서만 돈다(테스트의 SQLite 는 건너뛴다).
- 새 모델 파일을 만들면 `migrate.py` 의 `MODEL_MODULES` 에 더한다.

테스트(`backend/tests/test_schema_migrate.py`)가 지키는 것: 단계 번호가 1 씩 늘고 끝이 `SCHEMA_VERSION` 인지, 모델 지문이 기록과 같은지(모델을 고치고 단계를 빠뜨리면 여기서 걸린다), 모델 파일이 `MODEL_MODULES` 에 다 있는지.

플러그인은 자기 테이블을 자기가 만든다(코어의 스키마 버전에 들지 않는다).

### 명령

```
python -m app.cli migrate             # 대기 단계 적용
python -m app.cli migrate --check     # 적용하지 않고 판정
python -m app.cli migrate --status    # 현재 버전·대기 단계·기록·빠진 테이블/컬럼 (--json)
python -m app.cli migrate --repair    # 기준선 보정을 다시 돌린 뒤 대기 단계 적용
python -m app.cli migrate --on-start  # 컨테이너 기동용(entrypoint 가 부른다)
python -m app.cli schema-version      # 코드가 요구하는 버전 — 숫자만, DB 없이
```

| 종료 코드 | 뜻 |
|---|---|
| 0 | 적용했거나 할 일이 없다 |
| 1 | 단계가 실패했다(어느 단계에서 왜인지 표준 오류에) / `--check` 에서 대기 단계가 있다 / DB 가 낮은데 자동 적용이 꺼져 있다 |
| 3 | DB 스키마가 코드보다 높다 — 백업에서 복원해야 한다 |
| 4 | 버전은 맞는데 모델에 있는 테이블·컬럼이 DB 에 없다 — `--repair` |

한 번에 하나만 돈다. PostgreSQL 세션 advisory lock 을 잡고, 이미 누가 쥐고 있으면 풀릴 때까지 기다렸다가 상태를 다시 읽는다(할 일이 없으면 그대로 끝낸다).

### 서버가 뜰 때

컨테이너의 entrypoint 가 워커를 띄우기 **전에 한 번** `migrate --on-start` 를 돌린다. 각 워커도 뜰 때 버전을 확인한다(보통 읽기 한 번).

| DB 의 상태 | 동작 |
|---|---|
| 코드와 같다 | 그대로 뜬다 |
| 낮다, `JW_MIGRATE_ON_START` 없음(기본) | 잠금을 잡고 적용한 뒤 뜬다. 수동 `docker compose up` 설치가 그대로 동작한다 |
| 낮다, `JW_MIGRATE_ON_START=0` | 적용하지 않고 **뜨지 않는다**. 설치 관리자가 `migrate` 를 따로 부르는 구성용 |
| 적용이 실패했다 | **뜨지 않는다**. 실패한 단계와 원인을 로그에 남기고 종료 코드 1 |
| 코드보다 높다 | **뜨지 않는다**. 이미지를 되돌렸는데 DB 는 새것이라는 뜻 — 백업에서 복원하라는 안내 |
| 버전은 같은데 모델의 테이블·컬럼이 없다 | **뜨지 않는다**. `migrate --repair` 안내 |

예전에는 실패해도 다섯 번 재시도한 뒤 예외 없이 서버가 떴다(반쯤 적용된 스키마로). 지금은 DB 에 못 닿는 경우에만 30초까지 기다리고, 그 밖의 실패는 기다리지 않고 멈춘다.

코드가 요구하는 버전과 워커가 확인한 버전은 로그인한 요청의 `/api/health` 응답 `schema_version: {required, current}` 에 있다.

---

## 2. 백업 형식

형식은 하나다. 관리 화면의 백업, `scripts/backup.sh`, `python -m app.cli backup create`, 설치 관리자의 업데이트 전 백업이 모두 같은 것을 만들고 같은 것을 읽는다.

백업은 **디렉터리 하나**다.

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

옮길 때는 그 디렉터리를 **tar 한 개**(`.jwbak`, 압축 없음)로 묶는다(`backup pack`, `backup create --pack`, 관리 화면의 내려받기). `manifest.json` 이 첫 멤버라서 요약은 파일을 풀지 않고 앞부분만 읽는다. 읽는 쪽은 두 모양을 모두 받는다.

파일은 소유자만 읽을 수 있게(600, 디렉터리 700) 만든다.

### manifest.json

| 필드 | 뜻 |
|---|---|
| `format` | 형식 버전(지금 1). 모르는 버전이면 읽기를 거부한다 |
| `kind` | `full` 또는 `pre-update` |
| `created_at` | 만든 시각(UTC, ISO 8601) |
| `product_version` | 만든 제품 버전 |
| `schema_version` | 만든 시점의 DB 스키마 버전 — 복원할 수 있는지의 판정 기준 |
| `postgres_version` | 덤프를 만든 PostgreSQL 버전(`server_version_num`) |
| `install_id` | 설치 id(`JW_INSTALL_ID`) |
| `domain`, `app_url` | 만든 서버 |
| `zones` | 설치돼 있던 구역 |
| `storage` | 파일 저장소: `{"kind": "local"}` 또는 `{"kind": "nfs", "server", "export"}` |
| `stats` | `users`(사용자 수), `db_bytes`(DB 크기), `storage_bytes`(파일 저장소 크기 — 전체 백업·로컬 저장소일 때만) |
| `secret_key_fingerprint` | 암호화 키의 지문(값은 드러나지 않는다). 복원 때 "같은 키인가"를 본다 |
| `items` | 항목 id → `{"files": [{"name", "role", "size", "sha256"}], …}`. `config` 에는 `encrypted` |
| `skipped` | 들어가지 않은 항목 → 이유(`nfs`, `not-requested`, `failed`, 또는 설명) |
| `warnings` | 만들 때의 경고 |

### 항목

| 항목 | 내용 | 뜨는 방법 |
|---|---|---|
| `db` | 제품 DB 전체 | `pg_dump -Fc`(일관된 스냅숏, 서비스는 계속 돈다) |
| `config` | compose 프로젝트 폴더의 `.env` 와 사이트 설정(`docker-compose.override.yml`, `docker-compose.site.yml`, `nginx/site.d`, `nginx/private.d`, `livekit/livekit.yaml` 중 있는 것) | tar |
| `mail` | 메일 계정·DKIM 키(`mailserver/config`), 메일함, 메일 상태 | tar(서비스는 계속 돈다 — Maildir 은 메시지마다 파일이라 뜨는 중에 온 메일이 빠질 뿐이다) |
| `gitea` | 코드 저장소의 DB 와 데이터 볼륨 | **잠깐 세우고** DB 덤프 + 볼륨 tar, 끝나면 다시 띄운다. 실행 중에 뜨면 저장소와 DB 가 어긋날 수 있다 |
| `plugins-data` | 플러그인 데이터 볼륨 | tar |
| `certs` | 인증서 볼륨 | tar |
| `app-signing` | 모바일 앱 서명 키 볼륨(있을 때) — 잃으면 설치된 앱을 갱신할 수 없다 | tar |
| `files` | 파일 저장소 | tar(압축 없음). **선택**이고 로컬 저장소일 때만 |

구역이 없으면 그 항목은 `skipped` 에 이유와 함께 남는다.

### 두 종류

| | `pre-update` | `full` |
|---|---|---|
| 용도 | 업데이트 직전 자동 백업 | 정기 백업, 서버 이전 |
| 항목 | `db`, `config` | 전부(`files` 는 선택) |
| 서비스 정지 | 없음 | 코드 저장소만 잠깐 |

관리 화면의 "지금 백업"과 예약 백업은 `full` 이다. 파일 저장소를 넣을지는 예약 설정의 `include_files`(기본 켬)로 정한다.

### 들어가지 않는 것

- **Redis.** 세션·캐시·잠금·실시간 전달용이다. 복원 뒤에는 모든 사용자가 다시 로그인하면 된다. 문서·채팅·메일·회의·토큰 갱신 정보는 PostgreSQL 이나 디스크에 있다. 며칠~몇 달짜리 편의 정보(최근 받는 사람 추천, 대화별 도구 허용, 알려진 기기 목록)는 비워진다.

  예전에는 Redis 에만 있고 만료도 없는 값이 셋 있었다. 스키마 버전 2 부터 DB 에 있고 백업에 들어간다(아래 "Redis 에서 DB 로 옮긴 값").
- **NFS 의 파일.** 파일 저장소가 NFS 면 파일은 백업에 넣지 않는다. 파일은 이미 다른 장비에 있고, 그것을 서버의 로컬 디스크로 다시 끌어오는 것은 대개 용량도 뜻도 맞지 않는다. manifest 에는 저장소 정보(`server`, `export`)만 남는다. NAS 쪽의 스냅숏·복제로 따로 지킨다. 복원은 DB 만 되돌리므로, **DB 를 백업한 시점과 NFS 의 파일 상태가 다르면** 그 사이에 지운 파일은 목록에만 남고 그 사이에 올린 파일은 목록에 없다.
- **설치된 플러그인의 코드**(`plugins/`), 컨테이너 이미지, 로그.
- **회의 녹화 볼륨**(파일 저장소로 옮겨지기 전의 임시 출력).

### Redis 에서 DB 로 옮긴 값

| 값 | 지금 있는 곳 | 예전 Redis 키 |
|---|---|---|
| 개인 잠금 PIN(해시) | `privacy_pins` 표 | `privacy:pin:<사용자 id>` |
| POP3 계정의 읽음·별표 | `mail_pop3_state` 표(계정 + UIDL) | `mail:pop3:read:<계정 id>`, `mail:pop3:flag:<계정 id>` (집합) |
| 새 메일 감시가 마지막으로 본 위치 | `mail_accounts.last_seen_uid` | `mail:lastuid:<계정 id>` |

스키마 변경 단계 2 는 자리만 만든다(변경 단계는 DB 만 만질 수 있다). 값은 backend 가 옮긴다 — **기동하고 20초쯤 뒤에 한 번 훑어** 남은 것을 모두 옮기고(`backend/app/db/redis_handoff.py`), 그 전에 누가 먼저 읽으면 그때 옮긴다.

- **읽기**: DB 에 값이 있으면 그것만 쓴다. 없으면 예전 Redis 키를 한 번 보고, 있으면 DB 에 쓴 뒤 그 값을 쓴다. POP3 의 읽음·별표는 "행이 없다"가 "읽은 것이 없다"일 수도 있으므로 계정마다 옮겼다는 표시(`mail_accounts.pop3_state_imported`)를 따로 두고 한 번만 옮긴다. 여러 워커가 동시에 와도 하나만 옮긴다.
- **쓰기**: DB 에 쓰고, 예전 Redis 키에도 같은 값을 써 둔다. Redis 쪽은 **읽지 않는 사본**이다. 옮긴 뒤에도 예전 키를 지우지 않는다.
- **왜 사본을 두나**: 업데이트가 실패하면 이전 버전의 이미지로 되돌아가는데(5 절), 그 버전은 Redis 의 키만 읽는다. 키를 지웠거나 낡은 채로 두면 되돌아간 서버에서 PIN 이 사라지거나, 읽은 메일이 안 읽음으로 돌아가거나, 그 사이의 메일을 새 메일로 다시 알린다. 사본은 Redis 가 없어도(쓰기 실패) 동작에 영향이 없다.
- **낡은 값이 되살아나지 않는가**: DB 에 값(또는 옮겼다는 표시)이 생긴 뒤로는 Redis 를 읽지 않는다. DB 에 값이 없는 것은 아직 옮기지 않았을 때뿐이고, 그때의 Redis 값이 곧 지금 값이다. 스키마 버전 1 에서 만든 백업을 복원한 경우도 같다 — DB 에 자리가 비어 있으니 Redis 에 남은 값(있다면)을 옮겨 온다.
- Redis 를 비워도(복원, 볼륨 유실) 이미 옮긴 값은 남는다. 업데이트한 backend 가 한 번 뜨고 나면 남는 것이 없다 — 기동 때의 훑기가 실패했으면(로그 `[handoff]`) 다음 기동 때, 또는 그 값이 처음 읽힐 때 다시 옮긴다.

### 암호화 키

`config` 항목의 `.env` 에는 `SECRET_KEY` 가 있다. 이 키로 DB 안의 다음 값들이 암호화돼 있다: 외부 메일 계정 비밀번호, 2단계 인증 비밀, 저장소 접근 키, AI 제공자 키 등.

- **키를 잃으면** DB 를 복원해도 그 값들은 풀 수 없다. 사용자는 외부 메일 계정을 다시 연결하고 2단계 인증을 다시 등록해야 하며, 관리자는 저장소·AI 키를 다시 넣어야 한다. 그래서 백업에는 키가 **들어간다**.
- 그러므로 **백업 파일을 가진 사람은 서버의 모든 데이터를 읽을 수 있다.** 파일 권한을 600 으로 만들고, 만들 때마다 경고를 낸다.
- **암호 보호(선택)**: 암호를 주면 `config` 항목을 AES-256-GCM 으로 암호화한다(키는 scrypt 로 암호에서 만든다). `config.tar.enc` 가 되고 manifest 에 `encrypted: true`. 암호는 명령 인자가 아니라 `--password-file <파일>` 또는 환경변수 `JW_BACKUP_PASSWORD` 로 준다. **이 암호를 잃으면 설정 항목은 꺼낼 수 없다.** DB 덤프 등 다른 항목은 암호화하지 않는다 — 백업 전체를 지키려면 보관하는 곳을 암호화한다.
- 복원할 때 백업의 키 지문이 지금 서버의 키와 다르면 멈추고 묻는다(4 절).

### 만들기 전의 검사와 만든 뒤의 검증

- 시작하기 전에 대상 위치에 **쓸 수 있는지**, **여유 공간이 예상 크기보다 넉넉한지** 본다(예상 크기는 압축 전 크기로 넉넉하게 센다). 모자라면 시작하지 않고 이유를 낸다.
- 다 만든 뒤 manifest 의 해시로 **자체 검증**한다. 통과하지 못하면 백업을 남기지 않는다.
- `db` 를 못 뜨면 백업 전체가 실패다(디렉터리를 남기지 않는다). 다른 항목이 실패하면 그 항목을 빼고 **"일부"** 로 보고한다(무엇이 빠졌는지 manifest 의 `skipped`·`warnings` 와 종료 코드 2).
- 관리 화면의 백업은 서버의 백업 볼륨에 쌓인다. **같은 서버에만 있는 백업은 그 서버의 디스크가 죽으면 같이 죽는다** — `scripts/backup.sh <폴더>` 로 꺼내거나 내려받아 다른 곳에 둔다.

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

`create` 는 backend 컨테이너 안에서 돈다(`docker exec ws-backend …`). 종료 코드: 0 성공, 1 실패, 2 일부 항목이 빠진 백업.

호스트에서는 `sudo bash scripts/backup.sh [받을-폴더] [--kind …] [--include-files] [--password-file F]` — 백업을 만들어 tar 한 개로 묶고, 호스트 폴더로 꺼내고, 꺼낸 파일의 해시를 확인하고, 30일 넘은 것을 지운다.

### 구조: 계획과 실행의 분리

- `backup/plan.py` — 순수 함수. 입력은 구성(`StackConfig`: 컨테이너 이름, DB, 볼륨 위치, 구역), 출력은 단계 목록(`Step`: 명령 인자, 출력/입력 파일, 허용 종료 코드, "실패해도 돈다" 표시). 아무것도 실행하지 않는다. `to_dict()` 로 JSON 이 된다.
- `backup/runner.py` — 구성을 알아내고(`discover`), 단계를 주입된 실행기로 돌리고, 결과를 형식으로 묶는다. 기본 실행기는 backend 컨테이너의 docker CLI 다.
- `backup/format.py` — manifest·해시·암호·묶기·요약. 표준 라이브러리와 `cryptography` 만 쓴다.

설치 관리자는 backend 컨테이너에서 CLI 를 부르거나, `backup plan --json` 의 단계 목록을 자기 실행기로 돌릴 수 있다.

---

## 3. 내용 요약

`backup.format.summarize(path)`(= `backup inspect --json`)는 백업을 풀지 않고 manifest 만 읽어 돌려준다. 설치 마법사의 "백업에서 복원" 확인 화면이 쓴다.

`created_at`, `product_version`(= `backup_version`), `schema_version`, `postgres_version`, `install_id`, `domain`, `source_url`, `zones`, `users`, `data_bytes`, `storage`, `storage_bytes`, `files_included`, `files_bytes`, `items`, `skipped`, `config_included`, `config_encrypted`, `size_bytes`, `kind`.

사용자 수·데이터 크기는 백업을 만들 때 manifest 에 넣어 둔 값이다.

---

## 4. 복원

```
sudo bash scripts/restore.sh <백업 파일 또는 폴더> [--items a,b] [--with-config] [--password-file F] [--yes]
sudo bash scripts/restore.sh <백업> --inspect      # 내용만 본다
```

스크립트는 backend 이미지의 **일회용 컨테이너**에서 `python -m app.cli restore` 를 부른다. 리포 폴더에서 직접 띄운 서버용이다. 설치 관리자로 설치한 서버에서는 같은 일을 `docker exec jw-installer jw restore <백업> [--yes]` 가 한다(설정은 되돌리지 않는다 — [installer.md](installer.md) 6절의 "같은 서버에 되돌리기").

**앱 안에서는 복원하지 않는다.** 복원은 backend 를 세우고 DB 를 갈아 끼운 뒤 다시 띄우는 일인데, 실행 중인 backend 는 자신을 세울 수 없다. 그래서 복원하는 API 와 화면은 앱에 없다(돌아가는 DB 위에 덤프를 덮어쓰던 예전의 앱 내 복원은 없앴다). 실행 중인 backend 컨테이너 안에서 `restore` 를 부르면 아무것도 건드리지 않고 거부한다.

### 순서

| 단계 | 하는 일 | 여기서 실패하면 |
|---|---|---|
| `verify` | 형식 버전, 모든 파일의 크기·SHA-256, (설정을 되돌릴 때) 암호 | 아무것도 건드리지 않았다 |
| `compat` | 버전 판정(아래), 암호화 키 지문, 복원할 위치 확인 | 〃 |
| `extract` | tar 면 작업 폴더에 푼다(공간 확인) | 〃 |
| `safety-dump` | **지금 DB 를 떠 둔다** → `<백업 위치>/_pre-restore/<시각>.dump` | 〃 |
| `stop` | DB 를 쓰는 서비스(backend, SSO, LDAP)와 되돌릴 항목의 서비스(메일, 코드 저장소)를 세운다 | 다시 띄운다 |
| `db-load` | 덤프를 **옆 DB**(`<이름>_restore_new`)에 올린다. 오류 하나에도 멈춘다 | 옆 DB 를 지우고 서비스를 다시 띄운다. 쓰던 DB 는 그대로 |
| `db-swap` | 쓰던 DB 를 `<이름>_restore_old` 로 옮기고 새 DB 를 제자리에 둔다(이름 바꾸기) | 이름을 되돌린다 |
| `migrate` | 복원한 DB 에 스키마 변경 단계를 적용한다 | **원래 DB 로 되돌린다** |
| `items` | DB 밖의 항목을 되돌린다(볼륨을 비우고 백업 시점 그대로 푼다) | 실패로 보고한다. 복원한 DB 는 그대로 두고, 복원 전 DB 가 어디 있는지 알려 준다 |
| `config` | `--with-config` 일 때 설정 묶음을 프로젝트 폴더에 푼다 | 〃 |
| `start` | 세운 서비스를 반대 순서로 띄운다 | 실패로 보고 |
| `check` | backend 가 정상 상태가 될 때까지 기다린다(기본 300초) | 실패로 보고 |
| 정리 | 옮겨 둔 원래 DB 와 작업 폴더를 지운다. **안전 덤프는 남긴다**(최근 2개) | |

어느 단계든 실패하면 종료 코드 1 과 `복원 실패 — 단계 '<이름>': <원인> (<그 뒤의 상태>)` 를 낸다. `--json` 이면 `{"ok": false, "stage", "error", "state", "done"}`.

DB 는 `migrate` 까지 통과해야 확정된다. 그 전의 실패는 쓰던 DB 를 건드리지 않았거나 되돌린다. DB 밖의 항목은 되돌릴 수 없으므로 되돌릴 수 있는 것이 다 끝난 **뒤에** 한다.

안전 덤프는 복원이 성공한 뒤에도 남는다 — 엉뚱한 백업을 복원했을 때 되돌아갈 수단이다(`pg_restore` 로 직접 올리거나, 그 덤프로 백업 폴더를 꾸려 다시 복원한다).

### 버전 판정

- 백업의 `schema_version` **≤** 지금 코드의 `SCHEMA_VERSION` → 복원한 뒤 `migrate` 가 차이를 메운다.
- **더 높으면 거부**한다. 그 백업을 만든 버전 이상의 제품에서 복원해야 한다.
- 백업을 만든 PostgreSQL 의 메이저 버전이 지금 것보다 높아도 거부한다.

### 설정과 암호화 키

기본으로 `config` 는 되돌리지 않는다(같은 서버에서 DB 만 되돌리는 경우가 보통이고, `.env` 는 그 사이에 바뀌었을 수 있다).

- 백업과 지금 서버의 **암호화 키가 다르면** `compat` 에서 멈춘다. 그대로 복원하면 DB 안의 암호화된 값을 풀 수 없기 때문이다. `--with-config` 로 설정까지 되돌리거나, 알고도 진행하려면 `--allow-key-mismatch`.
- `--with-config` 는 `.env` 를 덮어쓴다. 컨테이너는 만들어질 때의 환경으로 돌기 때문에 끝난 뒤 스택을 다시 만들어야 한다(`scripts/restore.sh` 가 `docker compose up -d` 를 부른다).

### 새 서버로 옮기기

설치 마법사의 시작 방식 **"백업에서 복원"** 이 아래를 한 번에 한다([installer.md](installer.md) §14). 답변 파일(`"mode": "restore"`)로도 된다.

1. 원래 서버에서 전체 백업을 만든다: `backup create --kind full --include-files --pack`(파일 저장소가 NFS 면 `--include-files` 없이 — 파일은 그 저장소에 있다). 관리 화면의 "지금 백업" → 내려받기도 같다.
2. 새 서버에 설치 관리자를 띄우고 "백업에서 복원"을 고른다. 백업 파일을 올리거나, 서버에 미리 옮겨 둔 파일의 경로를 알려 준다.
3. 내용(만든 서버·버전·구역·파일 포함 여부)을 확인하고, 이 서버에서 다시 정할 것만 정한다 — 접속 주소, 연결 형태, 파일 저장 위치. 원래 저장소가 NFS 였으면 같은 공유를 다시 연결한다(표식의 설치 id 로 같은 공유인지 본다).
4. 설치 관리자가 백업의 설정에서 암호화 키·DB 비밀번호·구역·설치 id 를 가져와 스택을 꾸리고, 빈 DB 에 `restore` 로 데이터를 올린 뒤 스키마를 맞추고, 파일을 되돌리고, 구역을 띄운다.
5. 접속 주소의 레코드를 새 서버로 옮기고, 확인한 뒤 원래 서버를 끈다.

손으로 할 때의 순서도 같다: `backup extract-config <백업> --out <프로젝트 폴더>` 로 설정을 **먼저** 꺼내고(`.env` 의 DB 비밀번호와 암호화 키가 있어야 그 뒤가 맞는다. 접속 주소에 딸린 값은 새 서버에 맞게 고친다) → 그 설정으로 스택을 띄우고(빈 DB) → `restore <백업>`(설정은 이미 맞으므로 `--with-config` 없이) → 파일 저장소가 NFS 였으면 같은 저장소를 붙인다. 파일 저장소의 설치 표식에는 백업을 만든 설치의 id 가 적혀 있으므로 새 서버의 `JW_INSTALL_ID` 가 같아야 한다(꺼낸 `.env` 를 그대로 쓰면 같다).

### 예전 형식의 백업

이 형식 이전에 만든 백업(`postgres_*.sql.gz`, 또는 `postgres.dump` + `storage.tar.gz` 폴더)은 `manifest.json` 이 없어 `restore` 가 읽지 않는다. 필요하면 손으로 올린다: backend 를 세우고, 빈 DB 를 만들어 `psql`(sql.gz) 또는 `pg_restore`(dump)로 올린 뒤 `python -m app.cli migrate` 를 돌린다.

---

## 5. 업데이트와 되돌림

설치 관리자의 업데이트 순서와 이 문서의 것들이 맞물리는 자리:

| 순서 | 부르는 것 |
|---|---|
| 사전 점검 | `migrate --check`(대기 단계가 있는지), `backup inspect`·여유 공간 |
| 자동 백업 | `backup create --kind pre-update --json` — `db` + `config` |
| 이미지 받기 | 새 릴리스의 manifest 의 `db_schema` = 그 릴리스의 `schema-version` 출력 |
| **DB 변경** | 새 이미지로 `migrate`. 종료 코드 0 이 아니면 여기서 멈춘다 |
| 구역 교체 | `JW_MIGRATE_ON_START=0` 으로 띄우면 backend 는 스키마를 건드리지 않고 버전만 확인한다 |
| 상태 확인 | `/api/health`, `migrate --status` |

**되돌림**: 역방향 마이그레이션은 없다. 실패하면 이전 이미지로 되돌리고 **DB 는 직전 백업으로 복원**한다.

- 단계가 실패하면 그 단계는 트랜잭션째 사라지지만, **앞서 성공한 단계는 적용된 채 남는다.** 그래서 DB 는 이전 코드가 아는 버전보다 높아져 있을 수 있다.
- 그 상태에서 이전 이미지를 띄우면 backend 는 **뜨지 않는다**("DB 스키마 버전이 코드가 요구하는 버전보다 높습니다"). 조용히 어긋난 스키마로 도는 대신 멈추는 것이다.
- 그러므로 되돌림은 한 쌍이다: 이전 이미지 + `restore <직전 pre-update 백업>`(이전 이미지의 일회용 컨테이너에서). 백업의 스키마 버전은 이전 코드의 버전과 같으므로 판정을 통과한다.
- 업데이트를 시작한 뒤부터 되돌릴 때까지 들어온 변경은 사라진다. 업데이트 동안 쓰기를 막는 것은 설치 관리자의 일이다.

---

## 6. 검증

- 스키마: `backend/tests/test_schema_migrate.py`(SQLite), `backend/tests/test_schema_migrate_pg.py`(실제 PostgreSQL — 환경변수 `JW_TEST_PG_URL` 이 있을 때만 돈다: 새 DB, 기존 DB 무손실 편입, 동시 실행 8개, 잠금 대기, 실패 단계의 DDL 되돌림).
- 백업·복원: `backend/tests/test_backup_restore.py`(가짜 실행기로 형식·해시·암호·공간 부족·손상·버전 판정·단계별 실패와 되돌림).
- 실제 `pg_dump`/`pg_restore`·볼륨 왕복은 docker 가 있는 장비에서 임시 스택으로 확인한다.
