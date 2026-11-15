#!/bin/sh
# 실행(도커 호스트에서): tar 로 backend/app → $B/backend/app, deploy/rbi-netfilter → $B/nf 를 풀고 `sh test-propagation.sh`. 운영 이름은 RBI_TEST_STACK=1 이 거부한다.
# 동적 허용 목록 전파 시험(임시 컨테이너만 — 이름 r22-*, 체인 R22-RBI, 브리지 br-r22rbi. WS-RBI·ws-* 는 건드리지 않는다)
#   1) 백엔드 코드(app.rbi.egress)가 대상에서 allow.txt 를 쓴다 → 2) 사이드카가 한 주기 안에 체인에 건다 → 실제 트래픽 통과
#   3) 대상 제거 → 한 주기 안에 규칙이 사라지고 트래픽이 막힌다 · 4) 잘못된 줄·자기 주소(force 없음)·도커 대역·상한 밖은 rejected
set -u
B="${B:-/tmp/r22}"   # 이 아래에 backend/(리포 backend) · nf/(리포 deploy/rbi-netfilter) 를 풀어 둔다
POLL=2
IMG=r22-rbi-netfilter:test
ipt() { docker run --rm --network host --cap-add NET_ADMIN --entrypoint iptables $IMG -w 5 "$@"; }
cleanup() {
  docker stop -t 10 r22-netfilter >/dev/null 2>&1; docker rm -f r22-netfilter r22-probe >/dev/null 2>&1
  docker network rm r22-rbi-net >/dev/null 2>&1
  docker run --rm -v "$B":/t alpine rm -rf /t/allow /t/guard
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }

docker build -q -t $IMG $B/nf >/dev/null || fail build
ipt -S WS-RBI >/dev/null 2>&1 && echo "(운영 체인 WS-RBI 있음 — 읽기만 함)"
docker network create --driver bridge --subnet 172.31.222.0/24 --opt com.docker.network.bridge.name=br-r22rbi \
  --opt com.docker.network.bridge.enable_icc=false r22-rbi-net >/dev/null || fail net
mkdir -p $B/allow $B/guard

writer() {  # $1 = 파이썬 대상 목록(url) — 실제 백엔드 코드로 출구 계산·파일 쓰기
  docker run --rm --name r22-writer -e PYTHONDONTWRITEBYTECODE=1 -e RBI_ALLOW_FILE=/run/rbi-allow/allow.txt \
    -e RBI_PROTECTED=192.168.10.120,192.168.10.1 -e SECRET_KEY=x -e DATABASE_URL=sqlite+aiosqlite:///:memory: \
    -v $B/backend:/app -w /app -v $B/allow:/run/rbi-allow --entrypoint python localhost/just-workspace-backend:latest -c "
import asyncio, types
from app.rbi import egress as eg
async def main():
    ts=[]
    for i,u in enumerate([$1]):
        es,_=await eg.compute_egress(u, [], [])
        ts.append(types.SimpleNamespace(key=f't{i}', enabled=True, egress=eg.dump_entries(es)))
    lines=eg.desired_lines(ts)
    eg.write_allow_file(lines)
    print('wrote', [l.split()[0] for l in lines])
asyncio.run(main())" || fail writer
}

writer "" ; # 빈 목록으로 시작
docker run -d --name r22-netfilter --network host --cap-add NET_ADMIN --cap-add NET_RAW --security-opt no-new-privileges:true \
  -e RBI_TEST_STACK=1 -e RBI_CHAIN=R22-RBI -e RBI_BRIDGE=br-r22rbi -e RBI_SUBNET=172.31.222.0/24 -e RBI_NGINX_IP=172.31.222.250 \
  -e RBI_POLL=$POLL -e RBI_ALLOW_FILE=/run/rbi-allow/allow.txt -e RBI_STATE_FILE=/run/rbi-guard/state.json \
  -v $B/allow:/run/rbi-allow:ro -v $B/guard:/run/rbi-guard $IMG >/dev/null || fail sidecar
sleep 3
cat $B/guard/state.json; echo
probe() {  # 세션 대역에서 192.168.10.170:80 으로 TCP 연결(3초) — 0 이면 열림
  docker run --rm --name r22-probe --network r22-rbi-net alpine sh -c 'nc -z -w 3 192.168.10.170 80' >/dev/null 2>&1
}
probe && fail "목록이 비었는데 열려 있다" || echo "OK  빈 목록: 192.168.10.170:80 막힘"

# 대상 추가 → 한 주기 안에
writer "'http://192.168.10.170'"
t0=$(date +%s)
n=0; while [ $n -lt 20 ]; do ipt -S R22-RBI | grep -qE -- "-d 192.168.10.170/32 .*--dport 80 " && break; sleep 0.5; n=$((n+1)); done
t1=$(date +%s)
ipt -S R22-RBI | grep -q -- "--dport 443" || fail "추가 뒤 규칙 없음"
echo "OK  추가 → 규칙 적용 $((t1-t0))초 (주기 ${POLL}초)"
ipt -S R22-RBI
grep -q '"192.168.10.170:80"' $B/guard/state.json || fail "하트비트 allow 에 없음"
probe && echo "OK  세션 대역 → 192.168.10.170:80 열림" || fail "추가했는데 막힘"

# 잘못된/금지 줄 — 사이드카가 다시 검사(백엔드를 거치지 않고 파일에 직접 넣어 본다)
docker run --rm -v $B/allow:/a alpine sh -c 'printf "# rev=deadbeef\n192.168.10.170:80  # t0\n192.168.10.170:443\n192.168.10.120:22\n172.28.0.5:8000\n8.8.8.8:443\n127.0.0.1:80\n1.2.3:80\n" > /a/allow.txt'
sleep $((POLL+2))
cat $B/guard/state.json; echo
for r in "192.168.10.120:22 self-needs-force" "172.28.0.5:8000 denied" "8.8.8.8:443 outside-ceiling" "127.0.0.1:80 denied" "1.2.3:80 format"; do
  grep -q "\"$r\"" $B/guard/state.json || fail "rejected 에 없음: $r"
done
ipt -S R22-RBI | grep -qE -- "-d (192.168.10.120|172.28.0.5|8.8.8.8|127.0.0.1)/" && fail "금지 줄이 규칙에 들어감"
echo "OK  금지·잘못된 줄 5개 거부(rejected 에 이유), 규칙에는 없음"
grep -q '"allow_rev":"deadbeef"' $B/guard/state.json && echo "OK  allow_rev 반영"

# 대상 제거 → 한 주기 안에 사라진다
writer ""
t0=$(date +%s)
n=0; while [ $n -lt 20 ]; do ipt -S R22-RBI | grep -q -- "-d 192.168.10.170" || break; sleep 0.5; n=$((n+1)); done
t1=$(date +%s)
ipt -S R22-RBI | grep -q -- "-d 192.168.10.170" && fail "제거 뒤에도 규칙 남음"
echo "OK  제거 → 규칙 사라짐 $((t1-t0))초"
probe && fail "제거했는데 열림" || echo "OK  세션 대역 → 192.168.10.170:80 다시 막힘"
docker logs r22-netfilter 2>&1 | tail -8

# 종료(SIGTERM) → 체인 정리
docker stop -t 10 r22-netfilter >/dev/null
ipt -S R22-RBI >/dev/null 2>&1 && fail "종료 뒤 체인 남음" || echo "OK  종료 → R22-RBI 체인 제거"
ipt -S DOCKER-USER | grep -q R22-RBI && fail "DOCKER-USER 점프 남음" || echo "OK  DOCKER-USER 점프 제거"
ipt -S WS-RBI >/dev/null 2>&1 && echo "(운영 체인 WS-RBI 그대로)"
echo ALL-OK
