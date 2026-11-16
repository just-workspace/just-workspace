#!/usr/bin/env bash
# S12 코어 4개 미만 서버 — 회의 구역(녹화 컨테이너 포함)을 포함한 설치가 완료되는지 확인한다.
# 사용: s12-low-cpu.sh        서버의 코어 수가 4 미만이어야 의미가 있다(4 이상이면 상한이 4 로 기록되는 것만 확인한다).
#
# compose 의 CPU 상한이 서버의 코어 수를 초과하면 도커가 컨테이너 생성을 거부한다. 설치 관리자는 녹화 컨테이너의 상한을
# 코어 수에 맞춰 기록하고(EGRESS_CPUS), 사전 점검과 요약에서 녹화의 권장 사양 미달을 통지한다.
. "$(dirname "$0")/../lib.sh"

CORES="$(nproc)"
e2e_reset
check "설치 관리자 기동" installer_start
check "설치 토큰으로 세션 발급" wizard_login
answers_place "$E2E_ROOT/answers/meetings.json"
body="$E2E_WORK/answers-put.json"
(umask 077; sudo cat "$E2E_HOST_DIR/e2e/answers.json" | python3 -c 'import json,sys
d=json.load(sys.stdin); d.setdefault("admin",{})["password"]=open(sys.argv[1]).read().strip(); print(json.dumps(d))' \
    "$(admin_password_file)" > "$body")
wapi PUT /api/answers "@$body" >/dev/null; rm -f "$body"
expect "PUT /api/answers" 200 "$(wcode)"

say "사전 점검 · 요약 (코어 $CORES개)"
pre="$(wapi POST /api/preflight)"
expect "사전 점검 통과(경고는 설치를 막지 않는다)" True "$(printf '%s' "$pre" | json_get 'd["ok"]')"
cpu="$(printf '%s' "$pre" | json_get '[i for i in d["items"] if i["id"]=="cpu"][0]')"
note "cpu 항목: $cpu"
wapi POST /api/probe/dns '{}' >/dev/null
cautions="$(wapi GET /api/summary | json_get '[c["key"] for c in d["cautions"]]')"
if [ "$CORES" -lt 4 ]; then
  expect "cpu 항목은 경고" warn "$(printf '%s' "$cpu" | json_get 'd["status"]')"
  expect "경고의 키" cpu_below_recording "$(printf '%s' "$cpu" | json_get 'd["fix"]["key"]')"
  contains "요약의 주의에 녹화 권장 사양 미달" meetings_recording_low_cpu "$cautions"
  want_cpus="$CORES"
else
  expect "cpu 항목은 통과" pass "$(printf '%s' "$cpu" | json_get 'd["status"]')"
  want_cpus=4
fi

say "설치"
wapi POST /api/apply >/dev/null
expect "POST /api/apply" 202 "$(wcode)"
if wait_apply_api 2400; then ok "적용 완료"; else bad "적용 — $(apply_error)"; finish; fi
check_core
expect "EGRESS_CPUS 는 코어 수에 맞춘 값" "$want_cpus" "$(env_value EGRESS_CPUS)"
check "회의 서버 준비" wait_ready ws-livekit 180
check "녹화 컨테이너 준비" wait_ready ws-egress 180
expect "녹화 컨테이너의 CPU 상한(NanoCpus)" "$((want_cpus * 1000000000))" "$(docker inspect --format '{{.HostConfig.NanoCpus}}' ws-egress)"
sleep 20
expect "녹화 컨테이너가 재시작을 반복하지 않는다" "true 0" "$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' ws-egress)"
note "녹화 컨테이너 로그(끝): $(docker logs --tail 5 ws-egress 2>&1 | tr '\n' ' ' | cut -c1-400)"
ws_login
ws_api POST /api/meetings/rooms '{"name":"e2e-room"}' >/dev/null
check "회의 토큰 발급 API" test -n "$(ws_api POST /api/meetings/token '{"room":"e2e-room"}' | json_get 'd["token"]')"
check_locked
finish
