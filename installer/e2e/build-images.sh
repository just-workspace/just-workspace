#!/usr/bin/env bash
# 검수 서버에서 이미지를 소스로 빌드한다 — compose 의 build 설정 그대로, `localhost/just-workspace-<이름>:<VERSION>`.
# 사용: build-images.sh [서비스…]     인자가 없으면 자체 빌드 이미지 전부(격리 브라우저 세션 이미지 rbi-mirror 제외) + 설치 관리자
#       build-images.sh rbi-mirror    빌드 부담이 큰 이미지는 별도 빌드
#       build-images.sh backend-test  backend 테스트용 이미지(localhost/just-workspace-backend-test:<VERSION>) — 기본 목록에 미포함
set -uo pipefail
cd "$(dirname "$0")/../.."
VERSION="$(tr -d '[:space:]' < VERSION)"
export JW_REGISTRY=localhost JW_VERSION="$VERSION" JW_APP_VERSION="$VERSION"
# compose 는 빌드만 수행할 때도 필수 변수를 검사한다 — 값은 사용되지 않는다
export DB_PASSWORD=unused SECRET_KEY=unused
[ -f .env ] || : > .env

SERVICES=("$@")
[ "${#SERVICES[@]}" -eq 0 ] && SERVICES=(backend frontend-react mailserver sso ldap audiorelay docconv sandbox rbi-netfilter installer)

rc=0
for s in "${SERVICES[@]}"; do
  t0=$(date +%s)
  if [ "$s" = installer ]; then
    docker build -q -f installer/Dockerfile -t "just-workspace-installer:$VERSION" . > "/tmp/e2e-build-$s.log" 2>&1
  elif [ "$s" = backend-test ]; then
    # 테스트 대상 — 운영 이미지(runtime)에 pytest 를 추가한 것. 설치에는 사용되지 않는다(backend 테스트 실행 시에만 사용).
    docker build -q --target test --build-context licenses=. --build-arg JW_APP_VERSION="$VERSION"       -t "localhost/just-workspace-backend-test:$VERSION" backend > "/tmp/e2e-build-$s.log" 2>&1
  else
    docker compose --profile '*' build "$s" > "/tmp/e2e-build-$s.log" 2>&1
  fi
  if [ $? -eq 0 ]; then echo "빌드 $s: 성공 $(( $(date +%s) - t0 ))초"; else echo "빌드 $s: 실패 — /tmp/e2e-build-$s.log"; rc=1; fi
done
exit $rc
