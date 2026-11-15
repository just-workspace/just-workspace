#!/usr/bin/env bash
# S6 설치 후 구역 켜고 끄기 — 최소 묶음으로 설치한 뒤 내부 API 로 채팅 → 문서 → 코드 저장소를 켜고, 문서와 코드 저장소를 끈다.
# 내부 API 는 backend 가 부르는 방식 그대로(backend 컨테이너 안에서, 받은 주소·키로) 부른다.
. "$(dirname "$0")/../lib.sh"

e2e_reset
check "설치 관리자 기동" installer_start
install file "$E2E_ROOT/answers/minimal.json" || finish
check_core

say "내부 API 의 문"
expect "호스트에 8444 는 게시되지 않는다" "" "$(published_ports | grep 8444)"
expect "브라우저 포트(8443)에 /internal/zones 는 없다" 404 "$(curl -sk -o /dev/null -w '%{http_code}' "$WIZARD/internal/zones")"
expect "브라우저 포트(8443)에 /internal/health 도 없다" 404 "$(curl -sk -o /dev/null -w '%{http_code}' "$WIZARD/internal/health")"
check "호스트에서 8444 로는 붙지 못한다" bash -c "! curl -s --max-time 3 -o /dev/null http://127.0.0.1:8444/internal/health"
contains "backend 에서 키 없이 health" '"installed":true' "$(internal_api GET /internal/health)"
expect "backend 에서 키로 구역 목록" 200 "$(internal_api GET /internal/zones | cut -d' ' -f1)"
expect "틀린 키는 404" 404 "$(E2E_KEY=wrong internal_api GET /internal/zones | cut -d' ' -f1)"
# 내부 대역 밖(도커 기본 브리지)에서 맞는 키로 불러도 받지 않는다
BRIDGE_IP="$(docker inspect -f '{{(index .NetworkSettings.Networks "bridge").IPAddress}}' $INSTALLER)"
expect "내부 대역 밖에서는 맞는 키로도 404" 404 "$(docker run --rm -i -e E2E_URL="http://$BRIDGE_IP:8444" -e E2E_PATH=/internal/zones \
  -e E2E_KEY="$(env_value JW_INSTALLER_KEY)" --entrypoint python "$E2E_INSTALLER_IMAGE" - < "$E2E_ROOT/internal-call.py" | cut -d' ' -f1)"

# toggle <enable|disable> <구역> [설정 JSON]
toggle() {
  local action="$1" zone="$2" settings="${3:-}" body="" out id i
  [ -n "$settings" ] && body="{\"settings\":$settings}"
  if [ "$action" = enable ]; then
    out="$(internal_api POST "/internal/zones/$zone/check" "$body")"
    expect "$zone check" True "$(printf '%s' "${out#* }" | json_get 'd["ok"]')"
    note "$zone check: 새 포트 $(printf '%s' "${out#* }" | json_get 'd["ports"]') · 메모리 $(printf '%s' "${out#* }" | json_get 'd["memory"]')"
  fi
  out="$(internal_api POST "/internal/zones/$zone/$action" "$body")"
  expect "$zone $action 접수" 202 "${out%% *}"
  id="$(printf '%s' "${out#* }" | json_get 'd["id"]')"
  if wait_job "$id" 900; then
    ok "$zone $action 완료 — $(job_field "$id" '["stages"]')"
  else
    bad "$zone $action — $(job_field "$id" '["error"]')"
    sudo tail -20 "$E2E_HOST_DIR/state/logs/zone-$zone.log"
  fi
  check "backend 다시 준비" wait_ready ws-backend 240
  for i in $(seq 1 30); do [ "$(ws_code "$WS/api/health")" = 200 ] && break; sleep 2; done
  note "JW_ZONES=$(env_value JW_ZONES)  COMPOSE_PROFILES=$(env_value COMPOSE_PROFILES)"
}
health_zones() { ws_curl "$WS/api/health" | json_get 'd["zones"]'; }

say "채팅 켜기"
toggle enable chat
expect "JW_ZONES" "core,chat" "$(env_value JW_ZONES)"
expect "/api/health zones" '["chat"]' "$(health_zones)"
ws_login; expect "채널 목록 API" 200 "$(ws_api_code GET /api/chat/channels)"

say "문서 켜기"
toggle enable docs
expect "JW_ZONES" "core,chat,docs" "$(env_value JW_ZONES)"
contains "COMPOSE_PROFILES 에 onlyoffice" "onlyoffice" "$(env_value COMPOSE_PROFILES)"
check "문서 편집기 준비" wait_ready ws-onlyoffice 300
contains "discovery 응답" "<wopi-discovery>" "$(ws_curl "$WS/onlyoffice/hosting/discovery" | head -c 200)"
expect "/api/health zones" '["chat", "docs"]' "$(health_zones)"

say "코드 저장소 켜기"
toggle enable git '{"version":"tested"}'
expect "JW_ZONES" "core,chat,docs,git" "$(env_value JW_ZONES)"
contains "COMPOSE_PROFILES 에 gitea" "gitea" "$(env_value COMPOSE_PROFILES)"
check "Gitea 준비" wait_ready ws-gitea 300
check "GITEA_TOKEN 이 .env 에 들어갔다" test -n "$(env_value GITEA_TOKEN)"
expect "/git/ 앞단 경로" 200 "$(ws_code -L "$WS/git/")"
contains "게시 포트에 2222" "2222/tcp" "$(published_ports | tr '\n' ' ')"
ws_login; expect "/api/git/repos" 200 "$(ws_api_code GET /api/git/repos)"

say "이미 켜진 구역·모르는 구역"
expect "이미 켜진 구역은 409" 409 "$(internal_api POST /internal/zones/chat/enable | cut -d' ' -f1)"
expect "모르는 구역은 404" 404 "$(internal_api POST /internal/zones/nope/enable | cut -d' ' -f1)"

say "문서 끄기"
toggle disable docs
expect "JW_ZONES" "core,chat,git" "$(env_value JW_ZONES)"
check "COMPOSE_PROFILES 에서 onlyoffice 가 빠졌다" bash -c "! sudo grep -E '^COMPOSE_PROFILES=' '$E2E_HOST_DIR/stack/.env' | grep -q onlyoffice"
expect "문서 편집기 컨테이너는 없다" "" "$(docker ps -aq --filter name='^ws-onlyoffice$')"
expect "/api/health zones" '["chat", "git"]' "$(health_zones)"
check "켜 둔 구역은 그대로(Gitea)" container_ready ws-gitea

say "코드 저장소 끄기 — 데이터는 남는다"
toggle disable git
expect "Gitea 컨테이너는 없다" "" "$(docker ps -aq --filter name='^ws-gitea$')"
check "Gitea 데이터 볼륨은 남는다" docker volume inspect ws-gitea-data
expect "GITEA_TOKEN 은 .env 에서 빠졌다" "" "$(env_value GITEA_TOKEN)"
expect "JW_ZONES" "core,chat" "$(env_value JW_ZONES)"
expect "/api/health zones" '["chat"]' "$(health_zones)"

report_usage
finish
