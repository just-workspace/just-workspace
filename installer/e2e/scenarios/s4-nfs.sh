#!/usr/bin/env bash
# S4 NFS 저장소 — 이 서버 내에 NFS 서버(nfs-kernel-server)를 기동하여 내보내기를 생성하고, 해당 내보내기를 저장소로 설치한다.
# 확인 다섯 항목(probe)의 실제 결과, 볼륨·마커·업로드 위치, 그리고 NFS 서버 중지 시 쓰기 거부(503)와 복구.
# 호스트에 nfs-kernel-server 패키지를 설치하고 /etc/exports.d/e2e.exports 를 기록한다(검수 전용 서버에서만).
. "$(dirname "$0")/../lib.sh"
NFS_ROOT=/srv/e2e-nfs

say "NFS 서버 준비"
if ! dpkg -s nfs-kernel-server >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nfs-kernel-server >/dev/null 2>&1
fi
check "nfs-kernel-server 설치" dpkg -s nfs-kernel-server
sudo systemctl start nfs-server
e2e_reset
# 이전 실행의 저장소 내용(다른 설치의 마커)이 남아 있으면 삭제한다
sudo rm -rf "$NFS_ROOT"
sudo mkdir -p "$NFS_ROOT"/{rw,rwroot,ro,denied,rootonly}
sudo chown 1000:1000 "$NFS_ROOT/rw" "$NFS_ROOT/rwroot" "$NFS_ROOT/ro" "$NFS_ROOT/denied"
sudo chown root:root "$NFS_ROOT/rootonly"; sudo chmod 700 "$NFS_ROOT/rootonly"
# rw = 보통의 NAS 설정(root 를 낮춘다, 뿌리는 uid 1000 소유) · rwroot = root 를 그대로 받는 내보내기
# 도커 데몬이 붙이므로 클라이언트 주소는 이 서버 자신이다. denied 는 다른 주소에만 허용한다.
sudo mkdir -p /etc/exports.d
sudo tee /etc/exports.d/e2e.exports >/dev/null <<EOF
$NFS_ROOT/rw        $E2E_ADDR(rw,sync,no_subtree_check,root_squash) 127.0.0.1(rw,sync,no_subtree_check,root_squash)
$NFS_ROOT/rwroot    $E2E_ADDR(rw,sync,no_subtree_check,no_root_squash) 127.0.0.1(rw,sync,no_subtree_check,no_root_squash)
$NFS_ROOT/ro        $E2E_ADDR(ro,sync,no_subtree_check) 127.0.0.1(ro,sync,no_subtree_check)
$NFS_ROOT/rootonly  $E2E_ADDR(rw,sync,no_subtree_check,root_squash) 127.0.0.1(rw,sync,no_subtree_check,root_squash)
$NFS_ROOT/denied    203.0.113.9(rw,sync,no_subtree_check)
EOF
sudo exportfs -ra
check "내보내기 등록" bash -c "sudo exportfs -v | grep -q '$NFS_ROOT/rw'"

check "설치 관리자 기동" installer_start
check "세션" wizard_login

# probe <서버> <내보내기> → 응답 본문
probe() { wapi POST /api/probe/nfs "{\"server\":\"$1\",\"export\":\"$2\"}"; }
steps_of() { json_get '" ".join(s["id"]+"="+s["status"] for s in d["steps"])'; }

say "확인(probe) — 실패 분류"
r="$(probe 192.0.2.1 /srv/none)"
expect "없는 주소 → unreachable" unreachable "$(printf '%s' "$r" | json_get 'd["cause"]')"; note "$(printf '%s' "$r" | steps_of)"
r="$(probe "$E2E_ADDR" "$NFS_ROOT/denied")"
expect "허용 안 된 내보내기 → export_not_found(NFSv4 는 없는 경로와 같게 답한다)" export_not_found "$(printf '%s' "$r" | json_get 'd["cause"]')"; note "$(printf '%s' "$r" | steps_of)"
r="$(probe "$E2E_ADDR" "$NFS_ROOT/rootonly")"
expect "쓸 권한이 없는 내보내기 → permission_denied" permission_denied "$(printf '%s' "$r" | json_get 'd["cause"]')"; note "$(printf '%s' "$r" | steps_of)"
r="$(probe "$E2E_ADDR" "$NFS_ROOT/ro")"
expect "읽기 전용 내보내기 → read_only" read_only "$(printf '%s' "$r" | json_get 'd["cause"]')"; note "$(printf '%s' "$r" | steps_of)"
r="$(probe "$E2E_ADDR" /srv/e2e-nfs/no-such-export)"
expect "없는 내보내기 경로 → export_not_found" export_not_found "$(printf '%s' "$r" | json_get 'd["cause"]')"; note "$(printf '%s' "$r" | steps_of)"
note "no_locking 은 재현하지 않는다 — NFSv4.1 은 잠금이 프로토콜에 들어 있어 서버 설정으로 끌 수 없다"

say "확인(probe) — 정상"
r="$(probe "$E2E_ADDR" "$NFS_ROOT/rw")"
expect "쓰기 되는 내보내기 → ok" True "$(printf '%s' "$r" | json_get 'd["ok"]')"
expect "다섯 항목" "reach=pass mount=pass write=pass lock=pass space=pass" "$(printf '%s' "$r" | steps_of)"
note "여유 공간: $(printf '%s' "$r" | json_get '[s["value"] for s in d["steps"] if s["id"]=="space"][0]')GB"
expect "확인이 끝나면 임시 볼륨은 남지 않는다" "" "$(docker volume ls -q | grep jw-nfs-probe)"
expect "확인이 저장소에 남긴 파일이 없다" "" "$(sudo ls -A "$NFS_ROOT/rw")"
r="$(probe "$E2E_ADDR" "$NFS_ROOT/rwroot")"
expect "root 를 그대로 받는 내보내기도 ok" True "$(printf '%s' "$r" | json_get 'd["ok"]')"
expect "확인이 내보내기 뿌리의 소유자를 바꾸지 않는다" "1000:1000 755" "$(sudo stat -c '%u:%g %a' "$NFS_ROOT/rwroot")"

say "설치(API)"
check "답변·사전 점검" api_prepare "$E2E_ROOT/answers/nfs.json"
sum="$(wapi GET /api/summary)"
expect "요약의 저장소 종류" nfs "$(printf '%s' "$sum" | json_get 'd["storage"]["kind"]')"
contains "단계에 storage" "storage" "$(printf '%s' "$sum" | json_get '" ".join(d["steps"])')"
wapi POST /api/apply >/dev/null; expect "POST /api/apply" 202 "$(wcode)"
wait_apply_api 1200; rc=$?
if [ "$rc" = 0 ]; then ok "적용 완료"; else bad "적용 — $(apply_error)"; sudo tail -20 "$E2E_HOST_DIR/state/logs/storage.log"; finish; fi
step_seconds
check_core

say "볼륨·표식"
vol="$(docker volume inspect ws-storage-data)"
expect "볼륨 type" nfs "$(printf '%s' "$vol" | json_get 'd[0]["Options"]["type"]')"
expect "볼륨 device" ":$NFS_ROOT/rw" "$(printf '%s' "$vol" | json_get 'd[0]["Options"]["device"]')"
expect "볼륨 옵션" "addr=$E2E_ADDR,rw,nfsvers=4.1,hard,noatime" "$(printf '%s' "$vol" | json_get 'd[0]["Options"]["o"]')"
contains "backend 의 /storage 는 NFS" "nfs4" "$(docker exec ws-backend sh -c 'grep " /storage " /proc/mounts')"
check "표식 파일이 NFS 에 있다" sudo test -s "$NFS_ROOT/rw/.jw-storage"
expect "표식의 설치 id = .env 의 설치 id" "$(env_value JW_INSTALL_ID)" "$(sudo cat "$NFS_ROOT/rw/.jw-storage" | json_get 'd["install_id"]')"
check_files
check "올린 파일이 NFS 에 쓰였다" bash -c "sudo find '$NFS_ROOT/rw' -name '$E2E_LAST_UPLOAD' | grep -q ."
expect "NFS 에 쓰인 파일의 소유자" "1000:1000" "$(sudo find "$NFS_ROOT/rw" -name "$E2E_LAST_UPLOAD" -printf '%u:%g\n' | head -1 | sed -e "s/^$(id -un 1000 2>/dev/null || echo 1000):/1000:/" -e "s/:$(id -gn 1000 2>/dev/null || echo 1000)\$/:1000/")"

upload_code() {
  head -c 2000 /dev/urandom > "$E2E_WORK/small.bin"
  ws_curl --max-time "${2:-40}" -b "$UJAR" -H "Origin: $WS" -o "$E2E_WORK/upload.out" -w '%{http_code}' \
    -F "file=@$E2E_WORK/small.bin;filename=$1" "$WS/api/files/upload?path=my/"
}

say "끊김 — NFS 서버를 멈춘다"
sudo systemctl stop nfs-server
sleep 8
t0=$(date +%s)
code="$(upload_code e2e-while-down.bin 60)"
took=$(( $(date +%s) - t0 ))
expect "끊긴 동안 올리기는 503" 503 "$code"
expect "전용 코드" storage_unavailable "$(json_get 'd["code"]' < "$E2E_WORK/upload.out")"
note "응답까지 ${took}초 · 사유 $(json_get 'd["reason"]' < "$E2E_WORK/upload.out")"
check "거부는 오래 걸리지 않는다(30초 안)" test "$took" -lt 30
expect "끊긴 동안 저장소 상태(파일 탭·알림 띠용): 닿지 않음" False "$(ws_api GET /api/system/storage-status | json_get 'd["available"]')"
expect "끊긴 동안 관리 › 저장소의 상태" down "$(ws_api GET /api/admin/system/storage | json_get 'd["state"]')"
expect "끊긴 동안에도 로그인·다른 API 는 돈다" 200 "$(ws_api_code GET /api/auth/me)"
expect "끊긴 동안에도 /api/health" 200 "$(ws_code "$WS/api/health")"
code="$(upload_code e2e-while-down-2.bin 60)"
expect "두 번째 올리기도 503" 503 "$code"
check "backend 는 여전히 healthy" container_ready ws-backend

say "복구 — NFS 서버를 다시 띄운다"
sudo systemctl start nfs-server
code=""
for i in $(seq 1 40); do
  code="$(upload_code e2e-after-recover.bin 30)"
  [ "$code" = 200 ] && break
  sleep 5
done
expect "다시 살아난 뒤 올리기" 200 "$code"
note "복구까지 약 $(( i * 5 ))초 안"
expect "복구 뒤 저장소 상태: 닿음" True "$(ws_api GET /api/system/storage-status | json_get 'd["available"]')"
note "관리 › 저장소: $(ws_api POST /api/admin/system/storage/recheck | json_get '"%s %s %s" % (d.get("state"), d.get("kind"), d.get("location"))')"
check "복구 뒤 올린 파일이 NFS 에 있다" bash -c "sudo find '$NFS_ROOT/rw' -name 'e2e-after-recover.bin' | grep -q ."
check "거부된 올리기의 파일은 쓰이지 않았다" bash -c "! sudo find '$NFS_ROOT/rw' -name 'e2e-while-down*' | grep -q ."
check_locked

report_usage
finish
