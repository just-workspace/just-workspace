"""IMAP 993 으로 로그인해 편지함을 본다 — 검수 서버 안에서 돈다(표준 라이브러리만).

    imap-check.py <주소> <계정> <비밀번호 파일> login            로그인만
    imap-check.py <주소> <계정> <비밀번호 파일> find <제목>      제목으로 찾아 머리말 요약을 찍는다(없으면 종료 코드 1)
"""
import imaplib
import ssl
import sys

host, user, passfile, action = sys.argv[1:5]
m = imaplib.IMAP4_SSL(host, 993, ssl_context=ssl._create_unverified_context(), timeout=20)
m.login(user, open(passfile, encoding="utf-8").read().strip())
m.select("INBOX")
if action == "find":
    typ, data = m.search(None, "SUBJECT", '"%s"' % sys.argv[5])
    ids = data[0].split()
    if not ids:
        sys.exit(1)
    typ, d = m.fetch(ids[-1], "(BODY.PEEK[HEADER])")
    for line in d[0][1].decode(errors="replace").splitlines():
        if line.lower().startswith(("dkim-signature:", "from:", "to:")):
            print(line[:160])
m.logout()
