#!/usr/bin/env bash
# S5 앞단 프록시 뒤 — network proxy, cert proxy. nginx 는 80 평문만 듣고, 프록시 주소에서 온 연결의 X-Real-IP 만 믿는다.
# 프록시 주소는 192.168.10.0/24 와 이 서버 자신의 주소로 답한다(이 서버에서 보낸 요청이 프록시 노릇을 한다).
. "$(dirname "$0")/../lib.sh"
OTHER_NET=e2e-other-net            # 192.168.20.0/24 — 믿지 않는 대역

cleanup_nets() { docker network rm "$OTHER_NET" >/dev/null 2>&1; }
e2e_reset
cleanup_nets
check "설치 관리자 기동" installer_start
install api "$E2E_ROOT/answers/proxy.json" || { step_seconds; finish; }
step_seconds
contains "요약의 포트에 443 이 없다" "80/tcp" "$E2E_SUMMARY_PORTS"
check "요약의 포트에 443 이 없다(2)" bash -c "! printf '%s' '$E2E_SUMMARY_PORTS' | grep -q 443"
check "단계에 cert 가 없다(프록시가 맡는다)" bash -c "! printf '%s' '$E2E_SUMMARY_STEPS' | grep -qw cert"

say "nginx 는 80 평문만"
expect "DEPLOY_MODE" external_proxy "$(env_value DEPLOY_MODE)"
ports="$(published_ports | grep -v '^\[' | sed 's/^0\.0\.0\.0://' | tr '\n' ' ')"
expect "게시 포트" "80/tcp 8443/tcp " "$ports"
check "호스트는 443 을 듣지 않는다" bash -c "! sudo ss -ltnH | grep -qE ':443\s'"
expect "nginx 의 listen 은 80 뿐" "listen 80 default_server; listen 80;" "$(docker exec ws-nginx nginx -T 2>/dev/null | grep -E '^\s*listen ' | sed -E 's/^\s+//' | sort -u | tr '\n' ' ' | sed 's/ $//')"
contains "믿는 프록시 주소" "set_real_ip_from  192.168.10.0/24;" "$(sudo cat "$E2E_HOST_DIR/stack/nginx/site.d/http.conf")"
check "HSTS 는 붙이지 않는다(프록시 몫)" bash -c "! curl -s -D - -o /dev/null -H 'Host: $E2E_DOMAIN' http://$E2E_ADDR/ | grep -qi strict-transport-security"

say "평문 80 으로 서비스"
plain() { curl -s --max-time 30 -H "Host: $E2E_DOMAIN" -H 'X-Forwarded-Proto: https' "$@"; }
expect "프런트 화면(/)" 200 "$(plain -o /dev/null -w '%{http_code}' "http://$E2E_ADDR/")"
expect "/api/health" 200 "$(plain -o /dev/null -w '%{http_code}' "http://$E2E_ADDR/api/health")"
# 로그인 — 세션 쿠키는 Secure 라 curl 이 평문 연결에서는 저장하지 않는다. 응답 머리에서 꺼내 직접 싣는다.
body="$E2E_WORK/login.json"
(umask 077; python3 -c 'import json,sys; print(json.dumps({"username": "admin", "password": open(sys.argv[1]).read().strip()}))' "$(admin_password_file)" > "$body")
hdr="$(plain -D - -o /dev/null -H 'Content-Type: application/json' -H "Origin: $WS" --data-binary "@$body" "http://$E2E_ADDR/api/auth/login")"
rm -f "$body"
contains "로그인 200" " 200" "$(printf '%s' "$hdr" | head -1)"
cookie="$(printf '%s' "$hdr" | grep -i '^set-cookie: ws_session=' | head -1 | sed -E 's/^[^:]+: ([^;]+);.*/\1/' | tr -d '\r')"
check "세션 쿠키를 받았다" test -n "$cookie"
contains "세션 쿠키는 Secure" "secure" "$(printf '%s' "$hdr" | grep -i '^set-cookie: ws_session=' | tr 'A-Z' 'a-z')"
expect "로그인한 계정은 관리자" True "$(plain -H "Cookie: $cookie" "http://$E2E_ADDR/api/auth/me" | json_get 'd["is_admin"]')"

say "클라이언트 주소 — 프록시 주소에서 온 머리말만 쓴다"
# 답변의 프록시 주소: 192.168.10.0/24 와 이 서버 자신의 주소. 이 서버에서 직접 보낸 요청이 "프록시가 넘긴 요청" 노릇을 한다.
# 믿지 않는 출발지는 다른 도커 네트워크의 컨테이너다(nginx 에게는 내부망의 게이트웨이 주소로 보인다).
docker network create --subnet 192.168.20.0/24 "$OTHER_NET" >/dev/null
# nginx 접속 로그에서 그 표시(User-Agent)가 찍힌 줄의 $remote_addr(= backend 로 넘기는 X-Forwarded-For 값)
seen_as() { docker logs ws-nginx 2>&1 | grep "\"$1\"" | tail -1 | awk '{print $1}'; }
contains "믿는 주소 목록에 이 서버" "set_real_ip_from  $E2E_ADDR;" "$(sudo cat "$E2E_HOST_DIR/stack/nginx/site.d/http.conf")"

plain -o /dev/null -A e2e-proxy-realip -H 'X-Real-IP: 203.0.113.77' -H 'X-Forwarded-For: 198.51.100.1' "http://$E2E_ADDR/api/health"
src="$(seen_as e2e-proxy-realip)"
expect "프록시 주소에서 온 X-Real-IP 는 클라이언트 주소가 된다" 203.0.113.77 "$src"

plain -o /dev/null -A e2e-proxy-xff -H 'X-Forwarded-For: 203.0.113.78' "http://$E2E_ADDR/api/health"
src="$(seen_as e2e-proxy-xff)"
note "프록시 주소 + X-Forwarded-For 만 → nginx 가 본 주소: $src (프록시는 X-Real-IP 를 보내야 한다)"
expect "X-Forwarded-For 만으로는 승격하지 않는다(프록시 주소 그대로)" "$E2E_ADDR" "$src"

out="$(docker run --rm -i --network "$OTHER_NET" --entrypoint python "$E2E_INSTALLER_IMAGE" - "$E2E_ADDR" "$E2E_DOMAIN" <<'PY'
import sys, urllib.request
addr, host = sys.argv[1:3]
req = urllib.request.Request("http://%s/api/health" % addr, headers={
    "Host": host, "User-Agent": "e2e-untrusted", "X-Real-IP": "203.0.113.88", "X-Forwarded-For": "203.0.113.88"})
print(urllib.request.urlopen(req, timeout=15).status)
PY
)"
expect "다른 출발지에서 요청" 200 "$out"
src="$(seen_as e2e-untrusted)"
note "다른 출발지 + 두 머리말 → nginx 가 본 주소: $src"
check "다른 출발지의 머리말은 무시된다" test -n "$src" -a "$src" != 203.0.113.88

say "backend 가 보는 주소"
# 프록시 주소에서 X-Real-IP 를 실어 로그인 → 세션에 그 주소가 남는다. 다른 출발지에서 위조한 주소는 남지 않는다.
body="$E2E_WORK/login.json"
(umask 077; python3 -c 'import json,sys; print(json.dumps({"username": "admin", "password": open(sys.argv[1]).read().strip()}))' "$(admin_password_file)" > "$body")
hdr="$(plain -D - -o /dev/null -H 'X-Real-IP: 203.0.113.77' -H 'Content-Type: application/json' -H "Origin: $WS" --data-binary "@$body" "http://$E2E_ADDR/api/auth/login")"
rm -f "$body"
cookie2="$(printf '%s' "$hdr" | grep -i '^set-cookie: ws_session=' | head -1 | sed -E 's/^[^:]+: ([^;]+);.*/\1/' | tr -d '\r')"
sess="$(plain -H "Cookie: $cookie2" -H 'X-Real-IP: 203.0.113.77' "http://$E2E_ADDR/api/auth/me/sessions")"
ips="$(printf '%s' "$sess" | json_get 'sorted(set(s.get("ip") for s in d["sessions"]))')"
note "세션 목록의 주소: $ips"
contains "backend 가 기록한 주소 = 프록시가 넘긴 클라이언트 주소" "203.0.113.77" "$ips"
check "위조한 주소(203.0.113.88)는 어디에도 없다" bash -c "! printf '%s' '$ips' | grep -q 203.0.113.88"

cleanup_nets
check_locked
report_usage
finish
