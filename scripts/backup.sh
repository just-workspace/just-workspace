#!/usr/bin/env bash
# =============================================
# just-workspace — 백업
# =============================================
# 사용법: sudo bash scripts/backup.sh [받을-폴더] [옵션]
#
#   받을-폴더            백업 파일(.jwbak)을 저장할 호스트 폴더 (기본 ./backups)
#   --kind full|pre-update   full = 전체(기본), pre-update = DB 와 설정만
#   --include-files      파일 저장소도 포함한다(로컬 저장소일 때만 — NFS 는 포함하지 않는다)
#   --password-file F    설정 항목(.env — 암호화 키)을 이 파일의 암호로 보호한다
#   --keep-days N        받을-폴더에서 N일을 초과한 .jwbak 을 삭제한다 (기본 30, 0 = 삭제하지 않음)
#
# 이 스크립트는 얇은 래퍼이다. 백업은 backend 컨테이너의 `python -m app.cli backup create` 가 생성하고
# (관리 화면·설치 관리자와 동일한 형식 — docs/data-safety.md), 여기서는 그 결과를 tar 한 개로 묶어
# 호스트로 추출한다.
#
# 백업에는 암호화 키(SECRET_KEY)와 DB·서비스 비밀번호가 포함된다. 파일 권한은 600 으로 설정한다.
# Redis 는 백업하지 않는다(세션·캐시 — 복원 후 재로그인 필요).
# =============================================

set -euo pipefail

info()  { echo "[INFO] $*"; }
err()   { echo "[ERROR] $*" >&2; }

BACKEND="${JW_CONTAINER_PREFIX:-ws-}backend"
OUT_DIR="./backups"
KEEP_DAYS=30
PASSWORD_FILE=""
ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --kind)           ARGS+=(--kind "$2"); shift 2 ;;
        --include-files)  ARGS+=(--include-files); shift ;;
        --password-file)  PASSWORD_FILE="$2"; shift 2 ;;
        --keep-days)      KEEP_DAYS="$2"; shift 2 ;;
        -h|--help)        sed -n '2,19p' "$0"; exit 0 ;;
        -*)               err "모르는 옵션: $1"; exit 2 ;;
        *)                OUT_DIR="$1"; shift ;;
    esac
done

command -v docker >/dev/null || { err "docker 가 없습니다"; exit 1; }
if [[ "$(docker inspect -f '{{.State.Running}}' "$BACKEND" 2>/dev/null)" != "true" ]]; then
    err "$BACKEND 컨테이너가 실행 중이 아닙니다 — 백업은 backend 가 떠 있을 때 만듭니다"
    exit 1
fi

EXEC=(docker exec)
if [[ -n "$PASSWORD_FILE" ]]; then
    [[ -r "$PASSWORD_FILE" ]] || { err "암호 파일을 읽을 수 없습니다: $PASSWORD_FILE"; exit 1; }
    # 값을 명령 인자로 전달하지 않는다 — 이름만 전달하고 값은 환경변수로 전달
    JW_BACKUP_PASSWORD="$(head -n 1 "$PASSWORD_FILE")"
    export JW_BACKUP_PASSWORD
    EXEC+=(-e JW_BACKUP_PASSWORD)
fi

umask 077
mkdir -p "$OUT_DIR"

info "백업을 만듭니다(컨테이너 $BACKEND)"
set +e
RESULT="$("${EXEC[@]}" "$BACKEND" python -m app.cli backup create --pack --json ${ARGS[@]+"${ARGS[@]}"})"
RC=$?
set -e
# 0 = 성공, 2 = 일부 항목이 누락된 백업(파일은 생성됨), 그 외 = 실패
if [[ $RC -ne 0 && $RC -ne 2 ]]; then
    err "백업 실패(종료 코드 $RC)"
    exit 1
fi

# 결과 JSON 의 첫 "path" 가 컨테이너 내부의 백업 파일이다
INNER="$(printf '%s\n' "$RESULT" | sed -n 's/^  "path": "\(.*\)",\{0,1\}$/\1/p' | head -n 1)"
if [[ -z "$INNER" ]]; then
    err "백업 결과를 읽지 못했습니다"
    exit 1
fi
NAME="$(basename "$INNER")"

# 묶은 파일을 검증하고(형식 정보는 컨테이너 측에 있다), 추출 후 해시 일치 여부를 확인한다
if ! docker exec "$BACKEND" python -m app.cli backup verify "$INNER" >/dev/null; then
    err "만든 백업이 검증을 통과하지 못했습니다: $INNER"
    exit 1
fi
SUM_IN="$(docker exec "$BACKEND" sha256sum "$INNER" | cut -d' ' -f1)"
docker cp "$BACKEND:$INNER" "$OUT_DIR/$NAME"
chmod 600 "$OUT_DIR/$NAME"
SUM_OUT="$(sha256sum "$OUT_DIR/$NAME" | cut -d' ' -f1)"
if [[ -z "$SUM_IN" || "$SUM_IN" != "$SUM_OUT" ]]; then
    err "꺼낸 백업 파일이 원본과 다릅니다(컨테이너 안의 $INNER 는 남겨 두었습니다): $OUT_DIR/$NAME"
    exit 1
fi
docker exec "$BACKEND" rm -f "$INNER"

if [[ "$KEEP_DAYS" =~ ^[0-9]+$ && "$KEEP_DAYS" -gt 0 ]]; then
    find "$OUT_DIR" -maxdepth 1 -type f -name '*.jwbak' -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/[INFO] 오래된 백업 삭제: /'
fi

info "백업: $OUT_DIR/$NAME ($(du -h "$OUT_DIR/$NAME" | cut -f1))"
echo "[주의] 이 파일에는 암호화 키와 비밀번호가 들어 있습니다 — 접근이 제한된 곳에 보관하세요."
if [[ $RC -eq 2 ]]; then
    err "일부 항목이 백업에 들어가지 못했습니다 — 위의 경고를 확인하세요"
    exit 2
fi
