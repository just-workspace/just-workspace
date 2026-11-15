#!/bin/sh
# LOKI_PUSH_ALLOW(쉼표·공백 구분 IP/CIDR 여러 개) → /etc/nginx/push-allow.inc 의 allow 줄.
# nginx 의 allow 는 한 줄에 주소 하나라 envsubst 템플릿만으로는 목록을 못 받는다.
# IP/CIDR 모양이 아닌 값은 버린다(설정 주입 방지). 남는 게 없으면 127.0.0.1 = 사실상 닫힘.
set -eu
out=/etc/nginx/push-allow.inc
: > "$out"
for a in $(printf '%s' "${LOKI_PUSH_ALLOW:-127.0.0.1}" | tr ',' ' '); do
  if printf '%s' "$a" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$'; then
    echo "allow $a;" >> "$out"
  else
    echo "10-push-allow: 무시한 값 '$a' (IP/CIDR 아님)" >&2
  fi
done
[ -s "$out" ] || echo "allow 127.0.0.1;" > "$out"
echo "10-push-allow: $(tr '\n' ' ' < "$out")"
