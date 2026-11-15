# Update System

## 업데이트 방식

Git(소스 빌드) 또는 prebuilt 이미지 pull 기반이다.

### `scripts/update.sh`

```bash
bash scripts/update.sh              # git pull → 순차 재빌드 → 헬스체크
bash scripts/update.sh --no-pull    # git pull 생략(로컬 변경만 반영)
bash scripts/update.sh --rollback   # 직전 이미지 태그로 롤백
```

현재 이미지 태그를 적어 두고 서비스를 순차 재빌드·재기동한 뒤 헬스체크(`/api/health`)를 본다. **자동으로 되돌리지는 않는다** — 실패하면 `--rollback` 을 안내할 뿐이다. 이 스크립트는 DB 를 백업하지 않으므로 먼저 `scripts/backup.sh --kind pre-update` 를 돌린다. `scripts/health.sh` 는 Docker·컨테이너·DB·Redis·API·디스크·NFS·SSL 만료를 점검한다(`--json`).

설치 관리자로 설치한 서버는 이 스크립트가 아니라 설치 관리자가 릴리스 단위로 업데이트한다(사전 점검 → 자동 백업 → 이미지 받기 → DB 변경 → 구역 교체 → 상태 확인). 그 흐름과 되돌림은 [data-safety.md](data-safety.md) 5절. 관리 › 업데이트 화면이 부르는 내부 API 의 계약은 [update-api.md](update-api.md) — 업데이트 엔진은 아직 없고, 그 문서가 구현 기준이다.

## DB 마이그레이션

스키마에는 버전이 있다(`schema_migrations` 표, 코드가 요구하는 버전은 `backend/app/db/schema_version.py`). 자세한 것은 [data-safety.md](data-safety.md) 1절.

- 변경은 번호 붙은 단계로만 한다(`backend/app/db/migrations.py`). 단계 하나가 한 트랜잭션이고 되돌리는 단계는 없다
- 적용: `python -m app.cli migrate`(`--check`, `--status`). 한 번에 하나만 돈다(**PostgreSQL 세션 advisory lock**)
- 컨테이너가 뜰 때 워커보다 먼저 한 번 적용한다. 적용에 실패했거나 DB 가 코드보다 새것이면 **서버가 뜨지 않는다**. `JW_MIGRATE_ON_START=0` 이면 적용하지 않고 버전만 확인한다
- 컨테이너 버전 올리기(postgres 메이저, Redis 7→8, Gitea 1.27→28 등)는 compose 주석에 되돌리기 조건이 적혀 있다 — 전부 **백업 먼저**

## 버전

- 앱 버전 단일 출처: `backend/app/main.py` 의 `APP_VERSION`(`/api/health` 가 돌려준다). 패키지 버전도 여기서 나온다.
- 컨테이너 이미지 버전: `docker-compose.yml`(digest 고정 + 버전 주석)
- 의존성: `backend/requirements.txt`(전부 `==` 고정), `frontend-react/package.json`

## 롤백

```bash
bash scripts/update.sh --rollback          # 직전 이미지로
# 또는 특정 커밋
git log --oneline -10 && git checkout <해시> && docker compose build && docker compose up -d
```

주의: 이미지만 되돌리면 안 되는 경우가 있다. 업데이트가 스키마 버전을 올렸으면 이전 이미지의 backend 는 **뜨지 않는다**(DB 가 코드보다 새것) — 업데이트 직전 백업으로 DB 도 복원해야 한다(`scripts/restore.sh`, [data-safety.md](data-safety.md) 4·5절). 데이터 버전을 올린 컨테이너(Redis 8 RDB, Gitea 28 DB)도 백업 복원이 유일한 롤백이다.
프런트(React)도 다른 서비스와 같이 직전 이미지로 되돌린다. 옛 Vue 프런트로 되돌리는 경로는 없다.

## CI

- 배포 워크플로는 리포에 없다(사이트마다 다르다). 권장: `main` push 는 빌드·정적 검사·백엔드 테스트까지만 하고 실제 교체는 수동 실행으로 — 문서 오타 하나에 사용 중인 세션이 끊기지 않게.
- `.github/workflows/build-images.yml` — 태그 `v*` 에 멀티아치 이미지를 레지스트리로 push — [IMAGES.md](IMAGES.md).

## 백업

```bash
sudo bash scripts/backup.sh [받을-폴더]              # 전체 백업을 .jwbak 한 개로(30일 보존)
sudo bash scripts/backup.sh --kind pre-update        # DB 와 설정만(업데이트 직전)
sudo bash scripts/restore.sh <백업 파일>             # 검증 → 정지 → DB → 스키마 → 나머지 → 시작 → 확인
```

형식은 하나이고(관리 화면·스크립트·CLI·설치 관리자 공통), 무엇이 들어가고 빠지는지(Redis, NFS 의 파일), 암호화 키, 복원의 단계와 실패 시 동작은 [data-safety.md](data-safety.md). 관리 › 저장소·백업 화면의 백업(`/api/admin/backup`)은 `BACKUP_VOLUME`(기본 `backups-vol`)에 쌓인다. 복원은 앱 안에서 하지 않는다.
