# 설치 관리자가 만든 파일입니다 — 손으로 고치지 마세요(다음 적용 때 덮어씁니다).
# 서명 키를 rspamd 만 읽을 수 있는 자리로 옮긴다(스택 폴더의 원본은 root 만 읽는다).
install -d -o _rspamd -g _rspamd -m 750 /etc/rspamd/jw-dkim
install -o _rspamd -g _rspamd -m 600 /tmp/docker-mailserver/rspamd/dkim/default.private /etc/rspamd/jw-dkim/default.private
