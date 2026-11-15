"""청크 업로드 세션 — 디스크 레이아웃·조립·만료·ID 검증."""

import os
import time
from pathlib import Path

import pytest

from app.files import service as fs
from app.files import upload_sessions as us


def _root(tmp_path: Path) -> Path:
    return us.sessions_root(tmp_path)


def test_create_and_read_meta(tmp_path: Path):
    root = _root(tmp_path)
    meta = us.create_session(root, user_id="u1", target_vpath="my/docs", name="big.bin",
                             total_size=30, mtime_ms=1_700_000_000_000)
    assert root.name == ".uploads" and (root / meta["id"] / us.META_NAME).is_file()
    d, back = us.read_meta(root, meta["id"])
    assert back["user_id"] == "u1" and back["name"] == "big.bin" and back["mtime_ms"] == 1_700_000_000_000
    assert d == root / meta["id"]


@pytest.mark.parametrize("bad", ["", "..", "../x", "a/b", "short", "x" * 70, "with space 1234567890"])
def test_session_id_validation(tmp_path: Path, bad):
    with pytest.raises(us.SessionError):
        us.session_dir(_root(tmp_path), bad)


def test_assemble_in_order_and_cleanup(tmp_path: Path):
    root = _root(tmp_path)
    meta = us.create_session(root, user_id="u1", target_vpath="my", name="f", total_size=9, mtime_ms=None)
    d = root / meta["id"]
    # 순서 뒤섞어 저장 — 번호로 정렬돼야 한다
    us.chunk_path(d, 2).write_bytes(b"def")
    us.chunk_path(d, 1).write_bytes(b"abc")
    us.chunk_path(d, 3).write_bytes(b"ghi")
    (d / "000004.part").write_bytes(b"zzz")        # 쓰다 만 것은 무시
    assert us.list_chunks(d) == [(1, 3), (2, 3), (3, 3)]
    out = us.assemble(d, 9)
    assert out.read_bytes() == b"abcdefghi"
    assert us.discard(root, meta["id"]) is True
    assert not d.exists()


def test_assemble_rejects_gaps_and_size_mismatch(tmp_path: Path):
    root = _root(tmp_path)
    meta = us.create_session(root, user_id="u1", target_vpath="my", name="f", total_size=6, mtime_ms=None)
    d = root / meta["id"]
    us.chunk_path(d, 1).write_bytes(b"abc")
    us.chunk_path(d, 3).write_bytes(b"ghi")
    with pytest.raises(us.SessionError, match="빠진 청크"):
        us.assemble(d, 6)
    us.chunk_path(d, 2).write_bytes(b"de")
    with pytest.raises(us.SessionError, match="크기 불일치"):
        us.assemble(d, 6)
    assert us.assemble(d, None).read_bytes() == b"abcdeghi"      # 선언 크기 모르면 검사 생략


def test_chunk_number_bounds(tmp_path: Path):
    d = tmp_path
    with pytest.raises(us.SessionError):
        us.chunk_path(d, 0)
    with pytest.raises(us.SessionError):
        us.chunk_path(d, us.MAX_CHUNKS + 1)
    assert us.chunk_path(d, 7).name == "000007"


def test_apply_mtime_preserves_client_time(tmp_path: Path):
    f = tmp_path / "x"
    f.write_bytes(b"1")
    fs.apply_mtime(f, 1_700_000_000_123)
    assert f.stat().st_mtime_ns == 1_700_000_000_123 * 1_000_000
    fs.apply_mtime(f, None)                                      # 없으면 그대로
    assert f.stat().st_mtime_ns == 1_700_000_000_123 * 1_000_000


def test_expire_sessions_only_stale_and_only_under_uploads(tmp_path: Path):
    root = _root(tmp_path)
    fresh = us.create_session(root, user_id="u1", target_vpath="my", name="a", total_size=0, mtime_ms=None)
    stale = us.create_session(root, user_id="u1", target_vpath="my", name="b", total_size=0, mtime_ms=None)
    stale_dir = root / stale["id"]
    us.chunk_path(stale_dir, 1).write_bytes(b"x")
    old = time.time() - 2 * us.SESSION_TTL
    for p in [stale_dir, *stale_dir.iterdir()]:
        os.utime(p, (old, old))
    # ID 형식이 아닌 디렉터리는 건드리지 않는다
    foreign = root / "not-a-session"
    foreign.mkdir()
    os.utime(foreign, (old, old))

    stats = us.expire_sessions(root)
    assert not stale_dir.exists()
    assert (root / fresh["id"]).exists()
    assert foreign.exists()
    assert stats.removed == 1 and stats.errors == 0

    # 루트 이름이 .uploads 가 아니면 아무것도 안 한다
    assert us.expire_sessions(tmp_path).removed == 0
