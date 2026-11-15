#!/usr/bin/env bash
# 백업에서 복원(서버 이전) — 원래 서버 꾸미기 → 백업 → 서버 비우기 → 복원 → 확인을 조각으로 나눠 부른다.
# 화면으로 복원하는 것은 이 PC 의 restore-ui.cjs 가 하고, 이 스크립트는 그 앞뒤(준비·확인)와 API·무인 경로를 맡는다.
#
#   restore.sh seed [local|nfs]     설치 → 데이터 넣기(계정 2, 파일, 채팅, 메일, 일정, 암호화된 값) → 전체 백업(+ 암호 보호 사본)
#                                   결과: $E2E_WORK/restore/{backup.jwbak, backup-enc.jwbak, enc-pass, expect.json, files/}
#   restore.sh wipe                 워크스페이스·설치 관리자를 지운다(NFS 내보내기의 데이터와 $E2E_WORK/restore 는 남긴다)
#   restore.sh start                설치 관리자를 띄우고 설치 토큰을 찍는다(화면 검수용)
#   restore.sh stage                백업을 "서버에 미리 옮겨 둔 파일" 자리(/srv/e2e-restore)에 놓는다
#   restore.sh api [nfs]            마법사 API 로 복원(서버 경로 지정) — 내용 확인·시작·진행
#   restore.sh unattended           답변 파일(mode: restore)로 무인 복원
#   restore.sh reject               거부 경로 — 형식 아님·손상·암호 없음/틀림/맞음·더 높은 버전·파일 없는 로컬 백업
#   restore.sh fail-retry           데이터 복원 중 실패(DB 를 멈춤) → 실패 상태 → 재시도로 완료
#   restore.sh nfs-reject           NFS: 로컬 선택 거부, 다른 공유 거부(표식 없음·다른 설치)
#   restore.sh verify [nfs]         복원한 서버가 원래 것과 같은지
#
# E2E_NEW_DOMAIN 을 주면 복원할 때 접속 주소를 그 이름으로 바꾼다(기본: 백업과 같은 주소).
. "$(dirname "$0")/../lib.sh"
CMD="${1:?seed | wipe | start | stage | api | unattended | reject | fail-retry | nfs-reject | verify}"
KIND="${2:-local}"
R="$E2E_WORK/restore"
STAGED=/srv/e2e-restore
NFS_ROOT=/srv/e2e-nfs
SECOND=second
NEW_DOMAIN="${E2E_NEW_DOMAIN:-$E2E_DOMAIN}"
mkdir -p "$R"

second_pass_file() {
  local f="$R/second-pass"
  [ -s "$f" ] || (umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | head -c 24 > "$f")
  printf '%s' "$f"
}
expect_get() { json_get "$1" < "$R/expect.json"; }
psql_at() { docker exec ws-postgres psql -U workspace -d workspace -At -c "$1"; }

nfs_prepare() {
  sudo systemctl start nfs-server
  sudo mkdir -p "$NFS_ROOT"/{rw,other,empty}
  sudo chown 1000:1000 "$NFS_ROOT/rw" "$NFS_ROOT/other" "$NFS_ROOT/empty"
  sudo mkdir -p /etc/exports.d
  sudo tee /etc/exports.d/e2e.exports >/dev/null <<EOF
$NFS_ROOT/rw     $E2E_ADDR(rw,sync,no_subtree_check,root_squash) 127.0.0.1(rw,sync,no_subtree_check,root_squash)
$NFS_ROOT/other  $E2E_ADDR(rw,sync,no_subtree_check,root_squash) 127.0.0.1(rw,sync,no_subtree_check,root_squash)
$NFS_ROOT/empty  $E2E_ADDR(rw,sync,no_subtree_check,root_squash) 127.0.0.1(rw,sync,no_subtree_check,root_squash)
EOF
  sudo exportfs -ra
}

# 올린 파일이 저장소에 있는지(이름 → sha256). list_file_hash <이름>
download_hash() {
  ws_curl -b "$UJAR" -o "$R/down.bin" "$WS/api/files/download?path=my/$1" >/dev/null
  sha256sum "$R/down.bin" | cut -d' ' -f1
}

seed() {
  rm -rf "$R"; mkdir -p "$R/files"
  if [ "$KIND" = nfs ]; then
    e2e_reset
    sudo rm -rf "$NFS_ROOT"; nfs_prepare
    check "설치 관리자 기동" installer_start
    # NFS + 협업 묶음(메일·채팅·일정)
    python3 - "$E2E_ROOT/answers/nfs.json" > "$R/answers-nfs.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); d["preset"]="collab"; d["mail"]={"kind":"builtin","mail_domain":"e2e.example"}
print(json.dumps(d))
PY
    install file "$R/answers-nfs.json" || finish
  else
    e2e_reset
    check "설치 관리자 기동" installer_start
    install file "$E2E_ROOT/answers/collab.json" || finish
  fi
  check_core

  say "데이터 넣기"
  local envf="$E2E_WORK/second.env"
  (umask 077; printf 'ADMIN_PASSWORD=%s\n' "$(cat "$(second_pass_file)")" > "$envf")
  check "두 번째 계정" docker exec --user appuser --env-file "$envf" ws-backend python -m app.cli seed-admin --username "$SECOND" --display-name "두 번째"
  rm -f "$envf"
  local i name
  for i in 1 2 3; do
    name="r-file-$i.bin"
    head -c $((200000 * i)) /dev/urandom > "$R/files/$name"
    expect "파일 올리기 $name" 200 "$(ws_curl -b "$UJAR" -H "Origin: $WS" -o /dev/null -w '%{http_code}' -F "file=@$R/files/$name;filename=$name" "$WS/api/files/upload?path=my/")"
  done
  local chan msg
  chan="$(ws_api POST /api/chat/channels '{"name":"restore-check","type":"public"}' | json_get 'd["id"]')"
  msg="복원 확인용 메시지 $(date +%s)"
  check "채팅 메시지" test -n "$(ws_api POST "/api/chat/channels/$chan/messages" "{\"content\":\"$msg\"}" | json_get 'd["id"]')"
  check "메일 서버 준비" wait_ready ws-mailserver 240
  local subject="restore-mail-$(date +%s)" found="" admin_mail="admin@$E2E_MAIL_DOMAIN"
  expect "메일 보내기" True "$(ws_api POST /api/mail/send "{\"to\":[{\"email\":\"$admin_mail\",\"name\":\"admin\"}],\"subject\":\"$subject\",\"text_body\":\"hello\"}" | json_get 'd["ok"]')"
  for i in $(seq 1 20); do
    found="$(python3 "$E2E_ROOT/imap-check.py" 127.0.0.1 "$admin_mail" "$(admin_password_file)" find "$subject" 2>/dev/null)" && break
    sleep 2
  done
  contains "메일 도착" "From:" "$found"
  local cal
  cal="$(ws_api GET /api/calendar/calendars | json_get 'd["calendars"][0]["id"]')"
  contains "일정" "복원 확인 일정" "$(ws_api POST /api/calendar/events "{\"calendar_id\":\"$cal\",\"title\":\"복원 확인 일정\",\"start\":\"2030-03-04T01:00:00Z\",\"end\":\"2030-03-04T02:00:00Z\"}")"
  # 암호화 키로 잠근 값을 DB 에 넣어 둔다 — 복원한 서버의 키로 풀리면 키가 유지된 것이다
  local plain cipher
  plain="probe-$(head -c 12 /dev/urandom | base64 | tr -d '/+=')"
  cipher="$(docker exec --user appuser -e P="$plain" ws-backend python -c 'import os; from app.mail.crypto import encrypt_password; print(encrypt_password(os.environ["P"]))')"
  psql_at "CREATE TABLE IF NOT EXISTS e2e_probe(cipher text); DELETE FROM e2e_probe; INSERT INTO e2e_probe VALUES ('$cipher')" >/dev/null
  check "암호화된 값 저장" test -n "$cipher"

  say "백업"
  local out path
  if [ "$KIND" = nfs ]; then
    out="$(docker exec --user 0 ws-backend python -m app.cli backup create --kind full --pack --json 2>"$R/backup.err")"
  else
    out="$(docker exec --user 0 ws-backend python -m app.cli backup create --kind full --include-files --pack --json 2>"$R/backup.err")"
  fi
  path="$(printf '%s' "$out" | json_get 'd["path"]')"
  check "전체 백업" test -n "$path"
  expect "백업 상태" success "$(printf '%s' "$out" | json_get 'd["status"]')"
  expect "파일 포함" "$([ "$KIND" = nfs ] && echo False || echo True)" "$(printf '%s' "$out" | json_get 'd["files_included"]')"
  docker cp "ws-backend:$path" "$R/backup.jwbak" >/dev/null && sudo chown "$(id -u):$(id -g)" "$R/backup.jwbak"
  check "백업을 꺼냈다" test -s "$R/backup.jwbak"
  if [ "$KIND" != nfs ]; then
    # 암호로 보호한 사본(거부 경로 검수용)
    (umask 077; printf 'enc-%s\n' "$(head -c 9 /dev/urandom | base64 | tr -d '/+=')" > "$R/enc-pass")
    docker cp "$R/enc-pass" ws-backend:/tmp/enc-pass >/dev/null
    out="$(docker exec --user 0 ws-backend python -m app.cli backup create --kind full --pack --json --password-file /tmp/enc-pass 2>>"$R/backup.err")"
    path="$(printf '%s' "$out" | json_get 'd["path"]')"
    expect "암호 보호 백업" True "$(printf '%s' "$out" | json_get 'd["config_encrypted"]')"
    docker cp "ws-backend:$path" "$R/backup-enc.jwbak" >/dev/null && sudo chown "$(id -u):$(id -g)" "$R/backup-enc.jwbak"
    docker exec --user 0 ws-backend rm -f /tmp/enc-pass
  fi

  python3 - "$R" "$msg" "$subject" "$plain" "$KIND" > "$R/expect.json" <<PY
import hashlib, json, os, sys
r, msg, subject, plain, kind = sys.argv[1:6]
files = {n: hashlib.sha256(open(os.path.join(r, "files", n), "rb").read()).hexdigest() for n in sorted(os.listdir(os.path.join(r, "files")))}
print(json.dumps({"kind": kind, "files": files, "message": msg, "subject": subject, "plain": plain,
                  "install_id": "$(env_value JW_INSTALL_ID)", "users": int("$(psql_at 'SELECT count(*) FROM users')"),
                  "secret_fp": hashlib.sha256("$(env_value SECRET_KEY)".encode()).hexdigest()[:16],
                  "dkim": "$(sudo sha256sum "$E2E_HOST_DIR/state/dkim/$E2E_MAIL_DOMAIN.pem" 2>/dev/null | cut -d' ' -f1)",
                  "domain": "$E2E_DOMAIN"}, ensure_ascii=False))
PY
  cp "$(admin_password_file)" "$R/admin-pass"
  note "백업: $(ls -l "$R/backup.jwbak" | awk '{print $5}') 바이트 · 설치 id $(expect_get 'd["install_id"]') · 계정 $(expect_get 'd["users"]')"
  finish
}

wipe() {
  local keep; keep="$(mktemp -d)"
  cp -a "$R/." "$keep/"
  e2e_reset
  mkdir -p "$R"; cp -a "$keep/." "$R/"; rm -rf "$keep"
  cp "$R/admin-pass" "$(admin_password_file)" 2>/dev/null
  [ "$KIND" = keep-nfs ] || true
  note "남긴 것: $R$(sudo test -d "$NFS_ROOT/rw" && echo " · $NFS_ROOT")"
}

start() {
  check "설치 관리자 기동" installer_start
  echo "TOKEN=$(installer_token)"
}

stage() {
  sudo mkdir -p "$STAGED"
  sudo install -m 600 "$R/backup.jwbak" "$STAGED/backup.jwbak"
  [ -s "$R/backup-enc.jwbak" ] && sudo install -m 600 "$R/backup-enc.jwbak" "$STAGED/backup-enc.jwbak"
  note "놓았습니다: $STAGED"
}

# 대상(새 서버에서 정하는 값)
target_json() {
  if [ "$KIND" = nfs ]; then
    printf '{"domain":"%s","network":"direct","storage":{"kind":"nfs","server":"%s","export":"%s"}}' "$NEW_DOMAIN" "$E2E_ADDR" "${E2E_NFS_EXPORT:-$NFS_ROOT/rw}"
  else
    printf '{"domain":"%s","network":"direct","storage":{"kind":"local"}}' "$NEW_DOMAIN"
  fi
}

api_restore() {
  stage
  [ "$KIND" = nfs ] && nfs_prepare
  check "설치 관리자 기동" installer_start
  check "세션" wizard_login
  wapi PUT '/api/answers?step=file' '{"mode":"restore"}' >/dev/null
  wapi POST /api/preflight >/dev/null
  local info review
  info="$(wapi POST /api/restore/path "{\"path\":\"$STAGED/backup.jwbak\"}")"
  expect "서버 경로의 백업 확인" ok "$(printf '%s' "$info" | json_get 'd["status"]')"
  review="$(wapi GET /api/restore/review)"
  expect "내용 확인: 만든 서버" "https://$(expect_get 'd["domain"]')" "$(printf '%s' "$review" | json_get 'd["source_url"]')"
  expect "내용 확인: 설치 id" "$(expect_get 'd["install_id"]')" "$(printf '%s' "$review" | json_get 'd["install_id"]')"
  expect "내용 확인: 계정 수" "$(expect_get 'd["users"]')" "$(printf '%s' "$review" | json_get 'd["users"]')"
  expect "내용 확인: 버전 판정" ok "$(printf '%s' "$review" | json_get 'd["version_status"]')"
  expect "내용 확인: 원래 저장소" "$([ "$KIND" = nfs ] && echo nfs || echo local)" "$(printf '%s' "$review" | json_get 'd["storage"]["kind"]')"
  expect "내용 확인: 파일 포함" "$([ "$KIND" = nfs ] && echo False || echo True)" "$(printf '%s' "$review" | json_get 'd["files_included"]')"
  note "구역: $(printf '%s' "$review" | json_get 'd["zones"]') · 데이터 $(printf '%s' "$review" | json_get 'd["data_bytes"]') · 파일 $(printf '%s' "$review" | json_get 'd["files_bytes"]')"
  wapi POST /api/restore/apply "$(target_json)" >/dev/null
  expect "POST /api/restore/apply" 202 "$(wcode)"
  local t0; t0=$(date +%s)
  wait_apply_file 2400; local rc=$?
  if [ "$rc" = 0 ]; then ok "복원 완료($(( $(date +%s) - t0 ))초)"; else bad "복원 — $(apply_error)"; fi
  step_seconds
  return $rc
}

unattended() {
  stage
  [ "$KIND" = nfs ] && nfs_prepare
  check "설치 관리자 기동" installer_start
  local tmp; tmp="$(mktemp)"
  python3 - "$(target_json)" "$STAGED/backup.jwbak" > "$tmp" <<'PY'
import json,sys
t=json.loads(sys.argv[1])
print(json.dumps({"version":1,"mode":"restore","restore":{"path":sys.argv[2]},
                  "access":{"domain":t["domain"],"network":t["network"],"cert":"temporary"},"storage":t["storage"]}))
PY
  sudo mkdir -p "$E2E_HOST_DIR/e2e"; sudo install -m 600 "$tmp" "$E2E_HOST_DIR/e2e/restore.json"; rm -f "$tmp"
  local out
  out="$(jw apply --answers /data/e2e/restore.json --dry-run 2>&1)"
  contains "dry-run 은 복원 단계를 보여 준다" "unpack → pull → database" "$out"
  check "dry-run 은 아무것도 남기지 않는다" bash -c "! sudo test -e '$E2E_HOST_DIR/stack/.env' && ! sudo test -e '$E2E_HOST_DIR/state/restore'"
  local t0; t0=$(date +%s)
  if jw apply --answers /data/e2e/restore.json; then ok "jw apply(mode: restore) 완료($(( $(date +%s) - t0 ))초)"; else bad "jw apply — $(apply_error)"; fi
  step_seconds
}

reject() {
  stage
  check "설치 관리자 기동" installer_start
  check "세션" wizard_login
  wapi PUT '/api/answers?step=file' '{"mode":"restore"}' >/dev/null
  wapi POST /api/preflight >/dev/null
  local up="$R/reject" r
  mkdir -p "$up"
  upload() { curl -sk -b "$WJAR" -F "file=@$1;filename=$(basename "$1")" "$WIZARD/api/restore/upload"; }

  say "형식 아님 · 손상"
  head -c 50000 /dev/urandom > "$up/notes.zip"
  r="$(upload "$up/notes.zip")"
  expect "백업이 아닌 파일 → invalid" "invalid not_a_backup" "$(printf '%s' "$r" | json_get 'd["status"]+" "+str(d["reason"])')"
  # 가운데를 덮어쓴 사본(크기는 같다) → 해시 불일치
  cp "$R/backup.jwbak" "$up/damaged.jwbak"
  printf 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' | dd of="$up/damaged.jwbak" bs=1 seek=$(( $(stat -c %s "$up/damaged.jwbak") / 2 )) conv=notrunc 2>/dev/null
  r="$(upload "$up/damaged.jwbak")"
  expect "가운데가 깨진 백업 → corrupt" corrupt "$(printf '%s' "$r" | json_get 'd["status"]')"
  head -c $(( $(stat -c %s "$R/backup.jwbak") / 2 )) "$R/backup.jwbak" > "$up/cut.jwbak"
  r="$(upload "$up/cut.jwbak")"
  expect "중간에 끊긴 백업 → corrupt" corrupt "$(printf '%s' "$r" | json_get 'd["status"]')"
  expect "쓸 수 없는 백업으로는 내용 확인이 열리지 않는다" 409 "$(wapi GET /api/restore/review >/dev/null; wcode)"
  r="$(wapi POST /api/restore/path '{"path":"/srv/e2e-restore/none.jwbak"}')"
  expect "없는 경로 → not_found" not_found "$(printf '%s' "$r" | json_get 'd["status"]')"

  say "암호 보호 백업"
  r="$(wapi POST /api/restore/path "{\"path\":\"$STAGED/backup-enc.jwbak\"}")"
  expect "암호 없이 → password_required" password_required "$(printf '%s' "$r" | json_get 'd["status"]')"
  r="$(wapi POST /api/restore/password '{"password":"not-the-password"}')"
  expect "틀린 암호 → password_wrong" password_wrong "$(printf '%s' "$r" | json_get 'd["status"]')"
  (umask 077; python3 -c 'import json,sys; print(json.dumps({"password": open(sys.argv[1]).read().strip()}))' "$R/enc-pass" > "$up/pw.json")
  r="$(wapi POST /api/restore/password "@$up/pw.json")"; rm -f "$up/pw.json"
  expect "맞는 암호 → ok" ok "$(printf '%s' "$r" | json_get 'd["status"]')"
  r="$(wapi GET /api/restore/review)"
  expect "암호 보호 백업의 내용 확인" "$(expect_get 'd["install_id"]')" "$(printf '%s' "$r" | json_get 'd["install_id"]')"
  expect "파일 없는 로컬 백업 — 화면이 경고할 값(files_included)" "local False" "$(printf '%s' "$r" | json_get 'd["storage"]["kind"]+" "+str(d["files_included"])')"
  check "암호는 상태 폴더 밖으로 나가지 않는다(600)" bash -c "sudo stat -c %a '$E2E_HOST_DIR/state/restore/password' | grep -qx 600"

  say "더 높은 버전의 백업"
  # manifest 의 스키마·제품 버전을 올린 사본(백업 폴더 꼴)
  local dir="$up/newer"
  rm -rf "$dir"; mkdir -p "$dir"; tar -xf "$R/backup.jwbak" -C "$dir"
  python3 - "$dir/manifest.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["schema_version"]=int(d["schema_version"])+50; d["product_version"]="99.0.0"
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PY
  sudo rm -rf "$STAGED/newer"; sudo cp -a "$dir" "$STAGED/newer"; sudo chown -R root:root "$STAGED/newer"
  r="$(wapi POST /api/restore/path "{\"path\":\"$STAGED/newer\"}")"
  expect "조작한 사본(폴더 꼴)도 읽는다" ok "$(printf '%s' "$r" | json_get 'd["status"]')"
  r="$(wapi GET /api/restore/review)"
  expect "버전 판정 newer" "newer schema" "$(printf '%s' "$r" | json_get 'd["version_status"]+" "+str(d["version_reason"])')"
  expect "막는 사유" version_newer "$(printf '%s' "$r" | json_get 'd["blockers"][0]["code"]')"
  r="$(wapi POST /api/restore/apply "$(target_json)")"
  expect "더 높은 버전은 시작하지 못한다" "422 version_newer" "$(wcode) $(printf '%s' "$r" | json_get '[e["code"] for e in d["vars"]["errors"] if e["field"]=="mode"][0]')"
  check "거부한 뒤 서버에는 아무것도 만들어지지 않았다" bash -c "! sudo test -e '$E2E_HOST_DIR/stack/.env' && [ -z \"\$(docker ps -aq --filter name='^ws-')\" ]"
}

fail_retry() {
  stage
  check "설치 관리자 기동" installer_start
  check "세션" wizard_login
  wapi PUT '/api/answers?step=file' '{"mode":"restore"}' >/dev/null
  wapi POST /api/preflight >/dev/null
  expect "백업 확인" ok "$(wapi POST /api/restore/path "{\"path\":\"$STAGED/backup.jwbak\"}" | json_get 'd["status"]')"
  wapi POST /api/restore/apply "$(target_json)" >/dev/null
  expect "POST /api/restore/apply" 202 "$(wcode)"
  # 데이터 되돌리기가 시작되면 DB 를 멈춘다
  local i cur=""
  for i in $(seq 1 600); do
    cur="$(sudo cat "$E2E_HOST_DIR/state/apply.json" 2>/dev/null | json_get 'd["current"]')"
    if [ "$cur" = database ] && sudo grep -q "데이터를 되돌립니다" "$E2E_HOST_DIR/state/logs/database.log" 2>/dev/null; then break; fi
    sleep 0.5
  done
  expect "데이터 되돌리기 단계에 들어갔다" database "$cur"
  docker stop ws-postgres >/dev/null
  wait_apply_file 900
  expect "실패 상태" failed "$(apply_status)"
  expect "실패한 단계·원인" "database restore_database_failed" "$(sudo cat "$E2E_HOST_DIR/state/apply.json" | json_get 'd["error"]["step"]+" "+d["error"]["cause"]')"
  note "원인: $(apply_error)"
  expect "실패한 동안은 잠기지 않는다" wizard-or-applying "$(curl -sk -b "$WJAR" "$WIZARD/api/state" | json_get '"wizard-or-applying" if d["phase"] in ("wizard","applying") else d["phase"]')"
  wapi POST /api/restore/apply/retry '{}' >/dev/null
  expect "POST /api/restore/apply/retry" 202 "$(wcode)"
  wait_apply_file 2400; local rc=$?
  if [ "$rc" = 0 ]; then ok "재시도로 복원 완료"; else bad "재시도 — $(apply_error)"; fi
  step_seconds
  expect "끝난 단계는 다시 돌지 않았다(pull 로그의 시작 횟수)" 1 "$(sudo grep -c -- '── pull 시작 ──' "$E2E_HOST_DIR/state/logs/pull.log")"
}

nfs_reject() {
  stage
  nfs_prepare
  check "설치 관리자 기동" installer_start
  check "세션" wizard_login
  wapi PUT '/api/answers?step=file' '{"mode":"restore"}' >/dev/null
  wapi POST /api/preflight >/dev/null
  expect "백업 확인" ok "$(wapi POST /api/restore/path "{\"path\":\"$STAGED/backup.jwbak\"}" | json_get 'd["status"]')"
  local r
  r="$(wapi GET /api/restore/review)"
  expect "원래 저장소는 NFS" "nfs $E2E_ADDR $NFS_ROOT/rw" "$(printf '%s' "$r" | json_get 'd["storage"]["kind"]+" "+d["storage"]["server"]+" "+d["storage"]["export"]')"
  codes() { json_get '" ".join(sorted(e["field"]+"/"+e["code"] for e in d["vars"]["errors"]))'; }
  r="$(wapi POST /api/restore/apply "{\"domain\":\"$NEW_DOMAIN\",\"storage\":{\"kind\":\"local\"}}")"
  expect "로컬 선택은 거부" "422 storage.kind/storage_must_be_nfs" "$(wcode) $(printf '%s' "$r" | codes)"
  r="$(wapi POST /api/probe/nfs "{\"server\":\"$E2E_ADDR\",\"export\":\"$NFS_ROOT/empty\"}")"
  expect "빈 공유(표식 없음) — 연결 확인" "False marker_missing missing" "$(printf '%s' "$r" | json_get 'str(d["ok"])+" "+str(d["cause"])+" "+d["marker"]["status"]')"
  r="$(wapi POST /api/restore/apply "{\"domain\":\"$NEW_DOMAIN\",\"storage\":{\"kind\":\"nfs\",\"server\":\"$E2E_ADDR\",\"export\":\"$NFS_ROOT/empty\"}}")"
  expect "빈 공유는 거부" "422 storage/storage_marker_missing" "$(wcode) $(printf '%s' "$r" | codes)"
  echo '{"install_id":"00000000-1111-2222-3333-444444444444"}' | sudo tee "$NFS_ROOT/other/.jw-storage" >/dev/null
  sudo chown 1000:1000 "$NFS_ROOT/other/.jw-storage"
  r="$(wapi POST /api/probe/nfs "{\"server\":\"$E2E_ADDR\",\"export\":\"$NFS_ROOT/other\"}")"
  expect "다른 설치의 공유 — 연결 확인" "False other_install mismatch" "$(printf '%s' "$r" | json_get 'str(d["ok"])+" "+str(d["cause"])+" "+d["marker"]["status"]')"
  r="$(wapi POST /api/restore/apply "{\"domain\":\"$NEW_DOMAIN\",\"storage\":{\"kind\":\"nfs\",\"server\":\"$E2E_ADDR\",\"export\":\"$NFS_ROOT/other\"}}")"
  expect "다른 설치의 공유는 거부" "422 storage/storage_other_install" "$(wcode) $(printf '%s' "$r" | codes)"
  r="$(wapi POST /api/probe/nfs "{\"server\":\"$E2E_ADDR\",\"export\":\"$NFS_ROOT/rw\"}")"
  expect "같은 공유 — 다섯 항목 + 표식 일치" "True match reach=pass mount=pass write=pass lock=pass space=pass" \
    "$(printf '%s' "$r" | json_get 'str(d["ok"])+" "+d["marker"]["status"]+" "+" ".join(s["id"]+"="+s["status"] for s in d["steps"])')"
  expect "확인이 끝나면 임시 볼륨은 남지 않는다" "" "$(docker volume ls -q | grep -E 'jw-nfs-(probe|marker)')"
  docker rm -f "$INSTALLER" >/dev/null 2>&1; sudo rm -rf "$E2E_HOST_DIR"
}

verify() {
  local old_domain; old_domain="$(expect_get 'd["domain"]')"
  E2E_DOMAIN="$NEW_DOMAIN"; WS="https://$E2E_DOMAIN"
  say "복원한 서버"
  local c
  for c in ws-postgres ws-redis ws-backend ws-frontend-react ws-nginx ws-mailserver; do
    check "컨테이너 $c 준비" wait_ready "$c" 240
  done
  expect "/api/health" 200 "$(ws_code "$WS/api/health")"
  cp "$R/admin-pass" "$(admin_password_file)"
  check "옛 관리자 계정·옛 비밀번호로 로그인" ws_login
  expect "관리자 권한 유지" True "$(ws_api GET /api/auth/me | json_get 'd["is_admin"]')"
  expect "계정 수" "$(expect_get 'd["users"]')" "$(psql_at 'SELECT count(*) FROM users')"

  say "파일"
  local name want
  for name in $(expect_get '" ".join(d["files"])'); do
    want="$(E2E_N="$name" json_get 'd["files"][__import__("os").environ["E2E_N"]]' < "$R/expect.json")"
    expect "파일 $name 의 내용(sha256)" "$want" "$(download_hash "$name")"
  done
  if [ "$KIND" = nfs ]; then
    check "파일은 NFS 내보내기에 그대로 있다" bash -c "sudo find '$NFS_ROOT/rw' -type f -name '*.bin*' | grep -q . || sudo find '$NFS_ROOT/rw' -type f | grep -qv jw-storage"
    expect "저장소 볼륨은 같은 공유" ":$NFS_ROOT/rw" "$(docker volume inspect ws-storage-data --format '{{index .Options "device"}}')"
  fi
  expect "저장소 표식의 설치 id" "$(expect_get 'd["install_id"]')" "$(docker exec ws-backend cat /storage/.jw-storage | json_get 'd["install_id"]')"
  expect "파일 올리기(쓰기 가능)" 200 "$(head -c 1000 /dev/urandom > "$R/new.bin"; ws_curl -b "$UJAR" -H "Origin: $WS" -o /dev/null -w '%{http_code}' -F "file=@$R/new.bin;filename=after-restore.bin" "$WS/api/files/upload?path=my/")"

  say "채팅 · 메일 · 일정"
  local chan
  chan="$(ws_api GET /api/chat/channels | python3 -c 'import json,sys
d=json.load(sys.stdin); rows=d if isinstance(d,list) else d.get("channels", d.get("items", []))
print(next((c["id"] for c in rows if c.get("name")=="restore-check"), ""))')"
  check "채널이 있다" test -n "$chan"
  contains "채팅 메시지" "$(expect_get 'd["message"]')" "$(ws_api GET "/api/chat/channels/$chan/messages")"
  local found="" i admin_mail="admin@$E2E_MAIL_DOMAIN"
  for i in $(seq 1 15); do
    found="$(python3 "$E2E_ROOT/imap-check.py" 127.0.0.1 "$admin_mail" "$(admin_password_file)" find "$(expect_get 'd["subject"]')" 2>/dev/null)" && break
    sleep 2
  done
  contains "메일함의 메일(IMAP, 옛 비밀번호)" "From:" "$found"
  contains "일정" "복원 확인 일정" "$(ws_api GET '/api/calendar/events?start=2030-03-01T00:00:00Z&end=2030-03-31T00:00:00Z')"
  expect "메일 서명 키(DKIM)는 백업의 것" "$(expect_get 'd["dkim"]')" "$(docker exec ws-mailserver sha256sum /etc/rspamd/jw-dkim/default.private | cut -d' ' -f1)"

  say "암호화 키 · 설치 id · 두 번째 계정"
  expect "암호화 키 지문" "$(expect_get 'd["secret_fp"]')" "$(printf '%s' "$(env_value SECRET_KEY)" | sha256sum | cut -c1-16)"
  expect "DB 에 저장된 암호화 값이 풀린다" "$(expect_get 'd["plain"]')" \
    "$(docker exec --user appuser -e C="$(psql_at 'SELECT cipher FROM e2e_probe')" ws-backend python -c 'import os; from app.mail.crypto import decrypt_password; print(decrypt_password(os.environ["C"]))' 2>&1 | tail -1)"
  expect "설치 id(.env)" "$(expect_get 'd["install_id"]')" "$(env_value JW_INSTALL_ID)"
  expect "설치 id(설치 관리자)" "$(expect_get 'd["install_id"]')" "$(sudo cat "$E2E_HOST_DIR/state/install.json" | json_get 'd["install_id"]')"
  expect "접속 주소(APP_URL)" "https://$NEW_DOMAIN" "$(env_value APP_URL)"
  expect "메일 도메인(DOMAIN)은 그대로" "$E2E_MAIL_DOMAIN" "$(env_value DOMAIN)"
  E2E_ADMIN="$SECOND" check "두 번째 계정·옛 비밀번호로 로그인" ws_login "$R/second-pass"
  cp "$R/admin-pass" "$(admin_password_file)"; ws_login >/dev/null 2>&1

  check_locked
  check "꺼내 둔 백업 설정(암호화 키)은 지워졌다" bash -c "! sudo test -e '$E2E_HOST_DIR/state/restore/config'"
  note "주의: $(sudo cat "$E2E_HOST_DIR/state/apply.json" | json_get '[w["key"] for w in d["warnings"]]') · 결과: $(sudo cat "$E2E_HOST_DIR/state/apply.json" | json_get 'd["restore"]')"
  [ "$old_domain" = "$NEW_DOMAIN" ] || note "접속 주소를 $old_domain → $NEW_DOMAIN 로 바꿨다"
}

case "$CMD" in
  seed) seed ;;
  wipe) wipe; exit 0 ;;
  start) start; exit 0 ;;
  stage) stage; exit 0 ;;
  api) api_restore ;;
  unattended) unattended ;;
  reject) reject ;;
  fail-retry) fail_retry ;;
  nfs-reject) nfs_reject ;;
  verify) verify ;;
  *) echo "모르는 명령: $CMD"; exit 2 ;;
esac
finish
