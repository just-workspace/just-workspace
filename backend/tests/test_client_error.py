"""화면 측 오류 수집(/api/client-error) — 번호 형식·중복 억제·크기 제한."""

import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.middleware import client_error as ce


def _client():
    app = FastAPI()
    app.include_router(ce.router)
    return TestClient(app)


def test_logs_with_request_id(caplog):
    ce._seen.clear()
    with caplog.at_level(logging.WARNING, logger="client_error"):
        r = _client().post("/api/client-error", json={"request_id": "8347-f99d", "message": "boom", "stack": "at x", "url": "/chat", "status": 500})
    assert r.status_code == 204
    assert "req=8347-f99d" in caplog.text and "url=/chat" in caplog.text and "boom" in caplog.text


def test_dedupes_same_id(caplog):
    ce._seen.clear()
    c = _client()
    with caplog.at_level(logging.WARNING, logger="client_error"):
        c.post("/api/client-error", json={"request_id": "aaaa-bbbb", "message": "one"})
        c.post("/api/client-error", json={"request_id": "aaaa-bbbb", "message": "two"})
    assert caplog.text.count("req=aaaa-bbbb") == 1


def test_rejects_bad_id_and_big_body(caplog):
    ce._seen.clear()
    c = _client()
    with caplog.at_level(logging.WARNING, logger="client_error"):
        assert c.post("/api/client-error", json={"request_id": "not-an-id\nfake"}).status_code == 204
        assert c.post("/api/client-error", content=b"x" * (17 * 1024)).status_code == 204
        assert c.post("/api/client-error", content=b"{bad").status_code == 204
    assert "[client-error]" not in caplog.text
