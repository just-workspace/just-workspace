#!/usr/bin/env bash
# S1 최소 묶음 — 새 설치, 직접 받기, 임시 인증서, 도커 볼륨 저장소, 구역 없음.
# 사용: s1-minimal.sh [file|api]     file = 답변 파일 + jw apply(무인), api = 마법사가 부르는 순서 그대로
. "$(dirname "$0")/../lib.sh"
MODE="${1:-file}"

e2e_reset
say "설치 관리자 시작"
check "설치 관리자 기동" installer_start
contains "로그에 토큰 주소" "/?token=" "$(docker logs $INSTALLER 2>&1)"
contains "로그에 인증서 지문" "SHA-256" "$(docker logs $INSTALLER 2>&1)"
expect "세션 없이 답변 API" 401 "$(curl -sk -o /dev/null -w '%{http_code}' "$WIZARD/api/answers")"

if [ "$MODE" = file ]; then
  say "dry-run"
  answers_place "$E2E_ROOT/answers/minimal.json"
  (umask 077; printf 'JW_ADMIN_PASSWORD=%s\n' "$(cat "$(admin_password_file)")" > "$E2E_WORK/admin.env")
  out="$(docker exec --env-file "$E2E_WORK/admin.env" $INSTALLER jw apply --answers /data/e2e/answers.json --dry-run)"
  contains "dry-run 은 검증 통과를 알린다" "검증 통과" "$out"
  check "dry-run 은 아무것도 만들지 않는다" test ! -e "$E2E_HOST_DIR/stack/.env"
fi

install "$MODE" "$E2E_ROOT/answers/minimal.json" || { step_seconds; finish; }
step_seconds

check_core
expect "/api/health 의 zones 는 비어 있다" "[]" "$(ws_curl "$WS/api/health" | json_get 'd["zones"]')"
expect "80 은 https 로 넘긴다" 301 "$(ws_code "http://$E2E_DOMAIN/")"
check_files
check_locked

say "여는 포트"
ports="$(published_ports | tr '\n' ' ')"
note "게시: $ports"
expect "게시 포트(설치 관리자 8443 포함)" "0.0.0.0:80/tcp 0.0.0.0:443/tcp 0.0.0.0:8443/tcp " "$(printf '%s' "$ports" | tr ' ' '\n' | grep -v '^\[' | tr '\n' ' ')"

say "설치 관리자 재시작 뒤 상태 유지"
docker restart $INSTALLER >/dev/null
for i in $(seq 1 30); do curl -sk -o /dev/null "$WIZARD/healthz" && break; sleep 1; done
check_locked
contains "재시작 로그는 잠김을 알린다" "마법사는 잠겨 있습니다" "$(docker logs --tail 12 $INSTALLER 2>&1)"
expect "/api/health (재시작 뒤)" 200 "$(ws_code "$WS/api/health")"

say "jw 명령"
out="$(jw status)"; rc=$?
expect "jw status 종료 코드" 0 "$rc"
contains "jw status 단계 installed" "단계 installed" "$out"
contains "jw status lock done" "lock      done" "$out"
jw token >/dev/null 2>&1; expect "설치 뒤 jw token 은 거절" 1 "$?"
(umask 077; jw reset-admin admin > "$E2E_WORK/reset.out" 2>&1); expect "jw reset-admin 종료 코드" 0 "$?"
(umask 077; grep -v '^\[' "$E2E_WORK/reset.out" | grep -v '^$' | tail -1 | tr -d ' \n' > "$E2E_WORK/temp-pass")
check "임시 비밀번호로 로그인" ws_login "$E2E_WORK/temp-pass"
rm -f "$E2E_WORK/reset.out" "$E2E_WORK/temp-pass"

report_usage
finish
