#!/usr/bin/env bash
# 설치 관리자 실서버 검수 — 이 PC 에서 검수 서버를 부리는 러너.
#
#   remote.sh <ssh 대상> push                     작업 트리(git 이 추적하는 파일)를 서버의 <원격 폴더>에 올린다
#   remote.sh <ssh 대상> build [서비스…]           서버에서 이미지를 빌드한다(인자가 없으면 우리 이미지 전부 + 설치 관리자)
#   remote.sh <ssh 대상> run <시나리오> [인자…]    시나리오를 돌린다(scenarios/<이름>.sh)
#   remote.sh <ssh 대상> all                       push → build → 시나리오 전부
#
# <ssh 대상>: `ssh` 가 그대로 받는 이름(예 user@192.168.10.20). 그 계정은 docker 를 쓸 수 있고 sudo 가 비밀번호 없이 돼야 한다.
# 환경변수: E2E_REMOTE_DIR(기본 ~/jw-src), 그리고 lib.sh 의 E2E_* 는 서버로 그대로 넘어간다.
#
# 검수 서버는 **전용 서버**여야 한다 — 시나리오는 컨테이너·볼륨·설치 폴더를 지우고, NFS 서버 패키지를 깐다.
# 요건: 리눅스 x86_64, Docker Engine 24+, compose 플러그인 2.20+, 메모리 12GB(전체 묶음), 디스크 40GB.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TARGET="${1:?ssh 대상을 주세요(예 user@192.168.10.20)}"
ACTION="${2:?push | build | run <시나리오> | all}"
shift 2
REMOTE_DIR="${E2E_REMOTE_DIR:-jw-src}"

# 서버로 넘길 E2E_* 환경변수
forward_env() {
  local out="" name
  for name in $(compgen -e | grep '^E2E_' | grep -v '^E2E_REMOTE_DIR$' || true); do
    out+="$name=$(printf '%q' "${!name}") "
  done
  printf '%s' "$out"
}

push() {
  (cd "$REPO" && git ls-files -z | tar --null -T - -czf - 2>/dev/null) \
    | ssh "$TARGET" "rm -rf '$REMOTE_DIR' && mkdir -p '$REMOTE_DIR' && tar -xzf - -C '$REMOTE_DIR' && chmod +x '$REMOTE_DIR'/installer/e2e/*.sh '$REMOTE_DIR'/installer/e2e/scenarios/*.sh"
  echo "올렸습니다: $TARGET:$REMOTE_DIR"
}

build() {
  ssh "$TARGET" "cd '$REMOTE_DIR' && bash installer/e2e/build-images.sh $*"
}

run() {
  local name="${1:?시나리오 이름}"; shift
  ssh "$TARGET" "cd '$REMOTE_DIR' && $(forward_env) bash installer/e2e/scenarios/$name.sh $*"
}

case "$ACTION" in
  push)  push ;;
  build) build "$@" ;;
  run)   run "$@" ;;
  all)
    push
    build
    failed=()
    for s in "$HERE"/scenarios/*.sh; do
      name="$(basename "$s" .sh)"
      echo; echo "######## $name ########"
      run "$name" || failed+=("$name")
    done
    echo; echo "실패한 시나리오: ${failed[*]:-없음}"
    [ "${#failed[@]}" -eq 0 ]
    ;;
  *) echo "모르는 동작: $ACTION" >&2; exit 2 ;;
esac
