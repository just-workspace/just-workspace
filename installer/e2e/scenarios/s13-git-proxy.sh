#!/usr/bin/env bash
# S13 프런트 프록시 하단 + 코드 저장소 — Gitea 가 생성하는 절대 주소(페이지의 복제 주소, API 의 html_url·clone_url,
# 릴리스 첨부의 browser_download_url)가 프런트 프록시가 전달한 스킴(https)을 따르는지 확인한다.
# 프록시 하단 구성에서 nginx 의 $scheme 은 내부 구간의 http 이다. 이 서버에서 송신한 요청이 프런트 프록시 역할을 한다
# (X-Forwarded-Proto: https 를 직접 지정해 80 으로 요청한다).
. "$(dirname "$0")/../lib.sh"

e2e_reset
check "설치 관리자 기동" installer_start
install file "$E2E_ROOT/answers/proxy-git.json" || { step_seconds; finish; }
step_seconds
check_core
check "컨테이너 ws-gitea 준비" wait_ready ws-gitea 180
expect "DEPLOY_MODE" external_proxy "$(env_value DEPLOY_MODE)"

as_proxy() { curl -s --max-time 30 -H "Host: $E2E_DOMAIN" -H "X-Forwarded-Proto: ${PROTO:-https}" "$@"; }
TOKEN="$(env_value GITEA_TOKEN)"
check "관리 토큰" test -n "$TOKEN"
gapi() { as_proxy -H "Authorization: token $TOKEN" -H 'Content-Type: application/json' "$@"; }
G="http://$E2E_ADDR/git/api/v1"

say "저장소·릴리스·첨부 만들기(Gitea API — nginx 80 경유)"
owner="$(gapi "$G/user" | json_get 'd["login"]')"
expect "토큰의 계정" jw-admin "$owner"
gapi -X POST "$G/user/repos" -d '{"name":"e2e-proto","auto_init":true,"private":false}' -o /dev/null
rel="$(gapi -X POST "$G/repos/$owner/e2e-proto/releases" -d '{"tag_name":"v1.0.0","name":"v1.0.0","target_commitish":"main"}' | json_get 'd["id"]')"
check "릴리스 id" test -n "$rel"
printf 'e2e attachment\n' > "$E2E_WORK/asset.txt"
as_proxy -H "Authorization: token $TOKEN" -F "attachment=@$E2E_WORK/asset.txt" "$G/repos/$owner/e2e-proto/releases/$rel/assets?name=asset.txt" -o /dev/null

say "X-Forwarded-Proto: https — 절대 주소는 https"
repo="$(gapi "$G/repos/$owner/e2e-proto")"
expect "html_url" "https://$E2E_DOMAIN/git/$owner/e2e-proto" "$(printf '%s' "$repo" | json_get 'd["html_url"]')"
expect "clone_url" "https://$E2E_DOMAIN/git/$owner/e2e-proto.git" "$(printf '%s' "$repo" | json_get 'd["clone_url"]')"
release="$(gapi "$G/repos/$owner/e2e-proto/releases/$rel")"
contains "browser_download_url 은 https" "https://$E2E_DOMAIN/git/" "$(printf '%s' "$release" | json_get 'd["assets"][0]["browser_download_url"]')"
contains "zipball_url 은 https" "https://$E2E_DOMAIN/git/" "$(printf '%s' "$release" | json_get 'd["zipball_url"]')"
page="$(as_proxy "http://$E2E_ADDR/git/$owner/e2e-proto")"
contains "저장소 페이지의 복제 주소는 https" "https://$E2E_DOMAIN/git/$owner/e2e-proto.git" "$page"
check "저장소 페이지에 http 절대 주소가 없다" bash -c "! printf '%s' \"\$1\" | grep -q 'http://$E2E_DOMAIN/git/'" _ "$page"
note "릴리스 첨부: $(printf '%s' "$release" | json_get 'd["assets"][0]["browser_download_url"]')"

# 대조(판정 없음): 프런트 프록시가 http 를 전달한 경우 — 요청 기반으로 생성되는 주소가 전달값을 따르는지 기록한다
PROTO=http
note "대조 — X-Forwarded-Proto: http 일 때 browser_download_url: $(gapi "$G/repos/$owner/e2e-proto/releases/$rel" | json_get 'd["assets"][0]["browser_download_url"]')"
unset PROTO
finish
