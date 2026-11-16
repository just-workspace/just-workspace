#!/usr/bin/env bash
# S2 협업 프리셋 — 메일(내장)·채팅·일정·문서.
# 사용: s2-collab.sh [file|api]
. "$(dirname "$0")/../lib.sh"
MODE="${1:-file}"
ADMIN_MAIL="admin@$E2E_MAIL_DOMAIN"

e2e_reset
check "설치 관리자 기동" installer_start

if [ "$MODE" = api ]; then
  # 메일 레코드 화면이 DKIM 키를 사전 생성한다 — 답변 입력 전이므로 도메인을 직접 전달한다
  wizard_login
  rec="$(wapi POST /api/probe/mail-records "{\"mail_domain\":\"$E2E_MAIL_DOMAIN\"}")"
  expect "POST /api/probe/mail-records" 200 "$(wcode)"
  DKIM_SHOWN="$(printf '%s' "$rec" | json_get '[r["expected"] for r in d["records"] if r["id"]=="dkim"][0]')"
  note "화면에 보인 DKIM 레코드: $(printf '%s' "$DKIM_SHOWN" | head -c 60)…"
fi

install "$MODE" "$E2E_ROOT/answers/collab.json" || { step_seconds; finish; }
step_seconds
check_core
expect "/api/health 의 zones" '["mail", "chat", "calendar", "docs"]' "$(ws_curl "$WS/api/health" | json_get 'd["zones"]')"
check_files
check_locked

say "여는 포트 — 요약과 실제"
ports="$(published_ports | grep -v '^\[' | sed 's/^0\.0\.0\.0://' | tr '\n' ' ')"
note "게시: $ports"
expect "게시 포트" "25/tcp 80/tcp 443/tcp 465/tcp 587/tcp 993/tcp 8443/tcp " "$ports"
if [ -n "${E2E_SUMMARY_PORTS:-}" ]; then
  want="$(printf '%s\n' $E2E_SUMMARY_PORTS 8443/tcp | sort -t/ -k1,1n | tr '\n' ' ')"
  expect "요약의 포트 + 설치 관리자 = 실제 게시" "$want" "$ports"
fi
listening="$(sudo ss -ltnH | awk '{print $4}' | grep -E '^(0\.0\.0\.0|\*):' | sed -E 's/.*:([0-9]+)$/\1/' | sort -n | tr '\n' ' ')"
note "호스트가 듣는 TCP(ss): $listening"
check "평문 IMAP(143)은 호스트에 열려 있지 않다" bash -c "! sudo ss -ltnH | grep -qE ':143\s'"

say "메일"
check "메일 서버 준비" wait_ready ws-mailserver 240
check "IMAP 993 로그인(관리자, 워크스페이스 비밀번호)" python3 "$E2E_ROOT/imap-check.py" 127.0.0.1 "$ADMIN_MAIL" "$(admin_password_file)" login
expect "관리자 메일 계정(내장)" "$ADMIN_MAIL" "$(ws_api GET /api/mail/accounts | json_get 'd[0]["email"]')"
key_state="$(sudo sha256sum "$E2E_HOST_DIR/state/dkim/$E2E_MAIL_DOMAIN.pem" | cut -d' ' -f1)"
key_server="$(docker exec ws-mailserver sha256sum /etc/rspamd/jw-dkim/default.private | cut -d' ' -f1)"
expect "DKIM 키: 미리 만든 것 = 서버에 들어간 것" "$key_state" "$key_server"
if [ -n "${DKIM_SHOWN:-}" ]; then
  pub="$(docker exec ws-mailserver openssl rsa -in /etc/rspamd/jw-dkim/default.private -pubout -outform DER 2>/dev/null | base64 -w0)"
  contains "화면에 보인 DKIM 레코드가 서버 키의 공개 키다" "p=$pub" "$DKIM_SHOWN"
fi
subject="e2e-local-$(date +%s)"
expect "내부 발송(관리자 → 관리자)" True "$(ws_api POST /api/mail/send "{\"to\":[{\"email\":\"$ADMIN_MAIL\",\"name\":\"admin\"}],\"subject\":\"$subject\",\"text_body\":\"hello\"}" | json_get 'd["ok"]')"
found=""
for i in $(seq 1 20); do
  found="$(python3 "$E2E_ROOT/imap-check.py" 127.0.0.1 "$ADMIN_MAIL" "$(admin_password_file)" find "$subject" 2>/dev/null)" && break
  sleep 2
done
contains "받은편지함에 도착" "From:" "$found"
contains "DKIM 서명이 붙었다" "d=$E2E_MAIL_DOMAIN; s=default" "$found"

say "문서 편집기"
check "문서 편집기 준비" wait_ready ws-onlyoffice 300
contains "discovery 응답" "<wopi-discovery>" "$(ws_curl "$WS/onlyoffice/hosting/discovery" | head -c 200)"
expect "편집기 healthcheck" 200 "$(ws_code "$WS/onlyoffice/healthcheck")"

say "채팅 웹소켓"
contains "웹소켓 연결(101)" "101 Switching Protocols" "$(ws_curl --http1.1 -i -N --max-time 3 -b "$UJAR" -H "Origin: $WS" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$WS/ws/chat" | head -1)"
expect "채널 목록 API" 200 "$(ws_api_code GET /api/chat/channels)"

say "일정"
cal="$(ws_api GET /api/calendar/calendars | json_get 'd["calendars"][0]["id"]')"
ev="$(ws_api POST /api/calendar/events "{\"calendar_id\":\"$cal\",\"title\":\"e2e 일정\",\"start\":\"2030-01-02T01:00:00Z\",\"end\":\"2030-01-02T02:00:00Z\"}")"
contains "일정 만들기" "e2e 일정" "$ev"

report_usage
finish
