#!/usr/bin/env bash
# S9 설치 후 터미널에서 수행하는 작업 — 기본 + 코드 저장소, 임시 인증서로 설치한 서버에서:
#   · 시작 로그의 버전 알림(JW_INSTALLER_VERSION 없이 기동한 경우)
#   · jw update-key / jw update-channel — 공개 키가 없어 "구성되지 않음"이던 업데이트 확인이 채널 수신을 시도한다
#   · jw restore — 전체 백업을 동일 서버에 복원한다(목록, 내용만 조회, 복원, 거부)
#   · 사설 CA 인증서 — 서버 인증서만 업로드하면 코드 저장소 연결이 보류로 남고, 발급 CA 를 업로드하면(이후 CA 만 · 인증서와 함께 별도로 · 이어 붙여서) 재개된다.
#     backend 도 동일 CA 를 신뢰한다
# 사용: s9-operate.sh
. "$(dirname "$0")/../lib.sh"
OP="$E2E_WORK/operate"

e2e_reset
rm -rf "$OP"; mkdir -p "$OP"; chmod 700 "$OP"

say "설치 관리자 시작"
# 이미지에는 배포처의 공개 키가 포함되어 있을 수 있다(installer/keys/). "키가 없는 설치"를 검수하기 위해 내장 키 폴더를 빈 경로로 지정한다 —
# 설치 폴더의 키(state/update/keys/)는 그대로 사용된다.
check "설치 관리자 기동(내장 공개 키 없이)" installer_start -e JW_UPDATE_PUBKEY_DIR=/e2e-no-builtin-keys
contains "버전 환경변수 없이 띄우면 로그에 알린다" "JW_INSTALLER_VERSION 이 없어 이미지에 든 버전($E2E_VERSION)" "$(docker logs $INSTALLER 2>&1)"

install file "$E2E_ROOT/answers/git.json" || { step_seconds; finish; }
step_seconds
check_core
check "컨테이너 ws-gitea 준비" wait_ready ws-gitea 180

zone_pending() { internal_api GET /internal/zones | cut -d' ' -f2- | json_get '[z["pending"] for z in d["zones"] if z["id"]=="git"][0]'; }
expect "임시 인증서 — 코드 저장소의 로그인 연동은 보류" True "$(zone_pending)"

# ─── 업데이트 채널의 공개 키·주소 ───
say "jw update-key · jw update-channel"
update_error() { internal_api GET /internal/update/status | cut -d' ' -f2- | json_get '(d["check"]["error"] or {}).get("code")'; }
update_check() {
  internal_api POST /internal/update/check >/dev/null
  local i
  for i in $(seq 1 20); do
    [ "$(internal_api GET /internal/update/status | cut -d' ' -f2- | json_get 'd["check"]["state"]')" = idle ] && break
    sleep 1
  done
}
update_check
expect "공개 키가 없으면 확인은 구성되지 않음" unconfigured "$(update_error)"
contains "jw update-key 는 키가 없다고 알린다" "공개 키가 없습니다" "$(jw update-key 2>&1)"
# 검수용 임시 키 — 이 서버의 작업 폴더에만 생성하고 종료 시 삭제한다
openssl ecparam -name prime256v1 -genkey -noout -out "$OP/release.pem" 2>/dev/null
openssl ec -in "$OP/release.pem" -pubout -out "$OP/release.pub" 2>/dev/null
docker exec -i $INSTALLER jw update-key add - < "$OP/release.pem" > "$OP/key-private.out" 2>&1
expect "비공개 키는 받지 않는다" 1 "$?"
check "비공개 키를 저장하지 않았다" bash -c "! sudo test -e '$E2E_HOST_DIR/state/update/keys/release.pub'"
printf 'hello\n' | docker exec -i $INSTALLER jw update-key add - > /dev/null 2>&1
expect "공개 키가 아닌 파일은 받지 않는다" 1 "$?"
out="$(docker exec -i $INSTALLER jw update-key add - < "$OP/release.pub" 2>&1)"; rc=$?
expect "jw update-key add(표준 입력)" 0 "$rc"
contains "넣은 키의 지문을 보여 준다" "지문" "$out"
check "설치 폴더에 놓였다" sudo cmp -s "$OP/release.pub" "$E2E_HOST_DIR/state/update/keys/release.pub"
contains "jw update-channel 은 지금 주소를 보여 준다" "채널 주소: http" "$(jw update-channel 2>&1)"
jw update-channel "ftp://bad.example" >/dev/null 2>&1; expect "틀린 채널 주소는 거부" 1 "$?"
out="$(jw update-channel "http://127.0.0.1:9/e2e-channel" 2>&1)"; rc=$?
expect "jw update-channel <주소>" 0 "$rc"
contains "바꾼 주소를 보여 준다" "http://127.0.0.1:9/e2e-channel" "$out"
update_check
expect "키가 생기자 채널을 받으러 간다(그 주소에는 아무것도 없다)" channel_unreachable "$(update_error)"
jw update-channel --reset >/dev/null 2>&1; expect "jw update-channel --reset" 0 "$?"
check "채널 주소 파일이 없어졌다" bash -c "! sudo test -e '$E2E_HOST_DIR/state/update/channel-url'"
jw update-key remove release.pub >/dev/null 2>&1; expect "jw update-key remove" 0 "$?"
update_check
expect "키를 지우면 다시 구성되지 않음" unconfigured "$(update_error)"
rm -f "$OP/release.pem" "$OP/release.pub" "$OP/key-private.out"

# ─── 동일 서버에 복원 ───
say "jw restore"
check_files
kept="$E2E_LAST_UPLOAD"
docker exec ws-backend python -m app.cli backup create --kind full --include-files --json > "$OP/backup.json" 2> "$OP/backup.err"
expect "전체 백업 만들기" 0 "$?"
backup="$(json_get 'd["path"].rsplit("/",1)[-1]' < "$OP/backup.json")"
note "백업: $backup"
sleep 2
check_files
later="$E2E_LAST_UPLOAD"
ws_api POST /api/auth/logout >/dev/null 2>&1; check "관리자 로그인" ws_login

contains "jw restore --list 에 그 백업이 있다" "$backup" "$(jw restore --list 2>&1)"
out="$(jw restore "$backup" 2>&1)"; rc=$?
expect "--yes 없이는 종료 코드 1" 1 "$rc"
contains "내용을 보여 준다(되돌릴 항목)" "복원할 항목: db" "$out"
contains "아무것도 바꾸지 않았다고 알린다" "아무것도 변경하지 않았습니다" "$out"
expect "--yes 없이는 백업 뒤의 파일이 그대로다" 200 "$(ws_curl -b "$UJAR" -o /dev/null -w '%{http_code}' "$WS/api/files/download?path=my/$later")"
jw restore /srv/e2e-no-such-backup.jwbak --yes > "$OP/restore-missing.out" 2>&1; expect "없는 파일은 거부" 1 "$?"
jw restore "/srv/a b.jwbak" --yes >/dev/null 2>&1; expect "틀린 경로는 거부" 1 "$?"
expect "거부한 뒤에도 서비스는 그대로" 200 "$(ws_code "$WS/api/health")"

# 서버 경로 지정 — 백업을 파일 하나로 패킹하여 설치 폴더에 추출해 두고 해당 경로로 읽는다
docker exec ws-backend python -m app.cli backup pack "/backups/$backup" /backups/e2e-packed.jwbak >/dev/null 2>&1
docker cp ws-backend:/backups/e2e-packed.jwbak "$OP/e2e-packed.jwbak" >/dev/null 2>&1
sudo install -m 600 "$OP/e2e-packed.jwbak" "$E2E_HOST_DIR/e2e-packed.jwbak"
docker exec ws-backend rm -f /backups/e2e-packed.jwbak
contains "서버 경로(/data/…)의 백업을 읽는다" "복원할 항목: db" "$(jw restore /data/e2e-packed.jwbak 2>&1)"

t0=$(date +%s)
jw restore "$E2E_HOST_DIR/e2e-packed.jwbak" --yes > "$OP/restore.out" 2>&1; rc=$?
expect "jw restore <서버 경로> --yes" 0 "$rc"
[ "$rc" = 0 ] || tail -20 "$OP/restore.out"
note "되돌리기 $(( $(date +%s) - t0 ))초"
contains "되돌린 항목을 알린다" "복원했습니다: db" "$(cat "$OP/restore.out")"
contains "복원 전 DB 덤프의 위치를 알린다" "_pre-restore" "$(cat "$OP/restore.out")"
check "점검 표식이 남지 않았다" bash -c "! sudo test -e '$E2E_HOST_DIR/stack/nginx/state/maintenance.on'"
check "컨테이너 ws-backend 준비" wait_ready ws-backend 180
check "되돌린 뒤 관리자 로그인(세션은 새로)" ws_login
expect "백업에 있던 파일은 그대로" 200 "$(ws_curl -b "$UJAR" -o "$OP/kept.bin" -w '%{http_code}' "$WS/api/files/download?path=my/$kept")"
expect "백업 뒤에 올린 파일은 사라졌다" 404 "$(ws_curl -b "$UJAR" -o /dev/null -w '%{http_code}' "$WS/api/files/download?path=my/$later")"
check_files                                           # 저장소 마커가 유지되어야 쓰기가 가능하다
check "컨테이너 ws-gitea 준비(되돌린 뒤)" wait_ready ws-gitea 180
sudo rm -f "$E2E_HOST_DIR/e2e-packed.jwbak" "$OP/e2e-packed.jwbak"

# ─── 사설 CA 인증서 ───
say "사설 CA 가 내준 인증서 — 서버 인증서만 올리면 보류"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj "/CN=E2E Private CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$OP/ca.key" -out "$OP/ca.pem" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=$E2E_DOMAIN" \
  -keyout "$OP/leaf.key" -out "$OP/leaf.csr" 2>/dev/null
printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n' "$E2E_DOMAIN" > "$OP/leaf.ext"
openssl x509 -req -in "$OP/leaf.csr" -CA "$OP/ca.pem" -CAkey "$OP/ca.key" -CAcreateserial -days 30 \
  -extfile "$OP/leaf.ext" -out "$OP/leaf.pem" 2>/dev/null
check "검수용 CA 와 서버 인증서" openssl verify -CAfile "$OP/ca.pem" "$OP/leaf.pem"

reissue() {   # reissue <인증서 파일…> [--ca <CA 파일>]  → 작업 종료 상태(done|failed)
  local body reply id
  body="$(python3 -c 'import json,sys
a = sys.argv[2:]; ca = ""
if "--ca" in a: ca = open(a[a.index("--ca") + 1]).read(); a = a[:a.index("--ca")]
d = {"mode": "upload", "cert": "".join(open(p).read() for p in a), "key": open(sys.argv[1]).read()}
if ca: d["ca"] = ca
print(json.dumps(d))' "$OP/leaf.key" "$@")"
  reply="$(internal_api POST /internal/cert/reissue "$body")"
  id="$(printf '%s' "$reply" | cut -d' ' -f2- | json_get 'd["id"]')"
  [ -n "$id" ] || { printf 'rejected:%s' "$(printf '%s' "$reply" | head -c 200)"; return; }
  wait_job "$id" 600
  job_field "$id" '["status"]'
}
set_ca() {    # set_ca <CA 파일|-(제거)>  → 작업 종료 상태, 거부 시 "<상태 코드> <코드>"
  local body reply id
  if [ "$1" = - ]; then body='{"ca":""}'; else body="$(python3 -c 'import json,sys; print(json.dumps({"ca": open(sys.argv[1]).read()}))' "$1")"; fi
  reply="$(internal_api POST /internal/cert/ca "$body")"
  id="$(printf '%s' "$reply" | cut -d' ' -f2- | json_get 'd["id"]')"
  [ -n "$id" ] && [ "$id" != None ] || { printf '%s %s' "${reply%% *}" "$(printf '%s' "$reply" | cut -d' ' -f2- | json_get 'd["code"]')"; return; }
  wait_job "$id" 600
  job_field "$id" '["status"]'
}
cert_field() { internal_api GET /internal/cert | cut -d' ' -f2- | json_get "d[\"$1\"]"; }
fp() { openssl x509 -noout -fingerprint -sha256 2>/dev/null; }
gitea_ca() { docker exec ws-gitea cat /etc/ssl/certs/jw-site-ca.pem 2>/dev/null | fp; }
# backend 가 접속 주소의 인증서를 신뢰하는지 확인 — backend 프로세스(PID 1)가 전달받은 CA 번들(SSL_CERT_FILE)로 nginx 에 TLS 연결을 시도한다.
# 프로세스의 환경은 동일 사용자(appuser)만 읽을 수 있다
backend_trusts() {
  docker exec -i -u appuser -e E2E_HOST="$E2E_DOMAIN" ws-backend sh -c 'f="$(tr "\0" "\n" < /proc/1/environ | sed -n "s/^SSL_CERT_FILE=//p")"; [ -n "$f" ] && export SSL_CERT_FILE="$f"; exec python -' <<'PY'
import os, socket, ssl
ctx = ssl.create_default_context()
host = os.environ["E2E_HOST"]
try:
    with socket.create_connection(("nginx", 443), timeout=10) as raw, ctx.wrap_socket(raw, server_hostname=host):
        print("trusted", "public-cas=%s" % (ctx.cert_store_stats()["x509_ca"] > 50))
except ssl.SSLCertVerificationError as e:
    print("untrusted", e.verify_message)
except Exception as e:  # noqa: BLE001
    print("error", type(e).__name__)
PY
}

st="$(reissue "$OP/leaf.pem")"
note "서버 인증서만 올린 작업: $st"
expect "서버 인증서만 올리면 연결은 보류로 남는다" True "$(zone_pending)"
check "코드 저장소 컨테이너에 따로 믿게 한 CA 가 없다" bash -c "! docker exec ws-gitea test -e /etc/ssl/certs/jw-site-ca.pem"
expect "상태: 믿게 한 발급 CA 없음" False "$(cert_field site_ca)"
expect "상태: CA 인증서를 따로 올릴 수 있다" True "$(cert_field ca_uploadable)"
expect "backend 도 그 인증서를 믿지 못한다" untrusted "$(backend_trusts | cut -d" " -f1)"

say "CA 인증서만 나중에 올리기"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj "/CN=E2E Other CA" \
  -addext "basicConstraints=critical,CA:TRUE" -keyout "$OP/other.key" -out "$OP/other.pem" 2>/dev/null
expect "그 인증서를 내주지 않은 CA 는 거부" "422 cert_invalid" "$(set_ca "$OP/other.pem")"
expect "서버 인증서를 CA 로 올리면 거부" "422 cert_invalid" "$(set_ca "$OP/leaf.pem")"
expect "발급 CA 만 올린 작업" done "$(set_ca "$OP/ca.pem")"
check "컨테이너 ws-gitea 준비(다시 만든 뒤)" wait_ready ws-gitea 180
check "컨테이너 ws-backend 준비(다시 만든 뒤)" wait_ready ws-backend 180
expect "코드 저장소 컨테이너에 그 CA 가 붙었다" "$(fp < "$OP/ca.pem")" "$(gitea_ca)"
expect "보류됐던 로그인 연동이 이어졌다" False "$(zone_pending)"
contains "코드 저장소에 로그인 원본이 등록됐다" workspace "$(docker exec -u git ws-gitea gitea admin auth list 2>/dev/null)"
expect "상태: 믿게 한 발급 CA 있음" True "$(cert_field site_ca)"
expect "backend 가 접속 주소의 인증서를 믿고, 공개 CA 묶음도 그대로다" "trusted public-cas=True" "$(backend_trusts)"
check "nginx 가 올린 인증서를 낸다" bash -c "echo | openssl s_client -connect '$E2E_ADDR:443' -servername '$E2E_DOMAIN' -CAfile '$OP/ca.pem' 2>/dev/null | grep -q 'Verify return code: 0'"
expect "공개 CA 에 대한 신뢰는 그대로(컨테이너의 CA 묶음이 남아 있다)" 0 "$(docker exec ws-gitea sh -c 'test -s /etc/ssl/certs/ca-certificates.crt; echo $?')"
ws_login
expect "관리 화면의 인증서 상태에도 보인다" "True True" "$(ws_api GET /api/admin/system/cert | json_get '"%s %s" % (d["site_ca"], d["ca_uploadable"])')"

say "CA 걷어 내기 · 인증서와 함께 올리기"
expect "따로 올린 CA 를 걷어 낸 작업" done "$(set_ca -)"
check "컨테이너 ws-gitea 준비" wait_ready ws-gitea 180
check "코드 저장소 컨테이너에서 CA 가 사라졌다" bash -c "! docker exec ws-gitea test -e /etc/ssl/certs/jw-site-ca.pem"
check "컨테이너 ws-backend 준비" wait_ready ws-backend 180
expect "backend 도 다시 믿지 못한다" untrusted "$(backend_trusts | cut -d" " -f1)"
expect "인증서와 CA 인증서를 따로(칸 둘) 올린 작업" done "$(reissue "$OP/leaf.pem" --ca "$OP/ca.pem")"
check "컨테이너 ws-gitea 준비" wait_ready ws-gitea 180
expect "CA 가 다시 붙었다" "$(fp < "$OP/ca.pem")" "$(gitea_ca)"
expect "인증서 파일에 CA 를 이어 붙여 올린 작업(예전 방식)" done "$(reissue "$OP/leaf.pem" "$OP/ca.pem")"
check "컨테이너 ws-gitea 준비" wait_ready ws-gitea 180
expect "CA 는 한 번만 실린다" 1 "$(docker exec ws-gitea grep -c 'BEGIN CERTIFICATE' /etc/ssl/certs/jw-site-ca.pem)"
check "컨테이너 ws-backend 준비" wait_ready ws-backend 180
expect "backend 가 믿는다" trusted "$(backend_trusts | cut -d" " -f1)"
rm -f "$OP"/ca.key "$OP"/other.key "$OP"/leaf.key "$OP"/leaf.csr "$OP"/leaf.ext "$OP"/*.srl

report_usage
finish
