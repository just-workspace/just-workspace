#!/usr/bin/env bash
# S3 전체 프리셋 + 애드온(SSO·LDAP) — 메일·채팅·일정·문서·회의·코드 저장소·AI(나중에 연결) + sso.
# 메모리 12GB 서버를 전제로 한다.
# 사용: s3-full-sso.sh [file|api]
. "$(dirname "$0")/../lib.sh"
MODE="${1:-file}"

e2e_reset
check "설치 관리자 기동" installer_start
install "$MODE" "$E2E_ROOT/answers/full-sso.json" || { step_seconds; sudo tail -30 "$E2E_HOST_DIR/state/logs/zones.log"; finish; }
step_seconds
note "주의: $(sudo cat "$E2E_HOST_DIR/state/apply.json" | json_get '[w["key"] for w in d["warnings"]]')"
check_core
expect "/api/health 의 zones" '["mail", "chat", "calendar", "docs", "meetings", "git", "ai", "sso"]' "$(ws_curl "$WS/api/health" | json_get 'd["zones"]')"
check_files
check_locked

say "컨테이너"
for c in ws-mailserver ws-onlyoffice ws-livekit ws-gitea ws-searxng ws-docconv ws-sandbox ws-sso ws-ldap; do
  check "$c 준비" wait_ready "$c" 300
done
note "프로파일: $(env_value COMPOSE_PROFILES)"

say "여는 포트 — 요약과 실제"
ports="$(published_ports | grep -v '^\[' | sed 's/^0\.0\.0\.0://' | tr '\n' ' ')"
note "게시: $ports"
for p in 25/tcp 80/tcp 443/tcp 465/tcp 587/tcp 993/tcp 636/tcp 2222/tcp 3478/udp 5349/tcp 7881/tcp 7882-7892/udp 127.0.0.1:389/tcp; do
  contains "게시 $p" " $p " " $ports"
done
if [ -n "${E2E_SUMMARY_PORTS:-}" ]; then
  for p in $E2E_SUMMARY_PORTS; do contains "요약의 $p 가 실제로 열려 있다" " $p " " $ports"; done
  extra="$(for p in $ports; do case " $E2E_SUMMARY_PORTS 8443/tcp 127.0.0.1:389/tcp " in *" $p "*) ;; *) printf '%s ' "$p" ;; esac; done)"
  expect "요약에 없는데 열린 포트(설치 관리자 8443·루프백 389 제외)" "" "$extra"
fi

say "회의"
tok="$(ws_api POST /api/meetings/rooms '{"name":"e2e-room"}')"
note "회의실 만들기: $(printf '%s' "$tok" | head -c 120)"
tok="$(ws_api POST /api/meetings/token '{"room":"e2e-room"}')"
check "토큰 발급 API" test -n "$(printf '%s' "$tok" | json_get 'd["token"]')"
note "livekit_url: $(printf '%s' "$tok" | json_get 'd["livekit_url"]')"
expect "LiveKit 신호 경로(/livekit/ — 토큰 없이 401)" 401 "$(ws_code "$WS/livekit/rtc/validate")"
check "UDP 3478 을 호스트가 듣는다" bash -c "sudo ss -lunH | grep -qE ':3478\s'"
check "UDP 7882 를 호스트가 듣는다" bash -c "sudo ss -lunH | grep -qE ':7882\s'"
contains "LiveKit 이 알리는 주소(node_ip)" "$E2E_ADDR" "$(sudo cat "$E2E_HOST_DIR/stack/livekit/livekit.yaml")"

say "코드 저장소(Gitea 구역 훅)"
expect "버전 verified = compose 의 고정 이미지" "$(grep -oE 'gitea/gitea@sha256:[0-9a-f]{64}' "$E2E_REPO/docker-compose.yml" | head -1)" "$(env_value GITEA_IMAGE)"
contains "실제 컨테이너 이미지" "$(env_value GITEA_IMAGE | cut -d@ -f2)" "$(docker inspect -f '{{.Config.Image}}' ws-gitea)"
contains "초기 설정: DB 가 워크스페이스의 PostgreSQL" "DB_TYPE = postgres" "$(docker exec -u git ws-gitea cat /data/gitea/conf/app.ini | tr -s ' ')"
contains "gitea 데이터베이스에 표가 생겼다" "t" "$(docker exec ws-postgres psql -U workspace -d gitea -Atc "select count(*)>10 from information_schema.tables where table_schema='public'")"
contains "관리 계정 jw-admin" "jw-admin" "$(docker exec -u git ws-gitea gitea --config /data/gitea/conf/app.ini admin user list --admin)"
check "관리 토큰이 .env 에 있다" test -n "$(env_value GITEA_TOKEN)"
expect "backend 가 받은 토큰 = .env 의 토큰" "$(env_value GITEA_TOKEN | tr -d '\n' | sha256sum)" "$(docker exec ws-backend printenv GITEA_TOKEN | tr -d '\n' | sha256sum)"
contains "OAuth 클라이언트 등록(OAUTH_CLIENTS_JSON)" "/git/user/oauth2/workspace/callback" "$(docker exec ws-backend printenv OAUTH_CLIENTS_JSON)"
auths="$(docker exec -u git ws-gitea gitea --config /data/gitea/conf/app.ini admin auth list)"
if printf '%s' "$auths" | grep -q workspace; then
  ok "Gitea 로그인 원본 workspace 등록"
else
  # 임시 인증서에서는 Gitea 가 접속 주소의 설정 문서를 신뢰하지 못하여 등록이 보류된다 — 주의 항목으로 기록되어야 한다
  contains "로그인 원본 등록이 미뤄졌고 주의로 남았다(임시 인증서)" git_sso_pending "$(sudo cat "$E2E_HOST_DIR/state/apply.json" | json_get '[w["key"] for w in d["warnings"]]')"
  # 등록 명령 자체가 이 Gitea 버전에서 동작하는지는 내부 주소(인증서 없이 도달 가능한 backend)로 시험 등록한 후 삭제하여 확인한다
  gitea_cli() { docker exec -u git ws-gitea gitea --config /data/gitea/conf/app.ini "$@"; }
  gitea_cli admin auth add-oauth --name e2e-probe --provider openidConnect --key e2e-probe --secret e2e-probe-secret \
    --auto-discover-url http://backend:8000/oauth/.well-known/openid-configuration --scopes "openid email profile" >/dev/null 2>&1
  probe_id="$(gitea_cli admin auth list | awk '$2=="e2e-probe"{print $1}')"
  check "로그인 원본 등록 명령은 이 Gitea 버전에서 통한다(내부 주소로 시험 등록)" test -n "$probe_id"
  [ -n "$probe_id" ] && gitea_cli admin auth delete --id "$probe_id" >/dev/null 2>&1
fi
expect "/git/ 앞단 경로" 200 "$(ws_code -L "$WS/git/")"
expect "/git/api/healthz" 200 "$(ws_code "$WS/git/api/healthz")"
expect "/api/git/repos" 200 "$(ws_api_code GET /api/git/repos)"
check "Gitea SSH 포트 응답(2222)" bash -c "timeout 5 bash -c '</dev/tcp/127.0.0.1/2222'"

say "AI(나중에 연결)"
note "ai 구역 컨테이너: searxng·docconv·sandbox"
expect "AI 상태 API" 200 "$(ws_api_code GET /api/ai/status)"
expect "AI 제공자는 아직 연결되지 않았다" False "$(ws_api GET /api/ai/status | json_get 'd["configured"]')"

say "SSO·LDAP"
expect "/sso/health" 200 "$(ws_code "$WS/sso/health")"
contains "LDAPS 636 응답(TLS 핸드셰이크)" "BEGIN CERTIFICATE" "$(timeout 10 openssl s_client -connect 127.0.0.1:636 -showcerts </dev/null 2>/dev/null)"
expect "평문 389 는 루프백에만" "127.0.0.1:389" "$(sudo ss -ltnH | awk '{print $4}' | grep -E ':389$' | tr '\n' ' ' | sed 's/ $//')"
check "평문 389 는 바깥 주소로 닿지 않는다" bash -c "! timeout 3 bash -c '</dev/tcp/$E2E_ADDR/389'"
check "평문 389 는 루프백에서 닿는다" bash -c "timeout 3 bash -c '</dev/tcp/127.0.0.1/389'"

say "메모리 — zones.json 의 권장값과 실제"
python3 - "$E2E_REPO/backend/app/zones.json" <<'PY'
import json, subprocess, sys
z = json.load(open(sys.argv[1]))
groups = [z["core"], *z["zones"], *z.get("addons", [])]
stats = {}
for line in subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}"],
                           capture_output=True, text=True).stdout.splitlines():
    name, usage = line.split("\t")
    num = usage.split("/")[0].strip()
    mult = {"KiB": 1 / 1024, "MiB": 1, "GiB": 1024}[num[-3:]]
    stats[name] = float(num[:-3]) * mult
total_idle = total_rec = total_real = 0
print("   %-10s %8s %8s %8s  %s" % ("구역", "실제MB", "idle", "권장", "컨테이너"))
for g in groups:
    names = ["ws-" + s for s in g.get("services", [])]
    real = sum(stats.get(n, 0) for n in names)
    running = [n for n in names if n in stats]
    if not running and g["id"] != "core":
        continue
    m = g["memory_mb"]
    total_idle += m["idle"]; total_rec += m["recommend"]; total_real += real
    print("   %-10s %8.0f %8d %8d  %s" % (g["id"], real, m["idle"], m["recommend"], " ".join(running)))
print("   %-10s %8.0f %8d %8d" % ("합계", total_real, total_idle, total_rec))
print("   설치 관리자: %.0f MB" % stats.get("jw-installer", 0))
PY

report_usage
finish
