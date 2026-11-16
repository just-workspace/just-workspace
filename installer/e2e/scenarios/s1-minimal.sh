#!/usr/bin/env bash
# S1 최소 프리셋 — 신규 설치, 직접 받기, 임시 인증서, 도커 볼륨 저장소, 구역 없음.
# 사용: s1-minimal.sh [file|api]     file = 응답 파일 + jw apply(무인), api = 마법사의 호출 순서와 동일
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

say "관리자가 0명이어도 첫 관리자 API 는 닫혀 있다"
# 관리자 계정 생성 전(구역 시작 ~ seed-admin 사이)과 동일한 상태를 구성한다 — 관리자 표시를 일시 해제한다
psql_at() { docker exec ws-postgres psql -U workspace -d workspace -At -c "$1"; }
psql_at "UPDATE users SET is_admin = false WHERE username = 'admin'" >/dev/null
expect "관리자 0명" 0 "$(psql_at 'SELECT count(*) FROM users WHERE is_admin')"
expect "상태는 최초 설정 필요" True "$(ws_curl "$WS/api/setup/status" | json_get 'd["needs_setup"]')"
expect "방식은 installer" installer "$(ws_curl "$WS/api/setup/status" | json_get 'd["setup_mode"]')"
expect "첫 관리자 API 403" 403 "$(first_admin_code)"
expect "사유는 setup_closed" setup_closed "$(json_get 'd["detail"]["code"]' < "$E2E_WORK/first-admin.json")"
expect "계정이 만들어지지 않았다" 0 "$(psql_at "SELECT count(*) FROM users WHERE username = 'intruder'")"
docker exec -u appuser ws-backend python -m app.cli setup-token >/dev/null 2>&1; expect "setup-token 명령은 거절" 1 "$?"
expect "설정 토큰이 저장되지 않았다" 0 "$(psql_at "SELECT count(*) FROM system_settings WHERE key = 'setup.token_hash'")"
psql_at "UPDATE users SET is_admin = true WHERE username = 'admin'" >/dev/null
expect "관리자 표시를 되돌렸다" 1 "$(psql_at 'SELECT count(*) FROM users WHERE is_admin')"
check "되돌린 뒤 관리자 로그인" ws_login
expect "관리자가 있을 때도 403" 403 "$(first_admin_code)"

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
