#!/usr/bin/env bash
# 설치 관리자 실서버 검수 — 공용 함수. **검수할 서버 안에서** 돈다(시나리오 스크립트가 source 한다).
#
# 이 스크립트들은 서버의 컨테이너·볼륨·설치 폴더를 지운다. 검수 전용 서버에서만 돌린다.
#
# 환경변수(전부 선택):
#   E2E_DOMAIN           접속 주소로 쓸 이름. DNS 에 없어도 된다(curl --resolve 로 붙는다)   기본 ws.e2e.example
#   E2E_MAIL_DOMAIN      메일 도메인                                                         기본 e2e.example
#   E2E_ADDR             이 서버의 주소                                                      기본 나가는 경로의 주소
#   E2E_HOST_DIR         설치 폴더                                                           기본 /opt/just-workspace
#   E2E_WORK             작업 폴더(관리자 비밀번호·쿠키·결과)                                기본 ~/e2e-work
#   E2E_REGISTRY         우리 이미지의 저장소. localhost = 서버에서 빌드한 이미지            기본 localhost
#   E2E_INSTALLER_IMAGE  설치 관리자 이미지                                                  기본 just-workspace-installer:<VERSION>
#   E2E_IMAGE_TAG        우리 이미지의 태그(비우면 제품 버전)

set -u

E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_REPO="$(cd "$E2E_ROOT/../.." && pwd)"
E2E_VERSION="$(tr -d '[:space:]' < "$E2E_REPO/VERSION")"

E2E_DOMAIN="${E2E_DOMAIN:-ws.e2e.example}"
E2E_MAIL_DOMAIN="${E2E_MAIL_DOMAIN:-e2e.example}"
E2E_ADDR="${E2E_ADDR:-$(ip -4 route get 192.0.2.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')}"
E2E_HOST_DIR="${E2E_HOST_DIR:-/opt/just-workspace}"
E2E_WORK="${E2E_WORK:-$HOME/e2e-work}"
E2E_REGISTRY="${E2E_REGISTRY:-localhost}"
E2E_INSTALLER_IMAGE="${E2E_INSTALLER_IMAGE:-just-workspace-installer:$E2E_VERSION}"
E2E_IMAGE_TAG="${E2E_IMAGE_TAG:-}"

INSTALLER=jw-installer
WIZARD="https://127.0.0.1:8443"
WS="https://$E2E_DOMAIN"

mkdir -p "$E2E_WORK"
chmod 700 "$E2E_WORK"

# ─── 결과 집계 ───

PASS=0
FAIL=0
FAILED=()

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED+=("$1"); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

# check "이름" 명령…  — 명령이 0 으로 끝나면 통과
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi
}

# expect "이름" "기대값" "실제값"
expect() {
  if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1 — 기대 '$2', 실제 '$3'"; fi
}

# contains "이름" "찾을 글" "본문"
contains() {
  case "$3" in *"$2"*) ok "$1" ;; *) bad "$1 — '$2' 가 없다: $(printf '%s' "$3" | head -c 200)" ;; esac
}

finish() {
  say "결과: 통과 $PASS · 실패 $FAIL"
  if [ "$FAIL" -gt 0 ]; then printf '   실패: %s\n' "${FAILED[@]}"; exit 1; fi
  exit 0
}

# JSON 에서 값 하나 꺼내기: json_get '<파이썬 식 — d 가 문서>' < 입력
json_get() { python3 -c 'import json,sys
d=json.load(sys.stdin)
try:
    v=eval(sys.argv[1])
except Exception as e:
    v=""
print(v if not isinstance(v,(dict,list)) else json.dumps(v,ensure_ascii=False))' "$1" 2>/dev/null; }

# ─── 서버 초기화 ───

# 워크스페이스·설치 관리자의 컨테이너·볼륨·네트워크·설치 폴더를 지운다(이미지는 남긴다).
e2e_reset() {
  say "초기화"
  local ids
  ids="$(docker ps -aq --filter name='^ws-' --filter name="^$INSTALLER\$")"
  [ -n "$ids" ] && docker rm -fv $ids >/dev/null 2>&1
  ids="$(docker ps -aq --filter label=com.docker.compose.project=just-workspace)"
  [ -n "$ids" ] && docker rm -fv $ids >/dev/null 2>&1
  docker network rm just-workspace_workspace >/dev/null 2>&1
  ids="$(docker volume ls -q | grep -E '^(ws-|just-workspace_)' || true)"
  [ -n "$ids" ] && docker volume rm -f $ids >/dev/null 2>&1
  docker volume prune -f >/dev/null 2>&1          # 이름 없는(컨테이너에 딸렸던) 볼륨
  sudo rm -rf "$E2E_HOST_DIR"
  rm -f "$E2E_WORK"/jar-* "$E2E_WORK"/*.json "$E2E_WORK"/*.out
  note "컨테이너 $(docker ps -aq | wc -l)개, 볼륨 $(docker volume ls -q | wc -l)개 남음"
}

# ─── 설치 관리자 ───

# installer_start [docker run 에 더할 인자…]
installer_start() {
  sudo mkdir -p "$E2E_HOST_DIR"
  docker run -d --name "$INSTALLER" --restart unless-stopped -p 8443:8443 \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$E2E_HOST_DIR:/data" \
    -e "JW_HOST_DIR=$E2E_HOST_DIR" -e "JW_REGISTRY=$E2E_REGISTRY" -e "JW_PUBLIC_HOST=$E2E_ADDR" \
    ${E2E_IMAGE_TAG:+-e "JW_IMAGE_TAG=$E2E_IMAGE_TAG"} "$@" "$E2E_INSTALLER_IMAGE" >/dev/null || return 1
  local i
  for i in $(seq 1 30); do
    curl -sk -o /dev/null "$WIZARD/healthz" && return 0
    sleep 1
  done
  return 1
}

jw() { docker exec "$INSTALLER" jw "$@"; }

# 로그에 찍힌 설치 토큰(가장 최근 것)
installer_token() { docker logs "$INSTALLER" 2>&1 | grep -oE 'token=[A-Z0-9]+' | tail -1 | cut -d= -f2; }

# 관리자 비밀번호 — 난수로 만들어 작업 폴더의 파일에만 둔다
admin_password_file() {
  local f="$E2E_WORK/admin-pass"
  if [ ! -s "$f" ]; then
    (umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | head -c 24 > "$f")
  fi
  printf '%s' "$f"
}

# 답변 파일을 설치 폴더(컨테이너의 /data/e2e/)에 놓는다. 이름·주소는 환경에 맞춰 바꾼다.
answers_place() {
  local src="$1" tmp
  tmp="$(mktemp)"
  sed -e "s/ws\.e2e\.example/$E2E_DOMAIN/g" -e "s/\"e2e\.example\"/\"$E2E_MAIL_DOMAIN\"/g" \
      -e "s/__E2E_ADDR__/$E2E_ADDR/g" "$src" > "$tmp"
  sudo mkdir -p "$E2E_HOST_DIR/e2e"
  sudo install -m 600 "$tmp" "$E2E_HOST_DIR/e2e/answers.json"
  rm -f "$tmp"
}

# 무인 설치: jw_apply <답변 파일> [jw apply 에 더할 인자…]. 관리자 비밀번호는 env 파일로 넘긴다.
jw_apply() {
  local src="$1"; shift
  answers_place "$src" || return 1
  local envf="$E2E_WORK/admin.env"
  (umask 077; printf 'JW_ADMIN_PASSWORD=%s\n' "$(cat "$(admin_password_file)")" > "$envf")
  docker exec --env-file "$envf" "$INSTALLER" jw apply --answers /data/e2e/answers.json "$@"
}

# ─── 마법사 API(8443) ───

WJAR="$E2E_WORK/jar-wizard"

# wapi <메서드> <경로> [본문 JSON]  → 본문을 찍고, 상태 코드는 $E2E_WORK/wapi.code 에
wapi() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sk -X "$method" -b "$WJAR" -c "$WJAR" -o "$E2E_WORK/wapi.out" -w '%{http_code}')
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data-binary "$body")
  curl "${args[@]}" "$WIZARD$path" > "$E2E_WORK/wapi.code"
  cat "$E2E_WORK/wapi.out"
}
wcode() { cat "$E2E_WORK/wapi.code"; }

wizard_login() {
  rm -f "$WJAR"
  wapi POST /api/session "{\"token\":\"$(installer_token)\"}" >/dev/null
  [ "$(wcode)" = 200 ]
}

# 적용이 끝날 때까지 기다린다(API). wait_apply_api [초]  → done 이면 0
wait_apply_api() {
  local limit="${1:-1800}" waited=0 st
  while [ "$waited" -lt "$limit" ]; do
    st="$(wapi GET /api/apply | json_get 'd["status"]')"
    # 끝나면 잠겨서 423 이 된다 — 그때는 /api/state 로 본다
    if [ "$(wcode)" = 423 ]; then return 0; fi
    case "$st" in done) return 0 ;; failed) return 1 ;; esac
    sleep 3; waited=$((waited + 3))
  done
  return 2
}

# 적용이 끝날 때까지 기다린다(상태 파일). wait_apply_file [초]  → done 0, failed 1, 시간 초과 2
apply_status() { sudo cat "$E2E_HOST_DIR/state/apply.json" 2>/dev/null | json_get 'd["status"]'; }
apply_error()  { sudo cat "$E2E_HOST_DIR/state/apply.json" 2>/dev/null | json_get 'd["error"]'; }
wait_apply_file() {
  local limit="${1:-1800}" waited=0 st
  while [ "$waited" -lt "$limit" ]; do
    st="$(apply_status)"
    case "$st" in done) return 0 ;; failed) return 1 ;; esac
    sleep 3; waited=$((waited + 3))
  done
  return 2
}

# ─── 워크스페이스 ───

UJAR="$E2E_WORK/jar-ws"

# ws_curl <curl 인자…> — 접속 주소를 이 서버로 돌려 붙는다(인증서 검증 없이)
ws_curl() { curl -sk --max-time 60 --resolve "$E2E_DOMAIN:443:$E2E_ADDR" --resolve "$E2E_DOMAIN:80:$E2E_ADDR" "$@"; }
ws_code() { ws_curl -o /dev/null -w '%{http_code}' "$@"; }

# 관리자 로그인 → 쿠키. ws_login [비밀번호 파일]
ws_login() {
  local passfile="${1:-$(admin_password_file)}" body="$E2E_WORK/login.json"
  (umask 077; python3 -c 'import json,sys; print(json.dumps({"username": sys.argv[1], "password": open(sys.argv[2]).read().strip()}))' \
      "${E2E_ADMIN:-admin}" "$passfile" > "$body")
  rm -f "$UJAR"
  local code
  code="$(ws_curl -c "$UJAR" -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H "Origin: $WS" \
          --data-binary "@$body" "$WS/api/auth/login")"
  rm -f "$body"
  [ "$code" = 200 ]
}

# 로그인한 채로 부른다: ws_api <메서드> <경로> [본문 JSON]
ws_api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-X "$method" -b "$UJAR" -H "Origin: $WS")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data-binary "$body")
  ws_curl "${args[@]}" "$WS$path"
}
ws_api_code() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-X "$method" -b "$UJAR" -H "Origin: $WS" -o /dev/null -w '%{http_code}')
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data-binary "$body")
  ws_curl "${args[@]}" "$WS$path"
}

# 컨테이너 상태: running + (healthcheck 가 있으면) healthy
container_ready() {
  local st
  st="$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1" 2>/dev/null)"
  [ "$st" = "true " ] || [ "$st" = "true healthy" ]
}
wait_ready() {
  local name="$1" limit="${2:-300}" waited=0
  while [ "$waited" -lt "$limit" ]; do
    container_ready "$name" && return 0
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

env_value() { sudo grep -E "^$1=" "$E2E_HOST_DIR/stack/.env" | head -1 | cut -d= -f2- | sed -e "s/^'//" -e "s/'\$//"; }

# 호스트가 듣는 포트(도커가 게시한 것만): "25/tcp 80/tcp …"
published_ports() {
  docker ps --format '{{.Ports}}' | tr ',' '\n' | grep -- '->' | sed -E 's/^ *//' \
    | python3 -c '
import re,sys
out=set()
for line in sys.stdin:
    m=re.match(r"(\S+):(\d+)(?:-(\d+))?->\d+(?:-\d+)?/(tcp|udp)", line.strip())
    if not m: continue
    host,a,b,proto=m.groups()
    out.add((host, f"{a}-{b}" if b else a, proto))
for host,port,proto in sorted(out, key=lambda x:(int(x[1].split("-")[0]),x[2],x[0])):
    print(f"{host}:{port}/{proto}")'
}

# ─── 공통 확인 ───

# 기본 묶음이 떴는지 — 시나리오마다 맨 먼저 부른다
check_core() {
  say "기본 구성"
  local c
  for c in ws-postgres ws-redis ws-backend ws-frontend-react ws-nginx; do
    check "컨테이너 $c 준비" wait_ready "$c" 180
  done
  expect "프런트 화면(/)" 200 "$(ws_code "$WS/")"
  contains "프런트 화면은 HTML" "<!doctype html>" "$(ws_curl "$WS/" | head -c 200)"
  expect "/api/health" 200 "$(ws_code "$WS/api/health")"
  check "관리자 로그인" ws_login
  expect "로그인한 계정은 관리자" True "$(ws_api GET /api/auth/me | json_get 'd["is_admin"]')"
}

check_locked() {
  say "마법사 잠금"
  local st
  st="$(curl -sk "$WIZARD/api/state")"
  expect "/api/state phase" installed "$(printf '%s' "$st" | json_get 'd["phase"]')"
  expect "/api/state url" "$WS" "$(printf '%s' "$st" | json_get 'd["url"]')"
  expect "잠긴 뒤 답변 API" 423 "$(curl -sk -o /dev/null -w '%{http_code}' "$WIZARD/api/answers")"
  expect "잠긴 뒤 세션 발급" 423 "$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"token":"AAAAAAAAAAAA"}' "$WIZARD/api/session")"
}

# 파일 올리고 내려받아 같은지 본다
check_files() {
  say "파일 올리기·내려받기"
  local up="$E2E_WORK/up.bin" down="$E2E_WORK/down.bin" name="e2e-$(date +%s).bin"
  head -c 300000 /dev/urandom > "$up"
  expect "올리기" 200 "$(ws_curl -b "$UJAR" -H "Origin: $WS" -o /dev/null -w '%{http_code}' -F "file=@$up;filename=$name" "$WS/api/files/upload?path=my/")"
  expect "내려받기" 200 "$(ws_curl -b "$UJAR" -o "$down" -w '%{http_code}' "$WS/api/files/download?path=my/$name")"
  check "올린 것과 내려받은 것이 같다" cmp "$up" "$down"
  E2E_LAST_UPLOAD="$name"
}

# 메모리·디스크 사용량을 찍는다(보고용)
report_usage() {
  say "사용량"
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' | sort
  free -m | sed -n 1,2p
  docker system df
  df -h / | tail -1
}

# ─── 마법사가 부르는 순서 그대로 설치(API) ───
# api_install <답변 파일> — 토큰 → 상태 → 사전 점검 → 답변 → 접속 주소 확인 → 구역 → 요약 → 적용 → 진행 조회
api_install() {
  local src="$1" body="$E2E_WORK/answers-put.json"
  check "설치 토큰으로 세션 발급" wizard_login
  expect "GET /api/state phase" wizard "$(wapi GET /api/state | json_get 'd["phase"]')"

  local pre
  pre="$(wapi POST /api/preflight)"
  expect "POST /api/preflight" 200 "$(wcode)"
  expect "사전 점검 통과" True "$(printf '%s' "$pre" | json_get 'd["ok"]')"
  note "사전 점검: $(printf '%s' "$pre" | json_get '" ".join(i["id"]+"="+i["status"] for i in d["items"])')"

  answers_place "$src"
  (umask 077; sudo cat "$E2E_HOST_DIR/e2e/answers.json" | python3 -c 'import json,sys
d=json.load(sys.stdin); d.setdefault("admin",{})["password"]=open(sys.argv[1]).read().strip(); print(json.dumps(d))' \
      "$(admin_password_file)" > "$body")
  local put
  put="$(wapi PUT /api/answers "@$body")"
  rm -f "$body"
  expect "PUT /api/answers" 200 "$(wcode)"
  expect "답변 오류 없음" "[]" "$(printf '%s' "$put" | json_get 'd["errors"]')"
  expect "관리자 비밀번호는 응답에 없다" False "$(printf '%s' "$put" | json_get '"password" in d["answers"].get("admin",{})')"

  local dns
  dns="$(wapi POST /api/probe/dns '{}')"
  note "접속 주소 확인: $(printf '%s' "$dns" | json_get 'd["status"]')"
  check "접속 주소 확인 응답" test "$(wcode)" = 200
  wapi GET /api/zones >/dev/null; expect "GET /api/zones" 200 "$(wcode)"

  local sum
  sum="$(wapi GET /api/summary)"
  expect "GET /api/summary ready" True "$(printf '%s' "$sum" | json_get 'd["ready"]')"
  E2E_SUMMARY_PORTS="$(printf '%s' "$sum" | json_get '" ".join(d["ports"])')"
  E2E_SUMMARY_STEPS="$(printf '%s' "$sum" | json_get '" ".join(d["steps"])')"
  note "여는 포트: $E2E_SUMMARY_PORTS"
  note "단계: $E2E_SUMMARY_STEPS"

  wapi POST /api/apply >/dev/null
  expect "POST /api/apply" 202 "$(wcode)"
  wapi POST /api/apply >/dev/null
  expect "돌고 있을 때 다시 시작하면 409" 409 "$(wcode)"
  local t0; t0=$(date +%s)
  wait_apply_api 2400
  local rc=$?
  E2E_APPLY_SECONDS=$(( $(date +%s) - t0 ))
  if [ "$rc" = 0 ]; then ok "적용 완료(${E2E_APPLY_SECONDS}초)"; else bad "적용 — $(apply_error)"; fi
  return $rc
}

# 답변 파일 + jw apply (무인)
file_install() {
  local src="$1" t0 rc
  t0=$(date +%s)
  jw_apply "$src"
  rc=$?
  E2E_APPLY_SECONDS=$(( $(date +%s) - t0 ))
  if [ "$rc" = 0 ]; then ok "jw apply 완료(${E2E_APPLY_SECONDS}초)"; else bad "jw apply — $(apply_error)"; fi
  E2E_SUMMARY_PORTS=""
  return $rc
}

# install <file|api> <답변 파일>
install() {
  say "설치 ($1) — $(basename "$2")"
  if [ "$1" = api ]; then api_install "$2"; else file_install "$2"; fi
}

step_seconds() {
  sudo cat "$E2E_HOST_DIR/state/apply.json" | python3 -c '
import json,sys,datetime as dt
d=json.load(sys.stdin)
p=lambda s: dt.datetime.fromisoformat(s.replace("Z","+00:00"))
for s in d["steps"]:
    if s.get("started_at") and s.get("finished_at"):
        print("   %-9s %-7s %d초" % (s["id"], s["status"], (p(s["finished_at"])-p(s["started_at"])).total_seconds()))'
}

# ─── 내부 API(8444) — backend 가 부르는 방식 그대로 ───
# backend 컨테이너 안에서, backend 가 받은 JW_INSTALLER_URL·JW_INSTALLER_KEY 로 부른다.
# internal_api <메서드> <경로> [본문 JSON]  → "<상태 코드> <본문>".  E2E_KEY 를 주면 그 키로 부른다.
internal_api() {
  docker exec -i -e E2E_METHOD="$1" -e E2E_PATH="$2" -e E2E_BODY="${3:-}" ${E2E_KEY:+-e "E2E_KEY=$E2E_KEY"} \
    ws-backend python - < "$E2E_ROOT/internal-call.py"
}

# 구역 작업이 끝날 때까지 기다린다: wait_job <작업 id> [초] → done 0 / failed 1 / 시간 초과 2
# (켜고 끌 때 backend 가 다시 뜨므로 진행은 상태 파일로 본다)
job_field() { sudo cat "$E2E_HOST_DIR/state/jobs.json" 2>/dev/null | E2E_JOB="$1" json_get "d[__import__('os').environ['E2E_JOB']]$2"; }
wait_job() {
  local id="$1" limit="${2:-900}" waited=0 st
  while [ "$waited" -lt "$limit" ]; do
    st="$(job_field "$id" '["status"]')"
    case "$st" in done) return 0 ;; failed) return 1 ;; esac
    sleep 3; waited=$((waited + 3))
  done
  return 2
}

# ─── 실패·재시도 시나리오용 ───

# 세션 → 사전 점검 → 답변 → 접속 주소 확인까지(적용은 시작하지 않는다). api_prepare <답변 파일>
api_prepare() {
  local src="$1" body="$E2E_WORK/answers-put.json"
  wizard_login || return 1
  wapi POST /api/preflight >/dev/null
  answers_place "$src"
  (umask 077; sudo cat "$E2E_HOST_DIR/e2e/answers.json" | python3 -c 'import json,sys
d=json.load(sys.stdin); d.setdefault("admin",{})["password"]=open(sys.argv[1]).read().strip(); print(json.dumps(d))' \
      "$(admin_password_file)" > "$body")
  wapi PUT /api/answers "@$body" >/dev/null
  local code; code="$(wcode)"
  rm -f "$body"
  [ "$code" = 200 ] || return 1
  wapi POST /api/probe/dns '{}' >/dev/null
  [ "$(wapi GET /api/summary | json_get 'd["ready"]')" = True ]
}

# 적용 상태에서 값 하나: apply_get '<식 — d 가 GET /api/apply 응답>'
apply_get() { wapi GET /api/apply | json_get "$1"; }

# 지금 단계가 <단계> 가 될 때까지(또는 끝날 때까지) 기다린다
wait_step() {
  local step="$1" limit="${2:-600}" waited=0 cur st
  while [ "$waited" -lt "$limit" ]; do
    st="$(sudo cat "$E2E_HOST_DIR/state/apply.json" 2>/dev/null | json_get 'd["status"]')"
    cur="$(sudo cat "$E2E_HOST_DIR/state/apply.json" 2>/dev/null | json_get 'd["current"]')"
    [ "$cur" = "$step" ] && [ "$st" = running ] && return 0
    case "$st" in done|failed) return 1 ;; esac
    sleep 1; waited=$((waited + 1))
  done
  return 2
}

installer_wait_up() {
  local i
  for i in $(seq 1 40); do curl -sk -o /dev/null "$WIZARD/healthz" && return 0; sleep 1; done
  return 1
}
