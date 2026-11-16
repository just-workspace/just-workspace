#!/bin/sh
# docker.sock 의 그룹 gid 를 런타임에 감지하여 appuser 를 해당 그룹에 추가한 뒤 appuser 로 권한 강등.
# (호스트마다 docker 그룹 gid 가 상이하여 빌드 시점 하드코딩으로는 권한 불일치 발생)
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

# 격리 브라우저 동적 허용 목록(rbi-allow 볼륨) — 백엔드만 기록한다. 기존 볼륨이 루트 소유여도 기록 가능하도록 처리(사이드카는 읽기 전용)
if [ -d /run/rbi-allow ]; then chown appuser /run/rbi-allow 2>/dev/null || true; fi

# 사이트 CA — 접속 주소의 인증서를 사설 CA 가 발급한 설치에서, 해당 CA 인증서(PEM)를 이 경로의 파일에 추가하면 backend 가 송신하는
# HTTPS 요청(httpx·ssl 기본 설정)이 해당 CA 도 신뢰한다. 공개 CA 번들에 **추가한다** — SSL_CERT_FILE 은 번들 전체를 대체하므로
# 시스템 번들과 병합한 파일을 생성하여 지정한다. 설치 관리자는 업로드된 인증서의 발급 CA 를 이 파일에 추가한다(docs/installer.md 15절).
JW_SITE_CA="${JW_SITE_CA_FILE:-/etc/ssl/certs/jw-site-ca.pem}"
if [ -z "${SSL_CERT_FILE:-}" ] && [ -s "$JW_SITE_CA" ] && [ -r /etc/ssl/certs/ca-certificates.crt ]; then
    BUNDLE=/tmp/jw-ca-bundle.pem
    if cat /etc/ssl/certs/ca-certificates.crt "$JW_SITE_CA" > "$BUNDLE.$$" 2>/dev/null && mv "$BUNDLE.$$" "$BUNDLE"; then
        chmod 644 "$BUNDLE"
        export SSL_CERT_FILE="$BUNDLE"
    else
        rm -f "$BUNDLE.$$"
        echo "[entrypoint] 사이트 CA 를 묶음에 더하지 못했습니다 — 공개 CA 만 믿습니다" >&2
    fi
fi

# 앱 서버 기동 시에만: 비밀값 검사 → 워커 수 결정
if [ "$1" = "uvicorn" ]; then
    # 취약하거나 기본값인 비밀값이면 이 지점에서 중단한다(워커 기동 전 1회, 변수별 사유 한 줄 — app/security_defaults.py).
    # 설정 방법: python -m app.cli gen-secrets --merge .env --in-place
    gosu appuser python -m app.cli check-secrets || exit 1

    # DB 스키마를 코드가 요구하는 버전으로 맞춘다(워커 기동 전 1회). 적용에 실패했거나 DB 가 코드보다
    # 신규 버전이면 이 지점에서 중단한다 — 부분 적용된 스키마로 서버가 기동하는 것을 방지. JW_MIGRATE_ON_START=0 이면 적용하지
    # 않고 버전만 확인한다(설치 관리자가 python -m app.cli migrate 를 별도로 호출하는 구성).
    gosu appuser python -m app.cli migrate --on-start || exit 1

    # 워커 수 — 명령에 --workers 가 없으면 BACKEND_WORKERS, 이것도 없으면 CPU 수 기준 min(8, max(2, nproc)).
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
