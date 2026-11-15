#!/usr/bin/env bash
# =============================================
# just-workspace — 업데이트(설치 관리자 없이 직접 띄운 서버용)
# =============================================
# 설치 관리자로 설치한 서버는 이 스크립트를 쓰지 않는다 — 관리 › 업데이트가 백업·되돌림까지 한다.
# 이 스크립트는 리포 폴더에서 `docker compose` 로 직접 띄운 서버(docs/deployment.md)를 소스에서 다시 빌드해 올린다.
#
# 쓰는 법:
#   bash scripts/update.sh              # git pull → 빌드 → 다시 띄우기 → 확인
#   bash scripts/update.sh --no-pull    # git pull 생략(지금 폴더의 소스로)
#   bash scripts/update.sh --rollback   # 직전 업데이트 때 적어 둔 이미지로 되돌린다
#
# 하는 일:
#   1. 지금 돌고 있는 우리 이미지의 이름과 ID 를 적어 둔다(.update-rollback)
#   2. git pull --ff-only
#   3. 켜진 프로파일의 우리 이미지를 다시 빌드한다
#   4. docker compose up -d (backend 가 뜰 때 DB 스키마 변경 단계를 적용한다)
#   5. backend 의 상태를 확인한다
#
# 알아 둘 것:
#   - 서비스가 다시 뜨는 동안 접속이 잠깐 끊긴다.
#   - **실패해도 스스로 되돌리지 않는다.** 실패하면 종료 코드 1 과 함께 되돌리는 방법을 알려 줄 뿐이다.
#   - **DB 를 백업하지 않는다.** 먼저 `sudo bash scripts/backup.sh --kind pre-update` 를 돌린다.
#   - `--rollback` 은 이미지만 되돌린다. 업데이트가 DB 스키마 버전을 올렸으면 이전 이미지의 backend 는
#     뜨지 않는다 — 그때는 업데이트 직전 백업으로 DB 도 되돌린다(`sudo bash scripts/restore.sh <백업> --items db`).
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

# 기다린다: backend 컨테이너가 healthy 가 될 때까지(초)
wait_backend() {
  local limit="$1" status=""
  for _ in $(seq 1 "$limit"); do
    status="$(docker inspect ws-backend --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    # 스키마가 맞지 않거나 비밀값이 틀리면 backend 는 뜨지 않고 끝난다 — 끝까지 기다리지 않는다
    [[ "$status" == "exited" || "$status" == "dead" ]] && return 1
    sleep 1
  done
  return 1
}

# ─── 되돌리기 ───
if $ROLLBACK; then
  [[ -s "$ROLLBACK_FILE" ]] || { err "되돌릴 정보가 없습니다($ROLLBACK_FILE)"; exit 1; }
  info "직전 업데이트 때의 이미지로 되돌립니다"
  failed=0
  while IFS='|' read -r service ref image_id; do
    [[ -n "$service" && -n "$ref" && -n "$image_id" ]] || continue
    if docker image inspect "$image_id" >/dev/null 2>&1 && docker tag "$image_id" "$ref"; then
      info "  $service → $ref = ${image_id:0:19}"
    else
      err "  $service: 이전 이미지($image_id)가 서버에 없습니다"
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

# ─── 1. 지금 이미지 적어 두기 ───
info "1/5 지금 돌고 있는 이미지를 적어 둡니다"
: > "$ROLLBACK_FILE"
# 우리가 빌드하는 서비스 가운데 지금 프로파일에서 켜지는 것
mapfile -t SERVICES < <(docker compose config --format json 2>/dev/null \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(n for n,s in d.get("services",{}).items() if "build" in s))' 2>/dev/null || true)
if [[ ${#SERVICES[@]} -eq 0 ]]; then
  SERVICES=(backend frontend-react)       # python3 가 없는 호스트 — 늘 있는 둘만
  warn "켜진 서비스 목록을 읽지 못해 backend·frontend-react 만 다룹니다(나머지는 docker compose build 로 직접)"
fi
for svc in "${SERVICES[@]}"; do
  cid="$(docker compose ps -q "$svc" 2>/dev/null | head -1 || true)"
  [[ -n "$cid" ]] || continue
  ref="$(docker inspect "$cid" --format '{{.Config.Image}}' 2>/dev/null || true)"
  image_id="$(docker inspect "$cid" --format '{{.Image}}' 2>/dev/null || true)"
  [[ -n "$ref" && -n "$image_id" ]] && echo "${svc}|${ref}|${image_id}" >> "$ROLLBACK_FILE"
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

# ─── 4. 다시 띄우기 ───
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
