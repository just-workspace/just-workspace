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

exec gosu appuser "$@"
