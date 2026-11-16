#!/usr/bin/env bash
# S8 수동 설치 — 설치 관리자 없이 README·docs/deployment.md 의 절차 그대로: .env.example 을 채우고 docker compose up.
# 최소 구성(프로파일 없음), 평문 80 으로 띄워 본다.
# 관리자는 `.env` 에 적지 않는다 — backend 로그의 설정 토큰으로 웹의 첫 관리자 만들기를 거친다.
. "$(dirname "$0")/../lib.sh"
MANUAL="$HOME/e2e-manual"

manual_down() {
  if [ -f "$MANUAL/docker-compose.yml" ]; then
    (cd "$MANUAL" && docker compose --profile '*' down -v --remove-orphans >/dev/null 2>&1)
  fi
  docker volume rm ws-storage-data >/dev/null 2>&1
  rm -rf "$MANUAL"
}
manual_down
e2e_reset

say "리포 사본에서 문서의 절차대로"
mkdir -p "$MANUAL"
(cd "$E2E_REPO" && tar --exclude=./.env --exclude=./.git -cf - .) | tar -xf - -C "$MANUAL"
cd "$MANUAL" || finish
cp .env.example .env
# 도메인 등을 채운다 — 최소 구성, 이 서버의 주소로 평문 접속
set_env() { sed -i -E "s|^$1=.*|$1=$2|" .env; grep -q "^$1=" .env || printf '%s=%s\n' "$1" "$2" >> .env; }
set_env COMPOSE_PROFILES ""
set_env APP_URL "http://$E2E_ADDR"
set_env DOMAIN "$E2E_ADDR"
set_env ADMIN_EMAILS "admin@$E2E_MAIL_DOMAIN"
set_env ADMIN_USERNAME ""
set_env ADMIN_PASSWORD ""
chmod 600 .env

t0=$(date +%s)
docker build --build-context licenses=. -t localhost/just-workspace-backend:latest ./backend > "$E2E_WORK/manual-build.log" 2>&1
expect "docker build backend" 0 "$?"
docker run --rm -v "$PWD/.env:/work/.env" localhost/just-workspace-backend:latest \
  python -m app.cli gen-secrets --merge /work/.env --in-place > "$E2E_WORK/manual-secrets.log" 2>&1
expect "비밀값 채우기(gen-secrets --merge)" 0 "$?"
check "SECRET_KEY 가 채워졌다" bash -c "grep -qE '^SECRET_KEY=.{32,}' .env"
check "DB_PASSWORD 가 채워졌다" bash -c "grep -qE '^DB_PASSWORD=.{16,}' .env"
docker volume create ws-storage-data >/dev/null
expect "docker volume create ws-storage-data" 0 "$?"
docker compose config --quiet > "$E2E_WORK/manual-config.log" 2>&1
expect "docker compose config --quiet" 0 "$?"
docker compose up -d > "$E2E_WORK/manual-up.log" 2>&1
rc=$?
expect "docker compose up -d" 0 "$rc"
[ "$rc" = 0 ] || tail -15 "$E2E_WORK/manual-up.log"
note "빌드·기동 $(( $(date +%s) - t0 ))초"

say "떠 있는가"
for c in ws-postgres ws-redis ws-backend ws-frontend-react ws-nginx; do
  check "컨테이너 $c 준비" wait_ready "$c" 240
done
H="http://$E2E_ADDR"
expect "프런트 화면(/)" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$H/")"
expect "/api/health" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/health")"
note "/api/health zones: $(curl -s "$H/api/health" | json_get 'd["zones"]') (JW_ZONES 를 비우면 전부)"
expect "게시 포트" "80/tcp " "$(published_ports | grep -v '^\[' | sed 's/^0\.0\.0\.0://' | tr '\n' ' ')"
# 설치 관리자가 없는 구성 — 점검 관련 경로가 nginx 기동을 막지 않고, 점검 모드도 걸리지 않는다
expect "정적 점검 페이지(/maintenance.html)" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$H/maintenance.html")"
expect "공개 점검 상태는 설치 관리자가 없어 502" 502 "$(curl -s -o /dev/null -w '%{http_code}' "$H/maintenance/status")"
docker stop ws-frontend-react >/dev/null
for i in $(seq 1 12); do code="$(curl -s --max-time 10 -o "$E2E_WORK/manual-page.html" -w '%{http_code}' "$H/")"; [ "$code" = 503 ] && break; sleep 2; done
expect "프런트가 없으면 점검 페이지" 503 "$code"
check "그 본문은 점검 페이지다" grep -q 'maintenance/status' "$E2E_WORK/manual-page.html"
docker start ws-frontend-react >/dev/null; wait_ready ws-frontend-react 60

say "첫 관리자 — 설정 토큰"
# 시도는 주소당 분당 5회까지다 — 아래는 정확히 5번 부른다.
log_tokens() { docker logs ws-backend 2>&1 | sed -n 's/.*setup token: \([A-Za-z0-9_-]\{40,\}\).*/\1/p'; }
setup_post() {  # setup_post <토큰> <비밀번호 파일> → 상태 코드(본문은 first-admin.json)
  local body="$E2E_WORK/setup-admin.json" code
  (umask 077; python3 -c 'import json,sys; print(json.dumps({"username": "admin", "password": open(sys.argv[2]).read().strip(), "setup_token": sys.argv[1]}))' "$1" "$2" > "$body")
  code="$(curl -s -o "$E2E_WORK/first-admin.json" -w '%{http_code}' -H 'Content-Type: application/json' -H "Origin: $H" --data-binary "@$body" "$H/api/setup/admin")"
  rm -f "$body"
  printf '%s' "$code"
}
status_get() { curl -s "$H/api/setup/status" | json_get "$1"; }
expect "최초 설정 필요" True "$(status_get 'd["needs_setup"]')"
expect "방식은 token" token "$(status_get 'd["setup_mode"]')"
expect "상태 응답의 항목" "app_name,has_admin,needs_setup,setup_complete,setup_mode" "$(status_get '",".join(sorted(d))')"
expect "워커가 여럿이어도 로그의 토큰은 하나" 1 "$(log_tokens | wc -l | tr -d ' ')"
(umask 077; log_tokens | tail -1 > "$E2E_WORK/setup-token-1")
note "backend 워커 수: $(docker top ws-backend 2>/dev/null | grep -c 'multiprocessing.spawn\|uvicorn')"
expect "토큰 없이는 403" 403 "$(setup_post "" "$(admin_password_file)")"
expect "사유는 setup_token_invalid" setup_token_invalid "$(json_get 'd["detail"]["code"]' < "$E2E_WORK/first-admin.json")"
(umask 077; printf 'eleven-ch-1' > "$E2E_WORK/short-pass")
expect "맞는 토큰이어도 11자 비밀번호는 400" 400 "$(setup_post "$(cat "$E2E_WORK/setup-token-1")" "$E2E_WORK/short-pass")"
(umask 077; docker compose exec -T backend python -m app.cli setup-token 2>/dev/null | tail -1 | tr -d ' \r\n' > "$E2E_WORK/setup-token-2")
check "CLI 로 다시 발급한 토큰은 로그의 것과 다르다" bash -c "[ -s '$E2E_WORK/setup-token-2' ] && ! cmp -s '$E2E_WORK/setup-token-1' '$E2E_WORK/setup-token-2'"
expect "다시 발급하면 로그의 토큰은 못 쓴다(403)" 403 "$(setup_post "$(cat "$E2E_WORK/setup-token-1")" "$(admin_password_file)")"
expect "관리자는 아직 없다" False "$(status_get 'd["has_admin"]')"
expect "새 토큰으로 첫 관리자 만들기(201)" 201 "$(setup_post "$(cat "$E2E_WORK/setup-token-2")" "$(admin_password_file)")"
expect "관리자가 생겼다" False "$(status_get 'd["needs_setup"]')"
expect "같은 토큰으로 다시는 403" 403 "$(setup_post "$(cat "$E2E_WORK/setup-token-2")" "$(admin_password_file)")"
expect "사유는 admin_exists" admin_exists "$(json_get 'd["detail"]["code"]' < "$E2E_WORK/first-admin.json")"
expect "토큰은 DB 에서 사라졌다" 0 "$(docker exec ws-postgres psql -U workspace -d workspace -At -c "SELECT count(*) FROM system_settings WHERE key = 'setup.token_hash'")"
docker compose exec -T backend python -m app.cli setup-token >/dev/null 2>&1; expect "관리자가 있으면 setup-token 은 거절" 1 "$?"
rm -f "$E2E_WORK"/setup-token-* "$E2E_WORK/short-pass" "$E2E_WORK/first-admin.json"

say "관리자 로그인·파일"
body="$E2E_WORK/login.json"
(umask 077; python3 -c 'import json,sys; print(json.dumps({"username": "admin", "password": open(sys.argv[1]).read().strip()}))' "$(admin_password_file)" > "$body")
jar="$E2E_WORK/jar-manual"; rm -f "$jar"
expect "만든 관리자로 로그인" 200 "$(curl -s -c "$jar" -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H "Origin: $H" --data-binary "@$body" "$H/api/auth/login")"
rm -f "$body"
expect "로그인한 계정은 관리자" True "$(curl -s -b "$jar" "$H/api/auth/me" | json_get 'd["is_admin"]')"
head -c 100000 /dev/urandom > "$E2E_WORK/up.bin"
expect "올리기" 200 "$(curl -s -b "$jar" -H "Origin: $H" -o /dev/null -w '%{http_code}' -F "file=@$E2E_WORK/up.bin;filename=e2e-manual.bin" "$H/api/files/upload?path=my/")"
expect "내려받기" 200 "$(curl -s -b "$jar" -o "$E2E_WORK/down.bin" -w '%{http_code}' "$H/api/files/download?path=my/e2e-manual.bin")"
check "올린 것과 내려받은 것이 같다" cmp "$E2E_WORK/up.bin" "$E2E_WORK/down.bin"

say "scripts/update.sh — 소스로 다시 빌드해 올리기와 이미지 되돌리기"
before_id="$(docker inspect ws-backend --format '{{.Image}}')"
bash scripts/update.sh --no-pull > "$E2E_WORK/manual-update.log" 2>&1
rc=$?
expect "update.sh --no-pull" 0 "$rc"
[ "$rc" = 0 ] || tail -15 "$E2E_WORK/manual-update.log"
check "되돌릴 정보에 backend 의 이름·되돌릴 태그·ID 가 적혔다" grep -qxF "backend|localhost/just-workspace-backend:latest|localhost/just-workspace-backend:latest-rollback|$before_id" .update-rollback
expect "되돌릴 태그는 업데이트 전의 이미지다" "$before_id" "$(docker image inspect localhost/just-workspace-backend:latest-rollback --format '{{.Id}}')"
check "되돌릴 정보에 frontend-react 도 있다" grep -q '^frontend-react|' .update-rollback
expect "업데이트 뒤 /api/health" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/health")"
expect "업데이트 뒤 내려받기(데이터 유지)" 200 "$(curl -s -b "$jar" -o "$E2E_WORK/down2.bin" -w '%{http_code}' "$H/api/files/download?path=my/e2e-manual.bin")"
# 태그를 다른 이미지로 옮겨 두고(새 빌드가 달랐던 것처럼) 되돌리면 적어 둔 ID 로 돌아온다
docker tag "$(docker inspect ws-frontend-react --format '{{.Image}}')" localhost/just-workspace-backend:latest
bash scripts/update.sh --rollback > "$E2E_WORK/manual-rollback.log" 2>&1
rc=$?
expect "update.sh --rollback" 0 "$rc"
[ "$rc" = 0 ] || tail -15 "$E2E_WORK/manual-rollback.log"
expect "되돌린 뒤 이름이 가리키는 이미지 = 업데이트 전" "$before_id" "$(docker image inspect localhost/just-workspace-backend:latest --format '{{.Id}}')"
expect "되돌린 뒤 backend 컨테이너의 이미지 = 업데이트 전" "$before_id" "$(docker inspect ws-backend --format '{{.Image}}')"
expect "되돌린 뒤 /api/health" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/health")"

report_usage
say "정리"
manual_down
finish
