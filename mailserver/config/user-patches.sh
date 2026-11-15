#!/bin/bash
# DMS user-patches.sh — runs AFTER all DMS setup scripts
# PERMIT_DOCKER=none clears mynetworks entirely; restore localhost only
postconf "mynetworks = 127.0.0.0/8 [::1]/128"

# 외부 메일앱(삼성 메일 등)이 Message-ID/Date를 안 붙이고 submission하면 그대로 나가
# 수신측에서 MISSING_MID로 스팸점수↑ → postfix가 누락 헤더 자동 보강(submission 표준).
postconf "always_add_missing_headers = yes"

# ── Docker Desktop SNAT 대응: policyd-spf 오거부 방지 ──
# Docker Desktop(Windows)은 인바운드 소스IP를 게이트웨이(172.28.0.1)로 SNAT한다.
# 그 결과 모든 외부 수신메일의 client-ip가 172.28.0.1로 보여, policyd-spf가 발신도메인
# SPF를 172.28.0.1 기준으로 검사 → MS365 등 '-all'(hardfail) 도메인 메일이 오거부됨
# (예: MS365 도메인 답장이 550 SPF fail로 반송). 실IP를 못 보니 SPF 판정 무의미 →
# 도커 사설대역을 skip_addresses에 추가해 SPF 검사를 건너뛴다(스팸 판정은 rspamd가 계속).
SPF_CONF=/etc/postfix-policyd-spf-python/policyd-spf.conf
if [ -f "$SPF_CONF" ]; then
  if grep -q '^skip_addresses' "$SPF_CONF"; then
    grep -q '172.16.0.0/12' "$SPF_CONF" || sed -i 's#^skip_addresses.*#&,172.16.0.0/12#' "$SPF_CONF"
  else
    echo 'skip_addresses = 127.0.0.0/8,::ffff:127.0.0.0/104,::1,172.16.0.0/12' >> "$SPF_CONF"
  fi
fi

# ── 워크스페이스 비밀번호가 곧 메일 비밀번호 ──
#
# dovecot 이 로그인마다 백엔드에 물어본다. 비밀번호가 한 곳에만 있으므로
# 동기화할 대상이 없다. 스크립트 본문은 auth-workspace.lua 에 있다 —
# 여기에 heredoc 으로 끼워 넣으면 lua 의 이스케이프가 쉘을 지나며 깨진다.
#
# SQL passdb 로 postgres 를 직접 읽는 길은 막혀 있다: docker-mailserver v16
# 이미지에 dovecot 의 pgsql 드라이버가 없다(dovecot-auth-lua, dovecot-ldap 만).
LUA_SRC=/tmp/docker-mailserver/auth-workspace.lua
if [ -n "${INTERNAL_API_KEY:-}" ] && [ -f "$LUA_SRC" ]; then
  sed "s|__INTERNAL_KEY__|${INTERNAL_API_KEY}|" "$LUA_SRC" > /etc/dovecot/auth-workspace.lua
  chmod 600 /etc/dovecot/auth-workspace.lua

  cat > /etc/dovecot/conf.d/auth-workspace.conf.ext <<'EOF'
passdb lua {
  lua_file = /etc/dovecot/auth-workspace.lua
  result_failure      = continue
  result_internalfail = continue
}
EOF

  # include 순서가 곧 passdb 순서다. 워크스페이스 비밀번호를 먼저 본다.
  if ! grep -q 'auth-workspace.conf.ext' /etc/dovecot/conf.d/10-auth.conf; then
    sed -i '1i !include auth-workspace.conf.ext' /etc/dovecot/conf.d/10-auth.conf
  fi
fi

# ── rspamd local.d 추가 파일 ──
# DMS 는 rspamd/override.d 만 복사해 준다. local.d(기본 설정과 병합)에 둘 파일이 있으면 여기서 옮긴다.
if [ -d /tmp/docker-mailserver/rspamd/local.d ]; then
  for f in /tmp/docker-mailserver/rspamd/local.d/*; do
    if [ -f "$f" ]; then cp "$f" /etc/rspamd/local.d/; fi
  done
fi

# ── 사이트 전용 패치 ──
# 게이트웨이 경유 수신 같은 이 설치만의 조정은 user-patches.d/*.sh 에 둔다(코어 리포에 없음).
for p in /tmp/docker-mailserver/user-patches.d/*.sh; do
  if [ -f "$p" ]; then . "$p"; fi
done
