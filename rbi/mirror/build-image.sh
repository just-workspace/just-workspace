#!/bin/sh
# 미러 모드 세션 이미지 빌드 — compose 항목(rbi-mirror)과 같은 이름으로 굽는다.
#   sh rbi/mirror/build-image.sh            → ${JW_REGISTRY:-localhost}/just-workspace-rbi-mirror:${JW_VERSION:-latest} (prod)
#   TARGET=dev TAG=r21p1-rbi-mirror:dev sh rbi/mirror/build-image.sh   → 개발·시험용(하네스·테스트 페이지 포함, 운영 금지)
# 버전(Chromium·폰트·베이스 이미지)은 Dockerfile 의 ARG — 데비안 보안 갱신으로 빌드가 실패하면 build-arg 로 새 버전을 준다(docs/rbi.md).
set -eu
cd "$(dirname "$0")"
TARGET="${TARGET:-prod}"
TAG="${TAG:-${JW_REGISTRY:-localhost}/just-workspace-rbi-mirror:${JW_VERSION:-latest}}"
docker build --target "$TARGET" -t "$TAG" ${BUILD_ARGS:-} .
docker image inspect "$TAG" --format '{{.Id}} {{.Size}}'
