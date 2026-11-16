"""회귀 — 메일 보관(.eml·첨부) 경로는 사용자 본인 보관 폴더를 벗어날 수 없다(POP3 UIDL 조작)."""

from email.message import EmailMessage
from pathlib import Path

import pytest

from app.mail import archive


@pytest.fixture(autouse=True)
def _root(tmp_path, monkeypatch):
    monkeypatch.setattr(archive.settings, "storage_root", str(tmp_path))
    return tmp_path


def _raw_with_attachment():
    m = EmailMessage()
    m["Subject"] = "hi"
    m.set_content("body")
    m.add_attachment(b"data", maintype="application", subtype="pdf", filename="a.pdf")
    return m.as_bytes()


@pytest.mark.parametrize("uid", [
    "../../../../victim/x", "..", "../..", "a/b", "a\b", "/etc/passwd", "x" * 200, "..hidden",
])
def test_hostile_uidl_stays_in_own_archive(uid, _root):
    out = archive.save_raw("u1", "me@example.com", uid, "subj", "2026-10-01T00:00:00Z", _raw_with_attachment())
    assert out is not None
    own = (_root / "users" / "u1" / archive.ARCHIVE_DIRNAME / "me@example.com").resolve()
    files = [p.resolve() for p in _root.rglob("*") if p.is_file()]
    assert files and all(f.is_relative_to(own) for f in files)
    # 동일 id 는 동일 이름 — 재저장 시 중복으로 판정하여 생략
    assert archive.save_raw("u1", "me@example.com", uid, "subj", "2026-10-01T00:00:00Z", b"x") is None


def test_imap_numeric_uid_unchanged():
    p = archive.eml_path("u1", "me@example.com", "1234", "제목", "2026-10-01T00:00:00Z")
    assert p.name.startswith("1234_")


def test_invalid_user_id_rejected():
    with pytest.raises(archive.ArchivePathError):
        archive.eml_path("../u2", "me@example.com", "1", "s", None)


def test_symlinked_month_dir_cannot_escape(_root):
    victim = _root / "users" / "u2"
    victim.mkdir(parents=True)
    acc = _root / "users" / "u1" / archive.ARCHIVE_DIRNAME / "me@example.com"
    acc.mkdir(parents=True)
    (acc / "2026-10").symlink_to(victim, target_is_directory=True)
    with pytest.raises(archive.ArchivePathError):
        archive.save_raw("u1", "me@example.com", "1", "s", "2026-10-01T00:00:00Z", b"raw")
    assert not any(victim.iterdir())
