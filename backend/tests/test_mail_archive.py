"""외부 메일 아카이브 — 경로 규칙·안전한 파일명·예외 무해성."""

import email
import pytest
from email.message import EmailMessage
from pathlib import Path

from app.mail import archive


def test_safe_name_strips_path_and_control_chars():
    """제목이 파일명이 되므로 경로 탈출이 막혀야 한다."""
    assert "/" not in archive._safe_name("a/b/../../etc/passwd")
    assert "\\" not in archive._safe_name(r"a\b")
    assert archive._safe_name("") == "제목없음"
    assert archive._safe_name("  ") == "제목없음"
    # 제어문자
    assert "\x00" not in archive._safe_name("a\x00b")
    # 길이 상한
    assert len(archive._safe_name("가" * 300)) <= 80


def test_eml_path_groups_by_month():
    p = archive.eml_path("u1", "me@gmail.com", "42", "안녕", "2026-03-07T10:00:00+00:00")
    assert p.name == "42_안녕.eml"
    assert p.parent.name == "2026-03"
    assert p.parent.parent.name == "me@gmail.com"


def test_eml_path_falls_back_when_date_unparseable():
    """날짜가 깨져도 저장은 돼야 한다 — 안 그러면 그 메일만 조용히 유실된다."""
    p = archive.eml_path("u1", "me@gmail.com", "7", "제목", "not-a-date")
    assert p.name == "7_제목.eml"
    assert len(p.parent.name) == 7 and p.parent.name[4] == "-"


@pytest.mark.asyncio
async def test_archive_skipped_when_disabled():
    class Acct:
        archive_enabled = False
        user_id = "u1"
        email = "me@gmail.com"

    assert await archive.archive_message(Acct(), "1", "s", None) is None


def test_save_attachments_writes_files_and_keeps_extension(tmp_path: Path):
    msg = EmailMessage()
    msg["From"] = "a@b.com"
    msg["Subject"] = "보고서"
    msg.set_content("본문")
    msg.add_attachment(b"%PDF-1.4 fake", maintype="application", subtype="pdf",
                       filename="1분기 보고서.pdf")

    n = archive._save_attachments(msg.as_bytes(), tmp_path, "99")
    assert n == 1
    files = list((tmp_path / archive.ATTACH_DIRNAME).iterdir())
    assert len(files) == 1
    # 확장자가 남아야 색인기가 PDF 추출기를 고른다
    assert files[0].name.endswith(".pdf")
    assert files[0].name.startswith("99_")


def test_save_attachments_survives_garbage(tmp_path: Path):
    assert archive._save_attachments(b"not an email at all", tmp_path, "1") == 0


def test_client_picks_pop3_for_pop3_accounts():
    """POP3 계정에 IMAP 클라이언트를 쓰면 110 포트로 IMAP 핸드셰이크를 시도하다
    그대로 멈춘다 — 백필이 실제로 그렇게 걸렸다."""
    from app.mail import archive, imap_client, pop3_client

    class Pop:
        protocol = "pop3"

    class Imap:
        protocol = "imap"

    class NoAttr:
        pass

    assert archive._client(Pop()) is pop3_client
    assert archive._client(Imap()) is imap_client
    assert archive._client(NoAttr()) is imap_client   # 기본은 IMAP


def test_both_clients_expose_fetch_raw_many():
    """아카이브가 프로토콜을 안 가리려면 인터페이스가 같아야 한다."""
    from app.mail import imap_client, pop3_client

    for mod in (imap_client, pop3_client):
        assert hasattr(mod, "fetch_raw_many"), f"{mod.__name__} 에 fetch_raw_many 가 없다"
        assert hasattr(mod, "fetch_messages"), f"{mod.__name__} 에 fetch_messages 가 없다"
