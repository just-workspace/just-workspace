#!/bin/sh
# 상태 점검 프로브 — "조용히 죽는 것들"을 주기적으로 찔러보고 결과를 JSON 한 줄씩
# stdout 으로 뱉는다.
#
# 왜 이런 모양인가:
#   Vector 의 docker_logs 소스가 이미 전 컨테이너 stdout 을 읽어 Loki 로 보낸다.
#   그러니 여기서 stdout 에 찍기만 하면 service="ws-healthprobe" 라벨로 저절로
#   적재된다 — Vector 설정도, 새 수집 경로도 건드릴 필요가 없다.
#   status 값(ok/warn/error/critical)은 Vector 의 level 추정 정규식에 그대로
#   걸리도록 고른 단어다.
#
# 이 프로브가 잡으려는 것(재시도하며 조용히 실패하는 종류):
#   - 인증서 자동갱신이 계속 실패하는데 만료 직전에야 드러나는 경우
#   - 터널·프록시 경로가 패키지 업데이트 뒤 죽은 채로 방치되는 경우
#   - 파일 색인이 깨진 파일 하나 때문에 매 주기 실패하며 갱신이 멈추는 경우
#   공통점: 누가 들여다보기 전에는 드러나지 않는다.

set -u

INTERVAL="${PROBE_INTERVAL:-300}"
CERT_WARN_DAYS="${CERT_WARN_DAYS:-21}"
CERT_ERR_DAYS="${CERT_ERR_DAYS:-7}"
DISK_WARN_PCT="${DISK_WARN_PCT:-80}"
DISK_ERR_PCT="${DISK_ERR_PCT:-90}"
INDEX_WARN_HOURS="${INDEX_WARN_HOURS:-6}"
INDEX_ERR_HOURS="${INDEX_ERR_HOURS:-24}"

# JSON 문자열 이스케이프 — 역슬래시와 큰따옴표만 처리하면 충분하다
# (여기서 만드는 값에 제어문자는 안 들어간다).
esc() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

emit() {
  # emit <check> <target> <status> <value> <detail> [dev] [ms] [alert]
  #   dev   — 장비 표(장비 스테이터스)의 묶음 이름. 비우면 표에 안 나온다.
  #   ms    — 응답 시간(밀리초). 표의 "응답" 칸.
  #   alert — 0 이면 장비 다운 알림에서 뺀다(이미 다른 규칙이 같은 고장을 알리는 행).
  #   code  — 표·알림이 숫자로 비교하려고 status 를 0(ok)/1(warn)/2(error·critical)로 옮긴 것.
  #   ts    — 확인 시각(epoch 초). 표의 "마지막 확인" 칸 — Loki 지표 질의로는 줄의
  #           시각을 값으로 못 꺼내서 본문에 같이 싣는다.
  #   name  — 사람이 읽는 한글 이름(알림 메일). 9번째 인자, 비우면 default_name 이 정한다.
  case "$3" in ok) _c=0 ;; warn) _c=1 ;; *) _c=2 ;; esac
  _nm="${9:-}"; [ -n "$_nm" ] || _nm=$(default_name "$1" "$2")
  printf '{"probe":"healthcheck","check":"%s","target":"%s","name":"%s","status":"%s","value":%s,"detail":"%s","dev":"%s","code":%s,"ms":%s,"alert":"%s","ts":%s}\n' \
    "$(esc "$1")" "$(esc "$2")" "$(esc "$_nm")" "$3" "${4:-null}" "$(esc "${5:-}")" \
    "$(esc "${6:-}")" "$_c" "${7:-null}" "${8:-1}" "$(date +%s)"
}

# 코어가 직접 만드는 점검 행의 한글 이름. 사이트 장비 이름은 devices.conf 줄 끝 "# 이름".
default_name() {
  case "$1:$2" in
    http:backend)    echo "워크스페이스 백엔드" ;;
    http:frontend)   echo "워크스페이스 웹 화면" ;;
    http:loki)       echo "로그 저장소(Loki)" ;;
    http:grafana)    echo "모니터링(Grafana)" ;;
    http:gitea)      echo "Git 서버" ;;
    http:livekit)    echo "화상회의 서버(LiveKit)" ;;
    http:netlab)     echo "NetLab 사이트" ;;
    tcp:postgres)    echo "데이터베이스(PostgreSQL)" ;;
    tcp:redis)       echo "캐시(Redis)" ;;
    tcp:mail_smtp)   echo "메일 서버 SMTP(25)" ;;
    tcp:mail_imap)   echo "메일 서버 IMAP(993)" ;;
    cert:web)        echo "웹사이트 인증서" ;;
    cert:lab)        echo "NetLab 인증서" ;;
    cert:mail)       echo "메일 인증서" ;;
    cert:turn)       echo "화상회의 TURN 인증서" ;;
    tunnel:*)        echo "터널 경유 접속" ;;
    disk:*)          echo "저장 공간 $2" ;;
    index:indexer)   echo "파일 색인기" ;;
    index:rows)      echo "파일 색인 건수" ;;
    dns:*)           echo "공인 DNS $2" ;;
    *)               echo "$2" ;;
  esac
}

# 초 단위 소수(curl time_total) → 정수 밀리초
to_ms() { awk -v t="${1:-}" 'BEGIN { if (t == "") print "null"; else printf "%d", t * 1000 }'; }

# ── HTTP 헬스 ────────────────────────────────────────────────
check_http() {
  # check_http <이름> <URL> [기대코드정규식] [host:port:addr — curl --resolve, 앞단 프록시 경유 점검용]
  name="$1"; url="$2"; want="${3:-^(2|3)}"; rs="${4:-}"
  set --
  [ -n "$rs" ] && set -- --resolve "$rs"
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" "$url" 2>/dev/null)
  ms=$(curl -s -o /dev/null -m 10 -w '%{time_total}' "$@" "$url" 2>/dev/null)
  if printf '%s' "$code" | grep -qE "$want"; then
    emit http "$name" ok "${ms:-null}" "HTTP $code" app "$(to_ms "$ms")"
  else
    emit http "$name" error null "HTTP ${code:-000} (응답 없음 또는 비정상)" app
  fi
}

# ── TLS 인증서 만료 ──────────────────────────────────────────
# 파일(certbot 볼륨)이 아니라 **실제 서빙되는 인증서**를 본다.
# certbot 은 갱신했는데 nginx 가 리로드를 안 해서 옛 인증서를 계속 내보내는
# 경우가 있다 — 파일만 보면 그걸 못 잡는다.
check_cert() {
  name="$1"; hostport="$2"; sni="$3"
  end=$(echo | timeout 15 openssl s_client -connect "$hostport" -servername "$sni" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -z "$end" ]; then
    emit cert "$name" error null "TLS 핸드셰이크 실패 또는 인증서를 읽지 못함"
    return
  fi
  exp=$(date -d "$end" +%s 2>/dev/null)
  now=$(date +%s)
  if [ -z "$exp" ]; then
    emit cert "$name" error null "만료일 파싱 실패: $end"
    return
  fi
  days=$(( (exp - now) / 86400 ))
  if [ "$days" -lt "$CERT_ERR_DAYS" ]; then
    emit cert "$name" critical "$days" "만료 ${days}일 전 — $end"
  elif [ "$days" -lt "$CERT_WARN_DAYS" ]; then
    emit cert "$name" warn "$days" "만료 ${days}일 전 — $end"
  else
    emit cert "$name" ok "$days" "만료까지 ${days}일 — $end"
  fi
}

# ── 터널 경유 경로 ───────────────────────────────────────────
# 터널 IP 로 TCP 가 열리는지가 아니라 **터널 끝의 프록시가 실제로 원본까지 중계하는지**
# 를 본다. 터널만 서고 프록시가 죽어 있으면 전자는 통과해 버린다.
check_tunnel() {
  code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' \
         --resolve "${TUNNEL_PROBE_HOST}:443:${TUNNEL_IP}" \
         "https://${TUNNEL_PROBE_HOST}/" 2>/dev/null)
  if [ "$code" = "000" ] || [ -z "$code" ]; then
    emit tunnel "$TUNNEL_IP" error null "터널 경유 실패 — 터널 또는 출구 프록시 확인"
  else
    emit tunnel "$TUNNEL_IP" ok "$code" "터널 경유 정상 (HTTP $code)"
  fi
}

# ── 디스크 ───────────────────────────────────────────────────
check_disk() {
  path="$1"
  [ -d "$path" ] || { emit disk "$path" warn null "경로 없음(마운트 안 됨)"; return; }
  pct=$(df -P "$path" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
  avail=$(df -Ph "$path" 2>/dev/null | awk 'NR==2 {print $4}')
  [ -z "$pct" ] && { emit disk "$path" error null "df 실패"; return; }
  if [ "$pct" -ge "$DISK_ERR_PCT" ]; then
    emit disk "$path" critical "$pct" "사용률 ${pct}% — 남은 공간 ${avail}"
  elif [ "$pct" -ge "$DISK_WARN_PCT" ]; then
    emit disk "$path" warn "$pct" "사용률 ${pct}% — 남은 공간 ${avail}"
  else
    emit disk "$path" ok "$pct" "사용률 ${pct}% — 남은 공간 ${avail}"
  fi
}

# ── 파일 색인 ────────────────────────────────────────────────
# 두 가지는 전혀 다른 질문이라 따로 본다:
#   1) 색인기가 살아서 돌고 있나      → Redis 하트비트 (files:index:last_run)
#   2) 색인에 내용이 들어 있나        → file_index 행 수
# file_index.indexed_at(파일이 바뀐 시각)으로 1번을 판단하면 안 된다. 바뀐 파일이
# 없으면 색인기가 멀쩡해도 며칠씩 그대로라 멀쩡한 걸 장애로 오인한다.
check_index() {
  last=$(redis-cli -h "${REDIS_HOST:-redis}" --no-raw get files:index:last_run 2>/dev/null \
         | tr -d '"' | tr -d '\r')
  case "$last" in
    ''|*[!0-9]*)
      emit index indexer warn null "하트비트 없음 — 색인기가 아직 한 주기도 안 돌았거나 멈췄다"
      ;;
    *)
      mins=$(( ( $(date +%s) - last ) / 60 ))
      if [ "$mins" -ge 60 ]; then
        emit index indexer error "$mins" "색인기가 ${mins}분째 안 돎 — 주기는 15분이다"
      elif [ "$mins" -ge 35 ]; then
        emit index indexer warn "$mins" "마지막 주기 ${mins}분 전"
      else
        emit index indexer ok "$mins" "마지막 주기 ${mins}분 전"
      fi
      ;;
  esac

  [ -n "${PGPASSWORD:-}" ] || return
  rows=$(psql -h "${PGHOST:-postgres}" -U "${PGUSER:-workspace}" -d "${PGDATABASE:-workspace}" \
         -tAc "SELECT count(*) FROM file_index;" 2>/dev/null)
  if [ -z "$rows" ]; then
    emit index rows error null "DB 조회 실패"
  elif [ "$rows" -lt 1 ]; then
    emit index rows error 0 "색인이 비어 있음 — 검색이 아무것도 못 찾는다"
  else
    emit index rows ok "$rows" "색인 ${rows}건"
  fi
}

# ── 공인 DNS ─────────────────────────────────────────────────
# 권위 DNS 를 직접 운영하면 레코드 하나가 사라져도 도메인 전체가 죽는다(SERVFAIL).
# 외부 리졸버 기준으로 본다.
check_dns() {
  name="$1"; type="${2:-A}"
  ans=$(timeout 10 dig +short +time=3 +tries=2 "$type" "$name" @1.1.1.1 2>/dev/null | head -3 | tr '\n' ' ')
  if [ -z "$ans" ]; then
    emit dns "$name" critical null "$type 레코드 응답 없음 — 외부에서 해석 불가"
  else
    emit dns "$name" ok null "$type = $ans"
  fi
}

# ── TCP 포트 ─────────────────────────────────────────────────
check_tcp() {
  name="$1"; host="$2"; port="$3"
  t0=$(date +%s%N)
  if timeout 8 sh -c "nc -z $host $port" 2>/dev/null; then
    emit tcp "$name" ok null "${host}:${port} 열림" app $(( ($(date +%s%N) - t0) / 1000000 ))
  else
    emit tcp "$name" error null "${host}:${port} 연결 실패" app
  fi
}

# ── 연결 장비 (장비 스테이터스 표) ────────────────────────────
# 대상 목록은 사이트 파일 DEVICES_FILE(기본 /healthprobe/devices.conf — 리포엔 예시
# devices.example.conf 만 있다)에서 읽는다. 한 줄 = 한 행:
#   <묶음> <이름> ping <호스트>
#   <묶음> <이름> tcp  <호스트> <포트>
#   <묶음> <이름> http <URL> [기대코드정규식] [host:port:addr]   (자체서명 허용 -k)
#   <묶음> <이름> dns  <서버> <질의이름> [기대응답정규식]
# 줄 끝에 noalert 를 붙이면 장비 다운 알림에서 뺀다(다른 규칙이 이미 같은 고장을 알릴 때).
# 그 뒤 " # 한글 이름" 을 붙이면 알림 메일에 그 이름이 나온다.
# 결과는 check="device". 성공이어도 DEVICE_SLOW_MS 를 넘기면 warn.
DEVICES_FILE="${DEVICES_FILE:-/healthprobe/devices.conf}"
DEVICE_SLOW_MS="${DEVICE_SLOW_MS:-2000}"

dev_result() {
  # dev_result <묶음> <이름> <성공여부 0|1> <ms> <detail> <alert>
  if [ "$3" = 0 ]; then
    if [ -n "$4" ] && [ "$4" != null ] && [ "$4" -gt "$DEVICE_SLOW_MS" ]; then
      emit device "$2" warn "$4" "느림 ${4}ms — $5" "$1" "$4" "$6" "$dlabel"
    else
      emit device "$2" ok "$4" "$5" "$1" "$4" "$6" "$dlabel"
    fi
  else
    emit device "$2" error null "$5" "$1" null "$6" "$dlabel"
  fi
}

check_device() {
  dgrp="$1"; dname="$2"; dtype="$3"; shift 3
  alert=1
  # 마지막 인자가 noalert 면 떼어낸다
  for _a in "$@"; do :; done
  if [ "${_a:-}" = noalert ]; then
    alert=0
    _n=$#; _i=0; _rest=""
    for _a in "$@"; do _i=$((_i+1)); [ "$_i" -lt "$_n" ] && _rest="$_rest $_a"; done
    # shellcheck disable=SC2086
    set -- $_rest
  fi
  case "$dtype" in
    ping)
      out=$(ping -c 2 -W 2 "$1" 2>/dev/null)
      if [ $? -eq 0 ]; then
        ms=$(printf '%s' "$out" | awk -F'/' '/min\/avg\/max/ {printf "%d", $4 + 0.5}')
        dev_result "$dgrp" "$dname" 0 "${ms:-null}" "ping ${1} 응답 ${ms}ms" "$alert"
      else
        dev_result "$dgrp" "$dname" 1 null "ping ${1} 무응답" "$alert"
      fi
      ;;
    tcp)
      t0=$(date +%s%N)
      if timeout 8 sh -c "nc -z -w 5 $1 $2" 2>/dev/null; then
        dev_result "$dgrp" "$dname" 0 $(( ($(date +%s%N) - t0) / 1000000 )) "${1}:${2} 열림" "$alert"
      else
        dev_result "$dgrp" "$dname" 1 null "${1}:${2} 연결 실패" "$alert"
      fi
      ;;
    http)
      url="$1"; want="${2:-^(2|3)}"; rs="${3:-}"
      if [ -n "$rs" ]; then
        r=$(curl -sk -o /dev/null -m 10 -w '%{http_code} %{time_total}' --resolve "$rs" "$url" 2>/dev/null)
      else
        r=$(curl -sk -o /dev/null -m 10 -w '%{http_code} %{time_total}' "$url" 2>/dev/null)
      fi
      code=${r%% *}; ms=$(to_ms "${r#* }")
      if printf '%s' "$code" | grep -qE "$want"; then
        dev_result "$dgrp" "$dname" 0 "$ms" "HTTP $code" "$alert"
      else
        dev_result "$dgrp" "$dname" 1 null "HTTP ${code:-000} (응답 없음 또는 비정상)" "$alert"
      fi
      ;;
    dns)
      srv="$1"; q="$2"; want="${3:-.}"
      out=$(dig +noall +answer +stats +time=3 +tries=1 "$q" @"$srv" 2>/dev/null)
      ans=$(printf '%s\n' "$out" | awk '/^;/ || NF==0 {next} {print $NF}' | head -3 | tr '\n' ' ')
      ms=$(printf '%s\n' "$out" | awk '/Query time:/ {print $4}')
      if [ -n "$ans" ] && printf '%s' "$ans" | grep -qE "$want"; then
        dev_result "$dgrp" "$dname" 0 "${ms:-null}" "@${srv} ${q} = ${ans}" "$alert"
      elif [ -n "$ans" ]; then
        dev_result "$dgrp" "$dname" 1 null "@${srv} ${q} = ${ans}(기대 ${want} 아님)" "$alert"
      else
        dev_result "$dgrp" "$dname" 1 null "@${srv} ${q} 응답 없음" "$alert"
      fi
      ;;
    *)
      emit device "$dname" warn null "알 수 없는 점검 종류: $dtype" "$dgrp" null 1 "$dlabel"
      ;;
  esac
}

check_devices() {
  [ -f "$DEVICES_FILE" ] || return
  # 표준입력을 파일로 돌리면 안의 ping/curl 이 남은 줄을 먹을 수 있어 fd 3 으로 읽는다
  while IFS= read -r line <&3; do
    case "$line" in ''|'#'*) continue ;; esac
    # 줄 끝 " # 이름" = 알림 메일에 보일 한글 이름
    dlabel=""
    case "$line" in *' # '*) dlabel="${line#* # }"; line="${line%% # *}" ;; esac
    # shellcheck disable=SC2086
    set -- $line
    [ $# -ge 4 ] || continue
    check_device "$@"
  done 3< "$DEVICES_FILE"
}

run_once() {
  # 컨테이너 서비스
  check_http backend   "http://172.28.0.20:8000/api/health"
  check_http frontend  "http://172.28.0.22:3000/"   # React(ws-frontend-react). 점검 이름 frontend 는 알림 이력 때문에 그대로
  check_http loki      "http://172.28.0.71:3100/ready"
  check_http grafana   "http://172.28.0.72:3000/api/health"
  check_http gitea     "http://172.28.0.31:3000/" '^(2|3)'
  check_http livekit   "http://172.28.0.32:7880/" '^(2|3|4)'
  check_tcp  postgres  172.28.0.10 5432
  check_tcp  redis     172.28.0.11 6379
  check_tcp  mail_smtp 172.28.0.30 25
  check_tcp  mail_imap 172.28.0.30 993

  # 인증서 — 실제 서빙되는 것을 본다
  [ -n "$RP_IP" ] && check_cert web "${RP_IP}:443" "${DOMAIN:-localhost}"
  # netlab(랩 출처) — 앞단 프록시를 거친 실제 경로로 본다. NETLAB_HOST 가 비면 건너뛴다.
  if [ -n "$RP_IP" ] && [ -n "${NETLAB_HOST:-}" ]; then
    check_http netlab "https://${NETLAB_HOST}/healthz" '^2' "${NETLAB_HOST}:443:${RP_IP}"
    check_cert lab "${RP_IP}:443" "$NETLAB_HOST"
  fi
  check_cert mail  "172.28.0.30:993"             "mail.${DOMAIN:-localhost}"
  check_cert turn  "172.28.0.32:443"             "turn.${DOMAIN:-localhost}"

  # 터널 경유 경로 (설정된 사이트만)
  [ -n "$TUNNEL_IP" ] && [ -n "$TUNNEL_PROBE_HOST" ] && check_tunnel

  # 디스크
  check_disk /storage

  # 색인
  check_index

  # 공인 DNS
  check_dns "${DOMAIN:-localhost}"        A
  check_dns "ns1.${DOMAIN:-localhost}"    A
  check_dns "mail.${DOMAIN:-localhost}"   A
  check_dns "${DOMAIN:-localhost}"        MX

  # 연결 장비
  check_devices
}

echo '{"probe":"healthcheck","check":"startup","target":"probe","status":"ok","value":null,"detail":"상태 점검 프로브 시작"}'

while :; do
  run_once
  sleep "$INTERVAL"
done
