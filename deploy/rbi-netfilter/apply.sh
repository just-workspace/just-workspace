#!/bin/sh
# ws-rbi-netfilter — 격리 브라우저 세션 브리지(기본 br-wsrbi)의 트래픽을 허용 목적지로만 묶는 호스트 iptables 규칙.
#
# 전용 체인 WS-RBI 를 만들고 DOCKER-USER 맨 앞에서 뛰어든다(FORWARD 가 가장 먼저 거치는 체인 — 도커 자체 규칙보다 우선).
#   세션 → 바깥 : ESTABLISHED,RELATED 통과 · 허용 목적지 TCP 새 연결 통과 · 나머지 전부 DROP
#                 (인터넷·LAN·다른 도커 브리지·게시 포트 DNAT 로 가는 ws-* 전부)
#                 허용 목적지 = RBI_ALLOW(고정, 운영자가 .env 에 — 늘 허용) ∪ 동적 목록(RBI_ALLOW_FILE — 백엔드가 켜진 대상에서 만든다)
#   바깥 → 세션 : ws-nginx 고정 IP(RBI_NGINX_IP)에서 6901 로 가는 새 연결만 통과(도커의 게시 포트 규칙으로 이어짐) · 나머지 DROP
#   세션 → 호스트: INPUT 체인에서 브리지 입력을 DROP (호스트 sshd·docker-proxy 가 듣는 게시 포트 등)
# 동적 목록(관리 화면에서 대상을 더하면 재시작 없이): RBI_POLL 초(기본 5)마다 RBI_ALLOW_FILE 을 읽는다. 파일은 백엔드만 쓰는 볼륨
#   (rbi-allow, 여기서는 읽기 전용)이고 줄마다 다시 검사한다 — 형식(IPv4:포트[ force]) · RBI_ALLOW_CEILING(기본 사설 대역) 안 ·
#   루프백·링크로컬·멀티캐스트·세션 대역·이 호스트의 도커 브리지 대역(docker0·br-*)·RBI_DENY 거부 · 이 호스트 자신의 주소와
#   기본 게이트웨이는 "force" 가 붙은 줄만. 거부한 줄은 하트비트의 rejected 에 이유와 함께 싣는다(관리 화면 "격리 규칙 상태").
# 하트비트: 결과를 RBI_STATE_FILE(사이드카만 쓰는 볼륨 rbi-guard — 백엔드는 읽기 전용)에 매 주기 쓴다 — 오래되면 백엔드가 세션을 띄우지 않는다.
# 멱등: 체인 내용이 마지막으로 적용한 것과 같고 목록이 그대로면 손대지 않는다(다르거나 사라졌을 때만 flush → 재구성).
# 종료(SIGTERM): 체인·점프를 걷어낸다(남은 세션은 백엔드 reaper 가 하트비트 만료로 거둔다).
#
# ★ 운영 체인을 시험이 건드리지 못하게(실제 사고: 시험 중 `docker run <이미지> sh -c "iptables -S"` 가 ENTRYPOINT 로 이 스크립트를
#   기본값(체인 WS-RBI)으로 돌렸다 — NET_ADMIN 이 없어 실패했을 뿐):
#   1) 인자를 받지 않는다 — `docker run <이미지> <명령>` 으로 다른 일을 시키면 아무것도 하지 않고 끝난다(--entrypoint 를 쓸 것).
#   2) RBI_CHAIN 기본값이 없다 — 운영 compose 가 RBI_CHAIN=WS-RBI 를 명시한다. 비면 아무것도 하지 않고 끝난다.
#   3) RBI_TEST_STACK=1(시험 스택)이면 운영 이름(체인 WS-RBI·브리지 br-wsrbi)을 거부한다.
set -u

if [ "$#" -gt 0 ]; then
    echo "[rbi-netfilter] 인자를 받지 않습니다($*) — 다른 명령은 --entrypoint 로. 규칙을 건드리지 않고 끝냅니다" >&2
    exit 64
fi
if [ -z "${RBI_CHAIN:-}" ]; then
    echo "[rbi-netfilter] RBI_CHAIN 이 비었습니다(운영: WS-RBI — compose 가 명시). 규칙을 건드리지 않고 끝냅니다" >&2
    exit 64
fi
if [ "${RBI_TEST_STACK:-0}" = "1" ] && { [ "$RBI_CHAIN" = "WS-RBI" ] || [ "${RBI_BRIDGE:-br-wsrbi}" = "br-wsrbi" ]; }; then
    echo "[rbi-netfilter] 시험 스택(RBI_TEST_STACK=1)은 운영 이름(체인 WS-RBI·브리지 br-wsrbi)을 쓸 수 없습니다" >&2
    exit 64
fi
case "$RBI_CHAIN" in
    *[!A-Z0-9-]*|"") echo "[rbi-netfilter] RBI_CHAIN 형식 오류: $RBI_CHAIN" >&2; exit 64 ;;
esac

BRIDGE="${RBI_BRIDGE:-br-wsrbi}"
SUBNET="${RBI_SUBNET:-172.31.200.0/24}"
NGINX_IP="${RBI_NGINX_IP:-172.28.0.2}"
STATIC_ALLOW="${RBI_ALLOW:-}"
ALLOW_FILE="${RBI_ALLOW_FILE:-/run/rbi-allow/allow.txt}"
CEILING="${RBI_ALLOW_CEILING:-}"
[ -z "$CEILING" ] && CEILING="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
EXTRA_DENY="${RBI_DENY:-}"
STATE_FILE="${RBI_STATE_FILE:-/run/rbi-guard/state.json}"
POLL="${RBI_POLL:-5}"
CHAIN="$RBI_CHAIN"                    # 기본 WS-RBI(compose 가 명시) · 시험 스택은 다른 이름(예 R22-RBI)
INGRESS_PORT="${RBI_INGRESS_PORT:-6901}"  # 세션 컨테이너가 듣는 포트(KasmVNC·mirror-agent 모두 6901)
IPT="iptables -w 5"
case "$POLL" in *[!0-9]*|"") POLL=5 ;; esac
[ "$POLL" -lt 1 ] && POLL=1

ALLOW=""          # 이번 주기에 실제로 거는 목록(고정 ∪ 검사를 통과한 동적)
DYN_OK=""
REJECTED=""
ALLOW_REV=""

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [rbi-netfilter] $*"; }

# 동적 목록 읽기 + 줄마다 검사 → DYN_OK(쉼표 목록) · REJECTED("IP:포트 이유" 를 | 로) · ALLOW_REV
load_dynamic() {
    DYN_OK=""; REJECTED=""; ALLOW_REV=""
    [ -r "$ALLOW_FILE" ] || return 0
    ALLOW_REV=$(sed -n 's/^# rev=\([0-9a-f]*\).*/\1/p' "$ALLOW_FILE" | head -1)
    # 이 호스트의 도커 브리지 대역(세션이 닿으면 안 되는 ws-* 컨테이너) · 자신의 주소 · 기본 게이트웨이
    docker_nets=$(ip -4 -o addr show 2>/dev/null | awk '$2=="docker0" || $2 ~ /^br-/ {print $4}' | paste -sd, -)
    self_ips=$(ip -4 -o addr show 2>/dev/null | awk '{split($4,a,"/"); print a[1]}' | paste -sd, -)
    gw=$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')
    out=$(awk -v ceil="$CEILING" \
              -v deny="0.0.0.0/8,127.0.0.0/8,169.254.0.0/16,224.0.0.0/3,$SUBNET,$docker_nets,$EXTRA_DENY" \
              -v selfs="$self_ips,$gw" -f /rbi-allow-check.awk "$ALLOW_FILE")
    DYN_OK=$(echo "$out" | sed -n 1p)
    REJECTED=$(echo "$out" | sed -n 2p)
}

compute_allow() {
    load_dynamic
    ALLOW=$(printf '%s,%s' "$STATIC_ALLOW" "$DYN_OK" | tr ',' '\n' | tr -d ' ' | sed '/^$/d' | awk '!seen[$0]++' | paste -sd, -)
}

# 원하는 체인 내용(추가 순서 = 평가 순서)
desired_rules() {
    echo "-i $BRIDGE -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
    echo "-o $BRIDGE -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
    echo "$ALLOW" | tr ',' '\n' | tr -d ' ' | sed '/^$/d' | while IFS= read -r a; do
        ip="${a%%:*}"; port="${a##*:}"
        [ "$ip" = "$port" ] && port=80
        echo "-i $BRIDGE -d $ip -p tcp --dport $port -m conntrack --ctstate NEW -j RETURN"
    done
    echo "-i $BRIDGE -j DROP"
    echo "-o $BRIDGE -s $NGINX_IP -p tcp --dport $INGRESS_PORT -m conntrack --ctstate NEW -j RETURN"
    echo "-o $BRIDGE -j DROP"
}

LAST_APPLIED=""
RULES=0
OK=1
ERR=""

rebuild_chain() {
    $IPT -N "$CHAIN" 2>/dev/null || true
    $IPT -F "$CHAIN" || { OK=0; ERR="flush failed"; return; }
    desired_rules | while IFS= read -r r; do
        # shellcheck disable=SC2086
        $IPT -A "$CHAIN" $r || echo "FAILED $r" >&2
    done
    LAST_APPLIED=$($IPT -S "$CHAIN" 2>/dev/null)
}

apply() {
    OK=1; ERR=""
    if ! ip link show "$BRIDGE" >/dev/null 2>&1; then
        # 브리지는 백엔드가 첫 세션 때 만든다(docker network create). 그때까지는 지킬 것이 없다 — 하트비트는 쓴다.
        OK=0; ERR="bridge $BRIDGE not present yet"; RULES=0
        return
    fi
    current=$($IPT -S "$CHAIN" 2>/dev/null)
    if [ -z "$LAST_APPLIED" ] || [ "$current" != "$LAST_APPLIED" ]; then
        log "chain $CHAIN missing, drifted or allow list changed — rebuilding"
        rebuild_chain
    fi
    $IPT -N DOCKER-USER 2>/dev/null || true
    $IPT -C DOCKER-USER -j "$CHAIN" 2>/dev/null || $IPT -I DOCKER-USER 1 -j "$CHAIN" || { OK=0; ERR="jump failed"; }
    $IPT -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null || $IPT -I INPUT 1 -i "$BRIDGE" -j DROP || { OK=0; ERR="input failed"; }
    RULES=$($IPT -S "$CHAIN" 2>/dev/null | grep -c "^-A $CHAIN " || echo 0)
    want=$(desired_rules | wc -l)
    if [ "$RULES" -ne "$want" ]; then OK=0; ERR="rule count $RULES != $want"; fi
}

write_state() {
    mkdir -p "$(dirname "$STATE_FILE")"
    allow_json=$(echo "$ALLOW" | tr ',' '\n' | tr -d ' ' | sed '/^$/d' | sed 's/.*/"&"/' | paste -sd, -)
    dyn_n=$(echo "$DYN_OK" | tr ',' '\n' | sed '/^$/d' | wc -l)
    rej_json=$(echo "$REJECTED" | tr '|' '\n' | sed '/^$/d' | tr -d '"\\' | sed 's/.*/"&"/' | paste -sd, -)
    ok_json=$([ "$OK" = 1 ] && echo true || echo false)
    tmp="$STATE_FILE.tmp"
    printf '{"ok":%s,"applied_at":%s,"bridge":"%s","subnet":"%s","nginx_ip":"%s","allow":[%s],"dynamic":%s,"rejected":[%s],"allow_rev":"%s","rules":%s,"error":"%s"}\n' \
        "$ok_json" "$(date +%s)" "$BRIDGE" "$SUBNET" "$NGINX_IP" "$allow_json" "$dyn_n" "$rej_json" "$ALLOW_REV" "$RULES" "$(echo "$ERR" | tr '"' "'")" > "$tmp"
    mv -f "$tmp" "$STATE_FILE"
}

remove_rules() {
    log "removing rules"
    $IPT -D DOCKER-USER -j "$CHAIN" 2>/dev/null || true
    $IPT -D INPUT -i "$BRIDGE" -j DROP 2>/dev/null || true
    $IPT -F "$CHAIN" 2>/dev/null || true
    $IPT -X "$CHAIN" 2>/dev/null || true
    rm -f "$STATE_FILE"
}

trap 'remove_rules; exit 0' TERM INT

log "guarding bridge=$BRIDGE subnet=$SUBNET nginx=$NGINX_IP static=[$STATIC_ALLOW] dynamic=$ALLOW_FILE ceiling=[$CEILING] every ${POLL}s"
prev=""
prev_allow="__none__"
while :; do
    compute_allow
    if [ "$ALLOW" != "$prev_allow" ]; then
        log "allow list: [$ALLOW]${REJECTED:+ rejected: $REJECTED}"
        [ -z "$ALLOW" ] && log "allow list is empty — sessions have no egress at all"
        prev_allow="$ALLOW"
        LAST_APPLIED=""   # 목록이 바뀌었다 → 다음 apply 에서 체인을 다시 만든다
    fi
    apply
    write_state
    cur="ok=$OK rules=$RULES ${ERR:+err=$ERR}"
    if [ "$cur" != "$prev" ]; then log "$cur"; prev="$cur"; fi
    # 동적 목록을 POLL 초마다 본다(관리 화면에서 더한 대상이 한 주기 안에 걸린다). 체인은 목록이 바뀌었거나 어긋났을 때만 다시 만든다
    sleep "$POLL" &
    wait $!
done
