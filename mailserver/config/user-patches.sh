#!/bin/bash
# DMS user-patches.sh — runs AFTER all DMS setup scripts
# PERMIT_DOCKER=none clears mynetworks entirely; restore localhost only
postconf "mynetworks = 127.0.0.0/8 [::1]/128"

# 외부 메일 앱(삼성 메일 등)이 Message-ID/Date 없이 submission 하면 그대로 발송되어
# 수신 측에서 MISSING_MID 로 스팸 점수가 상승한다 → postfix 가 누락 헤더를 자동 보강(submission 표준).
postconf "always_add_missing_headers = yes"

# ── Docker Desktop SNAT 대응: policyd-spf 오거부 방지 ──
# Docker Desktop(Windows)은 인바운드 소스 IP 를 게이트웨이(172.28.0.1)로 SNAT 한다.
# 그 결과 모든 외부 수신 메일의 client-ip 가 172.28.0.1 로 표시되어, policyd-spf 가 발신 도메인
# SPF 를 172.28.0.1 기준으로 검사 → MS365 등 '-all'(hardfail) 도메인 메일이 오거부된다
# (예: MS365 도메인 답장이 550 SPF fail 로 반송). 실제 IP 를 확인할 수 없어 SPF 판정이 무의미하므로
# 도커 사설 대역을 skip_addresses 에 추가해 SPF 검사를 생략한다(스팸 판정은 rspamd 가 계속 수행).
SPF_CONF=/etc/postfix-policyd-spf-python/policyd-spf.conf
if [ -f "$SPF_CONF" ]; then
  if grep -q '^skip_addresses' "$SPF_CONF"; then
    grep -q '172.16.0.0/12' "$SPF_CONF" || sed -i 's#^skip_addresses.*#&,172.16.0.0/12#' "$SPF_CONF"
  else
    echo 'skip_addresses = 127.0.0.0/8,::ffff:127.0.0.0/104,::1,172.16.0.0/12' >> "$SPF_CONF"
  fi
fi

# ── 워크스페이스 비밀번호를 메일 비밀번호로 사용 ──
#
# dovecot 이 로그인마다 백엔드에 검증을 요청한다. 비밀번호가 한 곳에만 존재하므로
# 동기화 대상이 없다. 스크립트 본문은 auth-workspace.lua 에 있다 —
# 여기에 heredoc 으로 삽입하면 lua 의 이스케이프가 셸을 거치며 손상된다.
#
# SQL passdb 로 postgres 를 직접 조회하는 방식은 불가하다: docker-mailserver v16
# 이미지에 dovecot 의 pgsql 드라이버가 없다(dovecot-auth-lua, dovecot-ldap 만 포함).
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

  # include 순서가 passdb 순서와 동일하다. 워크스페이스 비밀번호를 먼저 검사한다.
  if ! grep -q 'auth-workspace.conf.ext' /etc/dovecot/conf.d/10-auth.conf; then
    sed -i '1i !include auth-workspace.conf.ext' /etc/dovecot/conf.d/10-auth.conf
  fi
fi

# ── rspamd local.d 추가 파일 ──
# DMS 는 rspamd/override.d 만 복사한다. local.d(기본 설정과 병합)에 둘 파일이 있으면 여기서 배치한다.
if [ -d /tmp/docker-mailserver/rspamd/local.d ]; then
  for f in /tmp/docker-mailserver/rspamd/local.d/*; do
    if [ -f "$f" ]; then cp "$f" /etc/rspamd/local.d/; fi
  done
fi

# ── 사이트 전용 패치 ──
# 게이트웨이 경유 수신 등 해당 설치 고유의 조정은 user-patches.d/*.sh 에 둔다(코어 리포에 없음).
for p in /tmp/docker-mailserver/user-patches.d/*.sh; do
  if [ -f "$p" ]; then . "$p"; fi
done
