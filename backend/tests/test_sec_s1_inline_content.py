"""회귀 — 사용자 콘텐츠(공유 링크·내 파일·첨부)가 본 서비스 출처에서 활성 콘텐츠로 열리지 않는다."""

from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient

from app.files import serve_safety
from app.files.router import _file_response


@pytest.mark.parametrize("name,ct", [
    ("x.htm", None), ("x.html", None), ("x.xhtml", None), ("x.shtml", None), ("x.svg", None),
    ("x.xml", None), ("x.mjs", None), ("x.js", None), ("x.pdf", "text/html"), ("x", "image/svg+xml"),
    ("x.txt", None),
])
def test_active_or_unknown_types_forced_to_attachment(name, ct):
    media, h = serve_safety.safe_file_headers(name, content_type=ct, inline=True)
    assert h["Content-Disposition"].startswith("attachment;")
    assert media == "application/octet-stream"
    assert h["X-Content-Type-Options"] == "nosniff"
    assert "sandbox" in h["Content-Security-Policy"]


@pytest.mark.parametrize("name", ["a.png", "a.jpg", "a.webp", "a.pdf", "a.mp4"])
def test_safe_types_may_be_inline(name):
    media, h = serve_safety.safe_file_headers(name, inline=True)
    assert h["Content-Disposition"].startswith("inline;")
    assert media != "application/octet-stream"
    if media != "application/pdf":
        assert "sandbox" in h["Content-Security-Policy"]


def test_svg_preview_is_image_only():
    media, h = serve_safety.svg_image_headers("a.svg")
    assert media == "image/svg+xml"
    assert h["Content-Disposition"].startswith("attachment;")
    assert "sandbox" in h["Content-Security-Policy"]


@pytest.mark.asyncio
async def test_file_response_never_serves_html_inline(tmp_path: Path):
    f = tmp_path / "evil.htm"
    f.write_text("<script>alert(1)</script>")
    app = FastAPI()

    @app.get("/f")
    async def get_f(request: Request):
        return _file_response(f, request, filename="evil.htm", inline=True)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/f")
    assert r.headers["content-type"].startswith("application/octet-stream")
    assert r.headers["content-disposition"].startswith("attachment;")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in r.headers["content-security-policy"]


@pytest.mark.asyncio
async def test_shared_link_inline_preview_blocks_active_content(tmp_path: Path, monkeypatch):
    """내려받기가 차단된 공유 링크 + ?inline=1 — .htm/.svg 는 403, 이미지는 inline 이미지로 응답."""
    from fastapi import HTTPException
    from types import SimpleNamespace
    from app.files import router as fr

    files = {"evil.htm": b"<script>1</script>", "pic.svg": b"<svg/>", "ok.png": b"\x89PNG\r\n\x1a\n"}
    for n, b in files.items():
        (tmp_path / n).write_bytes(b)
    state = {"name": None}

    async def load_public_link(_db, token):
        return SimpleNamespace(allow_download=False, max_downloads=None, download_count=0, paths=None,
                               password_hash=None, created_by="o", file_path="my/" + state["name"],
                               display_name=state["name"], id="l1", token=token)

    monkeypatch.setattr(fr, "load_public_link", load_public_link)
    monkeypatch.setattr(fr, "_password_ok", lambda *a: True)
    monkeypatch.setattr(fr, "resolve_link_path", lambda link, vp=None: tmp_path / state["name"])

    class _DB:
        async def execute(self, *_a, **_k):
            return SimpleNamespace(rowcount=1)

        async def commit(self):
            pass

        async def get(self, *_a):
            return None

    req = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})
    for bad in ("evil.htm", "pic.svg"):
        state["name"] = bad
        with pytest.raises(HTTPException) as e:
            await fr.download_shared("t", req, access=None, inline=True, db=_DB())
        assert e.value.status_code == 403
    state["name"] = "ok.png"
    r = await fr.download_shared("t", req, access=None, inline=True, db=_DB())
    assert r.media_type == "image/png"
    assert r.headers["content-disposition"].startswith("inline;")
    assert "sandbox" in r.headers["content-security-policy"]
