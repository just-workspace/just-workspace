"""파일 전송 헤더(R-18) — ETag 공식·If-None-Match 비교·mtime 파싱·Range(Starlette)."""

import os
import sys
import types
from pathlib import Path

import pytest

from app.files import service as fs

if os.name == "nt" and "resource" not in sys.modules:
    # 라우터 → indexer 가 유닉스 전용 `resource` 를 import 한다. Windows 개발 PC 에서도
    # 헤더 테스트는 돌아야 하니 빈 모듈을 끼운다(import 시점에만 필요).
    sys.modules["resource"] = types.ModuleType("resource")


def test_compute_etag_changes_with_size_and_mtime(tmp_path: Path):
    f = tmp_path / "a.txt"
    f.write_bytes(b"hello")
    e1 = fs.compute_etag(f.stat())
    assert e1.startswith('"') and e1.endswith('"')
    f.write_bytes(b"hello!")
    e2 = fs.compute_etag(f.stat())
    assert e1 != e2
    os.utime(f, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
    e3 = fs.compute_etag(f.stat())
    assert e3 == f'"{1_700_000_000_000_000_000:x}-{6:x}"'


def test_etag_matches_weak_and_list():
    tag = '"abc-5"'
    assert fs.etag_matches('"abc-5"', tag)
    assert fs.etag_matches('W/"abc-5"', tag)
    assert fs.etag_matches('"zzz", "abc-5"', tag)
    assert fs.etag_matches("*", tag)
    assert not fs.etag_matches('"abc-6"', tag)
    assert not fs.etag_matches(None, tag)
    assert not fs.etag_matches("", tag)


def test_client_mtime_parsing():
    from app.files.router import _client_mtime
    assert _client_mtime(1_700_000_000_000, None) == 1_700_000_000_000
    assert _client_mtime(None, "1700000000000") == 1_700_000_000_000
    assert _client_mtime(1_700_000_000_000, "1") == 1_700_000_000_000      # 쿼리 우선
    assert _client_mtime(None, None) is None
    assert _client_mtime(None, "abc") is None
    assert _client_mtime(1_700_000_000, None) is None                      # 초 단위 실수 → 무시
    assert _client_mtime(None, "") is None


@pytest.mark.asyncio
async def test_file_response_304_and_range(tmp_path: Path):
    """_file_response: If-None-Match → 304, Range → 206, 그냥 GET → 200 + ETag/Accept-Ranges."""
    from fastapi import FastAPI, Request
    from httpx import ASGITransport, AsyncClient
    from app.files.router import _file_response

    f = tmp_path / "data.bin"
    f.write_bytes(bytes(range(256)))
    etag = fs.compute_etag(f.stat())

    app = FastAPI()

    @app.get("/f")
    async def get_f(request: Request):
        return _file_response(f, request, filename="data.bin")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/f")
        assert r.status_code == 200
        assert r.headers["etag"] == etag
        assert r.headers["accept-ranges"] == "bytes"
        assert r.content == bytes(range(256))

        r = await c.get("/f", headers={"If-None-Match": etag})
        assert r.status_code == 304 and r.content == b""
        assert r.headers["etag"] == etag

        r = await c.get("/f", headers={"If-None-Match": '"other"'})
        assert r.status_code == 200

        r = await c.get("/f", headers={"Range": "bytes=10-19"})
        assert r.status_code == 206
        assert r.content == bytes(range(10, 20))
        assert r.headers["content-range"] == "bytes 10-19/256"

        r = await c.get("/f", headers={"Range": "bytes=1000-"})
        assert r.status_code == 416
