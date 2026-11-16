#!/usr/bin/env bash
# =============================================
# just-workspace — 업데이트(설치 관리자 없이 직접 기동한 서버용)
# =============================================
# 설치 관리자로 설치한 서버는 이 스크립트를 사용하지 않는다 — 관리 › 업데이트가 백업·롤백까지 수행한다.
# 이 스크립트는 리포 폴더에서 `docker compose` 로 직접 기동한 서버(docs/deployment.md)를 소스에서 재빌드하여 갱신한다.
#
# 사용법:
#   bash scripts/update.sh              # git pull → 빌드 → 재기동 → 확인
#   bash scripts/update.sh --no-pull    # git pull 생략(현재 폴더의 소스 사용)
#   bash scripts/update.sh --rollback   # 직전 업데이트 시 기록한 이미지로 롤백한다
#
# 수행 내용:
#   1. 현재 실행 중인 자체 빌드 이미지에 롤백용 태그(<이름>-rollback)를 부여하고 기록한다(.update-rollback)
#      — 태그가 없으면 재빌드 시점에 이전 이미지가 삭제될 수 있다
#   2. git pull --ff-only
#   3. 활성화된 프로파일의 자체 빌드 이미지를 재빌드한다
#   4. docker compose up -d (backend 기동 시 DB 스키마 변경 단계를 적용한다)
#   5. backend 의 상태를 확인한다
#
# 유의 사항:
#   - 서비스가 재기동되는 동안 접속이 일시 중단된다.
#   - **실패해도 자동으로 롤백하지 않는다.** 실패 시 종료 코드 1 과 함께 롤백 방법만 안내한다.
#   - **DB 를 백업하지 않는다.** 사전에 `sudo bash scripts/backup.sh --kind pre-update` 를 실행한다.
#   - `--rollback` 은 이미지만 롤백한다. 업데이트가 DB 스키마 버전을 올린 경우 이전 이미지의 backend 는
#     기동하지 않는다 — 이 경우 업데이트 직전 백업으로 DB 도 복원한다(`sudo bash scripts/restore.sh <백업> --items db`).
#     docs/update-system.md 의 "수동 설치", docs/data-safety.md 5절.
# =============================================

set -euo pipefail

info() { echo "[INFO] $*"; }
ok()   { echo "[ OK ] $*"; }
warn() { echo "[WARN] $*"; }
err()  { echo "[ERROR] $*" >&2; }

COMPOSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$COMPOSE_DIR"

ROLLBACK_FILE="$COMPOSE_DIR/.update-rollback"
LOG_FILE="${TMPDIR:-/tmp}/ws-update-$(date +%Y%m%d_%H%M%S).log"
NO_PULL=false
ROLLBACK=false

for arg in "$@"; do
  case "$arg" in
    --no-pull)  NO_PULL=true ;;
    --rollback) ROLLBACK=true ;;
    -h|--help)  sed -n '2,27p' "$0"; exit 0 ;;
    *) err "모르는 옵션: $arg"; exit 2 ;;
  esac
done

command -v docker >/dev/null || { err "docker 가 없습니다"; exit 1; }
[[ -f .env ]] || { err ".env 가 없습니다 — 이 스크립트는 리포 폴더에서 직접 띄운 서버용입니다"; exit 1; }

# 대기: backend 컨테이너가 healthy 가 될 때까지(초)
wait_backend() {
  local limit="$1" status=""
  for _ in $(seq 1 "$limit"); do
    status="$(docker inspect ws-backend --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    # 스키마 불일치 또는 비밀값 오류 시 backend 는 기동하지 못하고 종료된다 — 제한 시간까지 대기하지 않는다
    [[ "$status" == "exited" || "$status" == "dead" ]] && return 1
    sleep 1
  done
  return 1
}

# ─── 롤백 ───
if $ROLLBACK; then
  [[ -s "$ROLLBACK_FILE" ]] || { err "되돌릴 정보가 없습니다($ROLLBACK_FILE)"; exit 1; }
  info "직전 업데이트 때의 이미지로 되돌립니다"
  failed=0
  while IFS='|' read -r service ref keep image_id; do
    [[ -n "$service" && -n "$ref" && -n "$keep" ]] || continue
    if docker image inspect "$keep" >/dev/null 2>&1 && docker tag "$keep" "$ref"; then
      info "  $service → $ref = ${image_id:0:19}"
    else
      err "  $service: 이전 이미지($keep)가 서버에 없습니다"
      failed=$((failed + 1))
    fi
  done < "$ROLLBACK_FILE"
  if [[ $failed -gt 0 ]]; then
    err "되돌리지 못한 이미지가 ${failed}개 있습니다 — 컨테이너는 건드리지 않았습니다"
    exit 1
  fi
  docker compose up -d --no-build 2>&1 | tee -a "$LOG_FILE"
  if wait_backend 180; then
    ok "되돌렸습니다"
    exit 0
  fi
  err "이미지는 되돌렸지만 backend 가 준비되지 않았습니다: docker logs ws-backend"
  warn "로그에 'DB 스키마 버전이 코드가 요구하는 버전보다 높습니다'가 있으면 업데이트 직전 백업으로 DB 도 되돌려야 합니다:"
  warn "  sudo bash scripts/restore.sh <업데이트 직전 백업> --items db"
  exit 1
fi

# ─── 1. 현재 이미지 기록 ───
info "1/5 지금 돌고 있는 이미지를 적어 둡니다"
: > "$ROLLBACK_FILE"
# 자체 빌드 서비스 중 현재 프로파일에서 활성화되는 것
mapfile -t SERVICES < <(docker compose config --format json 2>/dev/null \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(n for n,s in d.get("services",{}).items() if "build" in s))' 2>/dev/null || true)
if [[ ${#SERVICES[@]} -eq 0 ]]; then
  SERVICES=(backend frontend-react)       # python3 가 없는 호스트 — 항상 존재하는 두 서비스만
  warn "켜진 서비스 목록을 읽지 못해 backend·frontend-react 만 다룹니다(나머지는 docker compose build 로 직접)"
fi
for svc in "${SERVICES[@]}"; do
  cid="$(docker compose ps -q "$svc" 2>/dev/null | head -1 || true)"
  [[ -n "$cid" ]] || continue
  ref="$(docker inspect "$cid" --format '{{.Config.Image}}' 2>/dev/null || true)"
  image_id="$(docker inspect "$cid" --format '{{.Image}}' 2>/dev/null || true)"
  [[ -n "$ref" && -n "$image_id" ]] || continue
  # 롤백용 이름 — 재빌드 시 원래 이름은 새 이미지로 이전되고, 이름이 없어진 이전 이미지는 삭제될 수 있다
  case "${ref##*/}" in *:*) keep="${ref}-rollback" ;; *) keep="${ref}:rollback" ;; esac
  if docker tag "$image_id" "$keep" 2>/dev/null; then
    echo "${svc}|${ref}|${keep}|${image_id}" >> "$ROLLBACK_FILE"
  else
    warn "  $svc: 지금 이미지에 되돌릴 때 쓸 태그를 붙이지 못했습니다 — 이 서비스는 되돌릴 수 없습니다"
  fi
done
ok "적어 둠: $ROLLBACK_FILE ($(wc -l < "$ROLLBACK_FILE")개)"
warn "이 스크립트는 DB 를 백업하지 않습니다 — 아직이면 멈추고 먼저: sudo bash scripts/backup.sh --kind pre-update"

# ─── 2. 소스 ───
if $NO_PULL; then
  info "2/5 git pull 생략(--no-pull)"
else
  info "2/5 git pull --ff-only"
  before="$(git rev-parse --short HEAD 2>/dev/null || echo "?")"
  if ! git pull --ff-only 2>&1 | tee -a "$LOG_FILE"; then
    err "git pull 실패 — 아무것도 바꾸지 않았습니다"
    exit 1
  fi
  after="$(git rev-parse --short HEAD 2>/dev/null || echo "?")"
  [[ "$before" == "$after" ]] && ok "이미 최신입니다($before)" || ok "$before → $after"
fi

# ─── 3. 빌드 ───
info "3/5 이미지 빌드: ${SERVICES[*]}"
if ! docker compose build "${SERVICES[@]}" >> "$LOG_FILE" 2>&1; then
  err "빌드 실패 — 돌고 있는 컨테이너는 그대로입니다. 로그: $LOG_FILE"
  exit 1
fi
ok "빌드 완료"

# ─── 4. 재기동 ───
info "4/5 다시 띄웁니다(잠깐 접속이 끊깁니다)"
if ! docker compose up -d --no-build >> "$LOG_FILE" 2>&1; then
  err "docker compose up 실패. 로그: $LOG_FILE"
  warn "이미지를 되돌리려면: bash scripts/update.sh --rollback"
  exit 1
fi

# ─── 5. 확인 ───
info "5/5 backend 가 준비되기를 기다립니다(스키마 변경 단계가 있으면 여기서 적용됩니다)"
if wait_backend 300 && docker exec ws-backend python -c \
    "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health', timeout=5)" 2>/dev/null; then
  ok "업데이트 완료 — $(docker exec ws-backend python -m app.cli schema-version 2>/dev/null | sed 's/^/DB 스키마 버전 /' || true)"
  info "로그: $LOG_FILE"
  exit 0
fi
err "backend 가 준비되지 않았습니다: docker logs ws-backend"
warn "스스로 되돌리지 않습니다. 이미지를 되돌리려면: bash scripts/update.sh --rollback"
warn "DB 스키마 버전이 이미 올라갔으면 업데이트 직전 백업으로 DB 도 되돌려야 합니다: sudo bash scripts/restore.sh <백업> --items db"
warn "로그: $LOG_FILE"
exit 1
