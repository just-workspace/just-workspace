#!/usr/bin/env bash
# =============================================
# just-workspace — 복원
# =============================================
# 쓰는 법: sudo bash scripts/restore.sh <백업 파일(.jwbak) 또는 백업 폴더> [옵션]
#
#   --items a,b          이 항목만 (기본: 백업에 든 것 전부, 설정 제외)
#   --with-config        설정(.env — 암호화 키 포함)도 되돌린다. 끝나면 스택을 다시 만든다
#   --password-file F    설정 항목이 암호로 보호돼 있을 때
#   --allow-key-mismatch 백업과 지금의 암호화 키가 달라도 진행한다
#   --yes                확인 질문 없이 진행
#   --inspect            복원하지 않고 내용만 본다
#
# 이 스크립트는 얇은 래퍼다. 실제 복원은 `python -m app.cli restore` 가 한다(docs/data-safety.md):
#   검증 → 버전 판정 → 지금 DB 덤프 → 서비스 정지 → DB 올리기 → 바꿔 끼우기 → 스키마 변경 단계 →
#   나머지 항목 → 서비스 시작 → 확인
# 어느 단계든 실패하면 종료 코드 1 과 단계 이름·원인을 낸다. DB 는 스키마 변경 단계까지 통과하지 못하면
# 복원 전 상태로 돌아간다.
#
# 복원은 backend 를 세워야 하므로 backend 컨테이너 안이 아니라, 같은 이미지의 일회용 컨테이너에서 돈다.
# =============================================

set -euo pipefail

err() { echo "[ERROR] $*" >&2; }

COMPOSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE=""
PASSWORD_FILE=""
WITH_CONFIG=false
INSPECT=false
ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --items)              ARGS+=(--items "$2"); shift 2 ;;
        --with-config)        WITH_CONFIG=true; ARGS+=(--with-config); shift ;;
        --allow-key-mismatch) ARGS+=(--allow-key-mismatch); shift ;;
        --yes)                ARGS+=(--yes); shift ;;
        --password-file)      PASSWORD_FILE="$2"; shift 2 ;;
        --inspect)            INSPECT=true; shift ;;
        -h|--help)            sed -n '2,21p' "$0"; exit 0 ;;
        -*)                   err "모르는 옵션: $1"; exit 2 ;;
        *)                    SOURCE="$1"; shift ;;
    esac
done

if [[ -z "$SOURCE" ]]; then
    sed -n '5,12p' "$0"
    echo ""
    echo "호스트의 백업 파일:"
    ls -1 "$COMPOSE_DIR"/backups/*.jwbak 2>/dev/null | sed 's/^/  /' || echo "  ($COMPOSE_DIR/backups 에 없음)"
    exit 2
fi
[[ -e "$SOURCE" ]] || { err "백업을 찾을 수 없습니다: $SOURCE"; exit 1; }
command -v docker >/dev/null || { err "docker 가 없습니다"; exit 1; }
SOURCE="$(cd "$(dirname "$SOURCE")" && pwd)/$(basename "$SOURCE")"

cd "$COMPOSE_DIR"

# 일회용 컨테이너: backend 서비스의 설정(이미지·환경·볼륨·docker 소켓)을 그대로 쓰되 서버는 띄우지 않는다.
# 호스트의 백업 파일은 소유자만 읽을 수 있으므로 root 로 돈다.
RUN=(docker compose run --rm --no-deps --user 0 --entrypoint python -v "$SOURCE:/restore-src:ro")
if [[ ! -t 0 ]]; then
    RUN+=(-T)
fi
if [[ -n "$PASSWORD_FILE" ]]; then
    [[ -r "$PASSWORD_FILE" ]] || { err "암호 파일을 읽을 수 없습니다: $PASSWORD_FILE"; exit 1; }
    JW_BACKUP_PASSWORD="$(head -n 1 "$PASSWORD_FILE")"
    export JW_BACKUP_PASSWORD
    RUN+=(-e JW_BACKUP_PASSWORD)
fi

if $INSPECT; then
    exec "${RUN[@]}" backend -m app.cli backup inspect /restore-src
fi

set +e
"${RUN[@]}" backend -m app.cli restore /restore-src ${ARGS[@]+"${ARGS[@]}"}
RC=$?
set -e
if [[ $RC -eq 3 ]]; then
    exit 0          # 확인 질문에서 취소했다
fi
if [[ $RC -ne 0 ]]; then
    err "복원이 끝나지 않았습니다(종료 코드 $RC) — 위의 단계 이름과 원인을 확인하세요"
    exit "$RC"
fi

if $WITH_CONFIG; then
    echo "[INFO] 되돌린 설정(.env)으로 스택을 다시 만듭니다"
    docker compose up -d
fi
echo "[OK] 복원을 마쳤습니다. 모든 사용자는 다시 로그인해야 합니다."
