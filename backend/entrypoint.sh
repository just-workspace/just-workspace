#!/bin/sh
# docker.sock 의 그룹 gid 를 런타임에 감지해 appuser 를 해당 그룹에 넣고 appuser 로 강등.
# (호스트마다 docker 그룹 gid 가 달라 빌드타임 하드코딩으론 권한이 안 맞음)
set -e

SOCK=/var/run/docker.sock
if [ -S "$SOCK" ]; then
    SGID="$(stat -c '%g' "$SOCK" 2>/dev/null || echo '')"
    if [ -n "$SGID" ] && [ "$SGID" != "0" ]; then
        if ! getent group "$SGID" >/dev/null 2>&1; then
            groupadd -g "$SGID" dockerhost 2>/dev/null || true
        fi
        GN="$(getent group "$SGID" | cut -d: -f1)"
        [ -n "$GN" ] && usermod -aG "$GN" appuser 2>/dev/null || true
    fi
fi

# 격리 브라우저 동적 허용 목록(rbi-allow 볼륨) — 백엔드만 쓴다. 이미 있던 볼륨이 루트 소유여도 쓸 수 있게(사이드카는 읽기 전용)
if [ -d /run/rbi-allow ]; then chown appuser /run/rbi-allow 2>/dev/null || true; fi

# 앱 서버를 띄울 때만: 비밀값 검사 → 워커 수 결정
if [ "$1" = "uvicorn" ]; then
    # 약한·기본 비밀값이면 여기서 멈춘다(워커가 뜨기 전에 한 번만, 변수마다 사유 한 줄 — app/security_defaults.py).
    # 채우는 법: python -m app.cli gen-secrets --merge .env --in-place
    gosu appuser python -m app.cli check-secrets || exit 1

    # 워커 수 — 명령에 --workers 가 없으면 BACKEND_WORKERS, 그것도 없으면 CPU 수 기준 min(8, max(2, nproc)).
    case " $* " in
        *" --workers "*) ;;
        *)
            W="${BACKEND_WORKERS:-}"
            case "$W" in
                ''|*[!0-9]*|0)
                    N="$(nproc 2>/dev/null || echo 2)"
                    W="$N"
                    if [ "$W" -lt 2 ]; then W=2; fi
                    if [ "$W" -gt 8 ]; then W=8; fi
                    ;;
            esac
            set -- "$@" --workers "$W"
            ;;
    esac
fi

exec gosu appuser "$@"
