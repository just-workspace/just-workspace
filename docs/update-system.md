# Update System

## 업데이트 방식

Git(소스 빌드) 또는 prebuilt 이미지 pull 기반이다.

### `scripts/update.sh`

```bash
bash scripts/update.sh              # git pull → 순차 재빌드 → 헬스체크
bash scripts/update.sh --no-pull    # git pull 생략(로컬 변경만 반영)
bash scripts/update.sh --rollback   # 직전 이미지 태그로 롤백
```

현재 이미지 태그를 백업해 두고 서비스를 순차 재빌드·재기동하며, 헬스체크(`/api/health`)가 실패하면 자동으로 롤백한다. `scripts/health.sh` 는 Docker·컨테이너·DB·Redis·API·디스크·NFS·SSL 만료를 점검한다(`--json`).

## DB 마이그레이션

backend 기동 시 `init_db()` 가 자동 실행한다(`backend/app/db/session.py`). 별도 명령 없음.

- `create_all` 로 새 테이블, `ALTER TABLE ... ADD COLUMN` 으로 새 컬럼(기존 데이터 보존), 각 단계는 SAVEPOINT 로 독립 실행, 이미 적용된 것은 건너뜀
- **PostgreSQL 세션 advisory lock** 안에서 돈다 — uvicorn 워커 8개가 동시에 기동해도 하나만 스키마를 만지고 나머지는 기다린다
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

주의: 스키마가 바뀐 뒤의 롤백은 새 컬럼 추가는 안전하지만 테이블 삭제·타입 변경은 되돌릴 수 없다. 데이터 버전을 올린 컨테이너(Redis 8 RDB, Gitea 28 DB)는 백업 복원이 유일한 롤백이다.
프런트(React)도 다른 서비스와 같이 직전 이미지로 되돌린다. 옛 Vue 프런트로 되돌리는 경로는 없다.

## CI

- 배포 워크플로는 리포에 없다(사이트마다 다르다). 권장: `main` push 는 빌드·정적 검사·백엔드 테스트까지만 하고 실제 교체는 수동 실행으로 — 문서 오타 하나에 사용 중인 세션이 끊기지 않게.
- `.github/workflows/build-images.yml` — 태그 `v*` 에 멀티아치 이미지를 레지스트리로 push — [IMAGES.md](IMAGES.md).

## 백업

```bash
sudo bash scripts/backup.sh [백업디렉토리]   # PostgreSQL + Redis + 메일 데이터 + 안드로이드 서명 키, 30일 보존
sudo bash scripts/restore.sh <백업디렉토리>
```

관리 › 저장소·백업 화면의 앱 내 백업/복원(`/api/backup`)은 `BACKUP_VOLUME`(기본 `backups-vol`)에 남는다.
