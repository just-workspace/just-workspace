"""목록 캐시는 디렉터리 변경 시 즉시 무효화 — 다른 워커가 invalidate 를 수신하지 못해도(워커 8개) 30초 동안 이전 목록을 반환하지 않는다."""

import os

from app.files import service as fs


def test_cache_follows_directory_mtime(tmp_path):
    fs._dir_cache.clear()
    d = tmp_path / "my"
    d.mkdir()
    (d / "a.txt").write_text("a")
    assert [i.name for i in fs.list_directory(d, "my")] == ["a.txt"]
    # 다른 워커가 폴더를 생성한 상황 — 이 워커의 캐시는 invalidate 되지 않는다
    (d / "new").mkdir()
    st = d.stat()
    os.utime(d, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))   # 파일시스템 시각 해상도 보정
    names = sorted(i.name for i in fs.list_directory(d, "my"))
    assert names == ["a.txt", "new"]


def test_cache_hit_when_unchanged(tmp_path, monkeypatch):
    fs._dir_cache.clear()
    d = tmp_path / "my"
    d.mkdir()
    fs.list_directory(d, "my")
    calls = []
    monkeypatch.setattr(fs, "_scan_directory", lambda *a: calls.append(1) or [])
    fs.list_directory(d, "my")
    assert calls == []
