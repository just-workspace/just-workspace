#!/usr/bin/env bash
# S11 로컬 ACME — 임시 인증서로 설치한 서버를 자동 발급으로 전환하고, 갱신과 갱신 후 재적재까지 확인한다.
# 사용: s11-acme-local.sh
#
# 검수 서버는 외부에서 도달할 수 없으므로 실제 인증 기관 대신 ACME 시험 서버(Pebble)를 내부망에 기동한다.
#   - 설치 관리자는 `JW_ACME_SERVER` 로 Pebble 의 디렉터리 주소를 사용한다. 확인 주기는 `JW_CERT_WATCH_SECONDS=30`.
#   - Pebble 은 접속 주소(E2E_DOMAIN)를 내부망의 nginx(2번)로 해석하고 80 포트로 검증한다(HTTP-01).
#   - certbot 이 Pebble 의 API 인증서를 신뢰하도록, 스택 폴더의 이미지 이름 조각(docker-compose.pins.yml — 설치 관리자가
#     compose 호출에 포함하는 파일)에 검수용 설정(REQUESTS_CA_BUNDLE)을 추가한다. 검수 전용 조치이며 제품 경로가 아니다.
# 확인: [다시 발급](auto) 작업 성공 → nginx 가 신규 인증서 제공 → 갱신 컨테이너가 고정 주소로 실행 → `certbot renew --dry-run`
#       → 강제 갱신 후 설치 관리자가 지문 변경을 감지하여 nginx 를 reload → 인증서 상태·jw status 의 갱신 정보.
# 환경변수(선택): E2E_PEBBLE_IMAGE(기본 ghcr.io/letsencrypt/pebble:latest)
. "$(dirname "$0")/../lib.sh"

PEBBLE_IMAGE="${E2E_PEBBLE_IMAGE:-ghcr.io/letsencrypt/pebble:latest}"
PEBBLE=jw-e2e-pebble
OP="$E2E_WORK/acme"; rm -rf "$OP"; mkdir -p "$OP"
PREFIX=172.28.0

served_fp() { echo | openssl s_client -connect "$E2E_ADDR:443" -servername "$E2E_DOMAIN" 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null; }
served_issuer() { echo | openssl s_client -connect "$E2E_ADDR:443" -servername "$E2E_DOMAIN" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null; }
cert_api() { ws_api GET /api/admin/system/cert; }
wait_cert_job() {
  local i st
  for i in $(seq 1 120); do
    st="$(cert_api | json_get '(d.get("job") or {}).get("status") or "none"')"
    [ "$st" = none ] && [ "$i" -gt 3 ] && return 0
    sleep 3
  done
  return 1
}

docker rm -f "$PEBBLE" >/dev/null 2>&1
e2e_reset
check "설치 관리자 기동(ACME 시험 서버 지정)" installer_start -e "JW_ACME_SERVER=https://pebble:14000/dir" -e "JW_CERT_WATCH_SECONDS=30"
install file "$E2E_ROOT/answers/minimal.json" || finish
check_core
expect "설치 시의 인증서 방식" temporary "$(cert_api | json_get 'd["mode"]')"
expect "임시 인증서 설치에는 갱신 서비스가 해당하지 않는다" False "$(cert_api | json_get 'd["renewal"]["applicable"]')"
expect "갱신 컨테이너 없음" "" "$(docker ps -aq --filter name='^ws-certbot$')"
FP_TEMP="$(served_fp)"

say "ACME 시험 서버(Pebble)"
cat > "$OP/pebble-config.json" <<'JSON'
{"pebble": {"listenAddress": "0.0.0.0:14000", "managementListenAddress": "0.0.0.0:15000",
  "certificate": "test/certs/localhost/cert.pem", "privateKey": "test/certs/localhost/key.pem",
  "httpPort": 80, "tlsPort": 443, "ocspResponderURL": "", "externalAccountBindingRequired": false}}
JSON
check "pull $PEBBLE_IMAGE" docker pull -q "$PEBBLE_IMAGE"
cid="$(docker create "$PEBBLE_IMAGE")"
docker cp "$cid:/test/certs/pebble.minica.pem" "$OP/pebble.minica.pem" >/dev/null 2>&1
docker rm "$cid" >/dev/null
check "Pebble 의 API CA 인증서" test -s "$OP/pebble.minica.pem"
# 내부망에 직접 연결하는 컨테이너는 105번 이상의 주소를 지정한다(docs/installer.md 의 내부망 주소 배정)
check "Pebble 기동(내부망 110번)" docker run -d --name "$PEBBLE" --network "$E2E_NET" --ip "$PREFIX.110" --network-alias pebble \
  --add-host "$E2E_DOMAIN:$PREFIX.2" -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 \
  -v "$OP/pebble-config.json:/test/config/pebble-config.json:ro" "$PEBBLE_IMAGE" -config /test/config/pebble-config.json
sudo tee "$E2E_HOST_DIR/stack/docker-compose.pins.yml" >/dev/null <<YAML
# 검수 전용 — certbot 이 ACME 시험 서버의 API 인증서를 신뢰하도록 한다.
services:
  certbot:
    environment:
      REQUESTS_CA_BUNDLE: /pebble-ca/pebble.minica.pem
    volumes:
      - $OP:/pebble-ca:ro
YAML

say "[다시 발급] — 임시 인증서 → 자동 발급"
reply="$(ws_api POST /api/admin/system/cert/reissue '{"mode":"auto"}')"
note "요청: $(printf '%s' "$reply" | head -c 200)"
check "작업 종료" wait_cert_job
job="$(sudo cat "$E2E_HOST_DIR/state/jobs.json" | json_get '[j for j in d.values() if j["kind"]=="cert"][-1]')"
expect "작업 상태" done "$(printf '%s' "$job" | json_get 'd["status"]')"
[ "$(printf '%s' "$job" | json_get 'd["status"]')" = done ] || { note "작업: $job"; sudo tail -25 "$E2E_HOST_DIR/state/logs/cert-reissue.log"; }
st="$(cert_api)"
expect "인증서 방식" auto "$(printf '%s' "$st" | json_get 'd["mode"]')"
expect "임시 아님" False "$(printf '%s' "$st" | json_get 'd["temporary"]')"
contains "발급자는 ACME 시험 서버" Pebble "$(printf '%s' "$st" | json_get 'd["issuer"]')"
contains "nginx 가 신규 인증서를 제공" Pebble "$(served_issuer)"
check "COMPOSE_PROFILES 에 certbot" bash -c "sudo grep -E '^COMPOSE_PROFILES=' '$E2E_HOST_DIR/stack/.env' | grep -q certbot"

say "갱신 컨테이너"
expect "갱신 컨테이너 실행 중" true "$(docker inspect --format '{{.State.Running}}' ws-certbot 2>/dev/null)"
expect "갱신 컨테이너의 고정 주소(35번)" "$PREFIX.35" "$(net_address ws-certbot)"
check_network
renewal="$(printf '%s' "$st" | json_get 'd["renewal"]')"
note "renewal: $renewal"
expect "갱신 서비스 상태" running "$(printf '%s' "$renewal" | json_get 'd["service"]')"
check "다음 갱신 예정이 표시된다" test -n "$(printf '%s' "$renewal" | json_get 'd["next_renewal_at"] or ""')"
for i in $(seq 1 20); do
  [ -n "$(cert_api | json_get 'd["renewal"]["last_run_at"] or ""')" ] && break
  sleep 3
done
expect "갱신 컨테이너의 최초 확인 결과" ok "$(cert_api | json_get 'd["renewal"]["last_result"]')"
# --dry-run 은 서버를 명시하지 않으면 Let's Encrypt 의 시험 서버로 요청한다 — 본 검수에서는 ACME 시험 서버를 명시한다
dry="$(docker exec ws-certbot certbot renew --webroot -w /var/www/certbot --dry-run --no-random-sleep-on-renew --server https://pebble:14000/dir 2>&1)"
contains "certbot renew --dry-run" "all simulated renewals succeeded" "$dry"
contains "jw status 의 자동 갱신 줄" "자동 갱신: 동작 중" "$(jw status 2>&1)"

say "갱신 → 설치 관리자가 nginx 를 reload"
FP_ISSUED="$(served_fp)"
check "임시 인증서와 다른 인증서" test "$FP_ISSUED" != "$FP_TEMP"
out="$(docker exec ws-certbot certbot renew --webroot -w /var/www/certbot --force-renewal --no-random-sleep-on-renew 2>&1)"
contains "강제 갱신" "all renewals succeeded" "$out"
for i in $(seq 1 40); do
  [ "$(served_fp)" != "$FP_ISSUED" ] && break
  sleep 3
done
check "nginx 가 갱신된 인증서를 제공(설치 관리자의 주기 확인 → reload)" test "$(served_fp)" != "$FP_ISSUED"
contains "재적재 기록" "다시 읽혔습니다" "$(sudo tail -5 "$E2E_HOST_DIR/state/logs/certwatch.log" 2>/dev/null)"
expect "프런트 화면" 200 "$(ws_code "$WS/")"

say "갱신 컨테이너가 중지되면 설치 관리자가 재기동"
docker stop ws-certbot >/dev/null
for i in $(seq 1 30); do
  [ "$(docker inspect --format '{{.State.Running}}' ws-certbot 2>/dev/null)" = true ] && break
  sleep 3
done
expect "갱신 컨테이너 재기동" true "$(docker inspect --format '{{.State.Running}}' ws-certbot 2>/dev/null)"

docker rm -f "$PEBBLE" >/dev/null 2>&1
finish
