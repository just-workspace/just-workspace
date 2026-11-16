#!/usr/bin/env bash
# 업데이트 검수 — 공용 함수. lib.sh 다음에 source 한다. **검수 전용 서버 안에서** 돈다.
#
# 실제 레지스트리·채널 대신 서버 안에 가짜 릴리스 환경을 만든다.
#   - 레지스트리: registry:2 컨테이너, 루프백(127.0.0.1:5000)에만 게시
#   - 채널: 정적 파일 서버(nginx), 도커 브리지 주소(기본 172.17.0.1:8089)에만 게시 — 설치 관리자 컨테이너가 받는다
#   - 서명 키: 이 서버의 작업 폴더에서 만든 임시 키 쌍. 서버 밖으로 내보내지 않고 리포에 넣지 않는다.
# 릴리스는 release/jwrelease 명령(make-manifest · publish · promote · bundle)으로 진짜 형식대로 만든다.
#
# 환경변수(선택): E2E_REG(기본 127.0.0.1:5000/jw) · E2E_CHANNEL_ADDR(기본 172.17.0.1:8089)

REG="${E2E_REG:-127.0.0.1:5000/jw}"
CHANNEL_ADDR="${E2E_CHANNEL_ADDR:-172.17.0.1:8089}"
CHANNEL_URL="http://$CHANNEL_ADDR"
REL="$E2E_WORK/release"                 # keys/ channel/ manifests/ src-<버전>/
OUR_IMAGES=(backend frontend-react mailserver sso ldap audiorelay docconv sandbox rbi-netfilter)
UPD=/api/admin/system/update
# 가짜 릴리스 환경에서 처음 설치하는 버전. 리포의 VERSION(지금 개발 중인 버전)과 무관하다 — 이 환경의 릴리스 번호(1.0.0, 1.0.1 …)는
# 검수 스크립트가 정한 것이고, 리포의 VERSION 이 그보다 낮거나 높아도 같은 결과가 나와야 한다.
BASE_VERSION=1.0.0
TOOL_IMAGE="${E2E_TOOL_IMAGE:-just-workspace-installer:$E2E_VERSION}"     # python + cryptography 가 든 이미지
# 리포의 DB 스키마 버전(S0)과, 검수용 변경 단계를 하나(S1)·둘(S2) 더한 버전
S0="$(sed -n 's/^SCHEMA_VERSION = \([0-9][0-9]*\).*/\1/p' "$E2E_REPO/backend/app/db/schema_version.py")"
S1=$((S0 + 1)); S2=$((S0 + 2))

# ─── 가짜 릴리스 환경 ───

rel_env_up() {
  mkdir -p "$REL/keys" "$REL/channel" "$REL/manifests"
  chmod 700 "$REL/keys"
  if [ ! -s "$REL/keys/release.pem" ]; then
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$REL/keys/release.pem" 2>/dev/null
    openssl pkey -in "$REL/keys/release.pem" -pubout -out "$REL/keys/release.pub" 2>/dev/null
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$REL/keys/other.pem" 2>/dev/null   # "다른 키" 검수용
    chmod 600 "$REL/keys/"*.pem
  fi
  docker inspect jw-e2e-registry >/dev/null 2>&1 || docker run -d --name jw-e2e-registry --restart unless-stopped \
    -p 127.0.0.1:5000:5000 -e REGISTRY_STORAGE_DELETE_ENABLED=true registry:2 >/dev/null
  docker start jw-e2e-registry >/dev/null 2>&1
  local nginx_image
  nginx_image="$(grep -oE 'nginx:[^ ]+@sha256:[0-9a-f]{64}' "$E2E_REPO/docker-compose.yml" | head -1)"
  docker inspect jw-e2e-channel >/dev/null 2>&1 || docker run -d --name jw-e2e-channel --restart unless-stopped \
    -p "$CHANNEL_ADDR:80" -v "$REL/channel:/usr/share/nginx/html:ro" "$nginx_image" >/dev/null
  docker start jw-e2e-channel >/dev/null 2>&1
  local i
  for i in $(seq 1 20); do curl -fs -o /dev/null "http://127.0.0.1:5000/v2/" && break; sleep 1; done
}

rel_env_down() { docker rm -f jw-e2e-registry jw-e2e-channel >/dev/null 2>&1; }

# 릴리스 도구 — 리포의 release/ 를 붙인 일회용 컨테이너에서 돈다(서버에 파이썬 패키지를 깔지 않는다)
jwrelease() {
  docker run --rm --network host --user "$(id -u):$(id -g)" -v "$E2E_REPO:/src:ro" -v "$REL:/work" -w /src/release \
    -e JWRELEASE_REGISTRY="$REG" -e JWRELEASE_CHANNEL_BASE_URL="$CHANNEL_URL" \
    -e JWRELEASE_DOWNLOAD_URL_TEMPLATE="$CHANNEL_URL/downloads/{version}/{filename}" -e HOME=/tmp \
    --entrypoint python "$TOOL_IMAGE" -m jwrelease "$@"
}

# rel_build <버전> <변형>  — 그 버전의 이미지를 만들어 레지스트리에 올리고 digests.json 을 쓴다.
#   변형: base(스키마 그대로) · plus1(리포의 단계 뒤에 검수용 변경 단계 하나) · plus2(둘) · broken2(둘째가 일부러 깨진다)
# backend 와 설치 관리자만 새로 빌드한다(VERSION 과, 검수용 스키마 변경 단계 — 리포에는 없는 패치). 나머지는 같은 이미지에 태그만.
rel_build() {
  local ver="$1" variant="${2:-base}" src="$REL/src-$1" n log="$REL/build-$1.log"
  rm -rf "$src"; mkdir -p "$src"
  (cd "$E2E_REPO" && tar -cf - --exclude=./frontend-react/node_modules .) | tar -xf - -C "$src"
  printf '%s\n' "$ver" > "$src/VERSION"
  if [ -n "${E2E_REDIS_REF:-}" ]; then
    # 이 버전의 compose 에서 캐시(redis) 이미지를 바꾼다 — "남의 이미지가 올라간 릴리스"
    sed -i -E "s#^(    image: )redis:[^ ]+@sha256:[0-9a-f]{64}#\\1$E2E_REDIS_REF#" "$src/docker-compose.yml"
    grep -q "image: $E2E_REDIS_REF" "$src/docker-compose.yml" || { echo "redis 이미지를 바꾸지 못했다"; return 1; }
  fi
  python3 - "$src" "$variant" <<'PY' || return 1
import re, sys
src, variant = sys.argv[1], sys.argv[2]
steps = {"base": 0, "plus1": 1, "plus2": 2, "broken2": 2}[variant]
if steps:
    p = f"{src}/backend/app/db/schema_version.py"
    s = open(p, encoding="utf-8").read()
    base = int(re.search(r"(?m)^SCHEMA_VERSION = (\d+)", s).group(1))
    s, n = re.subn(r"(?m)^SCHEMA_VERSION = \d+", f"SCHEMA_VERSION = {base + steps}", s)
    assert n == 1
    open(p, "w", encoding="utf-8").write(s)
    # 리포의 단계 목록 뒤에 검수용 단계를 잇는다(번호는 리포의 버전 다음부터).
    first, second = base + 1, base + 2
    if variant == "broken2":
        second_sql = "SELECT * FROM e2e_no_such_table"
    else:
        second_sql = f"INSERT INTO e2e_update_marker (id, note) VALUES ({second}, 'second') ON CONFLICT DO NOTHING"
    entries = [f'Step({first}, "e2e marker", _e2e_first),', f'Step({second}, "e2e second", _e2e_second),'][:steps]
    body = f'''


async def _e2e_first(conn):
    await run_sql(conn, "CREATE TABLE IF NOT EXISTS e2e_update_marker (id integer PRIMARY KEY, note text)")
    await run_sql(conn, "INSERT INTO e2e_update_marker (id, note) VALUES ({first}, 'first') ON CONFLICT DO NOTHING")


async def _e2e_second(conn):
    await run_sql(conn, "{second_sql}")


STEPS = STEPS + (
    {(chr(10) + "    ").join(entries)}
)
'''
    p = f"{src}/backend/app/db/migrations.py"
    s = open(p, encoding="utf-8").read()
    assert re.search(r"(?m)^STEPS(: [^=]+)? = \(", s), "STEPS 를 찾지 못했다"
    open(p, "w", encoding="utf-8").write(s.rstrip() + body)
PY
  : > "$log"
  (cd "$src" && [ -f .env ] || : > "$src/.env"
   cd "$src" && JW_REGISTRY="$REG" JW_VERSION="$ver" JW_APP_VERSION="$ver" DB_PASSWORD=unused SECRET_KEY=unused \
     docker compose --profile '*' build backend >> "$log" 2>&1) || { echo "backend 빌드 실패 — $log"; return 1; }
  (cd "$src" && docker build -q -f installer/Dockerfile --build-arg JW_UPDATE_CHANNEL_URL="$CHANNEL_URL" \
     -t "$REG/just-workspace-installer:$ver" . >> "$log" 2>&1) || { echo "설치 관리자 빌드 실패 — $log"; return 1; }
  local base
  for n in "${OUR_IMAGES[@]}"; do
    [ "$n" = backend ] && continue
    # 태그만 붙인다. 바탕은 — 처음 버전을 낼 때는 소스에서 빌드해 둔 이미지(`localhost/…:<리포의 VERSION>`), 그 뒤로는
    # 레지스트리에 올려 둔 처음 버전. 서버의 `localhost/…` 태그는 업데이트가 치우므로(어느 복원 지점도 가리키지 않는
    # 버전의 태그 — 소스에서 빌드해 둔 것도, 켜지 않은 구역의 것도) 처음 버전을 낸 뒤에는 거기에 기대지 않는다.
    base="localhost/just-workspace-$n:$E2E_VERSION"
    if [ "$ver" != "$BASE_VERSION" ]; then
      base="$REG/just-workspace-$n:$BASE_VERSION"
      docker image inspect "$base" >/dev/null 2>&1 || docker pull -q "$base" >/dev/null 2>&1 || base="localhost/just-workspace-$n:$E2E_VERSION"
    fi
    docker image inspect "$base" >/dev/null 2>&1 || { echo "바탕 이미지가 없다: $base — build-images.sh 로 먼저 빌드한다" >&2; return 1; }
    [ "$base" = "$REG/just-workspace-$n:$ver" ] || docker tag "$base" "$REG/just-workspace-$n:$ver" || return 1
  done
  docker tag alpine:latest "$REG/just-workspace-rbi-mirror:$ver"       # 검수 서버에서는 빌드하지 않는 이미지 — 자리만
  {
    printf '{"format":1,"version":"%s","registry":"%s","commit":"e2e","images":{' "$ver" "$REG"
    local first=1 digest
    for n in "${OUR_IMAGES[@]}" rbi-mirror installer; do
      docker push -q "$REG/just-workspace-$n:$ver" >> "$log" 2>&1 || { echo "푸시 실패: $n" >&2; return 1; }
      digest="$(curl -fsI -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' \
        "http://${REG%%/*}/v2/${REG#*/}/just-workspace-$n/manifests/$ver" | tr -d '\r' | awk 'tolower($1)=="docker-content-digest:"{print $2}')"
      [ -n "$digest" ] || { echo "다이제스트 조회 실패: $n" >&2; return 1; }
      [ "$first" = 1 ] || printf ','
      first=0
      printf '"%s":{"repository":"%s/just-workspace-%s","digest":"%s"}' "$n" "$REG" "$n" "$digest"
    done
    printf '}}\n'
  } > "$REL/digests-$ver.json" || return 1
  echo "$variant" > "$REL/variant-$ver"
}

# rel_local <버전> — 그 버전의 릴리스 이미지를 이 서버의 이미지 이름으로도 붙인다(소스에서 빌드해 둔 서버에 설치하는 꼴:
# 우리 이미지는 `localhost/just-workspace-<이름>:<버전>`, 설치 관리자는 `just-workspace-installer:<버전>`).
rel_local() {
  local ver="$1" n
  for n in "${OUR_IMAGES[@]}"; do
    docker tag "$REG/just-workspace-$n:$ver" "localhost/just-workspace-$n:$ver" || return 1
  done
  docker tag "$REG/just-workspace-installer:$ver" "just-workspace-installer:$ver"
}

# rel_manifest <버전> <스키마 버전> [make-manifest 에 더할 인자…]
rel_manifest() {
  local ver="$1" schema="$2"; shift 2
  jwrelease make-manifest --version "$ver" --digests "/work/digests-$ver.json" --db-schema "$schema" \
    --compose "/work/src-$ver/docker-compose.yml" --zones "/work/src-$ver/backend/app/zones.json" \
    --changelog "- $ver 검수용 릴리스" --resolve-sizes -o "/work/manifests/$ver.json" "$@"
}

rel_publish() { local ver="$1" channel="$2"; shift 2; jwrelease publish --repo /work/channel --manifest "/work/manifests/$ver.json" --channel "$channel" --key /work/keys/release.pem "$@"; }
rel_promote() { local ver="$1"; shift; jwrelease promote --repo /work/channel --version "$ver" --key /work/keys/release.pem "$@"; }
rel_verify()  { jwrelease verify --repo /work/channel --pubkey /work/keys/release.pub; }

# 레지스트리에서 이미지 하나를 지운다(없는 다이제스트 만들기) / 다시 올린다
reg_delete() {
  local name="$1" ver="$2" digest
  digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["images"][sys.argv[2]]["digest"])' "$REL/digests-$ver.json" "$name")"
  curl -fs -o /dev/null -X DELETE "http://${REG%%/*}/v2/${REG#*/}/just-workspace-$name/manifests/$digest"
}
reg_push() { docker push -q "$REG/just-workspace-$1:$2" >/dev/null 2>&1; }
# reg_forget <name> <build-version> <product-version>: keep a copy as a file, then drop every local name of the image
reg_forget() {
  local name="$1" built="$2" ver="$3" digest
  docker save "$REG/just-workspace-$name:$built" -o "$REL/keep-$name-$built.tar" || return 1
  digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["images"][sys.argv[2]]["digest"])' "$REL/digests-$built.json" "$name")"
  docker image rm "$REG/just-workspace-$name:$built" "$REG/just-workspace-$name@$digest" "localhost/just-workspace-$name:$ver" >/dev/null 2>&1
  ! docker image inspect "$REG/just-workspace-$name@$digest" >/dev/null 2>&1
}
# reg_restore <name> <build-version>: load the kept copy, push it back (same digest), drop the local copy again
reg_restore() {
  local name="$1" built="$2" digest
  docker load -q -i "$REL/keep-$name-$built.tar" >/dev/null || return 1
  reg_push "$name" "$built" || return 1
  digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["images"][sys.argv[2]]["digest"])' "$REL/digests-$built.json" "$name")"
  curl -fsI -o /dev/null -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json'     "http://${REG%%/*}/v2/${REG#*/}/just-workspace-$name/manifests/$digest" || return 1
  docker image rm "$REG/just-workspace-$name:$built" "$REG/just-workspace-$name@$digest" >/dev/null 2>&1
  rm -f "$REL/keep-$name-$built.tar"
}

# compose 에 고정한 것과 다른 redis 이미지 하나를 받아 `redis:<태그>@sha256:…` 로 돌려준다(오프라인 검수의 "추가 이미지")
other_redis() {
  local pinned running tag digest
  pinned="$(grep -oE 'redis:[^ ]+@sha256:[0-9a-f]{64}' "$E2E_REPO/docker-compose.yml" | head -1)"
  running="$(docker inspect ws-redis --format '{{.Config.Image}}' 2>/dev/null)"
  for tag in 8-alpine 8 alpine 8.8-alpine; do
    docker pull -q "redis:$tag" >/dev/null 2>&1 || continue
    digest="$(docker image inspect "redis:$tag" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -oE 'sha256:[0-9a-f]{64}' | head -1)"
    [ -n "$digest" ] && [ "$digest" != "${pinned#*@}" ] && [ "$digest" != "${running#*@}" ] && { echo "redis:$tag@$digest"; return 0; }
  done
  return 1
}

# ─── 업데이트 API ───

# 관리 화면이 쓰는 길(backend 의 대신 부르기) — 관리자 쿠키
upd()      { ws_api "$1" "$UPD$2" "${3:-}"; }
upd_code() { ws_api_code "$1" "$UPD$2" "${3:-}"; }

# 설치 관리자의 내부 API 를 호스트에서 직접(backend 가 내려가 있을 때도 된다) — 내부망의 설치 관리자 주소 + 공유 키
iapi() {
  local method="$1" path="$2" body="${3:-}" ip
  ip="$(docker inspect --format '{{with index .NetworkSettings.Networks "just-workspace_workspace"}}{{.IPAddress}}{{end}}' "$INSTALLER" 2>/dev/null)"
  local args=(-s --max-time 30 -X "$method" -H "X-JW-Installer-Key: $(env_value JW_INSTALLER_KEY)")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data-binary "$body")
  curl "${args[@]}" "http://$ip:8444/internal/update$path"
}

ujob()       { sudo cat "$E2E_HOST_DIR/state/update/jobs/$1.json" 2>/dev/null | json_get "${2:-d}"; }
ujob_steps() { ujob "$1" '" ".join(s["id"]+"="+s["status"] for s in d["steps"])'; }
active_job() { sudo cat "$E2E_HOST_DIR/state/update/active.json" 2>/dev/null | json_get 'd["job"] or ""'; }
state_file() { sudo cat "$E2E_HOST_DIR/state/update/$1" 2>/dev/null | json_get "$2"; }

# 작업이 끝날 때까지(상태가 done·failed·cancelled 이고 도는 것이 없을 때까지) 기다린다. 되돌림으로 넘어가면 그것까지.
wait_ujob() {
  local id="$1" limit="${2:-1500}" waited=0 st rb
  [ -n "$id" ] && [ "${id#\{}" = "$id" ] || return 1
  while [ "$waited" -lt "$limit" ]; do
    st="$(ujob "$id" 'd["status"]')"
    case "$st" in
      done|cancelled) return 0 ;;
      failed)
        rb="$(ujob "$id" 'd.get("rollback_job") or ""')"
        if [ -z "$rb" ]; then
          # 선택을 기다리는가(choices), 되돌림 작업 자신이 멈췄는가
          [ -n "$(ujob "$id" '",".join(d["choices"])')" ] && return 0
        else
          case "$(ujob "$rb" 'd["status"]')" in done|failed) return 0 ;; esac
        fi ;;
    esac
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

wait_ustatus() {      # wait_ustatus <작업> <상태> [초]
  local id="$1" want="$2" limit="${3:-120}" waited=0
  while [ "$waited" -lt "$limit" ]; do
    [ "$(ujob "$id" 'd["status"]')" = "$want" ] && return 0
    sleep 1; waited=$((waited + 1))
  done
  return 1
}

# 확인을 시키고 끝날 때까지 기다린다 → available.state
check_now() {
  iapi POST /check >/dev/null
  local i
  for i in $(seq 1 30); do
    [ "$(iapi GET /status | json_get 'd["check"]["state"]')" = idle ] && break
    sleep 1
  done
  iapi GET /status | json_get 'd["available"]["state"]'
}

# 관리자로 로그인한 /api/health 의 버전·스키마
health_version() { ws_api GET /api/health | json_get 'd.get("version")'; }
health_schema()  { ws_api GET /api/health | json_get 'd["schema_version"]["current"]'; }
db_schema()      { docker exec ws-backend python -m app.cli migrate --status --json 2>/dev/null | json_get 'd["current"]'; }
installer_version() { docker exec "$INSTALLER" python -c "from pathlib import Path;from app.bundle import Bundle;print(Bundle(Path('/app/bundle')).version)" 2>/dev/null; }
installer_image()   { docker inspect --format '{{.Config.Image}}' "$INSTALLER" 2>/dev/null; }

# ─── 중단 시간 재기 ───
# /api/health(점검 모드에서도 열려 있다 = backend 가 답하는가)와 화면(/)을 0.5초마다 찔러 기록한다.

probe_start() {
  PROBE_LOG="$E2E_WORK/probe-$1.log"
  : > "$PROBE_LOG"
  ( while :; do
      printf '%s %s %s %s\n' "$(date +%s.%N)" \
        "$(ws_curl --max-time 2 -o /dev/null -w '%{http_code}' "$WS/api/health")" \
        "$(ws_curl --max-time 2 -o "$E2E_WORK/probe-page.html" -w '%{http_code}' "$WS/")" \
        "$(ws_curl --max-time 2 -o /dev/null -w '%{http_code}' "$WS/api/files/list?path=my/" -b "$UJAR")" >> "$PROBE_LOG"
      grep -q 'maintenance/status' "$E2E_WORK/probe-page.html" 2>/dev/null && touch "$E2E_WORK/probe-saw-static-page"
      sleep 0.5
    done ) &
  PROBE_PID=$!
}

probe_stop() {
  kill "$PROBE_PID" 2>/dev/null; wait "$PROBE_PID" 2>/dev/null
  python3 - "$PROBE_LOG" <<'PY'
import sys
rows = [l.split() for l in open(sys.argv[1]) if len(l.split()) == 4]
def spans(col, bad):
    out, start, prev = [], None, None
    for r in rows:
        t = float(r[0])
        if bad(r[col]):
            start = t if start is None else start
        elif start is not None:
            out.append(t - start); start = None
        prev = t
    if start is not None:
        out.append(prev - start)
    return out
down = spans(1, lambda c: c != "200")
page = spans(2, lambda c: c != "200")
blocked = spans(3, lambda c: c == "503")
print(f"backend 무응답(/api/health != 200): 가장 긴 구간 {max(down, default=0):.1f}초, 합계 {sum(down):.1f}초, {len(down)}번")
print(f"화면(/) 비정상: 가장 긴 구간 {max(page, default=0):.1f}초, 합계 {sum(page):.1f}초 — 그동안의 응답 코드 {sorted({r[2] for r in rows if r[2] != '200'})}")
print(f"일반 API 가 503 이던 구간(점검 모드 포함): 합계 {sum(blocked):.1f}초")
PY
}

# ─── 데이터 넣기·확인 ───

seed_data() {
  say "데이터 넣기"
  local pass body ch
  pass="$(head -c 18 /dev/urandom | base64 | tr -d '/+=\n')Aa1!"
  body="$(python3 -c 'import json,sys; print(json.dumps({"username":"e2euser","password":sys.argv[1],"display_name":"검수 사용자","recovery_email":"e2euser@example.com"}))' "$pass")"
  note "가입: $(ws_curl -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Origin: $WS" --data-binary "$body" "$WS/api/auth/register")"
  check_files
  SEED_FILE="$E2E_LAST_UPLOAD"; cp "$E2E_WORK/up.bin" "$E2E_WORK/seed.bin"
  ch="$(ws_api POST /api/chat/channels '{"name":"e2e-update","type":"public"}' | json_get 'd["id"]')"
  SEED_MSG="before-update-$(date +%s)"
  ws_api POST "/api/chat/channels/$ch/messages" "{\"content\":\"$SEED_MSG\"}" >/dev/null
  SEED_SUBJECT="e2e-update-$(date +%s)"
  ws_api POST /api/mail/send "{\"to\":[{\"email\":\"admin@$E2E_MAIL_DOMAIN\",\"name\":\"admin\"}],\"subject\":\"$SEED_SUBJECT\",\"text_body\":\"hello\"}" >/dev/null
  printf 'SEED_FILE=%q\nSEED_CH=%q\nSEED_MSG=%q\nSEED_SUBJECT=%q\n' "$SEED_FILE" "$ch" "$SEED_MSG" "$SEED_SUBJECT" > "$E2E_WORK/seed.env"
  local i
  for i in $(seq 1 20); do
    python3 "$E2E_ROOT/imap-check.py" 127.0.0.1 "admin@$E2E_MAIL_DOMAIN" "$(admin_password_file)" find "$SEED_SUBJECT" >/dev/null 2>&1 && break
    sleep 2
  done
  check_data "넣은 직후"
}

check_data() {
  local label="$1" i found=""
  . "$E2E_WORK/seed.env"
  ws_login >/dev/null 2>&1
  contains "[$label] 사용자" e2euser "$(ws_api GET '/api/admin/users?limit=200')"
  expect "[$label] 파일 내려받기" 200 "$(ws_curl -b "$UJAR" -o "$E2E_WORK/seed.down" -w '%{http_code}' "$WS/api/files/download?path=my/$SEED_FILE")"
  check "[$label] 파일 내용이 같다" cmp "$E2E_WORK/seed.bin" "$E2E_WORK/seed.down"
  contains "[$label] 채팅 메시지" "$SEED_MSG" "$(ws_api GET "/api/chat/channels/$SEED_CH/messages")"
  for i in $(seq 1 10); do
    found="$(python3 "$E2E_ROOT/imap-check.py" 127.0.0.1 "admin@$E2E_MAIL_DOMAIN" "$(admin_password_file)" find "$SEED_SUBJECT" 2>/dev/null)" && break
    sleep 2
  done
  contains "[$label] 메일" "From:" "$found"
}

# 검수용 변경 단계가 만든 표가 있는가 — "t" / "f"
marker_table() { docker exec ws-postgres psql -U workspace -d workspace -Atc "SELECT to_regclass('public.e2e_update_marker') IS NOT NULL" 2>/dev/null; }
