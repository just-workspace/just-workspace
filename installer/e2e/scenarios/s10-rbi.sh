#!/usr/bin/env bash
# S10 격리 브라우저 — 기본 + 회의 + 격리 브라우저 애드온으로 설치하고, 대상으로 사용할 임시 웹 서버를 기동하여 등록한다.
#   · .env 의 RBI_PROTECTED 에 이 서버의 주소와 기본 게이트웨이가 기록되었는가
#   · 서버 자신을 가리키는 대상은 강제 지정 없이는 거부된다(backend 가 저장 시 차단한다)
#   · LAN 의 다른 호스트를 가리키는 대상은 그대로 저장된다
# 세션 화면에 대상이 실제로 렌더링되는지는 본 설치를 유지한 상태에서 이 PC 의 rbi-session-ui.cjs 로 확인한다(미러·픽셀, 화면 캡처).
# 회의 구역은 잡음 제거 화면 검수(meeting-noise-ui.cjs)가 동일 설치를 사용하도록 함께 활성화한다.
#
# 대상 웹 서버는 "LAN 의 다른 호스트" 여야 한다 — 세션 컨테이너는 이 서버 자신에 도달할 수 없다(호스트 INPUT 을 차단한다. 도커 대역도 대상이
# 될 수 없다). 따라서 네트워크 네임스페이스 하나를 별도 생성하여(veth 한 쌍, 대역 E2E_RBI_NET) 그 안에서 웹 서버를 기동한다.
#
# 사용: s10-rbi.sh          설치 + 대상 등록(설치와 대상 웹 서버를 유지한다)
#       s10-rbi.sh post     화면 검수 후 — 격리 규칙에 대상이 반영되었는지, 세션 컨테이너가 잔존하지 않는지 확인
#       s10-rbi.sh down     대상 웹 서버를 삭제한다
. "$(dirname "$0")/../lib.sh"
TARGET_PORT=8088
TARGET_NS=jwe2etgt
TARGET_NET="${E2E_RBI_NET:-10.211.77}"          # /24 의 앞 세 옥텟 — 이 서버가 사용하지 않는 사설 대역
TARGET_ADDR="$TARGET_NET.2"
TARGET_DIR="$E2E_WORK/rbi-target"
TARGET_MARK="JW-RBI-TARGET-4711"

target_down() {
  sudo ip netns pids "$TARGET_NS" 2>/dev/null | xargs -r sudo kill 2>/dev/null
  sudo ip netns del "$TARGET_NS" 2>/dev/null
  sudo ip link del jwtgt0 2>/dev/null
  rm -rf "$TARGET_DIR"
}
if [ "${1:-}" = down ]; then target_down; echo "대상 웹 서버를 지웠습니다"; exit 0; fi

if [ "${1:-}" = post ]; then
  say "화면 검수 뒤"
  ws_login
  line="$TARGET_ADDR:$TARGET_PORT"
  status="$(ws_api GET /api/admin/rbi)"
  expect "격리 규칙 상태" True "$(printf '%s' "$status" | json_get 'd["status"]["guard"]["ok"]')"
  contains "출구 규칙에 대상이 실렸다" "$line" "$(printf '%s' "$status" | json_get '" ".join(d["status"]["guard"]["allow"] or [])')"
  expect "거부된 줄 없음" 0 "$(printf '%s' "$status" | json_get 'len(d["status"]["guard"]["rejected"] or [])')"
  expect "열린 세션 없음" 0 "$(printf '%s' "$status" | json_get 'len(d["sessions"])')"
  expect "세션 컨테이너가 남지 않았다" "" "$(docker ps -a --format '{{.Names}}' | grep '^ws-rbi-s-' | tr '
' ' ')"
  modes="$(ws_api GET /api/admin/rbi/sessions | json_get '" ".join(sorted({s["mode"] for s in (d["sessions"] if isinstance(d, dict) else d)}))')"
  expect "끝난 세션의 방식(미러·픽셀)" "mirror pixel" "$modes"
  # 세션 브리지에서 이 서버 자신으로 향하는 경로는 차단되어 있다
  check "호스트 INPUT 에 세션 브리지 DROP" bash -c "docker exec ws-rbi-netfilter iptables -S INPUT | grep -q -- '-i br-wsrbi -j DROP'"
  finish
fi

target_down
e2e_reset
say "설치 관리자 시작"
check "설치 관리자 기동" installer_start
# 픽셀 방식의 세션 이미지는 외부 이미지(third-party)이다 — 최초 세션 시 pull 로 지연되지 않도록 사전에 pull 한다
PIXEL_IMAGE="$(sed -n 's/^ *rbi_image: str = "\(.*\)".*/\1/p' "$E2E_REPO/backend/app/config.py")"
check "픽셀 세션 이미지($PIXEL_IMAGE)" bash -c "docker image inspect '$PIXEL_IMAGE' >/dev/null 2>&1 || docker pull -q '$PIXEL_IMAGE' >/dev/null"
check "미러 세션 이미지" docker image inspect "localhost/just-workspace-rbi-mirror:$E2E_VERSION"

install file "$E2E_ROOT/answers/rbi.json" || { step_seconds; finish; }
step_seconds
check_core
check "컨테이너 ws-rbi-netfilter 준비" wait_ready ws-rbi-netfilter 120
check "컨테이너 ws-livekit 준비" wait_ready ws-livekit 180

say "RBI_PROTECTED"
gateway="$(ip -4 route show default | awk '{print $3; exit}')"
expect ".env 의 RBI_PROTECTED = 이 서버의 주소,기본 게이트웨이" "$E2E_ADDR,$gateway" "$(env_value RBI_PROTECTED)"
expect "backend 가 그 값을 받았다" "$E2E_ADDR,$gateway" "$(docker exec ws-backend printenv RBI_PROTECTED)"

say "대상 웹 서버(임시)"
mkdir -p "$TARGET_DIR"
cat > "$TARGET_DIR/index.html" <<HTML
<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>검수 대상</title>
<style>body{font-family:sans-serif;margin:40px;background:#fffbe6}h1{font-size:44px;color:#b00020}
.box{margin-top:24px;padding:20px;border:6px solid #0050b3;font-size:28px;background:#e6f4ff}</style></head>
<body><h1>$TARGET_MARK</h1><p>격리 브라우저 검수용 대상 페이지입니다.</p>
<div class="box">상자 안의 글자 — BOX-OK</div>
<p><a href="/second.html">둘째 쪽으로</a></p></body></html>
HTML
printf '<!doctype html><meta charset="utf-8"><title>둘째</title><h1>SECOND-PAGE</h1>\n' > "$TARGET_DIR/second.html"
sudo ip netns add "$TARGET_NS"
sudo ip link add jwtgt0 type veth peer name jwtgt1
sudo ip link set jwtgt1 netns "$TARGET_NS"
sudo ip addr add "$TARGET_NET.1/24" dev jwtgt0
sudo ip link set jwtgt0 up
sudo ip netns exec "$TARGET_NS" sh -c "ip link set lo up && ip addr add $TARGET_ADDR/24 dev jwtgt1 && ip link set jwtgt1 up && ip route add default via $TARGET_NET.1"
sudo ip netns exec "$TARGET_NS" sh -c "cd '$TARGET_DIR' && exec setsid python3 -m http.server $TARGET_PORT --bind $TARGET_ADDR >/dev/null 2>&1 &"
for i in $(seq 1 20); do curl -fs -o /dev/null "http://$TARGET_ADDR:$TARGET_PORT/" && break; sleep 1; done
contains "대상 페이지가 뜬다" "$TARGET_MARK" "$(curl -s "http://$TARGET_ADDR:$TARGET_PORT/")"

say "대상 등록"
ws_login
target_body() { printf '{"key":"%s","name":"%s","url":"http://%s:%s/","mode":"mirror","extra_ports":[%s]}' "$1" "$2" "$3" "$TARGET_PORT" "$TARGET_PORT"; }
expect "서버 자신을 가리키는 대상은 강제 없이 거부(400)" 400 "$(ws_api_code POST /api/admin/rbi/targets "$(target_body self 자신 "$E2E_ADDR")")"
contains "사유는 워크스페이스 자신의 주소" "워크스페이스 자신의 주소" "$(ws_api POST /api/admin/rbi/targets "$(target_body self 자신 "$E2E_ADDR")")"
out="$(ws_api POST /api/admin/rbi/targets "$(target_body e2e '검수 대상' "$TARGET_ADDR")")"
tid="$(printf '%s' "$out" | json_get 'd["id"]')"
check "LAN 의 다른 호스트는 그대로 저장" test -n "$tid" -a "$tid" != None
expect "저장한 출구" "$TARGET_ADDR:$TARGET_PORT" "$(printf '%s' "$out" | json_get '" ".join("%s:%s" % (e["ip"], e["port"]) for e in d["egress"])')"
expect "방식은 미러, 픽셀로도 열 수 있다" "mirror pixel" "$(printf '%s' "$out" | json_get '" ".join(d["modes"])')"
note "격리 규칙은 첫 세션이 세션 전용 브리지를 만든 뒤에 걸린다 — 화면 검수 뒤 's10-rbi.sh post' 가 본다"

report_usage
say "남겨 둔 것"
note "설치와 대상 웹 서버(http://$TARGET_ADDR:$TARGET_PORT/)를 남겼습니다 — 화면 검수(rbi-session-ui.cjs) → 's10-rbi.sh post' → 's10-rbi.sh down'"
finish
