#!/usr/bin/env bash
# U 업데이트 — 설치 관리자의 업데이트 실행부를 가짜 릴리스 환경으로 처음부터 끝까지.
# 사용: u-update.sh <단계…>      단계는 차례로 돈다. 서버의 상태가 단계 사이에 이어지므로 하나씩 불러도 된다.
#
#   setup   가짜 레지스트리·채널·임시 키, 1.0.0 과 1.0.1(Beta 로 낸 뒤 승격)을 만들고 1.0.0 을 설치, 데이터 넣기
#   u9      서명·검증: 변조된 채널, 만료, 순번 역행, 다른 키 → 거부
#   u1      수동 업데이트 1.0.0 → 1.0.1 (예고·점검·자기 교체·데이터·기록, 중단 시간)
#   u7      복원 지점으로 수동 복원(1.0.1 → 1.0.0)
#   u2      pull 실패(레지스트리에 없는 다이제스트) → 되돌리기 / 다시 시도
#   u3      DB 변경 실패(일부러 깨진 단계가 든 1.0.2) → 자동 되돌림
#   r103    1.0.3 릴리스를 낸다(u5 가 없으면 스스로 부른다 — 화면 검수 admin-update-ui.cjs 를 그 전에 돌릴 때 쓴다)
#   u5      중간 버전: 1.0.0 → 1.0.1 → 1.0.3
#   u4      자동 업데이트: 3일 유예 · 시간대 · 실패 뒤 멈춤과 다시 켜기 (1.0.4)
#   u6      Beta 채널로 올렸다가 Stable 로 — 기다리기와 "시험판 이전 상태로 복원" (1.1.0-beta.1)
#   u8      오프라인: 레지스트리·채널을 끊고 묶음 파일 + 추가 이미지 파일로 (1.0.5)
#   down    가짜 릴리스 환경 내리기
. "$(dirname "$0")/../lib.sh"
. "$(dirname "$0")/../update-lib.sh"

keys_install() {
  sudo mkdir -p "$E2E_HOST_DIR/state/update/keys"
  sudo cp "$REL/keys/release.pub" "$E2E_HOST_DIR/state/update/keys/release.pub"
}

apply_now() {      # apply_now <버전> → 작업 id (예고 없이)
  iapi POST /apply "{\"target\":\"$1\",\"start\":\"now\",\"actor\":{\"id\":\"e2e\",\"name\":\"검수\"}}" | json_get 'd.get("id") or d'
}

stage_setup() {
  e2e_reset
  rel_env_down; rm -rf "$REL"
  rel_env_up
  say "릴리스 만들기"
  check "1.0.0 이미지·다이제스트" rel_build 1.0.0 base
  check "1.0.0 manifest" rel_manifest 1.0.0 1
  check "1.0.0 을 stable 로 게시" rel_publish 1.0.0 stable
  check "1.0.1-beta.1 이미지(검수용 스키마 변경 단계 하나)" rel_build 1.0.1-beta.1 schema2
  check "1.0.1-beta.1 manifest" rel_manifest 1.0.1-beta.1 2
  check "Beta 로 게시" rel_publish 1.0.1-beta.1 beta
  check "채널 검증(공개 키)" rel_verify
  note "받을 용량(manifest): $(json_get 'd.get("download_bytes")' < "$REL/manifests/1.0.1-beta.1.json")"

  check "설치 관리자 기동(채널 주소 지정)" installer_start -e "JW_UPDATE_CHANNEL_URL=$CHANNEL_URL"
  install file "$E2E_ROOT/answers/collab.json" || finish
  check_core
  check "메일 서버 준비" wait_ready ws-mailserver 240
  ws_login
  say "공개 키가 없을 때"
  iapi POST /check >/dev/null; sleep 3
  expect "확인 결과" unconfigured "$(iapi GET /status | json_get 'd["check"]["error"]["code"]')"
  keys_install
  expect "공개 키를 넣은 뒤 — 최신" none "$(check_now)"
  expect "Beta 릴리스는 stable 채널에 보이지 않는다" 1.0.0 "$(json_get 'd["releases"][-1]["version"]' < "$REL/channel/channels/stable.json")"
  check "승격(1.0.1-beta.1 → 1.0.1)" rel_promote 1.0.1-beta.1
  expect "승격 뒤 — 받을 버전" update "$(check_now)"
  expect "available.version" 1.0.1 "$(iapi GET /status | json_get 'd["available"]["version"]')"
  note "available: $(iapi GET /status | json_get '{k: d["available"][k] for k in ("path","download_bytes","downtime_seconds","zones","auto_eligible_at")}')"
  seed_data
}

stage_u9() {
  say "U9 서명·검증"
  local ch="$REL/channel/channels/stable.json" keep="$REL/keep"
  rm -rf "$keep"; cp -a "$REL/channel" "$keep"
  restore_channel() { rm -rf "$REL/channel/channels" "$REL/channel/releases"; cp -a "$keep/channels" "$keep/releases" "$REL/channel/"; }
  local good; good="$(iapi GET /status | json_get 'd["available"]')"
  err() { iapi GET /status | json_get 'd["check"]["error"]["code"] + "/" + str(d["check"]["error"].get("kind"))'; }

  sed -i 's/"summary":"[^"]*"/"summary":"tampered"/' "$ch"; check_now >/dev/null
  expect "변조된 채널 파일" channel_invalid/signature "$(err)"
  restore_channel

  jwrelease sign /work/channel/channels/stable.json --key /work/keys/other.pem >/dev/null; check_now >/dev/null
  expect "다른 키로 서명한 채널" channel_invalid/signature "$(err)"
  restore_channel

  jwrelease refresh --repo /work/channel --key /work/keys/release.pem --now 2020-01-01T00:00:00Z >/dev/null; check_now >/dev/null
  expect "만료된 채널 파일" channel_invalid/expired "$(err)"
  restore_channel

  # 순번 역행 — 새 순번을 한 번 받아들이게 한 뒤 옛 파일을 다시 내민다
  jwrelease refresh --repo /work/channel --key /work/keys/release.pem >/dev/null
  expect "새 순번은 받는다" update "$(check_now)"
  cp -a "$REL/channel" "$keep.newer"
  restore_channel; check_now >/dev/null
  expect "순번이 뒤로 간 채널 파일" channel_invalid/rollback "$(err)"
  rm -rf "$REL/channel/channels"; cp -a "$keep.newer/channels" "$REL/channel/"; rm -rf "$keep" "$keep.newer"; cp -a "$REL/channel" "$keep"

  printf ' ' >> "$REL/channel/releases/1.0.1/manifest.json"; check_now >/dev/null
  expect "변조된 manifest" manifest_invalid/hash "$(err)"
  restore_channel

  expect "실패한 확인은 마지막으로 성공한 결과를 지우지 않았다" "$good" "$(iapi GET /status | json_get 'd["available"]')"
  docker stop jw-e2e-channel >/dev/null; check_now >/dev/null
  expect "채널에 닿지 못함" channel_unreachable/None "$(err)"
  docker start jw-e2e-channel >/dev/null; sleep 1
  expect "되돌린 뒤 다시 정상" update "$(check_now)"
  rm -rf "$keep"
}

stage_u1() {
  say "U1 수동 업데이트 1.0.0 → 1.0.1"
  ws_login
  expect "업데이트 전 버전(/api/health)" 1.0.0 "$(health_version)"
  expect "업데이트 전 스키마" 1 "$(health_schema)"
  local t0 job
  # 화면이 쓰는 길(backend 대신 부르기)로 예고부터
  job="$(upd POST /apply '{"target":"1.0.1","start":"countdown"}' | json_get 'd["id"]')"
  note "작업 $job"
  expect "예고 상태" countdown "$(upd GET "/jobs/$job" | json_get 'd["status"]')"
  expect "예고 300초" 300 "$(upd GET "/jobs/$job" | json_get 'd["countdown"]["seconds"]')"
  expect "backend 가 예고를 받았다(update-notice)" countdown "$(ws_api GET /api/system/update-notice | json_get 'd["state"]')"
  expect "공개 점검 상태(nginx 경유) — 예고" countdown "$(ws_curl "$WS/maintenance/status" | json_get 'd["phase"]')"
  expect "예고 중 일반 API 는 그대로" 200 "$(ws_api_code GET '/api/files/list?path=my/')"
  expect "취소" cancelled "$(upd POST "/jobs/$job/action" '{"action":"cancel"}' | json_get 'd["status"]')"
  expect "취소가 backend 에 닿았다" none "$(ws_api GET /api/system/update-notice | json_get 'd["state"]')"

  job="$(upd POST /apply '{"target":"1.0.1","start":"countdown"}' | json_get 'd["id"]')"
  rm -f "$E2E_WORK/probe-saw-static-page"
  probe_start u1
  t0=$(date +%s)
  expect "지금 바로 시작" running "$(upd POST "/jobs/$job/action" '{"action":"start_now"}' | json_get 'd["status"]')"
  sleep 2
  expect "backend 가 점검을 받았다(update-notice)" maintenance "$(ws_api GET /api/system/update-notice | json_get 'd["state"]')"
  local maint; maint="$(ws_curl "$WS/maintenance/status")"
  expect "공개 점검 상태 — active" True "$(printf '%s' "$maint" | json_get 'd["active"]')"
  expect "공개 점검 상태의 항목(버전·단계 없음)" "active,contact,countdown_ends_at,expected_seconds,kind,phase,started_at" "$(printf '%s' "$maint" | json_get '",".join(sorted(d))')"
  expect "점검 중 일반 API 는 503" 503 "$(ws_api_code GET '/api/files/list?path=my/')"
  contains "503 본문과 Retry-After" 'retry-after: 30' "$(ws_curl -i -b "$UJAR" "$WS/api/files/list?path=my/" | tr 'A-Z' 'a-z' | tr -d '\r')"
  expect "점검 중 진행 조회는 된다" 200 "$(upd_code GET "/jobs/$job")"
  expect "점검 중 로그인 경로는 열려 있다" 200 "$(ws_code "$WS/api/health")"
  check "작업 끝" wait_ujob "$job" 1500
  local took=$(( $(date +%s) - t0 ))
  sleep 5
  probe_stop
  note "업데이트 한 번: ${took}초"
  expect "작업 상태" done "$(ujob "$job" 'd["status"]')"
  expect "단계" "preflight=done backup=done pull=done migrate=done switch=done verify=done" "$(ujob_steps "$job")"
  note "단계별 초: $(ujob "$job" '" ".join(s["id"]+"="+str(int((__import__("datetime").datetime.fromisoformat(s["finished_at"][:-1])-__import__("datetime").datetime.fromisoformat(s["started_at"][:-1])).total_seconds())) for s in d["steps"])')"
  # 이 릴리스에서 프런트 이미지가 그대로면 프런트는 내려가지 않는다 — 그때는 정적 점검 페이지가 나올 일이 없다
  if [ -f "$E2E_WORK/probe-saw-static-page" ]; then note "프런트가 내려간 동안 정적 점검 페이지가 나왔다"; else note "화면(/)은 끊기지 않았다 — 정적 점검 페이지는 아래에서 따로 본다"; fi
  expect "설치 관리자 자신도 바뀌었다(버전)" 1.0.1 "$(installer_version)"
  expect "설치 관리자 이미지" localhost/just-workspace-installer:1.0.1 "$(installer_image)"
  check "설치 관리자 8443 응답" installer_wait_up
  expect "옛 설치 관리자 컨테이너는 남지 않았다" "" "$(docker ps -aq --filter name=jw-installer-prev)"
  check "backend 준비" wait_ready ws-backend 120
  ws_login
  expect "업데이트 뒤 버전(/api/health)" 1.0.1 "$(health_version)"
  expect "업데이트 뒤 스키마(/api/health)" 2 "$(health_schema)"
  expect "검수용 변경 단계가 적용됐다" t "$(marker_table)"
  expect ".env 의 JW_VERSION" 1.0.1 "$(env_value JW_VERSION)"
  expect "점검이 끝났다(공개 점검 상태)" False "$(ws_curl "$WS/maintenance/status" | json_get 'd["active"]')"
  expect "backend 의 예고·점검도 지워졌다" none "$(ws_api GET /api/system/update-notice | json_get 'd["state"]')"
  expect "일반 API 복귀" 200 "$(ws_api_code GET '/api/files/list?path=my/')"
  check_data "U1 뒤"
  local st; st="$(upd GET /status)"
  expect "status.current" "1.0.1/1.0.0" "$(printf '%s' "$st" | json_get 'd["current"]["version"]+"/"+str(d["current"]["previous_version"])')"
  expect "받을 버전 없음" none "$(printf '%s' "$st" | json_get 'd["available"]["state"]')"
  local row; row="$(upd GET /history | json_get 'd["items"][0]')"
  expect "기록" "$job success manual 1.0.1 1.0.0 관리자" "$(printf '%s' "$row" | json_get '" ".join([d["id"],d["result"],d["trigger"],d["version"],d["from_version"],d["actor"]["name"]])')"
  note "기록의 걸린 시간·중단 시간: $(printf '%s' "$row" | json_get 'str(d["duration_seconds"])+"초 / "+str(d["downtime_seconds"])+"초"')"
  contains "기록 내려받기" "[verify] 완료" "$(ws_curl -b "$UJAR" "$WS$UPD/jobs/$job/log/download")"
  expect "복원 지점" "pre-update 1.0.0" "$(upd GET /restore-points | json_get 'd["points"][0]["kind"]+" "+d["points"][0]["version"]')"
  expect "적용된 버전의 변경 내용" "- 1.0.1-beta.1 검수용 릴리스" "$(upd GET /releases/1.0.1 | json_get 'd["changelog"]')"
  stage_page
}

# 정적 점검 페이지 — 프런트 컨테이너가 없을 때 nginx 가 직접 내준다. 설치 관리자의 내부 API 는 밖으로 열리지 않는다.
stage_page() {
  say "정적 점검 페이지와 공개 경로"
  docker stop ws-frontend-react >/dev/null
  local page i
  for i in $(seq 1 12); do page="$(ws_curl --max-time 10 -i "$WS/some/page")"; case "$page" in HTTP*503*) break ;; esac; sleep 2; done
  contains "프런트가 없으면 503 + 점검 페이지(요청한 주소 그대로)" "HTTP/2 503" "$(printf '%s' "$page" | head -1)"
  contains "점검 페이지는 공개 점검 상태를 묻는다" "/maintenance/status" "$page"
  expect "API 는 그대로다(점검 페이지로 바꾸지 않는다)" 200 "$(ws_code "$WS/api/health")"
  docker start ws-frontend-react >/dev/null; wait_ready ws-frontend-react 60
  for i in $(seq 1 30); do [ "$(ws_code "$WS/")" = 200 ] && break; sleep 1; done
  expect "프런트가 돌아오면 화면도 돌아온다" 200 "$(ws_code "$WS/")"
  expect "공개 점검 상태는 GET 만" 403 "$(ws_curl -o /dev/null -w '%{http_code}' -X POST "$WS/maintenance/status")"
  expect "설치 관리자의 다른 내부 경로는 밖에서 닿지 않는다(/internal/…)" 200 "$(ws_code "$WS/internal/update/status")"
  case "$(ws_curl "$WS/internal/update/status")" in *'"current"'*) bad "내부 API 가 밖으로 열렸다" ;; *) ok "그 주소는 화면(프런트)이 답한다 — 내부 API 가 아니다" ;; esac
  expect "키를 실어도 공개 경로는 점검 상태만 준다" "active,contact,countdown_ends_at,expected_seconds,kind,phase,started_at" \
    "$(ws_curl -H "X-JW-Installer-Key: $(env_value JW_INSTALLER_KEY)" "$WS/maintenance/status/../status" | json_get '",".join(sorted(d))')"
}

stage_u7() {
  say "U7 복원 지점으로 수동 복원"
  ws_login
  local from point job
  from="$(iapi GET /status | json_get 'd["current"]["version"]')"
  point="$(iapi GET /restore-points | json_get '[p["id"] for p in d["points"] if p["version"]=="1.0.0"][0]')"
  note "지금 $from, 복원 지점 $point"
  job="$(upd POST /restore "{\"point\":\"$point\",\"start\":\"now\"}" | json_get 'd["id"]')"
  check "복원 작업 끝" wait_ujob "$job" 1500
  expect "작업" "restore done" "$(ujob "$job" 'd["kind"]+" "+d["status"]')"
  expect "단계" "stop=done images=done restore_db=done start=done verify=done" "$(ujob_steps "$job")"
  check "backend 준비" wait_ready ws-backend 180
  ws_login
  expect "버전(/api/health)" 1.0.0 "$(health_version)"
  expect "스키마" 1 "$(health_schema)"
  expect "검수용 표는 사라졌다(DB 복원)" f "$(marker_table)"
  expect "설치 관리자도 1.0.0 으로" 1.0.0 "$(installer_version)"
  check_data "U7 뒤"
  expect "기록" "restore restored $from" "$(upd GET /history | json_get '" ".join([d["items"][0]["kind"],d["items"][0]["result"],d["items"][0]["from_version"]])')"
  expect "다시 받을 수 있다" update "$(check_now)"
}

stage_u2() {
  say "U2 pull 실패 → 되돌리기 / 다시 시도"
  ws_login
  check "레지스트리에서 backend 1.0.1 을 지운다(없는 다이제스트)" reg_delete backend 1.0.1-beta.1
  check "서버에서도 그 이미지를 지운다(파일로 보관)" reg_forget backend 1.0.1-beta.1 1.0.1
  local job rb
  job="$(apply_now 1.0.1)"
  check "작업이 멈춘다" wait_ujob "$job" 600
  expect "상태·단계·원인" "failed pull image_pull_failed backend" "$(ujob "$job" '" ".join([d["status"],d["error"]["step"],d["error"]["cause"],d["error"]["vars"]["image"]])')"
  expect "고를 수 있는 것" "retry,rollback" "$(ujob "$job" '",".join(d["choices"])')"
  expect "선택을 기다리는 동안 점검 유지" True "$(ws_curl "$WS/maintenance/status" | json_get 'd["active"]')"
  expect "되돌리기" "$job" "$(upd POST "/jobs/$job/action" '{"action":"rollback"}' | json_get 'd["id"]')"
  rb="$(ujob "$job" 'd["rollback_job"]')"
  check "되돌림 끝" wait_ujob "$job" 600
  expect "되돌림 작업" "rollback done" "$(ujob "$rb" 'd["kind"]+" "+d["status"]')"
  expect "바뀐 것이 없어 건너뛴 단계" "True True True" "$(ujob "$rb" '" ".join(str(s["detail"].get("skipped")) for s in d["steps"][:3])')"
  ws_login
  expect "버전 그대로" 1.0.0 "$(health_version)"
  expect "점검 끝" False "$(ws_curl "$WS/maintenance/status" | json_get 'd["active"]')"
  expect "기록" rolled_back "$(upd GET "/history/$job" | json_get 'd["result"]')"

  job="$(apply_now 1.0.1)"
  check "다시 멈춘다" wait_ujob "$job" 600
  expect "실패 단계" pull "$(ujob "$job" 'd["error"]["step"]')"
  check "이미지를 다시 올린다" reg_restore backend 1.0.1-beta.1
  expect "다시 시도" running "$(upd POST "/jobs/$job/action" '{"action":"retry"}' | json_get 'd["status"]')"
  check "작업 끝" wait_ujob "$job" 1500
  expect "작업 상태" done "$(ujob "$job" 'd["status"]')"
  check "backend 준비" wait_ready ws-backend 180
  ws_login
  expect "버전" 1.0.1 "$(health_version)"
  check_data "U2 뒤"
}

stage_u3() {
  say "U3 DB 변경 실패 → 자동 되돌림"
  if [ ! -f "$REL/manifests/1.0.2.json" ]; then
    check "1.0.2 이미지(둘째 변경 단계가 일부러 깨진다)" rel_build 1.0.2 broken3
    check "1.0.2 manifest" rel_manifest 1.0.2 3 --min-upgrade-from 1.0.1
    check "게시" rel_publish 1.0.2 stable
  fi
  ws_login
  expect "지금 버전" 1.0.1 "$(health_version)"
  expect "받을 버전" update "$(check_now)"
  local job rb
  probe_start u3
  job="$(apply_now 1.0.2)"
  check "작업 끝(되돌림까지)" wait_ujob "$job" 1500
  sleep 3; probe_stop
  expect "업데이트 작업" "failed migrate database_migrate_failed" "$(ujob "$job" '" ".join([d["status"],d["error"]["step"],d["error"]["cause"]])')"
  expect "선택지 없음(자동 되돌림)" "" "$(ujob "$job" '",".join(d["choices"])')"
  rb="$(ujob "$job" 'd["rollback_job"]')"
  expect "되돌림 작업" "rollback done 1.0.2 1.0.1" "$(ujob "$rb" '" ".join([d["kind"],d["status"],d["from_version"],d["target_version"]])')"
  expect "되돌림 단계" "stop=done images=done restore_db=done start=done verify=done" "$(ujob_steps "$rb")"
  expect "DB 복원은 건너뛰지 않았다" None "$(ujob "$rb" 'd["steps"][2]["detail"].get("skipped")')"
  note "깨진 단계의 원문: $(ujob "$job" 'd["error"]["detail"][-160:]')"
  check "backend 준비" wait_ready ws-backend 180
  ws_login
  expect "버전(/api/health)" 1.0.1 "$(health_version)"
  expect "스키마 원복(/api/health)" 2 "$(health_schema)"
  expect "DB 의 스키마 버전" 2 "$(db_schema)"
  expect "깨지기 전에 적용된 단계의 흔적도 없다" "2" "$(docker exec ws-postgres psql -U workspace -d workspace -Atc 'SELECT max(version) FROM schema_migrations')"
  expect ".env 의 JW_VERSION" 1.0.1 "$(env_value JW_VERSION)"
  expect "설치 관리자 버전" 1.0.1 "$(installer_version)"
  check_data "U3 뒤"
  expect "기록" "rolled_back 1.0.1" "$(upd GET "/history/$job" | json_get 'd["result"]+" "+d["version"]')"
  expect "점검 끝" False "$(ws_curl "$WS/maintenance/status" | json_get 'd["active"]')"
}

stage_r103() {
  [ -f "$REL/manifests/1.0.3.json" ] && return 0
  say "1.0.3 릴리스"
  check "1.0.3 이미지(변경 단계 둘)" rel_build 1.0.3 schema3
  check "1.0.3 manifest(1.0.1 이상에서만 바로)" rel_manifest 1.0.3 3 --min-upgrade-from 1.0.1
  check "게시" rel_publish 1.0.3 stable
  expect "받을 버전" update "$(check_now)"
}

stage_u5() {
  say "U5 중간 버전: 1.0.0 → 1.0.1 → 1.0.3"
  stage_r103
  ws_login
  if [ "$(health_version)" != 1.0.0 ]; then
    local point job
    point="$(iapi GET /restore-points | json_get '[p["id"] for p in d["points"] if p["version"]=="1.0.0"][0]')"
    job="$(upd POST /restore "{\"point\":\"$point\",\"start\":\"now\"}" | json_get 'd["id"]')"
    check "1.0.0 으로 복원" wait_ujob "$job" 1500
    wait_ready ws-backend 180; ws_login
  fi
  expect "출발 버전" 1.0.0 "$(health_version)"
  expect "받을 버전" update "$(check_now)"
  expect "경로" '["1.0.1", "1.0.3"]' "$(iapi GET /status | json_get 'd["available"]["path"]')"
  local job backups
  backups="$(iapi GET /restore-points | json_get 'len(d["points"])')"
  job="$(apply_now 1.0.3)"
  check "작업 끝" wait_ujob "$job" 2400
  expect "작업" "done 1" "$(ujob "$job" 'd["status"]+" "+str(d["version_index"])')"
  check "backend 준비" wait_ready ws-backend 180
  ws_login
  expect "버전" 1.0.3 "$(health_version)"
  expect "스키마" 3 "$(health_schema)"
  expect "설치 관리자 버전" 1.0.3 "$(installer_version)"
  expect "버전마다 기록" '["1.0.1", "1.0.3"]' "$(upd GET "/history/$job" | json_get '[v["version"] for v in d["versions"]]')"
  expect "버전마다 백업(복원 지점의 버전)" "1.0.1 1.0.0" "$(iapi GET /restore-points | json_get '" ".join(p["version"] for p in d["points"][:2])')"
  note "복원 지점 수: 전 $backups → 후 $(iapi GET /restore-points | json_get 'len(d["points"])') (pre-update 는 최근 3개만)"
  check_data "U5 뒤"
}

stage_u4() {
  say "U4 자동 업데이트"
  ws_login
  local base; base="$(health_version)"
  local now young
  now="$(date -u +%s)"
  # 공개 시각 = 지금부터 3일 전 + 4분 → 4분 뒤에 유예가 끝난다
  young="$(date -u -d "@$(( now - 3 * 86400 + 240 ))" +%Y-%m-%dT%H:%M:%SZ)"
  if [ ! -f "$REL/manifests/1.0.4.json" ]; then
    check "1.0.4 이미지" rel_build 1.0.4 schema3
    check "1.0.4 manifest(공개 시각 $young)" rel_manifest 1.0.4 3 --now "$young"
    check "게시" rel_publish 1.0.4 stable
  fi
  local hour next
  hour="$(date +%H)"; next="$(printf '%02d' $(( (10#$hour + 2) % 24 )))"
  local far1 far2
  far1="$(printf '%02d' $(( (10#$hour + 5) % 24 )))"; far2="$(printf '%02d' $(( (10#$hour + 6) % 24 )))"
  expect "자동 방식 + 지금을 포함한 시간대($hour:00~$next:00)" auto "$(upd PUT /settings "{\"mode\":\"auto\",\"window\":{\"start\":\"$hour:00\",\"end\":\"$next:00\"}}" | json_get 'd["settings"]["mode"]')"
  expect "받을 버전" update "$(check_now)"
  local eligible; eligible="$(iapi GET /status | json_get 'd["available"]["auto_eligible_at"]')"
  note "자동 적용 시작 가능 시각: $eligible (지금 $(date -u +%H:%M:%SZ))"
  sleep 75
  expect "유예 전 — 시간대 안이어도 시작하지 않는다" "" "$(active_job)"
  # 시간대 밖으로 옮기고 유예가 끝나기를 기다린다
  upd PUT /settings "{\"window\":{\"start\":\"$far1:00\",\"end\":\"$far2:00\"}}" >/dev/null
  local wait_s=$(( $(date -u -d "$eligible" +%s) - $(date -u +%s) + 70 ))
  [ "$wait_s" -gt 0 ] && { note "유예가 끝날 때까지 ${wait_s}초 기다린다"; sleep "$wait_s"; }
  expect "유예 뒤 — 시간대 밖이면 시작하지 않는다" "" "$(active_job)"

  # 실패하게 해 두고 시간대 안으로 → 예고가 열린다
  check "레지스트리에서 backend 1.0.4 를 지운다" reg_delete backend 1.0.4
  check "서버에서도 그 이미지를 지운다(파일로 보관)" reg_forget backend 1.0.4 1.0.4
  hour="$(date +%H)"; next="$(printf '%02d' $(( (10#$hour + 2) % 24 )))"
  upd PUT /settings "{\"window\":{\"start\":\"$hour:00\",\"end\":\"$next:00\"}}" >/dev/null
  local job="" i
  for i in $(seq 1 30); do job="$(active_job)"; [ -n "$job" ] && break; sleep 5; done
  expect "유예 뒤 + 시간대 안 — 자동으로 예고가 열린다" "auto countdown" "$(ujob "$job" 'd["trigger"]+" "+d["status"]')"
  expect "예고 300초(5분 전)" 300 "$(ujob "$job" 'd["countdown"]["seconds"]')"
  expect "backend 가 예고를 받았다" countdown "$(ws_api GET /api/system/update-notice | json_get 'd["state"]')"
  upd POST "/jobs/$job/action" '{"action":"start_now"}' >/dev/null
  check "작업 끝(자동 되돌림까지)" wait_ujob "$job" 900
  expect "자동은 migrate 전 실패도 선택 없이 되돌린다" "failed pull  done" "$(ujob "$job" 'd["status"]+" "+d["error"]["step"]+" "+",".join(d["choices"])')$( printf ' %s' "$(ujob "$(ujob "$job" 'd["rollback_job"]')" 'd["status"]')")"
  local st; st="$(upd GET /status)"
  expect "자동 업데이트 멈춤" "True pull 1.0.4" "$(printf '%s' "$st" | json_get 'str(d["auto"]["paused"])+" "+d["auto"]["reason"]["step"]+" "+d["auto"]["reason"]["version"]')"
  expect "last_auto" "rolled_back pull" "$(printf '%s' "$st" | json_get 'd["last_auto"]["result"]+" "+d["last_auto"]["failed_step"]')"
  ws_login
  contains "관리자 알림 한 건" "자동 업데이트가 실패" "$(ws_api GET '/api/notifications?limit=5')"
  check "이미지를 다시 올린다" reg_restore backend 1.0.4
  sleep 130
  expect "멈춰 있는 동안에는 다시 시도하지 않는다" "" "$(active_job)"
  expect "다시 켜기" False "$(upd POST /auto/resume '{}' | json_get 'd["auto"]["paused"]')"
  job=""
  for i in $(seq 1 30); do job="$(active_job)"; [ -n "$job" ] && break; sleep 5; done
  expect "다시 켠 뒤 다음 확인에서 예고" "auto countdown" "$(ujob "$job" 'd["trigger"]+" "+d["status"]')"
  upd POST "/jobs/$job/action" '{"action":"start_now"}' >/dev/null
  check "작업 끝" wait_ujob "$job" 1500
  expect "작업" done "$(ujob "$job" 'd["status"]')"
  check "backend 준비" wait_ready ws-backend 180
  ws_login
  expect "버전" 1.0.4 "$(health_version)"
  expect "last_auto" "success 1.0.4 $base" "$(upd GET /status | json_get 'd["last_auto"]["result"]+" "+d["last_auto"]["version"]+" "+d["last_auto"]["from_version"]')"
  expect "기록의 실행자는 없다(자동)" None "$(upd GET /history | json_get 'd["items"][0]["actor"]')"
  upd PUT /settings '{"mode":"manual","window":{"start":"03:00","end":"05:00"}}' >/dev/null
  check_data "U4 뒤"
}

stage_u6() {
  say "U6 Beta 채널 → Stable 복귀"
  ws_login
  local base; base="$(health_version)"
  if [ ! -f "$REL/manifests/1.1.0-beta.1.json" ]; then
    check "1.1.0-beta.1 이미지" rel_build 1.1.0-beta.1 schema3
    check "manifest" rel_manifest 1.1.0-beta.1 3
    check "Beta 로만 게시" rel_publish 1.1.0-beta.1 beta
  fi
  expect "stable 채널에서는 보이지 않는다" none "$(check_now)"
  expect "채널을 beta 로" to_beta "$(upd PUT /settings '{"channel":"beta"}' | json_get 'd["effect"]["channel"]')"
  expect "beta 채널의 받을 버전" "1.1.0-beta.1 beta" "$(check_now >/dev/null; iapi GET /status | json_get 'd["available"]["version"]+" "+d["available"]["channel"]')"
  local job
  job="$(apply_now 1.1.0-beta.1)"
  check "작업 끝" wait_ujob "$job" 1500
  check "backend 준비" wait_ready ws-backend 180
  ws_login
  expect "버전" 1.1.0-beta.1 "$(health_version)"
  expect "status.current.channel" beta "$(upd GET /status | json_get 'd["current"]["channel"]')"
  expect "시험판 이전 백업이 따로 보관됐다" "pre-beta $base" "$(upd GET /settings | json_get 'd["beta"]["restore_point"]["kind"]+" "+d["beta"]["restore_point"]["version"]')"
  local msg="during-beta-$(date +%s)"
  . "$E2E_WORK/seed.env"
  ws_api POST "/api/chat/channels/$SEED_CH/messages" "{\"content\":\"$msg\"}" >/dev/null
  local reply; reply="$(upd PUT /settings '{"channel":"stable","stable_return":"wait"}')"
  expect "Stable 로 — 기다리기" "to_stable_wait $base 1.1.0" "$(printf '%s' "$reply" | json_get 'd["effect"]["channel"]+" "+d["effect"]["wait"]["channel_latest"]+" "+d["effect"]["wait"]["resume_from"]')"
  expect "available = wait" wait "$(upd GET /status | json_get 'd["available"]["state"]')"
  expect "기다리는 동안 적용은 안 된다" not_available "$(upd POST /apply '{"target":"1.0.4","start":"now"}' | json_get 'd["code"]')"
  upd PUT /settings '{"channel":"beta"}' >/dev/null
  reply="$(upd PUT /settings '{"channel":"stable","stable_return":"restore"}')"
  job="$(printf '%s' "$reply" | json_get 'd["effect"]["job"]["id"]')"
  expect "시험판 이전 상태로 복원 — 예고부터" "to_stable_restore restore countdown beta" "$(printf '%s' "$reply" | json_get '" ".join([d["effect"]["channel"],d["effect"]["job"]["kind"],d["effect"]["job"]["status"],d["effect"]["job"]["restore"]["reason"]])')"
  upd POST "/jobs/$job/action" '{"action":"start_now"}' >/dev/null
  check "복원 끝" wait_ujob "$job" 1500
  expect "작업" done "$(ujob "$job" 'd["status"]')"
  check "backend 준비" wait_ready ws-backend 180
  ws_login
  expect "버전" "$base" "$(health_version)"
  expect "채널은 stable 이 됐다" "stable None" "$(upd GET /settings | json_get 'd["channel"]+" "+str(d["beta"]["restore_point"])')"
  check_data "U6 뒤"
  case "$(ws_api GET "/api/chat/channels/$SEED_CH/messages")" in
    *"$msg"*) bad "시험판에서 쓴 메시지가 남아 있다(복원이 안 됐다)" ;;
    *) ok "시험판에서 쓴 메시지는 없다(이전 상태로 돌아갔다)" ;;
  esac
  expect "설치 관리자 버전" "$base" "$(installer_version)"
}

stage_u8() {
  say "U8 오프라인"
  ws_login
  local base; base="$(health_version)"
  local stage="$REL/stage-1.0.5" bundle="$REL/just-workspace-1.0.5-offline.tar"
  if [ ! -f "$bundle" ]; then
    # 이 릴리스는 캐시(redis) 이미지가 올라갔다 — 서버에 없는 "추가 이미지"가 하나 생긴다
    local other; other="$(other_redis)"
    note "1.0.5 의 redis: ${other:-(다른 판을 받지 못했다)}"
    E2E_REDIS_REF="$other" check "1.0.5 이미지" rel_build 1.0.5 schema3
    check "1.0.5 manifest" rel_manifest 1.0.5 3
    rm -rf "$stage"; mkdir -p "$stage/images"
    cp "$REL/manifests/1.0.5.json" "$stage/manifest.json"
    check "manifest 서명" jwrelease sign /work/stage-1.0.5/manifest.json --key /work/keys/release.pem
    note "이미지를 파일로 저장한다(bundle plan 이 낸 명령)"
    jwrelease bundle plan --manifest /work/stage-1.0.5/manifest.json --stage "$stage" | grep -E '^ *docker ' > "$REL/bundle-plan.sh"
    check "docker pull·tag·save" bash -c "[ -s '$REL/bundle-plan.sh' ] && bash -e '$REL/bundle-plan.sh'"
    check "색인 + 서명" jwrelease bundle index --stage /work/stage-1.0.5 --key /work/keys/release.pem
    check "묶기" jwrelease bundle pack --stage /work/stage-1.0.5 -o /work/just-workspace-1.0.5-offline.tar
    check "묶음 검증(도구)" jwrelease bundle verify /work/just-workspace-1.0.5-offline.tar --pubkey /work/keys/release.pub
    rm -rf "$stage/images"
  fi
  note "묶음 크기: $(du -h "$bundle" | cut -f1)"
  # 추가 이미지 하나를 파일로 받아 둔다(인터넷이 되는 PC 에서 하는 일) — 캐시(redis)
  local redis_ref redis_tag
  redis_ref="$(json_get 'd["third_party"]["core"]["redis"]' < "$REL/manifests/1.0.5.json")"
  redis_tag="${redis_ref%@*}:jw-$(printf '%s' "${redis_ref#*sha256:}" | cut -c1-12)"
  # 화면이 알려 주는 명령 그대로(docker pull … && docker tag … && docker save …)
  check "redis 를 파일로 저장" bash -c "cd '$REL' && docker pull -q '$redis_ref' >/dev/null && docker tag '$redis_ref' '$redis_tag' && docker save '$redis_tag' -o redis.tar"
  docker save alpine:latest -o "$REL/wrong.tar"

  say "레지스트리·채널을 끊는다"
  docker stop jw-e2e-registry jw-e2e-channel >/dev/null
  check_now >/dev/null
  expect "온라인 확인은 실패한다" channel_unreachable "$(iapi GET /status | json_get 'd["check"]["error"]["code"]')"
  # 새 버전의 우리 이미지와 redis 를 서버에서 지운다(묶음·파일에서 들어와야 한다)
  docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E ':1\.0\.5$' | xargs -r docker image rm >/dev/null 2>&1
  python3 -c 'import json,sys; [print(v) for v in json.load(open(sys.argv[1]))["images"].values()]' "$REL/manifests/1.0.5.json" | xargs -r docker image rm >/dev/null 2>&1

  say "거부되는 묶음"
  sudo mkdir -p "$E2E_HOST_DIR/offline"
  # 낮은 버전 — 가짜 이미지 파일로 만든 작은 묶음(서명은 진짜)
  local low="$REL/stage-low"
  rm -rf "$low"; mkdir -p "$low/images"
  cp "$REL/channel/releases/1.0.0/manifest.json" "$REL/channel/releases/1.0.0/manifest.json.sig" "$low/"
  python3 -c 'import json,sys; [open(sys.argv[2]+"/images/"+n+".tar","w").write(n) for n in json.load(open(sys.argv[1]))["images"]]' "$low/manifest.json" "$low"
  jwrelease bundle index --stage /work/stage-low --key /work/keys/release.pem >/dev/null
  jwrelease bundle pack --stage /work/stage-low -o /work/low.tar >/dev/null
  sudo cp "$REL/low.tar" "$E2E_HOST_DIR/offline/low.tar"
  offline_path() { upd POST /offline/bundle-path "{\"path\":\"$1\"}" >/dev/null; local i; for i in $(seq 1 120); do case "$(upd GET /offline | json_get 'd["bundle"]["state"]')" in uploading|verifying) sleep 2 ;; *) break ;; esac; done; upd GET /offline | json_get 'd["bundle"]["state"]+" "+str((d["bundle"]["error"] or {}).get("code"))'; }
  expect "낮은 버전" "version_too_low version_too_low" "$(offline_path /data/offline/low.tar)"
  # 다른 키로 서명한 묶음
  jwrelease bundle index --stage /work/stage-low --key /work/keys/other.pem >/dev/null
  jwrelease bundle pack --stage /work/stage-low -o /work/otherkey.tar >/dev/null
  sudo cp "$REL/otherkey.tar" "$E2E_HOST_DIR/offline/otherkey.tar"
  expect "서명 불일치" "signature_mismatch signature" "$(offline_path /data/offline/otherkey.tar)"
  expect "없는 파일" "file_missing None" "$(offline_path /data/offline/nope.tar)"
  # 해시 불일치 — 진짜 묶음의 이미지 부분 한 바이트를 바꾼다(끝에서 4KB 앞)
  sudo cp --reflink=auto "$bundle" "$E2E_HOST_DIR/offline/tampered.tar"
  local size; size="$(stat -c %s "$bundle")"
  printf '\377' | sudo dd of="$E2E_HOST_DIR/offline/tampered.tar" bs=1 seek=$(( size - 20000 )) conv=notrunc 2>/dev/null
  expect "해시 불일치" "invalid invalid" "$(offline_path /data/offline/tampered.tar)"
  sudo rm -f "$E2E_HOST_DIR/offline/tampered.tar"
  expect "거부된 묶음으로는 적용할 수 없다" offline_incomplete "$(upd POST /offline/apply '{"start":"now"}' | json_get 'd["code"]')"

  say "묶음 올리기(화면이 쓰는 길 — nginx → backend → 설치 관리자, 스트리밍)"
  ( sleep 4; upd GET /offline | json_get '"올리는 중: "+d["bundle"]["state"]+" "+str(d["bundle"]["percent"])+"%"' > "$E2E_WORK/upload-progress.txt" ) &
  local t0=$(date +%s)
  expect "올리기 응답" 202 "$(ws_curl --max-time 3600 -b "$UJAR" -H "Origin: $WS" -H 'Content-Type: application/octet-stream' \
    -H "X-JW-Filename: just-workspace-1.0.5-offline.tar" -o "$E2E_WORK/upload.out" -w '%{http_code}' -T "$bundle" -X POST "$WS$UPD/offline/bundle")"
  wait
  note "$(cat "$E2E_WORK/upload-progress.txt" 2>/dev/null) · 올리는 데 $(( $(date +%s) - t0 ))초"
  local i
  for i in $(seq 1 200); do case "$(upd GET /offline | json_get 'd["bundle"]["state"]')" in uploading|verifying) sleep 3 ;; *) break ;; esac; done
  local view; view="$(upd GET /offline)"
  expect "검증 결과" "verified 1.0.5 $base upload" "$(printf '%s' "$view" | json_get '" ".join([d["bundle"]["state"],d["bundle"]["version"],d["bundle"]["current_version"],d["bundle"]["source"]])')"
  note "추가 이미지: $(printf '%s' "$view" | json_get '" ".join(i["id"]+"="+i["state"] for i in d["images"])')"
  expect "꺼진 구역의 것은 필요 없음" not_needed "$(printf '%s' "$view" | json_get '[i["state"] for i in d["images"] if i["id"]=="gitea"][0]')"
  note "받는 명령(redis): $(printf '%s' "$view" | json_get '[i["command"] for i in d["images"] if i["id"]=="redis"][0]')"

  say "추가 이미지 — 없는 것으로 만들고 파일로 들인다"
  docker image rm "$redis_tag" "$redis_ref" "${redis_ref%@*}" >/dev/null 2>&1
  docker image ls --digests --format '{{.Repository}}@{{.Digest}} {{.ID}}' | awk -v d="redis@${redis_ref#*@}" '$1 == d {print $2}' | xargs -r docker image rm >/dev/null 2>&1
  expect "redis 가 없다" "missing images_missing" "$(upd GET /offline | json_get '[i["state"] for i in d["images"] if i["id"]=="redis"][0]+" "+",".join(d["blockers"])')"
  expect "빠진 채로는 적용할 수 없다" offline_incomplete "$(upd POST /offline/apply '{"start":"now"}' | json_get 'd["code"]')"
  upload_image() { ws_curl --max-time 600 -b "$UJAR" -H "Origin: $WS" -H 'Content-Type: application/octet-stream' -H "X-JW-Filename: $2" -o /dev/null -w '%{http_code}' -T "$1" -X POST "$WS$UPD/offline/images/redis"; }
  wait_image() { local i; for i in $(seq 1 60); do [ "$(upd GET /offline | json_get '[i["state"] for i in d["images"] if i["id"]=="redis"][0]')" = verifying ] || break; sleep 2; done; upd GET /offline | json_get '[i["state"] for i in d["images"] if i["id"]=="redis"][0]'; }
  expect "엉뚱한 파일 올리기" 202 "$(upload_image "$REL/wrong.tar" wrong.tar)"
  expect "→ 불일치" hash_mismatch "$(wait_image)"
  expect "맞는 파일 올리기" 202 "$(upload_image "$REL/redis.tar" redis.tar)"
  expect "→ 있음" present "$(wait_image)"
  expect "전부 갖춰졌다" "True " "$(upd GET /offline | json_get 'str(d["ready"])+" "+",".join(d["blockers"])')"

  say "적용"
  local job
  job="$(upd POST /offline/apply '{"start":"now"}' | json_get 'd["id"]')"
  check "작업 끝" wait_ujob "$job" 2400
  expect "작업" "done offline" "$(ujob "$job" 'd["status"]+" "+d["trigger"]')"
  note "pull 단계의 이미지: $(ujob "$job" '" ".join(i["name"]+"="+i["status"] for i in d["steps"][2]["detail"]["images"])')"
  check "backend 준비" wait_ready ws-backend 180
  ws_login
  expect "버전" 1.0.5 "$(health_version)"
  expect "설치 관리자 버전" 1.0.5 "$(installer_version)"
  expect "적용한 준비물은 치워졌다" None "$(upd GET /offline | json_get 'd["bundle"]')"
  expect "레지스트리는 여전히 꺼져 있다" "" "$(docker ps -q --filter name=jw-e2e-registry)"
  check_data "U8 뒤"
  docker start jw-e2e-registry jw-e2e-channel >/dev/null
}

stage_down() { rel_env_down; }

[ $# -gt 0 ] || { sed -n '2,15p' "$0"; exit 2; }
for stage in "$@"; do
  type "stage_$stage" >/dev/null 2>&1 || { echo "모르는 단계: $stage" >&2; exit 2; }
  "stage_$stage"
done
finish
