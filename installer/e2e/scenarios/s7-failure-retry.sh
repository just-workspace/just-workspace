#!/usr/bin/env bash
# S7 실패와 재시도.
#   token    설치 토큰: 불일치 · 재발급 · 만료 · 5회 불일치 시 일시 거부
#   image    이미지 하나의 pull 실패 → 해당 단계 실패·원인 키 → 수정 후 retry 로 해당 단계부터 재개
#   restart  적용 도중 설치 관리자를 재시작 → 이어서 완료
#   cert     인증서 auto → 발급 실패 → use_temporary_cert 로 계속
# 사용: s7-failure-retry.sh [token|image|restart|cert|all]
. "$(dirname "$0")/../lib.sh"
WHAT="${1:-all}"
want() { [ "$WHAT" = all ] || [ "$WHAT" = "$1" ]; }

session_code() { curl -sk -o "$E2E_WORK/sess.out" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d "{\"token\":\"$1\"}" "$WIZARD/api/session"; }
session_err() { json_get 'd["code"]' < "$E2E_WORK/sess.out"; }

# ─── 토큰 ───
if want token; then
  e2e_reset
  check "설치 관리자 기동" installer_start
  say "설치 토큰"
  T1="$(installer_token)"
  check "토큰은 12자리(헷갈리는 글자 없음)" bash -c "printf '%s' '$T1' | grep -qE '^[A-HJ-NP-Z2-9]{12}\$'"
  expect "틀린 토큰" 401 "$(session_code AAAAAAAAAAAA)"; expect "  원인" token_wrong "$(session_err)"
  expect "주소의 ?token= 이 틀리면 사유를 실어 토큰 없는 주소로" "302 /?token_status=wrong" "$(curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' "$WIZARD/?token=AAAAAAAAAAAA" | sed "s#$WIZARD##")"
  expect "맞는 토큰(소문자·줄표로 옮겨 적어도)" 200 "$(session_code "$(printf '%s' "$T1" | tr 'A-Z' 'a-z' | sed -E 's/(....)(....)/\1-\2-/')")"
  expect "세션 없이도 화면(/)은 열린다" 200 "$(curl -sk -o /dev/null -w '%{http_code}' "$WIZARD/")"
  check "세션 발급" wizard_login
  wapi GET /api/state >/dev/null; expect "세션으로 /api/state" 200 "$(wcode)"
  expect "주소의 ?token= 이 맞으면 토큰 없는 주소로 넘긴다" 302 "$(curl -sk -o /dev/null -w '%{http_code}' "$WIZARD/?token=$T1")"

  say "다시 발급"
  out="$(jw token)"; expect "jw token" 0 "$?"
  T2="$(printf '%s' "$out" | grep -oE 'token=[A-Z0-9]+' | head -1 | cut -d= -f2)"
  check "새 토큰은 옛 것과 다르다" test -n "$T2" -a "$T1" != "$T2"
  expect "옛 토큰은 못 쓴다" 401 "$(session_code "$T1")"; expect "  원인" token_wrong "$(session_err)"
  expect "새 토큰은 된다" 200 "$(session_code "$T2")"
  wapi GET /api/state >/dev/null; expect "이미 열린 세션은 그대로" 200 "$(wcode)"

  say "만료"
  sudo python3 - "$E2E_HOST_DIR/state/token.json" <<'PY'
import json, sys, time
p = sys.argv[1]
d = json.load(open(p))
d["expires"] = time.time() - 10
json.dump(d, open(p, "w"))
PY
  expect "만료된 토큰" 401 "$(session_code "$T2")"; expect "  원인" token_expired "$(session_err)"
  expect "틀린 토큰은 만료와 구분된다" token_wrong "$(session_code AAAAAAAAAAAA >/dev/null; session_err)"
  out="$(jw token)"
  T3="$(printf '%s' "$out" | grep -oE 'token=[A-Z0-9]+' | head -1 | cut -d= -f2)"
  expect "다시 발급한 토큰" 200 "$(session_code "$T3")"

  say "다섯 번 틀리면 30초 동안 받지 않는다"
  for i in 1 2 3 4; do session_code AAAAAAAAAAAA >/dev/null; done
  expect "다섯 번째 틀림" 401 "$(session_code AAAAAAAAAAAA)"
  expect "  다시 시도까지" 30 "$(json_get 'd["vars"]["retry_after"]' < "$E2E_WORK/sess.out")"
  expect "잠긴 동안은 맞는 토큰도 거절" 429 "$(session_code "$T3")"; expect "  원인" token_locked "$(session_err)"
  note "31초 기다립니다"
  sleep 31
  expect "잠금이 풀리면 맞는 토큰은 된다" 200 "$(session_code "$T3")"
fi

# ─── 이미지 하나의 pull 실패 ───
if want image; then
  MISSING="0.0.0-e2e-missing"
  e2e_reset
  docker rmi "localhost/just-workspace-backend:$MISSING" "localhost/just-workspace-frontend-react:$MISSING" >/dev/null 2>&1
  E2E_IMAGE_TAG="$MISSING" installer_start; check "설치 관리자 기동(없는 태그 $MISSING)" installer_wait_up
  say "없는 이미지로 적용"
  check "답변·사전 점검" api_prepare "$E2E_ROOT/answers/minimal.json"
  wapi POST /api/apply >/dev/null; expect "POST /api/apply" 202 "$(wcode)"
  wait_apply_api 600; expect "적용은 실패로 끝난다" 1 "$?"
  expect "실패한 단계" pull "$(apply_get 'd["error"]["step"]')"
  expect "원인 키" image_pull_failed "$(apply_get 'd["error"]["cause"]')"
  expect "해결 키" check_network_or_registry "$(apply_get 'd["error"]["fix"]')"
  contains "못 받은 이미지 이름" ":$MISSING" "$(apply_get 'd["error"]["vars"]["image"]')"
  expect "config 단계는 끝나 있다" done "$(apply_get '[s for s in d["steps"] if s["id"]=="config"][0]["status"]')"
  expect "이미지별 상태에 failed" 1 "$(apply_get 'len([i for i in [s for s in d["steps"] if s["id"]=="pull"][0]["detail"]["images"] if i["status"]=="failed"])')"
  expect "/api/state 의 단계" applying "$(wapi GET /api/state | json_get 'd["phase"]')"
  expect "jw status 는 실패를 알린다(종료 코드 1)" 1 "$(jw status >/dev/null 2>&1; echo $?)"
  wapi GET "/api/apply/log?step=pull" >/dev/null; expect "단계 로그 조회" 200 "$(wcode)"
  config_started="$(apply_get '[s for s in d["steps"] if s["id"]=="config"][0]["started_at"]')"

  say "고친 뒤 retry"
  docker tag "localhost/just-workspace-backend:$E2E_VERSION" "localhost/just-workspace-backend:$MISSING"
  docker tag "localhost/just-workspace-frontend-react:$E2E_VERSION" "localhost/just-workspace-frontend-react:$MISSING"
  wapi POST /api/apply/retry '{}' >/dev/null; expect "POST /api/apply/retry" 202 "$(wcode)"
  expect "retry 직후의 상태는 이미 running" running "$(apply_get 'd["status"]')"
  expect "config 단계는 다시 돌지 않는다" "$config_started" "$(sudo cat "$E2E_HOST_DIR/state/apply.json" | json_get '[s for s in d["steps"] if s["id"]=="config"][0]["started_at"]')"
  wait_apply_api 900; expect "이어서 완료" 0 "$?"
  check_core
  check_locked
  wapi POST /api/apply/retry '{}' >/dev/null; expect "끝난 뒤 retry 는 잠김" 423 "$(wcode)"
  docker rm -fv ws-backend ws-frontend-react >/dev/null 2>&1
  docker rmi "localhost/just-workspace-backend:$MISSING" "localhost/just-workspace-frontend-react:$MISSING" >/dev/null 2>&1
fi

# ─── 적용 도중 설치 관리자 재시작 ───
if want restart; then
  e2e_reset
  check "설치 관리자 기동" installer_start
  say "적용 도중 재시작"
  check "답변·사전 점검" api_prepare "$E2E_ROOT/answers/collab.json"
  wapi POST /api/apply >/dev/null; expect "POST /api/apply" 202 "$(wcode)"
  wait_step zones 900; expect "zones 단계까지 진행" 0 "$?"
  sleep 4
  docker restart $INSTALLER >/dev/null
  check "설치 관리자 다시 기동" installer_wait_up
  contains "로그는 이어서 진행함을 알린다" "이어서 진행합니다" "$(docker logs --tail 20 $INSTALLER 2>&1)"
  wapi GET /api/apply >/dev/null
  check "세션은 재시작 뒤에도 유효(또는 이미 잠김)" bash -c "[ '$(wcode)' = 200 ] || [ '$(wcode)' = 423 ]"
  wait_apply_file 1200; expect "이어서 완료" 0 "$?"
  expect "끊긴 단계에 표시가 남는다" True "$(sudo cat "$E2E_HOST_DIR/state/apply.json" | json_get 'any(s.get("interrupted") for s in d["steps"])')"
  step_seconds
  check_core
  expect "/api/health 의 zones" '["mail", "chat", "calendar", "docs"]' "$(ws_curl "$WS/api/health" | json_get 'd["zones"]')"
  check "메일 서버 준비" wait_ready ws-mailserver 240
  check "문서 편집기 준비" wait_ready ws-onlyoffice 300
  check_locked
fi

# ─── 인증서 발급 실패 → 임시 인증서로 계속 ───
if want cert; then
  e2e_reset
  check "설치 관리자 기동" installer_start
  say "인증서 auto(밖에서 닿지 않는 서버)"
  check "답변·사전 점검" api_prepare "$E2E_ROOT/answers/auto-cert.json"
  contains "요약의 주의에 발급 실패 예고" dns_mismatch_cert_will_fail "$(wapi GET /api/summary | json_get '[c["key"] for c in d["cautions"]]')"
  wapi POST /api/apply >/dev/null; expect "POST /api/apply" 202 "$(wcode)"
  wait_apply_api 900; expect "적용은 실패로 끝난다" 1 "$?"
  expect "실패한 단계" cert "$(apply_get 'd["error"]["step"]')"
  expect "원인 키(DNS 불일치로 분류)" cert_dns_mismatch "$(apply_get 'd["error"]["cause"]')"
  expect "대안" '[{"key": "use_temporary_cert"}]' "$(apply_get 'd["alternatives"]')"
  expect "/api/state 에도 대안이 실린다" '[{"key": "use_temporary_cert"}]' "$(wapi GET /api/state | json_get 'd["apply"]["alternatives"]')"
  check "80 을 잡고 있던 것은 남지 않는다" bash -c "! sudo ss -ltnH | grep -qE ':80\s'"
  say "임시 인증서로 계속"
  wapi POST /api/apply/retry '{"use_temporary_cert":true}' >/dev/null; expect "POST /api/apply/retry" 202 "$(wcode)"
  expect "retry 직후의 상태는 이미 running(옛 오류·대안은 지워진다)" 'running None []' "$(apply_get '"%s %s %s" % (d["status"], d["error"], d["alternatives"])')"
  wait_apply_api 900; expect "이어서 완료" 0 "$?"
  expect "답변의 인증서 방식이 temporary 로 바뀌었다" temporary "$(sudo cat "$E2E_HOST_DIR/state/answers.json" | json_get 'd["access"]["cert"]')"
  check "COMPOSE_PROFILES 에 certbot 이 없다" bash -c "! sudo grep -E '^COMPOSE_PROFILES=' '$E2E_HOST_DIR/stack/.env' | grep -q certbot"
  check_core
  check_locked
fi

finish
