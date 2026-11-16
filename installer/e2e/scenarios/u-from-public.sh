#!/usr/bin/env bash
# U 공개 이전 버전에서 업데이트 — 공개된 이전 버전의 이미지로 설치한 서버를 현재 소스의 빌드로 업데이트한다.
# 사용: u-from-public.sh            (선행: build-images.sh 로 현재 소스의 이미지를 빌드해 둔다)
#
# 검증 대상은 내부망 주소 배정의 이행이다. 1.0.0-beta.2 이하의 설치 관리자는 내부망에 동적 주소(통상 3번 — 당시 인증서 갱신
# 컨테이너의 고정 주소)로 연결되어 있고, 업데이트의 switch 단계는 그 이전 버전의 설치 관리자가 수행한다.
#   1. 공개 이미지(E2E_OLD_REGISTRY 의 E2E_OLD_VERSION)를 서버 내부의 모의 레지스트리에 복제하여 설치한다(자동 발급 구성).
#      실제 인증 기관에는 요청할 수 없으므로, 사설 CA 가 발급한 인증서를 인증서 볼륨에 미리 배치한다(이미 유효한 인증서가 있으면
#      설치 관리자는 발급을 생략한다) — 갱신 컨테이너의 프로파일(certbot)이 활성화된 설치가 된다.
#   2. 현재 소스를 E2E_NEW_VERSION 으로 빌드해 모의 Beta 채널에 게시하고 업데이트한다.
#   3. 업데이트 후: 설치 관리자가 예약 주소(100번)로 재연결됨, 갱신 컨테이너가 고정 주소(35번)로 실행 중, 주소 중복 없음,
#      네트워크는 재생성되지 않음(id 동일), 데이터 보존, 일회용 실행이 실행 중인 backend 와 충돌하지 않음.
#
# 환경변수(선택): E2E_OLD_VERSION(기본 1.0.0-beta.2) · E2E_OLD_REGISTRY(기본 ghcr.io/just-workspace) · E2E_NEW_VERSION(기본 1.0.0-beta.90)
. "$(dirname "$0")/../lib.sh"
. "$(dirname "$0")/../update-lib.sh"

OLD="${E2E_OLD_VERSION:-1.0.0-beta.2}"
OLD_REG="${E2E_OLD_REGISTRY:-ghcr.io/just-workspace}"
NEW="${E2E_NEW_VERSION:-1.0.0-beta.90}"
NET=just-workspace_workspace
PREFIX=172.28.0

net_id() { docker network inspect --format '{{.Id}}' "$NET" 2>/dev/null; }

e2e_reset
rel_env_down; rm -rf "$REL"
rel_env_up

say "공개된 $OLD 이미지를 모의 레지스트리에 복제"
for n in backend frontend-react installer; do
  check "pull $n:$OLD" docker pull -q "$OLD_REG/just-workspace-$n:$OLD"
  docker tag "$OLD_REG/just-workspace-$n:$OLD" "$REG/just-workspace-$n:$OLD"
  check "push $n:$OLD" docker push -q "$REG/just-workspace-$n:$OLD"
done

say "유효한 인증서를 인증서 볼륨에 미리 배치(사설 CA 발급)"
OP="$E2E_WORK/from-public"; rm -rf "$OP"; mkdir -p "$OP"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj "/CN=E2E Private CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$OP/ca.key" -out "$OP/ca.pem" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=$E2E_DOMAIN" \
  -keyout "$OP/leaf.key" -out "$OP/leaf.csr" 2>/dev/null
printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\n' "$E2E_DOMAIN" > "$OP/ext.cnf"
openssl x509 -req -in "$OP/leaf.csr" -CA "$OP/ca.pem" -CAkey "$OP/ca.key" -CAcreateserial -days 30 \
  -extfile "$OP/ext.cnf" -out "$OP/leaf.pem" 2>/dev/null
check "검수용 CA 와 서버 인증서" openssl verify -CAfile "$OP/ca.pem" "$OP/leaf.pem"
docker volume create ws-certbot-data >/dev/null
check "인증서 볼륨에 배치" docker run --rm -v ws-certbot-data:/le -v "$OP:/src:ro" alpine:latest sh -c \
  "mkdir -p /le/live/$E2E_DOMAIN && cat /src/leaf.pem /src/ca.pem > /le/live/$E2E_DOMAIN/fullchain.pem && cp /src/leaf.key /le/live/$E2E_DOMAIN/privkey.pem && chmod 600 /le/live/$E2E_DOMAIN/privkey.pem"

say "$OLD 설치(자동 발급 구성)"
E2E_REGISTRY="$REG"
E2E_INSTALLER_IMAGE="$REG/just-workspace-installer:$OLD"
check "설치 관리자 기동($OLD)" installer_start -e "JW_UPDATE_CHANNEL_URL=$CHANNEL_URL" -e "JW_INSTALLER_VERSION=$OLD"
install file "$E2E_ROOT/answers/auto-cert.json" || finish
expect "설치된 버전" "$OLD" "$(env_value JW_VERSION)"
contains "갱신 컨테이너의 프로파일이 켜진 설치" certbot "$(env_value COMPOSE_PROFILES)"
E2E_SKIP_NETWORK_CHECK=1 check_core          # 이전 버전의 설치 관리자는 동적 주소를 사용한다 — 주소 확인은 업데이트 후에 수행
ws_login
check_files
OLD_FILE="$E2E_LAST_UPLOAD"; cp "$E2E_WORK/up.bin" "$OP/seed.bin"
NET_BEFORE="$(net_id)"
note "업데이트 전 — 설치 관리자의 내부망 주소: $(net_address "$INSTALLER"), 갱신 컨테이너: $(docker inspect --format '{{.State.Status}}' ws-certbot 2>/dev/null || echo 없음)"

say "현재 소스를 $NEW 로 게시(Beta 채널)"
check "$NEW 이미지·다이제스트" rel_build "$NEW" base
check "$NEW manifest" rel_manifest "$NEW" "$S0"
check "Beta 로 게시" rel_publish "$NEW" beta
sudo mkdir -p "$E2E_HOST_DIR/state/update/keys"
sudo cp "$REL/keys/release.pub" "$E2E_HOST_DIR/state/update/keys/release.pub"
upd PUT /settings '{"channel":"beta"}' >/dev/null
expect "받을 버전" update "$(check_now)"
expect "available.version" "$NEW" "$(iapi GET /status | json_get 'd["available"]["version"]')"

say "업데이트 $OLD → $NEW"
job="$(iapi POST /apply "{\"target\":\"$NEW\",\"start\":\"now\",\"actor\":{\"id\":\"e2e\",\"name\":\"검수\"}}" | json_get 'd.get("id") or d')"
note "작업 $job"
check "작업 종료" wait_ujob "$job" 1800
expect "작업 상태" done "$(ujob "$job" 'd["status"]')"
note "단계: $(ujob_steps "$job")"
[ "$(ujob "$job" 'd["status"]')" = done ] || { note "오류: $(ujob "$job" 'd.get("error")')"; sudo tail -30 "$E2E_HOST_DIR/state/update/jobs/$job.log"; }
installer_wait_up
expect "설치 관리자 버전" "$NEW" "$(installer_version)"
ws_login
expect "/api/health 버전" "$NEW" "$(health_version)"

say "업데이트 후의 내부망"
for i in $(seq 1 40); do
  [ "$(net_address "$INSTALLER")" = "$PREFIX.100" ] && [ "$(docker inspect --format '{{.State.Running}}' ws-certbot 2>/dev/null)" = true ] && break
  sleep 3
done
expect "네트워크는 재생성되지 않았다(id 동일)" "$NET_BEFORE" "$(net_id)"
expect "설치 관리자는 예약 주소" "$PREFIX.100" "$(net_address "$INSTALLER")"
expect "갱신 컨테이너 실행 중" true "$(docker inspect --format '{{.State.Running}}' ws-certbot 2>/dev/null)"
expect "갱신 컨테이너의 고정 주소" "$PREFIX.35" "$(net_address ws-certbot)"
expect "nginx 의 고정 주소" "$PREFIX.2" "$(net_address ws-nginx)"
expect "주소 중복 없음" "" "$(net_duplicates)"
expect "backend → 설치 관리자(내부 API) 연결" 200 "$(ws_api_code GET /api/admin/system/cert)"
renewal="$(ws_api GET /api/admin/system/cert | json_get 'd.get("renewal")')"
note "인증서 상태의 renewal: $renewal"
expect "갱신 서비스 상태" running "$(printf '%s' "$renewal" | json_get 'd["service"]')"
contains "jw status 의 자동 갱신 줄" "자동 갱신: 동작 중" "$(jw status 2>&1)"
expect "이전 버전에서 올린 파일" 200 "$(ws_curl -b "$UJAR" -o "$OP/seed.down" -w '%{http_code}' "$WS/api/files/download?path=my/$OLD_FILE")"
check "파일 내용이 같다" cmp "$OP/seed.bin" "$OP/seed.down"

say "일회용 실행은 실행 중인 backend 의 고정 주소와 충돌하지 않는다"
out="$(docker exec "$INSTALLER" python -c "
from app import api, paths
svc = api.build_services(paths.from_env())
r = svc.docker.compose_run('backend', ['-m', 'app.cli', 'migrate', '--status', '--json'], run_args=['-T', '--entrypoint', 'python'], timeout=300)
print('RC', r.rc, r.text[-300:])
" 2>&1)"
contains "실행 중인 backend 옆에서 compose run" "RC 0" "$out"

say "서버 재부팅에 해당하는 재기동(도커 재시작) 후에도 주소 유지"
sudo systemctl restart docker
for i in $(seq 1 60); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' ws-backend 2>/dev/null)" = healthy ] \
    && [ "$(docker inspect --format '{{.State.Running}}' ws-nginx 2>/dev/null)" = true ] \
    && [ "$(docker inspect --format '{{.State.Running}}' ws-certbot 2>/dev/null)" = true ] && break
  sleep 5
done
expect "재기동 후 설치 관리자 주소" "$PREFIX.100" "$(net_address "$INSTALLER")"
expect "재기동 후 갱신 컨테이너 주소" "$PREFIX.35" "$(net_address ws-certbot)"
expect "재기동 후 nginx 주소" "$PREFIX.2" "$(net_address ws-nginx)"
expect "재기동 후 주소 중복 없음" "" "$(net_duplicates)"
expect "재기동 후 프런트" 200 "$(ws_code "$WS/")"

rel_env_down
finish
